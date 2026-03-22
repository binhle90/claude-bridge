#!/usr/bin/env node
const Database = require("better-sqlite3");
const { join, relative, basename, dirname } = require("path");
const { homedir } = require("os");
const { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } = require("fs");
const { execSync } = require("child_process");
const { createHash } = require("crypto");

const HOME = homedir();
const DB_PATH = join(HOME, ".claude-mem", "claude-mem.db");
const STATE_PATH = join(HOME, ".claude-mem", "remote-sync-state.json");
const ENV_PATH = join(HOME, ".claude-mem", "remote-sync-env");
const POLL_INTERVAL_MS = 30_000;
const FILE_SYNC_INTERVAL_MS = 300_000; // 5 minutes for file sync
const BATCH_SIZE = 100;

// CLAUDE_MEM_SYNC_PROJECT_ROOT — absolute path to the project root directory
// whose .md files should be synced to the remote server.
// Example: /home/you/src/my-project
// This env var is REQUIRED for file sync to work.
const PROJECT_ROOT = process.env.CLAUDE_MEM_SYNC_PROJECT_ROOT;
if (!PROJECT_ROOT) {
  console.warn(
    "CLAUDE_MEM_SYNC_PROJECT_ROOT is not set. File sync will be disabled.\n" +
    "Set it to the absolute path of your project root, e.g.:\n" +
    "  export CLAUDE_MEM_SYNC_PROJECT_ROOT=/home/you/src/my-project"
  );
}

// Directories to exclude when searching for .md files
const EXCLUDE_PATTERNS = [
  "node_modules", ".next", ".git", ".terraform", ".claude/worktrees",
  "standalone", ".cache", "dist", "build",
];

function loadEnv() {
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^(?:export\s+)?(\w+)=(.*)$/);
      if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function loadState() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")); } catch {}
  }
  return { lastObservationId: 0, lastSessionSummaryId: 0, lastPromptId: 0 };
}

