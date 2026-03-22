const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("Enrichment Worker", () => {
  it("enqueue adds IDs to queue", () => {
    const { EnrichmentWorker } = require("../server/enrichment-worker");
    const worker = new EnrichmentWorker({});
    worker.enqueueObservation(42);
    worker.enqueueObservation(43);
    worker.enqueueSession(10);
    assert.deepStrictEqual(worker.pendingObservations(), [42, 43]);
    assert.deepStrictEqual(worker.pendingSessions(), [10]);
  });

  it("enqueue deduplicates IDs", () => {
    const { EnrichmentWorker } = require("../server/enrichment-worker");
    const worker = new EnrichmentWorker({});
    worker.enqueueObservation(42);
    worker.enqueueObservation(42);
    assert.deepStrictEqual(worker.pendingObservations(), [42]);
  });

  it("processOneBatch processes observation embeddings", async () => {
    const { createDb } = require("../server/db");
    const { NoopEmbeddings } = require("../server/embeddings");
    const { NoopAbstractGenerator } = require("../server/abstracts");
    const { EnrichmentWorker } = require("../server/enrichment-worker");

    const db = createDb(":memory:");
    db.prepare(`INSERT INTO observations (id, source, title, narrative, created_at_epoch) VALUES (1, 'test', 'Test', 'A narrative', 1000)`).run();

    const worker = new EnrichmentWorker({
      db,
      embeddingProvider: new NoopEmbeddings(),
      abstractGenerator: new NoopAbstractGenerator(),
    });
    worker.enqueueObservation(1);

    await worker.processOneBatch();

    const embRow = db.prepare("SELECT * FROM observation_embeddings WHERE observation_id = 1").get();
    assert.strictEqual(embRow, undefined);

    const obs = db.prepare("SELECT abstract FROM observations WHERE id = 1").get();
    assert.strictEqual(obs.abstract, null);

    assert.deepStrictEqual(worker.pendingObservations(), []);

    db.close();
  });

  it("processOneBatch processes session embeddings", async () => {
    const { createDb } = require("../server/db");
    const { NoopEmbeddings } = require("../server/embeddings");
    const { NoopAbstractGenerator } = require("../server/abstracts");
    const { EnrichmentWorker } = require("../server/enrichment-worker");

    const db = createDb(":memory:");
    db.prepare(`INSERT INTO session_summaries (id, source, request, learned, completed, created_at_epoch) VALUES (1, 'test', 'Build search', 'FTS5 works', 'Implemented', 1000)`).run();

    const worker = new EnrichmentWorker({
      db,
      embeddingProvider: new NoopEmbeddings(),
      abstractGenerator: new NoopAbstractGenerator(),
    });
    worker.enqueueSession(1);

    await worker.processOneBatch();

    const embRow = db.prepare("SELECT * FROM session_embeddings WHERE session_id = 1").get();
    assert.strictEqual(embRow, undefined);

    assert.deepStrictEqual(worker.pendingSessions(), []);

    db.close();
  });
});
