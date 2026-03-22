const oauth = require("../oauth");

let warnedNoApiKey = false;

function auth(req, res, next) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const wwwAuth = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

  // Warn once if API_KEY is not configured
  const apiKey = process.env.API_KEY;
  if (!apiKey && !warnedNoApiKey) {
    console.log(JSON.stringify({ level: "warn", message: "API_KEY not set — sync daemon auth will fail", timestamp: new Date().toISOString() }));
    warnedNoApiKey = true;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).set("WWW-Authenticate", wwwAuth).json({ error: "Unauthorized" });
  }

  const token = header.slice(7);

  // Check static API key (sync daemon, Claude Code)
  if (apiKey && token === apiKey) return next();

  // Check OAuth-issued access tokens
  if (oauth.tokenStore.isValidAccessToken(token)) return next();

  return res.status(401).set("WWW-Authenticate", wwwAuth).json({ error: "Unauthorized" });
}

module.exports = auth;
