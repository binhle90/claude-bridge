const Database = require("better-sqlite3");
const { statfsSync } = require("fs");
const { dirname } = require("path");

function createDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = db.prepare("SELECT version FROM schema_version").get();
  let version = row ? row.version : 0;

  const migrations = [
    // v1: initial schema
    (db) => {
      db.exec(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          source_id INTEGER,
          session_source_id INTEGER,
          project TEXT,
          type TEXT,
          title TEXT,
          subtitle TEXT,
          text TEXT,
          narrative TEXT,
          facts TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          created_at TEXT,
          created_at_epoch INTEGER
        );
        CREATE UNIQUE INDEX idx_obs_source_dedup ON observations(source, source_id) WHERE source_id IS NOT NULL;

        CREATE TABLE session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          source_id INTEGER,
          project TEXT,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read TEXT,
          files_edited TEXT,
          notes TEXT,
          created_at TEXT,
          created_at_epoch INTEGER
        );
        CREATE UNIQUE INDEX idx_ss_source_dedup ON session_summaries(source, source_id) WHERE source_id IS NOT NULL;

        CREATE TABLE user_prompts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          source_id INTEGER,
          session_source_id INTEGER,
          project TEXT,
          prompt_text TEXT,
          prompt_number INTEGER,
          created_at TEXT,
          created_at_epoch INTEGER
        );
        CREATE UNIQUE INDEX idx_up_source_dedup ON user_prompts(source, source_id) WHERE source_id IS NOT NULL;

        CREATE VIRTUAL TABLE observations_fts USING fts5(
          title, subtitle, text, narrative, facts, concepts,
          content='observations', content_rowid='id'
        );

        CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
          request, investigated, learned, completed, next_steps, notes,
          content='session_summaries', content_rowid='id'
        );
      `);
    },

    // v2: embedding vector tables
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS observation_embeddings (
          observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          embedded_text_hash TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS session_embeddings (
          session_id INTEGER PRIMARY KEY REFERENCES session_summaries(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          embedded_text_hash TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
    },

    // v3: abstract column + FTS5 rebuild
    (db) => {
      db.exec(`ALTER TABLE observations ADD COLUMN abstract TEXT`);
      db.exec(`ALTER TABLE session_summaries ADD COLUMN abstract TEXT`);

      db.exec(`DROP TABLE IF EXISTS observations_fts`);
      db.exec(`
        CREATE VIRTUAL TABLE observations_fts USING fts5(
          title, subtitle, text, narrative, facts, concepts, abstract,
          content='observations', content_rowid='id'
        )
      `);
      db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);

      db.exec(`DROP TABLE IF EXISTS session_summaries_fts`);
      db.exec(`
        CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
          request, investigated, learned, completed, next_steps, notes, abstract,
          content='session_summaries', content_rowid='id'
        )
      `);
      db.exec(`INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild')`);
    },
  ];

  for (let i = version; i < migrations.length; i++) {
    migrations[i](db);
    if (version === 0 && i === 0) {
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i + 1);
    } else {
      db.prepare("UPDATE schema_version SET version = ?").run(i + 1);
    }
  }
}

function getDiskFreeMb(dbPath) {
  try {
    const stats = statfsSync(dirname(dbPath));
    return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    return -1;
  }
}

module.exports = { createDb, getDiskFreeMb };
