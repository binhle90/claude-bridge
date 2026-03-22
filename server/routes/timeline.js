function timelineRoutes(router, db) {
  router.get("/api/timeline", (req, res) => {
    const depthBefore = parseInt(req.query.depth_before) || 10;
    const depthAfter = parseInt(req.query.depth_after) || 10;
    const { project, anchor, query } = req.query;

    // Collect all items
    const items = [];

    // Observations
    let obsSql = "SELECT * FROM observations";
    const obsParams = [];
    if (project) {
      obsSql += " WHERE project = ?";
      obsParams.push(project);
    }
    const observations = db.prepare(obsSql).all(...obsParams);
    for (const o of observations) {
      items.push({
        type: "observation",
        data: o,
        epoch: o.created_at_epoch || 0,
      });
    }

    // Session summaries
    let ssSql = "SELECT * FROM session_summaries";
    const ssParams = [];
    if (project) {
      ssSql += " WHERE project = ?";
      ssParams.push(project);
    }
    const sessions = db.prepare(ssSql).all(...ssParams);
    for (const s of sessions) {
      items.push({
        type: "session",
        data: s,
        epoch: s.created_at_epoch || 0,
      });
    }

    // User prompts
    let upSql = "SELECT * FROM user_prompts";
    const upParams = [];
    if (project) {
      upSql += " WHERE project = ?";
      upParams.push(project);
    }
    const prompts = db.prepare(upSql).all(...upParams);
    for (const p of prompts) {
      items.push({
        type: "prompt",
        data: p,
        epoch: p.created_at_epoch || 0,
      });
    }

    // Sort chronologically
    items.sort((a, b) => a.epoch - b.epoch);

    // Determine anchor index
    let anchorIdx = -1;

    if (anchor) {
      // anchor can be: observation ID (number), "S{id}" for session, or ISO timestamp
      if (/^S\d+$/i.test(anchor)) {
        const sessionId = parseInt(anchor.slice(1));
        anchorIdx = items.findIndex(
          (i) => i.type === "session" && i.data.id === sessionId
        );
      } else if (/^\d+$/.test(anchor)) {
        const obsId = parseInt(anchor);
        anchorIdx = items.findIndex(
          (i) => i.type === "observation" && i.data.id === obsId
        );
      } else {
        // ISO timestamp — find closest item
        const ts = new Date(anchor).getTime();
        if (!isNaN(ts)) {
          let minDist = Infinity;
          items.forEach((item, idx) => {
            const dist = Math.abs(item.epoch - ts);
            if (dist < minDist) {
              minDist = dist;
              anchorIdx = idx;
            }
          });
        }
      }
    } else if (query) {
      // Use FTS to find best match as anchor
      try {
        const obsMatch = db
          .prepare(
            `SELECT o.id FROM observations_fts fts
             JOIN observations o ON o.id = fts.rowid
             WHERE observations_fts MATCH ?
             LIMIT 1`
          )
          .get(query);
        if (obsMatch) {
          anchorIdx = items.findIndex(
            (i) => i.type === "observation" && i.data.id === obsMatch.id
          );
        }
      } catch {
        // Invalid FTS query
      }
    }

    let result;
    if (anchorIdx >= 0) {
      const start = Math.max(0, anchorIdx - depthBefore);
      const end = Math.min(items.length, anchorIdx + depthAfter + 1);
      result = items.slice(start, end);
    } else {
      // No anchor — return last N items
      const total = depthBefore + depthAfter;
      result = items.slice(-total);
    }

    res.json({ items: result });
  });
}

module.exports = timelineRoutes;
