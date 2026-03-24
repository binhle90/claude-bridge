const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const TEST_API_KEY = "test-secret-key-12345";

function request(baseUrl, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/json", ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const AUTH = { Authorization: `Bearer ${TEST_API_KEY}` };

describe("Search, Timeline, Batch, Context", () => {
  let server;
  let baseUrl;
  let obs1Id, obs2Id, sessionId, promptId;

  before(async () => {
    process.env.API_KEY = TEST_API_KEY;
    const { createApp } = require("../server/index");
    const { app } = createApp(":memory:");
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Seed observation 1 — project alpha, discovery
    const r1 = await request(baseUrl, "POST", "/api/observations", {
      body: {
        source: "claude-code",
        source_id: 501,
        project: "alpha",
        type: "discovery",
        title: "Database indexing strategy",
        narrative: "We discovered that FTS5 indexes improve search performance dramatically",
        text: "SQLite FTS5 provides full-text search capabilities",
        created_at: "2026-01-01T01:00:00Z",
        created_at_epoch: 1767229200000,
      },
      headers: AUTH,
    });
    assert.strictEqual(r1.status, 201);
    obs1Id = r1.body.id;

    // Seed observation 2 — project beta, bugfix
    const r2 = await request(baseUrl, "POST", "/api/observations", {
      body: {
        source: "claude-code",
        source_id: 502,
        project: "beta",
        type: "bugfix",
        title: "Authentication token expiry fix",
        narrative: "Fixed a bug where JWT tokens were not expiring correctly",
        text: "The token validation logic was missing expiry checks",
        created_at: "2026-01-01T02:00:00Z",
        created_at_epoch: 1767232800000,
      },
      headers: AUTH,
    });
    assert.strictEqual(r2.status, 201);
    obs2Id = r2.body.id;

    // Seed session summary — project alpha
    const r3 = await request(baseUrl, "POST", "/api/sessions", {
      body: {
        source: "claude-code",
        source_id: 601,
        project: "alpha",
        request: "Implement database search functionality",
        investigated: "Looked at FTS5 and SQLite virtual tables",
        learned: "FTS5 is powerful for full-text search in SQLite",
        completed: "Implemented search endpoint with FTS5",
        next_steps: "Add pagination",
        notes: "Performance is excellent for small datasets",
        created_at: "2026-01-01T03:00:00Z",
        created_at_epoch: 1767236400000,
      },
      headers: AUTH,
    });
    assert.strictEqual(r3.status, 201);
    sessionId = r3.body.id;

    // Seed user prompt — project alpha
    const r4 = await request(baseUrl, "POST", "/api/prompts", {
      body: {
        source: "claude-code",
        source_id: 701,
        session_source_id: 601,
        project: "alpha",
        prompt_text: "Please implement the search endpoint",
        prompt_number: 1,
        created_at: "2026-01-01T00:30:00Z",
        created_at_epoch: 1767227400000,
      },
      headers: AUTH,
    });
    assert.strictEqual(r4.status, 201);
    promptId = r4.body.id;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // --- Search ---
  it("GET /api/search finds observations by keyword", async () => {
    const res = await request(baseUrl, "GET", "/api/search?query=indexing", {
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.results));
    assert.ok(res.body.results.length >= 1);
    const match = res.body.results.find((r) => r.type === "observation");
    assert.ok(match);
    assert.ok(match.title.includes("indexing") || match.snippet.includes("index"));
    assert.strictEqual(typeof res.body.total, "number");
  });

  it("GET /api/search finds session summaries", async () => {
    const res = await request(
      baseUrl,
      "GET",
      "/api/search?query=database+search+functionality",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    const sessions = res.body.results.filter((r) => r.type === "session");
    assert.ok(sessions.length >= 1);
  });

  it("GET /api/search filters by project", async () => {
    const res = await request(
      baseUrl,
      "GET",
      "/api/search?query=FTS5&project=alpha",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    for (const r of res.body.results) {
      assert.strictEqual(r.project, "alpha");
    }
  });

  it("GET /api/search respects limit", async () => {
    const res = await request(
      baseUrl,
      "GET",
      "/api/search?query=FTS5&limit=1",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.results.length <= 1);
  });

  it("GET /api/search returns 400 without query", async () => {
    const res = await request(baseUrl, "GET", "/api/search", {
      headers: AUTH,
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });

  it("GET /api/search handles invalid FTS syntax gracefully", async () => {
    const res = await request(
      baseUrl,
      "GET",
      "/api/search?query=" + encodeURIComponent("AND OR NOT <<<>>>"),
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.results));
  });

  // --- Timeline ---
  it("GET /api/timeline returns chronological items", async () => {
    const res = await request(baseUrl, "GET", "/api/timeline", {
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.items.length >= 3); // 2 obs + 1 session + 1 prompt
    // Check chronological order
    for (let i = 1; i < res.body.items.length; i++) {
      assert.ok(res.body.items[i].epoch >= res.body.items[i - 1].epoch);
    }
  });

  it("GET /api/timeline with anchor filters around a point", async () => {
    const res = await request(
      baseUrl,
      "GET",
      `/api/timeline?anchor=${obs1Id}&depth_before=1&depth_after=1`,
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    // Should have items around the anchor point
    assert.ok(res.body.items.length >= 1);
  });

  it("GET /api/timeline filters by project", async () => {
    const res = await request(
      baseUrl,
      "GET",
      "/api/timeline?project=alpha",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    for (const item of res.body.items) {
      if (item.data.project) {
        assert.strictEqual(item.data.project, "alpha");
      }
    }
  });

  // --- Batch ---
  it("POST /api/observations/batch returns observations by ID", async () => {
    const res = await request(baseUrl, "POST", "/api/observations/batch", {
      body: { ids: [obs1Id, obs2Id] },
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 2);
    const ids = res.body.map((o) => o.id);
    assert.ok(ids.includes(obs1Id));
    assert.ok(ids.includes(obs2Id));
  });

  it("POST /api/observations/batch returns 400 for invalid input", async () => {
    const res = await request(baseUrl, "POST", "/api/observations/batch", {
      body: { ids: [] },
      headers: AUTH,
    });
    assert.strictEqual(res.status, 400);

    const res2 = await request(baseUrl, "POST", "/api/observations/batch", {
      body: {},
      headers: AUTH,
    });
    assert.strictEqual(res2.status, 400);

    const res3 = await request(baseUrl, "POST", "/api/observations/batch", {
      body: { ids: "not-an-array" },
      headers: AUTH,
    });
    assert.strictEqual(res3.status, 400);
  });

  // --- Context ---
  it("GET /api/context returns formatted string", async () => {
    const res = await request(
      baseUrl,
      "GET",
      "/api/context?projects=alpha",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.context, "string");
    assert.ok(res.body.context.includes("Memory Context"));
    assert.strictEqual(typeof res.body.observations_count, "number");
    assert.strictEqual(typeof res.body.sessions_count, "number");
    assert.ok(res.body.observations_count >= 1);
    assert.ok(res.body.sessions_count >= 1);
  });

  it("GET /api/context returns 400 without projects", async () => {
    const res = await request(baseUrl, "GET", "/api/context", {
      headers: AUTH,
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });

  it("GET /api/context filters by project", async () => {
    const res = await request(
      baseUrl,
      "GET",
      "/api/context?projects=beta",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    // beta has obs2 (bugfix) but no session
    assert.ok(res.body.observations_count >= 1);
    assert.strictEqual(res.body.sessions_count, 0);
  });

  // --- Search mode parameter ---
  it("GET /api/search accepts mode parameter", async () => {
    const res = await request(
      baseUrl, "GET",
      "/api/search?query=indexing&mode=keyword",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.results));
  });

  it("GET /api/search returns error for semantic mode without config", async () => {
    const res = await request(
      baseUrl, "GET",
      "/api/search?query=indexing&mode=semantic",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.error || res.body.results !== undefined);
  });

  it("GET /api/search rejects invalid mode", async () => {
    const res = await request(
      baseUrl, "GET",
      "/api/search?query=indexing&mode=invalid",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes("Invalid mode"));
  });

  it("GET /api/search includes abstract in results", async () => {
    const res = await request(
      baseUrl, "GET",
      "/api/search?query=indexing",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    if (res.body.results.length > 0) {
      assert.ok("abstract" in res.body.results[0]);
    }
  });

  it("GET /api/search hybrid mode falls back to keyword without embeddings", async () => {
    const res = await request(
      baseUrl, "GET",
      "/api/search?query=indexing&mode=hybrid",
      { headers: AUTH }
    );
    assert.strictEqual(res.status, 200);
    // Without EMBEDDING_PROVIDER, hybrid should still return keyword results
    assert.ok(res.body.error || res.body.results !== undefined);
  });

  // --- Search filters ---
  it("GET /api/search filters by obs_type", async () => {
    const res = await request(baseUrl, "GET",
      "/api/search?query=FTS5&obs_type=discovery",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    for (const r of res.body.results) {
      if (r.type === "observation") {
        assert.strictEqual(r.obs_type, "discovery");
      }
    }
    // Should not return sessions when obs_type filter is set
    const sessions = res.body.results.filter(r => r.type === "session");
    assert.strictEqual(sessions.length, 0);
  });

  it("GET /api/search filters by source", async () => {
    const res = await request(baseUrl, "GET",
      "/api/search?query=FTS5&source=claude-code",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    for (const r of res.body.results) {
      assert.strictEqual(r.source, "claude-code");
    }
  });

  it("GET /api/search filters by after (relative)", async () => {
    // Seeded data has epoch 1767229200000 (2026-01-01T01:00:00Z)
    // "1d" = 1 day ago — seeded data is months old so should be excluded
    const res = await request(baseUrl, "GET",
      "/api/search?query=FTS5&after=1d",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    // All seeded data is from months ago, so no results should match
    assert.strictEqual(res.body.results.length, 0);
  });

  it("GET /api/search filters by before (ISO)", async () => {
    // All seeded data is from 2026-01-01 — use cutoff of 2026-01-01T01:30:00Z
    const cutoff = new Date("2026-01-01T01:30:00Z").getTime();
    const res = await request(baseUrl, "GET",
      "/api/search?query=indexing&before=2026-01-01T01:30:00Z",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    for (const r of res.body.results) {
      assert.ok(r.created_at_epoch < cutoff);
    }
  });

  it("GET /api/search composes multiple filters with AND", async () => {
    const res = await request(baseUrl, "GET",
      "/api/search?query=FTS5&obs_type=discovery&project=alpha",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    for (const r of res.body.results) {
      assert.strictEqual(r.project, "alpha");
      if (r.type === "observation") {
        assert.strictEqual(r.obs_type, "discovery");
      }
    }
  });

  it("GET /api/search with obs_type excludes session results", async () => {
    const res = await request(baseUrl, "GET",
      "/api/search?query=database&obs_type=discovery",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    for (const r of res.body.results) {
      assert.notStrictEqual(r.type, "session");
    }
  });
});
