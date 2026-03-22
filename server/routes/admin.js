function adminRoutes(router, db, enrichmentWorker) {
  router.post("/api/admin/backfill", (req, res) => {
    // Find all observations without embeddings
    const obsRows = db.prepare(`
      SELECT o.id FROM observations o
      LEFT JOIN observation_embeddings e ON e.observation_id = o.id
      WHERE e.observation_id IS NULL
    `).all();

    for (const row of obsRows) {
      enrichmentWorker.enqueueObservation(row.id);
    }

    // Also enqueue observations without abstracts
    const obsAbstractRows = db.prepare(
      "SELECT id FROM observations WHERE abstract IS NULL"
    ).all();
    for (const row of obsAbstractRows) {
      enrichmentWorker.enqueueObservation(row.id);
    }

    // Find all sessions without embeddings
    const sessionRows = db.prepare(`
      SELECT ss.id FROM session_summaries ss
      LEFT JOIN session_embeddings e ON e.session_id = ss.id
      WHERE e.session_id IS NULL
    `).all();

    for (const row of sessionRows) {
      enrichmentWorker.enqueueSession(row.id);
    }

    // Also enqueue sessions without abstracts
    const sessionAbstractRows = db.prepare(
      "SELECT id FROM session_summaries WHERE abstract IS NULL"
    ).all();
    for (const row of sessionAbstractRows) {
      enrichmentWorker.enqueueSession(row.id);
    }

    const obsQueued = enrichmentWorker.pendingObservations().length;
    const sessQueued = enrichmentWorker.pendingSessions().length;

    res.json({
      observations_queued: obsQueued,
      sessions_queued: sessQueued,
      message: `Backfill enqueued. Worker will process in background.`,
    });
  });
}

module.exports = adminRoutes;
