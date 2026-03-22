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
});
