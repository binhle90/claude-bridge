const { semanticSearch, mergeRRF } = require("../search-semantic");

function searchRoutes(router, db) {
  router.get("/api/search", async (req, res) => {
    const { query, project, type, obs_type, mode: searchMode } = req.query;
    const embeddingProvider = req.app.locals.embeddingProvider;
    const hasEmbeddings = embeddingProvider && embeddingProvider.constructor.name !== "NoopEmbeddings";
    const mode = searchMode || (hasEmbeddings ? "hybrid" : "keyword");
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: "query parameter is required" });
    }

    if (mode === "semantic" || mode === "hybrid") {
      const embeddingProvider = req.app.locals.embeddingProvider;
      if (!embeddingProvider || embeddingProvider.constructor.name === "NoopEmbeddings") {
        return res.json({
          results: mode === "hybrid" ? keywordSearch(db, query, { project, type, obs_type, limit }) : [],
          total: 0,
          error: "Semantic search not configured. Set EMBEDDING_PROVIDER.",
        });
      }
    }

    try {
      let results;

      if (mode === "keyword") {
        results = keywordSearch(db, query, { project, type, obs_type, limit: limit + offset });
      } else if (mode === "semantic") {
        results = await semanticSearch(db, req.app.locals.embeddingProvider, query, { limit: limit + offset, project });
      } else if (mode === "hybrid") {
        const [ftsResults, semResults] = await Promise.all([
          Promise.resolve(keywordSearch(db, query, { project, type, obs_type, limit: 50 })),
          semanticSearch(db, req.app.locals.embeddingProvider, query, { limit: 50, project }),
        ]);
        results = mergeRRF(ftsResults, semResults);
      } else {
        return res.status(400).json({ error: `Invalid mode: ${mode}. Use keyword, semantic, or hybrid.` });
      }

      const total = results.length;
      const paged = results.slice(offset, offset + limit);
      res.json({ results: paged, total });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

function keywordSearch(db, query, { project, type, obs_type, limit = 20 } = {}) {
  const results = [];

  if (!type || type === "observations") {
    try {
      let sql = `
        SELECT o.*, snippet(observations_fts, -1, '', '', '...', 40) as fts_snippet
        FROM observations_fts fts
        JOIN observations o ON o.id = fts.rowid
        WHERE observations_fts MATCH ?
      `;
      const params = [query];
      if (project) { sql += " AND o.project = ?"; params.push(project); }
      if (obs_type) { sql += " AND o.type = ?"; params.push(obs_type); }

      const rows = db.prepare(sql).all(...params);
      for (const row of rows) {
        results.push({
          id: row.id,
          type: "observation",
          title: row.title,
          abstract: row.abstract || null,
          snippet: (row.fts_snippet || row.narrative || row.text || row.title || "").slice(0, 200),
          project: row.project,
          created_at_epoch: row.created_at_epoch,
          source: row.source,
          obs_type: row.type,
        });
      }
    } catch { /* Invalid FTS5 query syntax */ }
  }

  if (!type || type === "sessions") {
    try {
      let sql = `
        SELECT ss.*, snippet(session_summaries_fts, -1, '', '', '...', 40) as fts_snippet
        FROM session_summaries_fts fts
        JOIN session_summaries ss ON ss.id = fts.rowid
        WHERE session_summaries_fts MATCH ?
      `;
      const params = [query];
      if (project) { sql += " AND ss.project = ?"; params.push(project); }

      const rows = db.prepare(sql).all(...params);
      for (const row of rows) {
        results.push({
          id: row.id,
          type: "session",
          title: row.request,
          abstract: row.abstract || null,
          snippet: (row.fts_snippet || row.request || row.learned || "").slice(0, 200),
          project: row.project,
          created_at_epoch: row.created_at_epoch,
          source: row.source,
          obs_type: null,
        });
      }
    } catch { /* Invalid FTS5 query syntax */ }
  }

  results.sort((a, b) => (b.created_at_epoch || 0) - (a.created_at_epoch || 0));
  return results;
}

module.exports = searchRoutes;
module.exports.keywordSearch = keywordSearch;
