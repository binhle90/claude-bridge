function sessionRoutes(router, db) {
  const insert = db.prepare(`
    INSERT INTO session_summaries (
      source, source_id, project,
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes,
      created_at, created_at_epoch
    ) VALUES (
      @source, @source_id, @project,
      @request, @investigated, @learned, @completed, @next_steps,
      @files_read, @files_edited, @notes,
      @created_at, @created_at_epoch
    )
  `);

  const syncFts = db.prepare(`
    INSERT INTO session_summaries_fts (rowid, request, investigated, learned, completed, next_steps, notes, abstract)
    SELECT id, request, investigated, learned, completed, next_steps, notes, abstract
    FROM session_summaries WHERE id = ?
  `);

  router.post("/api/sessions", (req, res) => {
    const b = req.body;
    if (!b.source) {
      return res.status(400).json({ error: "source is required" });
    }

    try {
      const result = insert.run({
        source: b.source,
        source_id: b.source_id ?? null,
        project: b.project ?? null,
        request: b.request ?? null,
        investigated: b.investigated ?? null,
        learned: b.learned ?? null,
        completed: b.completed ?? null,
        next_steps: b.next_steps ?? null,
        files_read: b.files_read ?? null,
        files_edited: b.files_edited ?? null,
        notes: b.notes ?? null,
        created_at: b.created_at ?? null,
        created_at_epoch: b.created_at_epoch ?? null,
      });

      syncFts.run(result.lastInsertRowid);

      if (req.app.locals.enrichmentWorker) {
        req.app.locals.enrichmentWorker.enqueueSession(Number(result.lastInsertRowid));
      }

      res.status(201).json({ id: Number(result.lastInsertRowid), success: true });
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({ error: "Duplicate session summary (source, source_id)" });
      }
      throw err;
    }
  });
}

module.exports = sessionRoutes;
