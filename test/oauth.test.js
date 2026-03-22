const crypto = require("node:crypto");
const http = require("node:http");

const TEST_API_KEY = "test-secret-key-12345";
const TEST_CLIENT_ID = "test-client-id";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_PASSWORD = "test-password";
process.env.API_KEY = TEST_API_KEY;
process.env.OAUTH_CLIENT_ID = TEST_CLIENT_ID;
process.env.OAUTH_CLIENT_SECRET = TEST_CLIENT_SECRET;
process.env.OAUTH_PASSWORD = TEST_PASSWORD;

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");

describe("OAuth Token Store", () => {
  let tokenStore;

  before(() => {
    // createApp initializes the db and calls setupOAuth, which creates the SQLite-backed tokenStore
    const { createApp } = require("../server/index");
    createApp(":memory:");
    tokenStore = require("../server/oauth").tokenStore;
  });

  it("stores and validates access tokens", () => {
    const token = tokenStore.createAccessToken();
    assert.ok(tokenStore.isValidAccessToken(token));
    assert.ok(!tokenStore.isValidAccessToken("bogus-token"));
  });

  it("stores and validates refresh tokens", () => {
    const token = tokenStore.createRefreshToken();
    const valid = tokenStore.consumeRefreshToken(token);
    assert.ok(valid);
    const second = tokenStore.consumeRefreshToken(token);
    assert.ok(!second);
  });

  it("stores and consumes auth codes", () => {
    const data = {
      redirect_uri: "https://claude.ai/callback",
      code_challenge: "abc123",
      code_challenge_method: "S256",
    };
    const code = tokenStore.createAuthCode(data);
    const retrieved = tokenStore.consumeAuthCode(code);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.redirect_uri, data.redirect_uri);
    assert.ok(!tokenStore.consumeAuthCode(code));
  });

  it("rejects expired auth codes", () => {
    const data = {
      redirect_uri: "https://claude.ai/callback",
      code_challenge: "abc123",
      code_challenge_method: "S256",
    };
    const code = tokenStore.createAuthCode(data, -1000);
    assert.ok(!tokenStore.consumeAuthCode(code));
  });
});

