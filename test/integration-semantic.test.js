const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const TEST_API_KEY = "test-secret-key-12345";

// Mock embedding provider that returns deterministic vectors
class MockEmbeddings {
  constructor() {
    this.model = "mock";
    this.callCount = 0;
  }

  async embed(texts) {
    this.callCount++;
    return texts.map((text) => {
      const vec = new Float32Array(4);
      for (let i = 0; i < text.length && i < 4; i++) {
        vec[i] = text.charCodeAt(i) / 255;
      }
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    });
  }
}

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

describe("Semantic Search Integration", () => {
  let server, baseUrl, mockEmb;

  before(async () => {
    process.env.API_KEY = TEST_API_KEY;
    // Do NOT set EMBEDDING_PROVIDER — app starts with NoopEmbeddings,
    // then we swap in the mock. Avoids creating a broken OpenAIEmbeddings.
    const { createApp } = require("../server/index");
    const { app, enrichmentWorker } = createApp(":memory:");

    // Replace noop with mock embeddings
    mockEmb = new MockEmbeddings();
    app.locals.embeddingProvider = mockEmb;
    enrichmentWorker.embeddingProvider = mockEmb;

    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Seed data
    await request(baseUrl, "POST", "/api/observations", {
      body: {
        source: "test", source_id: 1, project: "alpha",
        type: "discovery", title: "OAuth PKCE authentication flow",
        narrative: "We implemented OAuth 2.1 with PKCE for browser security",
        created_at_epoch: 1000,
      },
      headers: AUTH,
    });

    await request(baseUrl, "POST", "/api/observations", {
      body: {
        source: "test", source_id: 2, project: "alpha",
        type: "bugfix", title: "Docker container memory limit fix",
        narrative: "Fixed OOM crashes by setting container memory limits",
        created_at_epoch: 2000,
      },
      headers: AUTH,
    });

    // Process enrichment queue to generate embeddings
    await enrichmentWorker.processOneBatch();
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it("semantic search returns results", async () => {
    const res = await request(baseUrl, "GET",
      "/api/search?query=OAuth+authentication&mode=semantic",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.results.length >= 1);
  });

  it("hybrid search returns results from both sources", async () => {
    const res = await request(baseUrl, "GET",
      "/api/search?query=OAuth&mode=hybrid",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.results.length >= 1);
  });

  it("keyword search still works as before", async () => {
    const res = await request(baseUrl, "GET",
      "/api/search?query=OAuth&mode=keyword",
      { headers: AUTH });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.results.length >= 1);
  });

  it("embeddings were created during write", () => {
    assert.ok(mockEmb.callCount >= 1, "Mock embeddings should have been called");
  });
});
