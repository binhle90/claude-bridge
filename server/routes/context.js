const TYPE_ICONS = {
  discovery: "\u{1F535}",
  decision: "\u2696\uFE0F",
  bugfix: "\u{1F534}",
  feature: "\u{1F7E3}",
  refactor: "\u{1F504}",
  change: "\u2705",
};

function contextRoutes(router, db) {
  router.get("/api/context", (req, res) => {
    const { projects } = req.query;

    if (!projects || !projects.trim()) {
      return res
        .status(400)
        .json({ error: "projects parameter is required (comma-separated)" });
    }

    const projectList = projects
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    if (projectList.length === 0) {
      return res
        .status(400)
        .json({ error: "projects parameter is required (comma-separated)" });
    }

    const placeholders = projectList.map(() => "?").join(", ");

    // Fetch recent sessions
    const sessions = db
      .prepare(
        `SELECT * FROM session_summaries
         WHERE project IN (${placeholders})
         ORDER BY created_at_epoch DESC
         LIMIT 20`
      )
      .all(...projectList);

    // Fetch recent observations
    const observations = db
      .prepare(
        `SELECT * FROM observations
         WHERE project IN (${placeholders})
         ORDER BY created_at_epoch DESC
         LIMIT 50`
      )
      .all(...projectList);

    // Build markdown context
    let md = "# Memory Context\n\n";

    if (sessions.length > 0) {
      md += "## Recent Sessions\n\n";
      for (const s of sessions) {
        md += `### ${s.request || "Untitled session"}\n`;
        if (s.project) md += `**Project:** ${s.project}\n`;
        if (s.investigated) md += `**Investigated:** ${s.investigated}\n`;
        if (s.learned) md += `**Learned:** ${s.learned}\n`;
        if (s.completed) md += `**Completed:** ${s.completed}\n`;
        if (s.next_steps) md += `**Next steps:** ${s.next_steps}\n`;
        md += "\n";
      }
    }

    if (observations.length > 0) {
      md += "## Recent Observations\n\n";
      for (const o of observations) {
        const icon = TYPE_ICONS[o.type] || "\u{1F7E2}";
        md += `- ${icon} **${o.title || "Untitled"}**`;
        if (o.project) md += ` (${o.project})`;
        md += "\n";
        if (o.narrative) {
          md += `  ${o.narrative.slice(0, 200)}\n`;
        }
      }
    }

    res.json({
      context: md,
      observations_count: observations.length,
      sessions_count: sessions.length,
    });
  });
}

module.exports = contextRoutes;
