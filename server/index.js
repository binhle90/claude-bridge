const express = require("express");
const rateLimit = require("express-rate-limit");
const { createDb } = require("./db");
const auth = require("./middleware/auth");
const healthRoutes = require("./routes/health");
const observationRoutes = require("./routes/observations");
const sessionRoutes = require("./routes/sessions");
const promptRoutes = require("./routes/prompts");
const searchRoutes = require("./routes/search");
const timelineRoutes = require("./routes/timeline");
const batchRoutes = require("./routes/batch");
const contextRoutes = require("./routes/context");
const adminRoutes = require("./routes/admin");
const setupMcp = require("./mcp");
const { setupOAuth } = require("./oauth");
const { createEmbeddingProvider } = require("./embeddings");
const { createAbstractGenerator } = require("./abstracts");
const { EnrichmentWorker } = require("./enrichment-worker");

function createApp(dbPath) {
  if (!dbPath && dbPath !== ":memory:") {
    throw new Error("DATABASE_URL is required.");
  }

  const db = createDb(dbPath);

  const embeddingProvider = createEmbeddingProvider({
    provider: process.env.EMBEDDING_PROVIDER,
    model: process.env.EMBEDDING_MODEL,
    apiKey: process.env.EMBEDDING_API_KEY,
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10),
  });

  const abstractGenerator = createAbstractGenerator({
    apiKey: process.env.EMBEDDING_API_KEY,
    model: process.env.ABSTRACT_MODEL,
  });

  const enrichmentWorker = new EnrichmentWorker({
    db, embeddingProvider, abstractGenerator,
  });

  const app = express();

  // Store on app.locals for access in route handlers
  app.locals.enrichmentWorker = enrichmentWorker;
  app.locals.embeddingProvider = embeddingProvider;

  app.set("trust proxy", 1);

  app.use(express.json({ limit: "1mb" }));

  // OAuth 2.1 endpoints (discovery + authorize) — public, no auth required
  setupOAuth(app, db);

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Health is public (before auth)
  healthRoutes(app, db, dbPath);

  // All /api routes require auth + rate limiting
  app.use("/api", auth, limiter);
  observationRoutes(app, db);
  sessionRoutes(app, db);
  promptRoutes(app, db);
  searchRoutes(app, db);
  timelineRoutes(app, db);
  batchRoutes(app, db);
  contextRoutes(app, db);
  adminRoutes(app, db, enrichmentWorker);

  // MCP endpoint (JSON-RPC 2.0 for Claude Desktop)
  setupMcp(app, db, auth);

  // Error handler
  app.use((err, req, res, next) => {
    console.error(
      JSON.stringify({
        level: "error",
        path: req.path,
        error: err.message,
        timestamp: new Date().toISOString(),
      })
    );
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, db, enrichmentWorker };
}

if (require.main === module) {
  const raw = process.env.DATABASE_URL || "";
  const dbPath = raw === ":memory:" ? ":memory:" : raw.replace("file:", "");
  const { app, enrichmentWorker } = createApp(dbPath);
  const port = parseInt(process.env.PORT || "3010", 10);
  app.listen(port, () => {
    console.log(
      JSON.stringify({
        level: "info",
        message: `Listening on :${port}`,
        timestamp: new Date().toISOString(),
      })
    );
    enrichmentWorker.start();
  });
}

module.exports = { createApp };
