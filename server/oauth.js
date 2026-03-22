const crypto = require("crypto");

const ACCESS_TOKEN_TTL = 24 * 60 * 60 * 1000;        // 24 hours
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 days
const AUTH_CODE_TTL = 5 * 60 * 1000;                  // 5 minutes

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPkce(codeVerifier, codeChallenge) {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const computed = hash.toString("base64url");
  return safeCompare(computed, codeChallenge);
}

// Create a token store backed by SQLite (survives restarts)
function createTokenStore(db) {
  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      data TEXT,
      expires INTEGER NOT NULL
    )
  `);

  const stmts = {
    insert: db.prepare("INSERT INTO oauth_tokens (token, type, data, expires) VALUES (?, ?, ?, ?)"),
    get: db.prepare("SELECT * FROM oauth_tokens WHERE token = ? AND type = ?"),
    del: db.prepare("DELETE FROM oauth_tokens WHERE token = ? AND type = ?"),
    cleanup: db.prepare("DELETE FROM oauth_tokens WHERE expires <= ?"),
  };

  // Cleanup expired entries every 10 minutes
  setInterval(() => stmts.cleanup.run(Date.now()), 10 * 60 * 1000).unref();

  return {
    createAuthCode(data, ttlOverride) {
      const code = randomToken();
      stmts.insert.run(code, "auth_code", JSON.stringify(data), Date.now() + (ttlOverride ?? AUTH_CODE_TTL));
      return code;
    },
    consumeAuthCode(code) {
      const row = stmts.get.get(code, "auth_code");
      if (!row) return null;
      stmts.del.run(code, "auth_code");
      if (row.expires <= Date.now()) return null;
      return JSON.parse(row.data);
    },
    createAccessToken() {
      const token = randomToken();
      stmts.insert.run(token, "access_token", null, Date.now() + ACCESS_TOKEN_TTL);
      return token;
    },
    isValidAccessToken(token) {
      const row = stmts.get.get(token, "access_token");
      if (!row) return false;
      if (row.expires <= Date.now()) { stmts.del.run(token, "access_token"); return false; }
      return true;
    },
    createRefreshToken() {
      const token = randomToken();
      stmts.insert.run(token, "refresh_token", null, Date.now() + REFRESH_TOKEN_TTL);
      return token;
    },
    consumeRefreshToken(token) {
      const row = stmts.get.get(token, "refresh_token");
      if (!row) return false;
      stmts.del.run(token, "refresh_token");
      if (row.expires <= Date.now()) return false;
      return true;
    },
    verifyPkce,
    safeCompare,
  };
}

// Allowed redirect_uri hosts for OAuth (claude.ai + localhost variants)
const ALLOWED_REDIRECT_HOSTS = ["claude.ai", "localhost", "127.0.0.1"];

function isAllowedRedirectUri(uri) {
  try {
    const url = new URL(uri);
    return ALLOWED_REDIRECT_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function getBaseUrl(req) {
  return req.protocol + "://" + req.get("host");
}

function renderAuthForm(params, error) {
  const fields = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
  ];
  const hiddenInputs = fields
    .map(
      (f) =>
        `<input type="hidden" name="${f}" value="${escapeHtml(params[f] || "")}">`
    )
    .join("\n    ");

  const errorHtml = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Memory Bridge — Authorize</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; }
    h1 { font-size: 1.2rem; margin-bottom: 1.5rem; }
    label { display: block; margin-bottom: 0.5rem; font-weight: 600; }
    input[type="password"] { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; margin-bottom: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    button { width: 100%; padding: 0.6rem; font-size: 1rem; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .error { color: #dc2626; font-size: 0.9rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>Claude Memory Bridge — Authorize</h1>
  ${errorHtml}
  <form method="post" action="/authorize">
    ${hiddenInputs}
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus>
    <button type="submit">Grant Access</button>
  </form>
</body>
</html>`;
}

// tokenStore is set when setupOAuth is called with a db
let tokenStore = {
  isValidAccessToken() { return false; },
  verifyPkce,
  safeCompare,
};

