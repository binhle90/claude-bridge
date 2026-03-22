const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { createDb } = require("../server/db");

describe("Database", () => {
  let db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes("observations"));
    assert.ok(tables.includes("session_summaries"));
    assert.ok(tables.includes("user_prompts"));
    assert.ok(tables.includes("schema_version"));
  });

  it("creates FTS5 virtual tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(tables.some((t) => t.startsWith("observations_fts")));
    assert.ok(tables.some((t) => t.startsWith("session_summaries_fts")));
  });

  it("inserts and deduplicates observations", () => {
    const insert = db.prepare(`
      INSERT INTO observations (source, source_id, project, type, title, narrative, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("claude-code", 1, "test", "discovery", "Test obs", "A narrative", "2026-01-01T00:00:00Z", 1767225600000);

    // Duplicate should fail with UNIQUE constraint
    assert.throws(() => {
      insert.run("claude-code", 1, "test", "discovery", "Dupe", "Dupe narrative", "2026-01-01T00:00:00Z", 1767225600000);
    });

    // Different source_id should succeed
    insert.run("claude-code", 2, "test", "discovery", "Second", "Another narrative", "2026-01-01T00:00:00Z", 1767225600000);
    const count = db.prepare("SELECT COUNT(*) as c FROM observations").get().c;
    assert.strictEqual(count, 2);
  });

  it("FTS5 search works on observations", () => {
    db.prepare(`
      INSERT INTO observations (source, source_id, project, type, title, narrative, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("claude-code", 1, "test", "discovery", "Auth middleware rewrite", "Rewrote the authentication middleware", "2026-01-01T00:00:00Z", 1767225600000);

    // Trigger FTS sync (includes abstract column added in v3)
    db.prepare(`
      INSERT INTO observations_fts (rowid, title, subtitle, text, narrative, facts, concepts, abstract)
      SELECT id, title, subtitle, text, narrative, facts, concepts, abstract FROM observations WHERE id = last_insert_rowid()
    `).run();

    const results = db.prepare(`
      SELECT o.* FROM observations_fts fts
      JOIN observations o ON o.id = fts.rowid
      WHERE observations_fts MATCH 'authentication'
    `).all();
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].title, "Auth middleware rewrite");
  });

  it("FTS5 search works on session_summaries", () => {
    db.prepare(`
      INSERT INTO session_summaries (source, source_id, project, request, learned, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("claude-code", 1, "test", "Fix auth bug", "JWT tokens expire correctly", "2026-01-01T00:00:00Z", 1767225600000);

    db.prepare(`
      INSERT INTO session_summaries_fts (rowid, request, investigated, learned, completed, next_steps, notes, abstract)
      SELECT id, request, investigated, learned, completed, next_steps, notes, abstract FROM session_summaries WHERE id = last_insert_rowid()
    `).run();

    const results = db.prepare(`
      SELECT ss.* FROM session_summaries_fts fts
      JOIN session_summaries ss ON ss.id = fts.rowid
      WHERE session_summaries_fts MATCH 'JWT'
    `).all();
    assert.strictEqual(results.length, 1);
  });

  it("migration creates observation_embeddings table", () => {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observation_embeddings'"
    ).get();
    assert.ok(table, "observation_embeddings table should exist");
    const cols = db.prepare("PRAGMA table_info(observation_embeddings)").all();
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes("observation_id"));
    assert.ok(colNames.includes("embedding"));
    assert.ok(colNames.includes("model"));
    assert.ok(colNames.includes("dimensions"));
    assert.ok(colNames.includes("embedded_text_hash"));
  });

  it("migration creates session_embeddings table", () => {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_embeddings'"
    ).get();
    assert.ok(table, "session_embeddings table should exist");
  });

  it("migration adds abstract column to observations", () => {
    const cols = db.prepare("PRAGMA table_info(observations)").all();
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes("abstract"), "observations should have abstract column");
  });

  it("migration adds abstract column to session_summaries", () => {
    const cols = db.prepare("PRAGMA table_info(session_summaries)").all();
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes("abstract"), "session_summaries should have abstract column");
  });

  it("FTS5 index includes abstract column", () => {
    db.prepare(`INSERT INTO observations (source, title, abstract, created_at_epoch) VALUES ('test', 'Test Title', 'This is a test abstract about deployment', 1000)`).run();
    db.prepare(`INSERT INTO observations_fts (rowid, title, subtitle, text, narrative, facts, concepts, abstract) SELECT id, title, subtitle, text, narrative, facts, concepts, abstract FROM observations WHERE id = last_insert_rowid()`).run();
    const rows = db.prepare("SELECT * FROM observations_fts WHERE observations_fts MATCH 'deployment'").all();
    assert.ok(rows.length >= 1, "FTS5 should find content from abstract column");
  });
});
