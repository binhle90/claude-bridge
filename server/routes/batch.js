function batchRoutes(router, db) {
  router.post("/api/observations/batch", (req, res) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ error: "ids must be a non-empty array" });
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`)
      .all(...ids);

    res.json(rows);
  });
}

module.exports = batchRoutes;