// --- HTTP helper that supports both JSON and form-urlencoded ---
function httpRequest(baseUrl, method, path, { body, headers = {}, form = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    let bodyStr;
    if (body && form) {
      bodyStr = new URLSearchParams(body).toString();
    } else if (body) {
      bodyStr = JSON.stringify(body);
    }
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + (url.search || ""),
      headers: {
        "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
        ...headers,
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("OAuth Endpoints", () => {
  let server;
  let baseUrl;

  before(async () => {
    const { createApp } = require("../server/index");
    const { app } = createApp(":memory:");
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("GET /.well-known/oauth-protected-resource returns RFC 9728 metadata", async () => {
    const res = await httpRequest(baseUrl, "GET", "/.well-known/oauth-protected-resource");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.resource, "should have resource field");
    assert.ok(Array.isArray(res.body.authorization_servers), "should have authorization_servers array");
    assert.ok(Array.isArray(res.body.bearer_methods_supported), "should have bearer_methods_supported array");
  });

  it("GET /.well-known/oauth-authorization-server returns RFC 8414 metadata", async () => {
    const res = await httpRequest(baseUrl, "GET", "/.well-known/oauth-authorization-server");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.issuer, "should have issuer field");
    assert.ok(res.body.authorization_endpoint, "should have authorization_endpoint field");
    assert.ok(res.body.token_endpoint, "should have token_endpoint field");
    assert.ok(
      Array.isArray(res.body.code_challenge_methods_supported) &&
        res.body.code_challenge_methods_supported.includes("S256"),
      "should support S256 PKCE"
    );
    assert.deepStrictEqual(res.body.scopes_supported, ["mcp"], "scopes_supported should be ['mcp']");
  });

  it("GET /authorize with valid client_id returns HTML password form", async () => {
    const qs = new URLSearchParams({
      client_id: TEST_CLIENT_ID,
      redirect_uri: "https://claude.ai/callback",
      response_type: "code",
      code_challenge: "abc123",
      code_challenge_method: "S256",
      state: "test-state",
    }).toString();
    const res = await httpRequest(baseUrl, "GET", `/authorize?${qs}`);
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body === "string", "body should be HTML string");
    assert.ok(res.body.includes("password"), "should include password input");
    assert.ok(res.body.includes("Grant Access"), "should include Grant Access button");
  });

  it("GET /authorize with wrong client_id returns 400", async () => {
    const qs = new URLSearchParams({
      client_id: "wrong-client-id",
      redirect_uri: "https://claude.ai/callback",
      response_type: "code",
      code_challenge: "abc123",
      code_challenge_method: "S256",
    }).toString();
    const res = await httpRequest(baseUrl, "GET", `/authorize?${qs}`);
    assert.strictEqual(res.status, 400);
  });

  it("GET /authorize with invalid redirect_uri returns 400", async () => {
    const qs = new URLSearchParams({
      client_id: TEST_CLIENT_ID,
      redirect_uri: "https://evil.com/steal",
      response_type: "code",
      code_challenge: "abc123",
      code_challenge_method: "S256",
    }).toString();
    const res = await httpRequest(baseUrl, "GET", `/authorize?${qs}`);
    assert.strictEqual(res.status, 400);
  });

  it("POST /authorize with wrong password returns 200 with Invalid password", async () => {
    const res = await httpRequest(baseUrl, "POST", "/authorize", {
      form: true,
      body: {
        password: "wrong-password",
        client_id: TEST_CLIENT_ID,
        redirect_uri: "https://claude.ai/callback",
        response_type: "code",
        code_challenge: "abc123",
        code_challenge_method: "S256",
        state: "test-state",
        scope: "mcp",
      },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body === "string", "body should be HTML string");
    assert.ok(res.body.includes("Invalid password"), "should show Invalid password error");
  });

  it("POST /authorize with correct password returns 302 with code and state", async () => {
    const res = await httpRequest(baseUrl, "POST", "/authorize", {
      form: true,
      body: {
        password: TEST_PASSWORD,
        client_id: TEST_CLIENT_ID,
        redirect_uri: "https://claude.ai/callback",
        response_type: "code",
        code_challenge: "abc123",
        code_challenge_method: "S256",
        state: "test-state",
        scope: "mcp",
      },
    });
    assert.strictEqual(res.status, 302);
    const location = res.headers["location"];
    assert.ok(location, "should have Location header");
    const redirectUrl = new URL(location);
    assert.ok(redirectUrl.searchParams.has("code"), "redirect should include code param");
    assert.strictEqual(redirectUrl.searchParams.get("state"), "test-state", "redirect should echo state param");
  });

  // --- Token endpoint helpers ---

  // Helper to generate PKCE pair
  function generatePkce() {
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    return { codeVerifier, codeChallenge };
  }

  // Helper to do the full authorize dance and get an auth code
  async function getAuthCode(bUrl, { codeChallenge, state = "test" } = {}) {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const res = await httpRequest(bUrl, "POST", "/authorize", {
      form: true,
      body: {
        password: TEST_PASSWORD,
        client_id: TEST_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      },
    });
    const location = new URL(res.headers.location);
    return location.searchParams.get("code");
  }

  it("POST /token full PKCE flow returns access and refresh tokens", async () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const code = await getAuthCode(baseUrl, { codeChallenge });

    const res = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
        code_verifier: codeVerifier,
      },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.token_type, "Bearer");
    assert.ok(res.body.access_token, "should have access_token");
    assert.ok(res.body.refresh_token, "should have refresh_token");
    assert.strictEqual(res.body.expires_in, 86400);
    assert.strictEqual(res.body.scope, "mcp");
  });

  it("POST /token with wrong client_secret returns 401 invalid_client", async () => {
    const { codeChallenge, codeVerifier } = generatePkce();
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const code = await getAuthCode(baseUrl, { codeChallenge });

    const res = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: TEST_CLIENT_ID,
        client_secret: "wrong-secret",
        code_verifier: codeVerifier,
      },
    });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, "invalid_client");
  });

  it("POST /token with invalid PKCE verifier returns 400 invalid_grant", async () => {
    const { codeChallenge } = generatePkce();
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const code = await getAuthCode(baseUrl, { codeChallenge });

    const res = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
        code_verifier: "wrong-verifier",
      },
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, "invalid_grant");
  });

  it("POST /token with reused auth code returns 400 invalid_grant", async () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const code = await getAuthCode(baseUrl, { codeChallenge });

    // First exchange — should succeed
    await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
        code_verifier: codeVerifier,
      },
    });

    // Second exchange of same code — should fail
    const res = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
        code_verifier: codeVerifier,
      },
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, "invalid_grant");
  });

  it("OAuth token works on MCP endpoint", async () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const code = await getAuthCode(baseUrl, { codeChallenge });

    const tokenRes = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
        code_verifier: codeVerifier,
      },
    });
    assert.strictEqual(tokenRes.status, 200);
    const { access_token } = tokenRes.body;
    assert.ok(access_token, "should have access_token");

    const mcpRes = await httpRequest(baseUrl, "POST", "/mcp", {
      body: { jsonrpc: "2.0", method: "ping", params: {}, id: 1 },
      headers: { Authorization: `Bearer ${access_token}` },
    });
    assert.strictEqual(mcpRes.status, 200);
    assert.strictEqual(mcpRes.body.jsonrpc, "2.0");
    assert.deepStrictEqual(mcpRes.body.result, {});
  });

  it("401 includes WWW-Authenticate header", async () => {
    const res = await httpRequest(baseUrl, "POST", "/mcp", {
      body: { jsonrpc: "2.0", method: "ping", params: {}, id: 1 },
    });
    assert.strictEqual(res.status, 401);
    const wwwAuth = res.headers["www-authenticate"];
    assert.ok(wwwAuth, "should have WWW-Authenticate header");
    assert.ok(
      wwwAuth.includes("oauth-protected-resource"),
      "WWW-Authenticate should reference oauth-protected-resource"
    );
  });

  it("Static API_KEY still works on MCP endpoint", async () => {
    const res = await httpRequest(baseUrl, "POST", "/mcp", {
      body: { jsonrpc: "2.0", method: "ping", params: {}, id: 1 },
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.deepStrictEqual(res.body.result, {});
  });

  it("POST /token refresh_token grant rotates tokens and rejects reuse", async () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const code = await getAuthCode(baseUrl, { codeChallenge });

    // Get initial tokens
    const initial = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
        code_verifier: codeVerifier,
      },
    });
    assert.strictEqual(initial.status, 200);
    const oldRefreshToken = initial.body.refresh_token;
    const oldAccessToken = initial.body.access_token;

    // Use refresh token to get new tokens
    const refreshed = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "refresh_token",
        refresh_token: oldRefreshToken,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      },
    });
    assert.strictEqual(refreshed.status, 200);
    assert.strictEqual(refreshed.body.token_type, "Bearer");
    assert.ok(refreshed.body.access_token, "should have new access_token");
    assert.ok(refreshed.body.refresh_token, "should have new refresh_token");
    assert.notStrictEqual(refreshed.body.access_token, oldAccessToken, "access_token should be new");
    assert.notStrictEqual(refreshed.body.refresh_token, oldRefreshToken, "refresh_token should be new");

    // Old refresh token should be rejected
    const reuse = await httpRequest(baseUrl, "POST", "/token", {
      form: true,
      body: {
        grant_type: "refresh_token",
        refresh_token: oldRefreshToken,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      },
    });
    assert.strictEqual(reuse.status, 400);
    assert.strictEqual(reuse.body.error, "invalid_grant");
  });
});
