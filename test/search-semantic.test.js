const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("Semantic Search", () => {
  it("cosineSimilarity returns 1.0 for identical vectors", () => {
    const { cosineSimilarity } = require("../server/search-semantic");
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1.0) < 0.0001);
  });

  it("cosineSimilarity returns 0 for orthogonal vectors", () => {
    const { cosineSimilarity } = require("../server/search-semantic");
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.0001);
  });

  it("cosineSimilarity returns -1 for opposite vectors", () => {
    const { cosineSimilarity } = require("../server/search-semantic");
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    assert.ok(Math.abs(cosineSimilarity(a, b) + 1.0) < 0.0001);
  });

  it("mergeRRF merges two ranked lists by reciprocal rank", () => {
    const { mergeRRF } = require("../server/search-semantic");
    const fts = [
      { id: 1, type: "observation", title: "A" },
      { id: 2, type: "observation", title: "B" },
      { id: 3, type: "observation", title: "C" },
    ];
    const sem = [
      { id: 3, type: "observation", title: "C" },
      { id: 1, type: "observation", title: "A" },
      { id: 4, type: "observation", title: "D" },
    ];
    const merged = mergeRRF(fts, sem);
    const ids = merged.map((r) => r.id);
    assert.ok(ids.includes(1));
    assert.ok(ids.includes(3));
    assert.ok(ids.length === 4);
    const idxOf1 = ids.indexOf(1);
    const idxOf4 = ids.indexOf(4);
    assert.ok(idxOf1 < idxOf4, "Item in both lists should rank higher");
  });

  it("mergeRRF handles empty lists", () => {
    const { mergeRRF } = require("../server/search-semantic");
    assert.deepStrictEqual(mergeRRF([], []), []);
    const items = [{ id: 1, type: "observation", title: "A" }];
    const merged = mergeRRF(items, []);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].id, 1);
  });

  it("semanticSearch requires embedding provider", async () => {
    const { createDb } = require("../server/db");
    const { NoopEmbeddings } = require("../server/embeddings");
    const { semanticSearch } = require("../server/search-semantic");
    const db = createDb(":memory:");
    const provider = new NoopEmbeddings();
    await assert.rejects(
      () => semanticSearch(db, provider, "test query"),
      /not configured/
    );
    db.close();
  });

  it("semanticSearch accepts filter options without error", async () => {
    const { createDb } = require("../server/db");
    const { semanticSearch } = require("../server/search-semantic");
    const db = createDb(":memory:");

    const mockProvider = {
      embed: async () => [new Float32Array([1, 0, 0])],
    };

    db.prepare(`
      INSERT INTO observations (source, source_id, project, type, title, narrative, created_at, created_at_epoch)
      VALUES ('claude-code', 1, 'test', 'decision', 'Test decision', 'We decided on X', datetime('now'), ?)
    `).run(Date.now());

    const obsId = db.prepare("SELECT id FROM observations WHERE source_id = 1").get().id;

    const vec = new Float32Array([0.5, 0.5, 0.5]);
    const buf = Buffer.from(vec.buffer);
    db.prepare(`
      INSERT INTO observation_embeddings (observation_id, embedding, model, dimensions, embedded_text_hash)
      VALUES (?, ?, 'test-model', 3, 'hash1')
    `).run(obsId, buf);

    const results = await semanticSearch(db, mockProvider, "test", {
      limit: 10,
      filters: { obs_type: "decision" },
    });

    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].obs_type, "decision");

    db.close();
  });

  it("semanticSearch filters out non-matching obs_type", async () => {
    const { createDb } = require("../server/db");
    const { semanticSearch } = require("../server/search-semantic");
    const db = createDb(":memory:");

    const mockProvider = {
      embed: async () => [new Float32Array([1, 0, 0])],
    };

    db.prepare(`
      INSERT INTO observations (source, source_id, project, type, title, narrative, created_at, created_at_epoch)
      VALUES ('claude-code', 2, 'test', 'discovery', 'Test discovery', 'Found something', datetime('now'), ?)
    `).run(Date.now());

    const obsId = db.prepare("SELECT id FROM observations WHERE source_id = 2").get().id;
    const vec = new Float32Array([0.5, 0.5, 0.5]);
    const buf = Buffer.from(vec.buffer);
    db.prepare(`
      INSERT INTO observation_embeddings (observation_id, embedding, model, dimensions, embedded_text_hash)
      VALUES (?, ?, 'test-model', 3, 'hash2')
    `).run(obsId, buf);

    const results = await semanticSearch(db, mockProvider, "test", {
      limit: 10,
      filters: { obs_type: "decision" },
    });

    assert.strictEqual(results.length, 0);
    db.close();
  });

  it("semanticSearch skips sessions when obs_type filter is set", async () => {
    const { createDb } = require("../server/db");
    const { semanticSearch } = require("../server/search-semantic");
    const db = createDb(":memory:");

    const mockProvider = {
      embed: async () => [new Float32Array([1, 0, 0])],
    };

    db.prepare(`
      INSERT INTO session_summaries (source, source_id, project, request, created_at, created_at_epoch)
      VALUES ('claude-code', 3, 'test', 'Test session', datetime('now'), ?)
    `).run(Date.now());

    const sessionId = db.prepare("SELECT id FROM session_summaries WHERE source_id = 3").get().id;
    const vec = new Float32Array([0.9, 0.1, 0.0]);
    const buf = Buffer.from(vec.buffer);
    db.prepare(`
      INSERT INTO session_embeddings (session_id, embedding, model, dimensions, embedded_text_hash)
      VALUES (?, ?, 'test-model', 3, 'hash3')
    `).run(sessionId, buf);

    const results = await semanticSearch(db, mockProvider, "test", {
      limit: 10,
      filters: { obs_type: "decision" },
    });

    const sessions = results.filter(r => r.type === "session");
    assert.strictEqual(sessions.length, 0);
    db.close();
  });
});
