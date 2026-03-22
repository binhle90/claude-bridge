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
      path: url.pathname,
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

describe("API", () => {
  let server;
  let baseUrl;

  before(async () => {
    process.env.API_KEY = TEST_API_KEY;
    const { createApp } = require("../server/index");
    const { app } = createApp(":memory:");
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // --- Health ---
  it("health returns 200 without auth", async () => {
    const res = await request(baseUrl, "GET", "/api/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "ok");
    assert.strictEqual(res.body.version, "1.0.0");
    assert.strictEqual(typeof res.body.observations_count, "number");
  });

  // --- Auth ---
  it("rejects requests without API key", async () => {
    const res = await request(baseUrl, "POST", "/api/observations", {
      body: { source: "test" },
    });
    assert.strictEqual(res.status, 401);
    assert.ok(res.body.error);
  });

  it("rejects wrong API key", async () => {
    const res = await request(baseUrl, "POST", "/api/observations", {
      body: { source: "test" },
      headers: { Authorization: "Bearer wrong-key" },
    });
    assert.strictEqual(res.status, 401);
    assert.ok(res.body.error);
  });

  it("accepts correct API key", async () => {
    const res = await request(baseUrl, "POST", "/api/observations", {
      body: {
        source: "test",
        source_id: 9999,
        title: "Auth test",
        narrative: "Testing auth works",
      },
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
  });

  // --- Observations ---
  it("POST /api/observations creates observation", async () => {
    const res = await request(baseUrl, "POST", "/api/observations", {
      body: {
        source: "claude-code",
        source_id: 1,
        project: "my-project",
        type: "discovery",
        title: "Test observation",
        subtitle: "A subtitle",
        text: "Some text",
        narrative: "A narrative about testing",
        facts: "fact1, fact2",
        concepts: "concept1",
        prompt_number: 1,
        created_at: "2026-01-01T00:00:00Z",
        created_at_epoch: 1767225600000,
      },
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(typeof res.body.id, "number");
  });

  it("POST /api/observations returns 409 on duplicate", async () => {
    const obs = {
      source: "claude-code",
      source_id: 100,
      title: "Dupe test",
      narrative: "Testing dedup",
    };
    const headers = { Authorization: `Bearer ${TEST_API_KEY}` };
    const res1 = await request(baseUrl, "POST", "/api/observations", {
      body: obs,
      headers,
    });
    assert.strictEqual(res1.status, 201);

    const res2 = await request(baseUrl, "POST", "/api/observations", {
      body: obs,
      headers,
    });
    assert.strictEqual(res2.status, 409);
  });

  // --- Sessions ---
  it("POST /api/sessions creates session summary", async () => {
    const res = await request(baseUrl, "POST", "/api/sessions", {
      body: {
        source: "claude-code",
        source_id: 1,
        project: "my-project",
        request: "Fix auth bug",
        investigated: "Looked at JWT handling",
        learned: "Tokens expire correctly",
        completed: "Fixed the bug",
        next_steps: "Deploy",
        notes: "All good",
        created_at: "2026-01-01T00:00:00Z",
        created_at_epoch: 1767225600000,
      },
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(typeof res.body.id, "number");
  });

  // --- Prompts ---
  it("POST /api/prompts creates user prompt", async () => {
    const res = await request(baseUrl, "POST", "/api/prompts", {
      body: {
        source: "claude-code",
        source_id: 1,
        session_source_id: 1,
        project: "my-project",
        prompt_text: "Implement the auth middleware",
        prompt_number: 1,
        created_at: "2026-01-01T00:00:00Z",
        created_at_epoch: 1767225600000,
      },
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(typeof res.body.id, "number");
  });
});