function setupOAuth(app, db) {
  const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
  const PASSWORD = process.env.OAUTH_PASSWORD;

  if (!CLIENT_ID || !CLIENT_SECRET || !PASSWORD) {
    console.warn(
      "[oauth] OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, or OAUTH_PASSWORD not set — OAuth disabled"
    );
    return;
  }

  // Initialize SQLite-backed token store
  tokenStore = createTokenStore(db);

  const rateLimit = require("express-rate-limit");
  const urlencoded = require("express").urlencoded({ extended: false });
  const jsonParser = require("express").json();

  const authorizeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // RFC 9728 — OAuth Protected Resource Metadata
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const base = getBaseUrl(req);
    res.json({
      resource: base,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
    });
  });

  // RFC 8414 — Authorization Server Metadata
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = getBaseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    });
  });

  // GET /authorize — serve HTML password form
  app.get("/authorize", (req, res) => {
    const { client_id, redirect_uri } = req.query;

    if (!safeCompare(client_id || "", CLIENT_ID)) {
      return res.status(400).send("Invalid client_id");
    }
    if (!redirect_uri || !isAllowedRedirectUri(redirect_uri)) {
      return res.status(400).send("Invalid redirect_uri");
    }

    res.send(renderAuthForm(req.query, null));
  });

  const tokenLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // POST /authorize — validate password, issue auth code, redirect
  app.post("/authorize", authorizeLimiter, urlencoded, (req, res) => {
    const {
      password,
      client_id,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      state,
      scope,
    } = req.body;

    const params = {
      client_id,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      state,
      scope,
    };

    // Validate client_id and redirect_uri
    if (!safeCompare(client_id || "", CLIENT_ID)) {
      return res.status(400).send("Invalid client_id");
    }
    if (!redirect_uri || !isAllowedRedirectUri(redirect_uri)) {
      return res.status(400).send("Invalid redirect_uri");
    }

    // Validate password
    if (!safeCompare(password || "", PASSWORD)) {
      return res.status(200).send(renderAuthForm(params, "Invalid password"));
    }

    // Issue auth code
    const code = tokenStore.createAuthCode({
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    res.redirect(302, redirectUrl.toString());
  });

  // POST /token — exchange auth code or refresh token for access token
  // Accept both form-urlencoded and JSON bodies; support client_secret_post and client_secret_basic
  app.post("/token", tokenLimiter, urlencoded, jsonParser, (req, res) => {
    let client_id = req.body.client_id;
    let client_secret = req.body.client_secret;

    // Support client_secret_basic: credentials in Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      const colonIdx = decoded.indexOf(":");
      if (colonIdx > 0) {
        client_id = decodeURIComponent(decoded.slice(0, colonIdx));
        client_secret = decodeURIComponent(decoded.slice(colonIdx + 1));
      }
    }

    const { grant_type } = req.body;

    // Validate client credentials
    if (!safeCompare(client_id || "", CLIENT_ID) || !safeCompare(client_secret || "", CLIENT_SECRET)) {
      return res.status(401).json({ error: "invalid_client", error_description: "Invalid client credentials" });
    }

    if (grant_type === "authorization_code") {
      const { code, redirect_uri, code_verifier } = req.body;

      // Consume auth code (single use)
      const codeEntry = tokenStore.consumeAuthCode(code);
      if (!codeEntry) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
      }

      // Verify redirect_uri matches
      if (codeEntry.redirect_uri !== redirect_uri) {
        return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }

      // Verify PKCE
      if (!tokenStore.verifyPkce(code_verifier || "", codeEntry.code_challenge || "")) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }

      const access_token = tokenStore.createAccessToken();
      const refresh_token = tokenStore.createRefreshToken();

      return res.json({
        access_token,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL / 1000),
        refresh_token,
        scope: "mcp",
      });
    }

    if (grant_type === "refresh_token") {
      const { refresh_token } = req.body;

      // Consume refresh token (single use — rotation)
      const valid = tokenStore.consumeRefreshToken(refresh_token);
      if (!valid) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" });
      }

      const access_token = tokenStore.createAccessToken();
      const new_refresh_token = tokenStore.createRefreshToken();

      return res.json({
        access_token,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL / 1000),
        refresh_token: new_refresh_token,
        scope: "mcp",
      });
    }

    return res.status(400).json({ error: "unsupported_grant_type", error_description: "Unsupported grant type" });
  });
}

module.exports = { setupOAuth, get tokenStore() { return tokenStore; } };
