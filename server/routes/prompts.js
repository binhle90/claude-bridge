function promptRoutes(router, db) {
  const insert = db.prepare(`
    INSERT INTO user_prompts (
      source, source_id, session_source_id, project,
      prompt_text, prompt_number,
      created_at, created_at_epoch
    ) VALUES (
      @source, @source_id, @session_source_id, @project,
      @prompt_text, @prompt_number,
      @created_at, @created_at_epoch
    )
  `);

  router.post("/api/prompts", (req, res) => {
    const b = req.body;
    if (!b.source) {
      return res.status(400).json({ error: "source is required" });
    }

    try {
      const result = insert.run({
        source: b.source,
        source_id: b.source_id ?? null,
        session_source_id: b.session_source_id ?? null,
        project: b.project ?? null,
        prompt_text: b.prompt_text ?? null,
        prompt_number: b.prompt_number ?? null,
        created_at: b.created_at ?? null,
        created_at_epoch: b.created_at_epoch ?? null,
      });

      res.status(201).json({ id: Number(result.lastInsertRowid), success: true });
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({ error: "Duplicate user prompt (source, source_id)" });
      }
      throw err;
    }
  });
}

module.exports = promptRoutes;
