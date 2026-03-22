const { getDiskFreeMb } = require("../db");

function healthRoutes(router, db, dbPath) {
  router.get("/api/health", (req, res) => {
    const count = db.prepare("SELECT COUNT(*) as c FROM observations").get().c;
    res.json({
      status: "ok",
      version: "1.0.0",
      observations_count: count,
      disk_free_mb: getDiskFreeMb(dbPath),
    });
  });
}

module.exports = healthRoutes;