function saveState(state) {
  mkdirSync(join(HOME, ".claude-mem"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function post(url, apiKey, path, body) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 409) return { duplicate: true };
  if (!res.ok) throw new Error(`POST ${path} returned ${res.status}`);
  return res.json();
}

async function syncOnce() {
  const url = process.env.CLAUDE_MEM_REMOTE_URL;
  const apiKey = process.env.CLAUDE_MEM_REMOTE_API_KEY;
  if (!url || !apiKey) { console.error("Missing CLAUDE_MEM_REMOTE_URL or CLAUDE_MEM_REMOTE_API_KEY"); return; }
  if (!existsSync(DB_PATH)) { console.error(`claude-mem DB not found at ${DB_PATH}`); return; }

  const db = new Database(DB_PATH, { readonly: true });
  const state = loadState();
  let synced = 0;

  try {
    // Sync observations
    const obs = db.prepare(`
      SELECT o.*, ss.id as resolved_session_id
      FROM observations o
      LEFT JOIN session_summaries ss ON o.memory_session_id = ss.memory_session_id
      WHERE o.id > ? ORDER BY o.id ASC LIMIT ?
    `).all(state.lastObservationId, BATCH_SIZE);

    for (const o of obs) {
      try {
        await post(url, apiKey, "/api/observations", {
          source: "claude-code", source_id: o.id,
          session_source_id: o.resolved_session_id ?? null,
          project: o.project, type: o.type, title: o.title, subtitle: o.subtitle,
          text: o.text, narrative: o.narrative, facts: o.facts, concepts: o.concepts,
          files_read: o.files_read, files_modified: o.files_modified,
          prompt_number: o.prompt_number,
          created_at: o.created_at, created_at_epoch: o.created_at_epoch,
        });
        state.lastObservationId = o.id;
        synced++;
      } catch (err) { console.error(`Failed to sync observation ${o.id}: ${err.message}`); break; }
    }

    // Sync session summaries
    const sessions = db.prepare(`
      SELECT * FROM session_summaries WHERE id > ? ORDER BY id ASC LIMIT ?
    `).all(state.lastSessionSummaryId, BATCH_SIZE);

    for (const s of sessions) {
      try {
        await post(url, apiKey, "/api/sessions", {
          source: "claude-code", source_id: s.id, project: s.project,
          request: s.request, investigated: s.investigated, learned: s.learned,
          completed: s.completed, next_steps: s.next_steps,
          files_read: s.files_read, files_edited: s.files_edited, notes: s.notes,
          created_at: s.created_at, created_at_epoch: s.created_at_epoch,
        });
        state.lastSessionSummaryId = s.id;
        synced++;
      } catch (err) { console.error(`Failed to sync session ${s.id}: ${err.message}`); break; }
    }

    // Sync user prompts
    const prompts = db.prepare(`
      SELECT up.*, s.project, ss.id as resolved_session_id
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      LEFT JOIN session_summaries ss ON s.memory_session_id = ss.memory_session_id
      WHERE up.id > ? ORDER BY up.id ASC LIMIT ?
    `).all(state.lastPromptId, BATCH_SIZE);

    for (const p of prompts) {
      try {
        await post(url, apiKey, "/api/prompts", {
          source: "claude-code", source_id: p.id,
          session_source_id: p.resolved_session_id ?? null,
          project: p.project ?? "unknown",
          prompt_text: p.prompt_text, prompt_number: p.prompt_number,
          created_at: p.created_at, created_at_epoch: p.created_at_epoch,
        });
        state.lastPromptId = p.id;
        synced++;
      } catch (err) { console.error(`Failed to sync prompt ${p.id}: ${err.message}`); break; }
    }

    saveState(state);
    if (synced > 0) console.log(`Synced ${synced} records`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// File sync: push .md files as reference observations
// ---------------------------------------------------------------------------

function findMdFiles() {
  if (!PROJECT_ROOT) return [];
  try {
    const excludeArgs = EXCLUDE_PATTERNS.map((p) => `-not -path '*/${p}/*'`).join(" ");
    const cmd = `find ${PROJECT_ROOT} -name "*.md" ${excludeArgs} -type f 2>/dev/null`;
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function deriveProject(filePath) {
  if (!PROJECT_ROOT) return "unknown";
  const rel = relative(PROJECT_ROOT, filePath);
  // apps/my-app/TODO.md → my-app
  // apps/another-app/CLAUDE.md → another-app
  // CLAUDE.md → (basename of PROJECT_ROOT)
  // skills/deploy/SKILL.md → (basename of PROJECT_ROOT)
  const parts = rel.split("/");
  if (parts[0] === "apps" && parts.length >= 2) return parts[1];
  return basename(PROJECT_ROOT);
}

async function syncFiles() {
  const url = process.env.CLAUDE_MEM_REMOTE_URL;
  const apiKey = process.env.CLAUDE_MEM_REMOTE_API_KEY;
  if (!url || !apiKey || !PROJECT_ROOT) return;

  const state = loadState();
  if (!state.fileHashes) state.fileHashes = {};

  const files = findMdFiles();
  let synced = 0;
  let skipped = 0;

  for (const filePath of files) {
    try {
      const stat = statSync(filePath);
      // Skip files larger than 100KB — likely generated or not useful
      if (stat.size > 100_000) continue;

      const content = readFileSync(filePath, "utf-8");
      const hash = hashContent(content);
      const relPath = relative(PROJECT_ROOT, filePath);

      // Skip if unchanged
      if (state.fileHashes[relPath] === hash) {
        skipped++;
        continue;
      }

      const project = deriveProject(filePath);
      const fileName = basename(filePath);
      const dirName = basename(dirname(filePath));
      const title = `[doc] ${dirName}/${fileName}`;
      const now = new Date();

      // Use a stable source_id derived from the file path so updates replace the old version
      // We use a negative number space to avoid colliding with claude-mem observation IDs
      const pathHash = createHash("sha256").update(relPath).digest();
      const sourceId = -(pathHash.readUInt32BE(0) % 1_000_000_000);

      await post(url, apiKey, "/api/observations?upsert=true", {
        source: "file-sync",
        source_id: sourceId,
        project,
        type: "reference",
        title,
        subtitle: relPath,
        narrative: content,
        created_at: now.toISOString(),
        created_at_epoch: now.getTime(),
      });

      state.fileHashes[relPath] = hash;
      synced++;
    } catch (err) {
      console.error(`Failed to sync file ${filePath}: ${err.message}`);
    }
  }

  // Clean up hashes for deleted files
  if (PROJECT_ROOT) {
    for (const relPath of Object.keys(state.fileHashes)) {
      const fullPath = join(PROJECT_ROOT, relPath);
      if (!existsSync(fullPath)) {
        delete state.fileHashes[relPath];
      }
    }
  }

  saveState(state);
  if (synced > 0) console.log(`File sync: pushed ${synced} new/changed .md files (${skipped} unchanged)`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

loadEnv();
console.log(`Sync daemon started. DB poll every ${POLL_INTERVAL_MS / 1000}s, file sync every ${FILE_SYNC_INTERVAL_MS / 1000}s`);
console.log(`Remote: ${process.env.CLAUDE_MEM_REMOTE_URL || "(not set)"}`);
console.log(`DB: ${DB_PATH}`);
console.log(`Files: ${PROJECT_ROOT ? PROJECT_ROOT + "/**/*.md" : "(disabled — set CLAUDE_MEM_SYNC_PROJECT_ROOT)"}`);

let lastFileSync = 0;

async function loop() {
  while (true) {
    try { await syncOnce(); }
    catch (err) { console.error(`DB sync error: ${err.message}`); }

    // File sync every 5 minutes
    const now = Date.now();
    if (now - lastFileSync >= FILE_SYNC_INTERVAL_MS) {
      try { await syncFiles(); }
      catch (err) { console.error(`File sync error: ${err.message}`); }
      lastFileSync = now;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop();
