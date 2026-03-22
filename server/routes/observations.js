function observationRoutes(router, db) {
  const insert = db.prepare(`
    INSERT INTO observations (
      source, source_id, session_source_id, project, type,
      title, subtitle, text, narrative, facts, concepts,
      files_read, files_modified, prompt_number,
      created_at, created_at_epoch
    ) VALUES (
      @source, @source_id, @session_source_id, @project, @type,
      @title, @subtitle, @text, @narrative, @facts, @concepts,
      @files_read, @files_modified, @prompt_number,
      @created_at, @created_at_epoch
    )
  `);

  const syncFts = db.prepare(`
    INSERT INTO observations_fts (rowid, title, subtitle, text, narrative, facts, concepts, abstract)
    SELECT id, title, subtitle, text, narrative, facts, concepts, abstract
    FROM observations WHERE id = ?
  `);

  const findBySourceId = db.prepare(
    "SELECT id FROM observations WHERE source = ? AND source_id = ?"
  );

  const update = db.prepare(`
    UPDATE observations SET
      project = @project, type = @type, title = @title, subtitle = @subtitle,
      text = @text, narrative = @narrative, facts = @facts, concepts = @concepts,
      files_read = @files_read, files_modified = @files_modified,
      prompt_number = @prompt_number, created_at = @created_at, created_at_epoch = @created_at_epoch
    WHERE id = @id
  `);

  const deleteFts = db.prepare(
    "INSERT INTO observations_fts (observations_fts, rowid, title, subtitle, text, narrative, facts, concepts, abstract) SELECT 'delete', id, title, subtitle, text, narrative, facts, concepts, abstract FROM observations WHERE id = ?"
  );

  router.post("/api/observations", (req, res) => {
    const b = req.body;
    if (!b.source) {
      return res.status(400).json({ error: "source is required" });
    }

    // Check for upsert: if source_id exists and ?upsert=true, update instead of 409
    const upsert = req.query.upsert === "true";

    try {
      const result = insert.run({
        source: b.source,
        source_id: b.source_id ?? null,
        session_source_id: b.session_source_id ?? null,
        project: b.project ?? null,
        type: b.type ?? null,
        title: b.title ?? null,
        subtitle: b.subtitle ?? null,
        text: b.text ?? null,
        narrative: b.narrative ?? null,
        facts: b.facts ?? null,
        concepts: b.concepts ?? null,
        files_read: b.files_read ?? null,
        files_modified: b.files_modified ?? null,
        prompt_number: b.prompt_number ?? null,
        created_at: b.created_at ?? null,
        created_at_epoch: b.created_at_epoch ?? null,
      });

      syncFts.run(result.lastInsertRowid);

      // Enqueue for enrichment (embeddings + abstracts)
      if (req.app.locals.enrichmentWorker) {
        req.app.locals.enrichmentWorker.enqueueObservation(Number(result.lastInsertRowid));
      }

      res.status(201).json({ id: Number(result.lastInsertRowid), success: true });
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        if (upsert && b.source_id != null) {
          // Update existing record
          const existing = findBySourceId.get(b.source, b.source_id);
          if (existing) {
            deleteFts.run(existing.id);
            update.run({
              id: existing.id,
              project: b.project ?? null,
              type: b.type ?? null,
              title: b.title ?? null,
              subtitle: b.subtitle ?? null,
              text: b.text ?? null,
              narrative: b.narrative ?? null,
              facts: b.facts ?? null,
              concepts: b.concepts ?? null,
              files_read: b.files_read ?? null,
              files_modified: b.files_modified ?? null,
              prompt_number: b.prompt_number ?? null,
              created_at: b.created_at ?? null,
              created_at_epoch: b.created_at_epoch ?? null,
            });
            syncFts.run(existing.id);
            // Null out abstract on content change for re-generation
            db.prepare("UPDATE observations SET abstract = NULL WHERE id = ?").run(existing.id);
            // Enqueue for re-enrichment
            if (req.app.locals.enrichmentWorker) {
              req.app.locals.enrichmentWorker.enqueueObservation(existing.id);
            }
            return res.status(200).json({ id: existing.id, success: true, updated: true });
          }
        }
        return res.status(409).json({ error: "Duplicate observation (source, source_id)" });
      }
      throw err;
    }
  });
}

module.exports = observationRoutes;
