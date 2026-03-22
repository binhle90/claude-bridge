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
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const AUTH = { Authorization: `Bearer ${TEST_API_KEY}` };

describe("Admin Backfill", () => {
  let server, baseUrl;

  before(async () => {
    process.env.API_KEY = TEST_API_KEY;
    const { createApp } = require("../server/index");
    const { app } = createApp(":memory:");
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it("POST /api/admin/backfill returns status", async () => {
    const res = await request(baseUrl, "POST", "/api/admin/backfill", { headers: AUTH });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.observations_queued, "number");
    assert.strictEqual(typeof res.body.sessions_queued, "number");
  });

  it("POST /api/admin/backfill requires auth", async () => {
    const res = await request(baseUrl, "POST", "/api/admin/backfill", {});
    assert.strictEqual(res.status, 401);
  });
});
