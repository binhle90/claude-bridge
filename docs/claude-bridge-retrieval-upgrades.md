# claude-bridge Retrieval Upgrades: Design Specification

**Date:** 2026-03-21
**Project:** claude-bridge
**Status:** Implemented (2026-03-22)
**Author:** Binh Le + Claude Opus 4.6

---

## Context

claude-bridge currently uses SQLite FTS5 for all retrieval. This serves keyword queries well (sub-5ms latency, zero external dependencies) but fails on semantic queries ("what authentication decisions have I made across all projects?") and produces undifferentiated result sets where a high-level architectural decision and a minor implementation note receive equal treatment.

Two targeted upgrades capture the most valuable retrieval properties of systems like OpenViking without replacing the storage layer or introducing Python/Go/C++ runtime dependencies.

---

## Upgrade 1: Hybrid Semantic Search

### Problem Statement

FTS5 is keyword-based. The query "authentication flow" will not match an observation titled "OAuth 2.1 design specification" unless both strings share tokens. Structured observations exacerbate this: a decision stored in the `facts` column as "Use PKCE for all browser-based flows" is invisible to a search for "security measures." The retrieval gap grows as observation count increases and vocabulary diverges between the time-of-writing and time-of-querying contexts.

### Design

Add an optional `mode` parameter to the existing `search` MCP tool. Three modes:

| Mode | Behavior | Latency |
|------|----------|---------|
| `keyword` (default) | Current FTS5 behavior, unchanged | <5ms |
| `semantic` | Embedding cosine similarity only | 200-400ms |
| `hybrid` | FTS5 + embedding, RRF-merged | 200-400ms |

The `keyword` default preserves backward compatibility. No existing client breaks.

### Schema Changes

New migration (server/db.js):

```sql
-- New table for embedding vectors
CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,           -- Float32Array as raw bytes
  model TEXT NOT NULL,                -- e.g., "text-embedding-3-small"
  dimensions INTEGER NOT NULL,       -- e.g., 1536
  embedded_text_hash TEXT NOT NULL,   -- SHA-256 of the text that was embedded
  created_at TEXT DEFAULT (datetime('now'))
);

-- Same for session summaries
CREATE TABLE IF NOT EXISTS session_embeddings (
  session_id INTEGER PRIMARY KEY REFERENCES session_summaries(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedded_text_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Why raw BLOB, not sqlite-vec?** sqlite-vec is the obvious choice for vector similarity in SQLite, but it requires a native extension (.so/.dylib) that complicates the Docker build and cross-platform deployment. For the expected data scale (<50K observations over years of use), brute-force cosine similarity over Float32 BLOBs in JavaScript is fast enough. At 1536 dimensions, comparing a query vector against 10,000 stored vectors takes ~15ms in pure JS. This can be revisited if scale demands it.

### Embedding Pipeline

**Where embedding happens:** Server-side, triggered asynchronously. Two paths:

1. **On write (non-blocking):** When `POST /api/observations` or `POST /api/sessions` creates/upserts a record, enqueue the ID for embedding. A background worker (setInterval, 5s) processes the queue in batches of 20. The write returns immediately; the embedding is eventual.

2. **Backfill (one-time):** New endpoint `POST /api/admin/backfill-embeddings` iterates all observations/sessions missing embeddings and processes them in batches. Rate-limited to 100/min to stay within API tier limits.

**What gets embedded:** A composed string per observation:

```javascript
function composeEmbeddingText(obs) {
  const parts = [obs.title, obs.narrative, obs.facts, obs.concepts, obs.text]
    .filter(Boolean);
  // Truncate to ~8000 chars (~2000 tokens) to stay within embedding model limits
  return parts.join('\n\n').slice(0, 8000);
}
```

For sessions: concatenate `request`, `investigated`, `learned`, `completed`, `next_steps`.

**Hash for staleness detection:** `embedded_text_hash` stores SHA-256 of the composed text. On upsert, if the hash matches, skip re-embedding. This prevents redundant API calls during file-sync cycles where content has not changed.

### Embedding Provider

**Default:** OpenAI `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens). At 500 tokens average per observation and 10,000 observations, full backfill costs ~$0.10. Ongoing cost is negligible.

**Configuration:**

```bash
# New env vars (server-side)
EMBEDDING_PROVIDER=openai          # openai | voyage | local
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_API_KEY=sk-...
EMBEDDING_DIMENSIONS=1536
```

**Provider abstraction:**

```javascript
// server/embeddings.js
class EmbeddingProvider {
  async embed(texts) { /* returns Float32Array[] */ }
}

class OpenAIEmbeddings extends EmbeddingProvider { ... }
class VoyageEmbeddings extends EmbeddingProvider { ... }
class NoopEmbeddings extends EmbeddingProvider {
  // Returns null; search falls back to FTS5-only
  async embed() { return null; }
}
```

If `EMBEDDING_PROVIDER` is unset, the server starts with `NoopEmbeddings`. Semantic search returns an error message: "Semantic search not configured. Set EMBEDDING_PROVIDER." FTS5 continues to work. Zero-config degradation.

### Search Implementation

**MCP tool schema change:**

```json
{
  "name": "search",
  "description": "Full-text and semantic search across observations and sessions",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "limit": { "type": "number", "default": 20 },
      "project": { "type": "string" },
      "mode": {
        "type": "string",
        "enum": ["keyword", "semantic", "hybrid"],
        "default": "keyword",
        "description": "keyword: FTS5 only. semantic: embedding similarity. hybrid: both, merged via RRF."
      }
    },
    "required": ["query"]
  }
}
```

**Hybrid merge via Reciprocal Rank Fusion (RRF):**

```javascript
function mergeRRF(ftsResults, semanticResults, k = 60) {
  const scores = new Map();

  ftsResults.forEach((r, i) => {
    const id = `${r.type}:${r.id}`;
    scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
    if (!scores.has(`_obj:${id}`)) scores.set(`_obj:${id}`, r);
  });

  semanticResults.forEach((r, i) => {
    const id = `${r.type}:${r.id}`;
    scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
    if (!scores.has(`_obj:${id}`)) scores.set(`_obj:${id}`, r);
  });

  return [...scores.entries()]
    .filter(([k]) => !k.startsWith('_obj:'))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => scores.get(`_obj:${k}`));
}
```

**Cosine similarity in JS (no native deps):**

```javascript
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function semanticSearch(queryText, { limit = 20, project } = {}) {
  const [queryVec] = await embeddingProvider.embed([queryText]);
  if (!queryVec) throw new Error('Semantic search not configured');

  let rows = db.prepare(`
    SELECT o.id, o.type, o.title, o.project, o.narrative, o.created_at_epoch,
           e.embedding, e.dimensions
    FROM observations o
    JOIN observation_embeddings e ON e.observation_id = o.id
    ${project ? 'WHERE o.project = ?' : ''}
  `).all(...(project ? [project] : []));

  const scored = rows.map(row => {
    const stored = new Float32Array(row.embedding.buffer,
      row.embedding.byteOffset, row.dimensions);
    return { ...row, score: cosineSimilarity(queryVec, stored) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
```

### Performance Budget

| Operation | Target | Mechanism |
|-----------|--------|-----------|
| keyword search | <5ms | Unchanged FTS5 path |
| semantic search (10K obs) | <400ms | 200ms embedding API + 15ms brute-force cosine + overhead |
| hybrid search | <400ms | Parallel FTS5 + semantic, merge |
| embedding on write | 0ms (non-blocking) | Async queue, 5s worker cycle |
| backfill 10K observations | ~10min | 100 batch/min, 20 per batch |

### Deployment Changes

- New env vars: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`, `EMBEDDING_DIMENSIONS`
- New npm dependency: none for OpenAI (raw fetch), or `openai` package if preferred
- Docker: network egress to `api.openai.com` (already allowed for example.com)
- Database migration: automatic on server restart (existing pattern)
- Backfill: manual one-time `POST /api/admin/backfill-embeddings`

### Rollback

Drop the two new tables. Remove the env vars. `mode: "semantic"` and `mode: "hybrid"` return errors. `mode: "keyword"` continues unchanged. Zero-risk rollback.

---

## Upgrade 2: Abstraction Layer (L0 Summaries)

### Problem Statement

When the search tool returns 15 results, Claude receives the full `snippet` (40 chars from FTS5) plus the `title` for each. The snippet is often a mid-sentence fragment that lacks semantic value. Claude must then call `get_observations` to fetch full content for promising results, consuming tool calls and context window tokens to triage what turned out to be irrelevant observations.

A one-line summary per observation, generated at write time, would let Claude triage results in a single search call without fetching full content for most results.

### Design

Add an `abstract` column to both `observations` and `session_summaries`. Populated asynchronously via the same background worker used for embeddings. The abstract is a single sentence (under 100 tokens) summarizing the observation's content and significance.

### Schema Changes

```sql
ALTER TABLE observations ADD COLUMN abstract TEXT;
ALTER TABLE session_summaries ADD COLUMN abstract TEXT;

-- Add abstract to FTS5 index rebuild
DROP TABLE IF EXISTS observations_fts;
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, subtitle, text, narrative, facts, concepts, abstract,
  content='observations',
  content_rowid='id'
);

-- Rebuild FTS index (one-time during migration)
INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
```

### Generation Pipeline

**Provider:** Uses the same `EMBEDDING_PROVIDER` API key but calls the chat completion endpoint (or a cheaper model). Default: `gpt-4.1-mini` for cost efficiency.

**New env var:**

```bash
ABSTRACT_MODEL=gpt-4.1-mini    # model for generating abstracts
```

**Prompt:**

```javascript
const ABSTRACT_PROMPT = `Summarize this observation in exactly one sentence.
The sentence must capture: what was decided/discovered/built, which project,
and why it matters. Maximum 100 tokens. No preamble.

Title: {title}
Type: {type}
Project: {project}
Content:
{narrative}
{facts}`;
```

**Queue integration:** The background worker processes embeddings and abstracts in the same cycle. Each observation gets both in a single pass. The abstract generation is a single API call per observation (no batching needed since it is a completion, not an embedding).

**Cost:** At ~200 input tokens + ~50 output tokens per observation, using gpt-4.1-mini at ~$0.40/1M input + $1.60/1M output: 10,000 observations costs approximately $0.16 for abstracts. Combined with embedding backfill, total one-time cost for 10K observations is under $0.30.

### Search Result Enhancement

The `search` MCP tool response currently returns:

```json
{
  "id": 1106,
  "type": "change",
  "title": "OAuth 2.1 design specification committed",
  "snippet": "...OAuth 2.1 design specification committed as docs/superpowers...",
  "project": "apps",
  "created_at": "2026-03-21T07:26:36.821Z"
}
```

With abstracts, it returns:

```json
{
  "id": 1106,
  "type": "change",
  "title": "OAuth 2.1 design specification committed",
  "abstract": "Committed a 330-line OAuth 2.1 spec for claude-bridge enabling Claude.ai to connect as a remote MCP client via Authorization Code + PKCE flow.",
  "snippet": "...OAuth 2.1 design specification committed as docs/superpowers...",
  "project": "apps",
  "created_at": "2026-03-21T07:26:36.821Z"
}
```

The `abstract` field is `null` for observations not yet processed. Claude can use the abstract to decide whether to fetch full content via `get_observations`, reducing unnecessary tool calls by an estimated 50-70%.

### Staleness Detection

Same pattern as embeddings: hash the composed text. If the observation is upserted (file-sync) and the content hash changes, mark the abstract as stale by setting it to `NULL`. The background worker re-generates it on the next cycle.

### For session_summaries

Session summaries already have structured fields (request, investigated, learned, completed, next_steps). The abstract generation uses a slightly different prompt:

```javascript
const SESSION_ABSTRACT_PROMPT = `Summarize this coding session in one sentence.
Capture: what was requested, what was accomplished, and the project name.
Maximum 100 tokens. No preamble.

Project: {project}
Request: {request}
Completed: {completed}
Learned: {learned}`;
```

### Deployment Changes

- Migration adds `abstract` column (nullable, non-breaking)
- FTS5 index rebuild (automatic, takes <1s for 10K rows)
- Backfill via same `POST /api/admin/backfill-embeddings` endpoint (renamed to `POST /api/admin/backfill` since it now handles both)
- New env var: `ABSTRACT_MODEL`

### Rollback

The `abstract` column remains but is ignored. Search results simply return `null` for the field. FTS5 index continues to work (null columns contribute nothing to search). Zero-risk.

---

## Combined Implementation Plan

### Phase 1: Schema + Provider Abstraction (Day 1)

1. Add migration for `observation_embeddings`, `session_embeddings` tables
2. Add migration for `abstract` column on both tables
3. Implement `EmbeddingProvider` abstraction (OpenAI, Noop)
4. Add env var parsing and validation in `server/index.js`
5. Rebuild FTS5 indexes to include `abstract`

### Phase 2: Background Worker (Day 1-2)

1. Implement embedding queue processor (`server/workers/embedding-worker.js`)
2. Add abstract generation alongside embedding in same worker loop
3. Hook into `POST /api/observations` and `POST /api/sessions` to enqueue on write
4. Implement staleness detection (hash comparison on upsert)
5. Add `POST /api/admin/backfill` endpoint

### Phase 3: Search Enhancement (Day 2)

1. Add `mode` parameter to search MCP tool
2. Implement `semanticSearch()` with brute-force cosine similarity
3. Implement `hybridSearch()` with RRF merge
4. Include `abstract` in all search result responses
5. Update MCP tool descriptions to document new capabilities

### Phase 4: Testing + Deployment (Day 2-3)

1. Unit tests for cosine similarity, RRF merge, hash staleness
2. Integration tests for all three search modes
3. Backfill existing production database
4. Update ARCHITECTURE.md
5. Deploy to example.com via existing `deploy.sh`

### New Files

```
server/
  embeddings.js          # Provider abstraction + OpenAI/Noop implementations
  workers/
    enrichment-worker.js # Background queue for embeddings + abstracts
  routes/
    admin.js             # Backfill endpoint
```

### Modified Files

```
server/db.js             # New migrations
server/mcp.js            # search tool: mode param, abstract in results
server/index.js          # Worker initialization, env var parsing
server/routes/search.js  # REST search: same enhancements
```

### New Dependencies

```
none (uses native fetch for OpenAI API calls)
```

### New Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | No | `noop` | `openai`, `voyage`, or `noop` |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model name |
| `EMBEDDING_API_KEY` | No | — | API key for embedding provider |
| `EMBEDDING_DIMENSIONS` | No | `1536` | Vector dimensions |
| `ABSTRACT_MODEL` | No | `gpt-4.1-mini` | Model for abstract generation |

All optional. Server starts and operates normally without any of them. Semantic search returns an error if invoked without configuration. Keyword search is always available.

---

## What This Does NOT Do

To keep scope bounded, this spec explicitly excludes:

- **Replacing FTS5.** Keyword search remains the default and fastest path.
- **Adding a vector database.** Brute-force cosine in JS is sufficient at <50K scale.
- **Hierarchical retrieval.** No directory-recursive strategy. The project filter + FTS5 + semantic similarity covers the query patterns that matter.
- **Auto-evolving memory.** No session-end extraction loop. The `save_memory` MCP tool remains the explicit save mechanism.
- **Multi-modal embedding.** Text only. No image or PDF content understanding.
- **Changing the sync daemon.** The daemon continues to push raw records. Enrichment (embeddings + abstracts) happens server-side after receipt.

Any of these can be added later as independent upgrades without modifying this spec.

---

## Test and Validation Framework

### Objective

Measure retrieval quality before and after implementation using queries derived from production data. Establish a baseline, define a kill criterion, and provide a regression test for future changes.

### Methodology

**Eval-driven development.** Build the eval harness and ground-truth query set first, run it against the current FTS5-only system to establish a baseline, then run it again after each upgrade. If the upgrades do not beat the baseline on the query categories where they should improve, do not deploy.

**Three query categories:**

| Category | Description | FTS5 Expected | Semantic Expected | Hybrid Expected |
|----------|-------------|---------------|-------------------|-----------------|
| A: Keyword-friendly | Query vocabulary matches stored vocabulary | High | Medium | High |
| B: Synonym/paraphrase | Same intent, different vocabulary | Low | High | High |
| C: Conceptual/intent | Requires understanding meaning, not tokens | Low | Medium-High | Medium-High |

**Kill criterion:** Hybrid mode must achieve higher Recall@10 than keyword mode on Categories B and C without degrading Recall@10 on Category A. If this condition is not met, the embedding infrastructure does not justify deployment.

### Ground-Truth Query Set

Built from live queries against production data (memory.example.com, March 2026). Each entry includes the query, the expected observation IDs (manually verified), the category, and what FTS5 returns today.

#### Category A: Keyword-Friendly (FTS5 baseline should be high)

```json
[
  {
    "id": "A1",
    "query": "OAuth PKCE token",
    "expected_ids": [658, 659, 1089, 1090, 1091, 1092],
    "category": "A",
    "fts5_today": "PASS — returns all expected observations",
    "notes": "Direct keyword match. OAuth, PKCE, token all appear verbatim in stored text."
  },
  {
    "id": "A2",
    "query": "Docker container Caddy reverse proxy",
    "expected_ids": [33, 63, 82, 85, 152],
    "category": "A",
    "fts5_today": "PASS — returns all 5 deployment observations",
    "notes": "Infrastructure keywords match exactly."
  },
  {
    "id": "A3",
    "query": "blue green deployment",
    "expected_ids": [63, 65, 154],
    "category": "A",
    "fts5_today": "PASS — returns blue-green spec and implementation",
    "notes": "Technical term matches verbatim."
  },
  {
    "id": "A4",
    "query": "OOM memory crash container",
    "expected_ids": [226, 227, 228, 229, 230],
    "category": "A",
    "fts5_today": "PASS — returns full OOM investigation chain",
    "notes": "Exact keyword overlap with stored observations."
  },
  {
    "id": "A5",
    "query": "performance bottleneck slow",
    "expected_ids": [809, 810],
    "category": "A",
    "fts5_today": "PASS — returns report generation latency observations",
    "notes": "Keywords 'performance' and 'bottleneck' appear verbatim."
  },
  {
    "id": "A6",
    "query": "Redshore Kubernetes admission",
    "expected_ids": [108, 148, 181, 182, 184],
    "category": "A",
    "fts5_today": "PASS — returns Redshore build chain",
    "notes": "Project name + technical terms match."
  },
  {
    "id": "A7",
    "query": "claude-bridge MCP protocol",
    "expected_ids": [658, 659, 1081],
    "category": "A",
    "fts5_today": "PASS — returns architecture docs and MCP implementation",
    "notes": "Product name + protocol name match."
  }
]
```

#### Category B: Synonym/Paraphrase (FTS5 baseline should be low)

```json
[
  {
    "id": "B1",
    "query": "making sure apps stay running when I push updates",
    "expected_ids": [63, 154, 205, 230],
    "category": "B",
    "fts5_today": "FAIL — 0 results",
    "notes": "Natural language for 'zero-downtime deployment'. No keyword overlap with 'blue-green', 'rolling restart', 'zero-downtime'."
  },
  {
    "id": "B2",
    "query": "preventing data loss server crash",
    "expected_ids": [226, 227, 228, 229, 230],
    "category": "B",
    "fts5_today": "FAIL — 0 results",
    "notes": "Semantic equivalent of OOM crash chain. Stored observations use 'out-of-memory', 'OOM', 'container limits' — no overlap with 'data loss' or 'server crash'."
  },
  {
    "id": "B3",
    "query": "protecting against unauthorized access",
    "expected_ids": [637, 1082, 1091, 1095],
    "category": "B",
    "fts5_today": "FAIL — 0 results",
    "notes": "Security concept. Stored observations use 'Bearer token authentication', 'PKCE', 'brute-force protection', 'redirect_uri validation' — none share tokens with query."
  },
  {
    "id": "B4",
    "query": "infrastructure setup hosting web apps HTTPS",
    "expected_ids": [33, 63, 82, 85, 152],
    "category": "B",
    "fts5_today": "PARTIAL FAIL — returns SKILL.md docs (276, 463) but NOT actual deployment observations (33, 63, 82, 85, 152)",
    "notes": "Finds documentation about deployment but misses the actual deployment records. 'Hosting' and 'HTTPS' appear in skill descriptions, not in deployment logs that use 'Docker', 'Caddy', 'reverse proxy'."
  },
  {
    "id": "B5",
    "query": "user experience delays frustrating",
    "expected_ids": [809, 810],
    "category": "B",
    "fts5_today": "FAIL — 0 results",
    "notes": "Natural language for performance bottleneck. Stored observations use 'latency', 'bottleneck', 'delays' (partial overlap on 'delays' but FTS5 requires more token matches to rank)."
  },
  {
    "id": "B6",
    "query": "change governance compliance enforcement",
    "expected_ids": [108, 502, 506],
    "category": "B",
    "fts5_today": "PARTIAL FAIL — finds Redshore blog/website content (502, 506) but misses the core Redshore integration roadmap (108)",
    "notes": "Stored observation 108 uses 'governance workflow', 'decision records', 'evidence packs', 'approval' — related but different vocabulary from 'compliance enforcement'."
  },
  {
    "id": "B7",
    "query": "how I connect Claude.ai to my memory server",
    "expected_ids": [1079, 1081, 1106, 1112, 1216, 1218],
    "category": "B",
    "fts5_today": "FAIL — 0 results (tested: none of 'connect', 'Claude.ai', 'memory server' in combination match the stored OAuth/MCP vocabulary)",
    "notes": "The user's natural phrasing for 'OAuth 2.1 remote MCP connector configuration'. Stored observations use 'OAuth', 'MCP endpoint', 'connector', 'Streamable HTTP' — entirely different register."
  }
]
```

#### Category C: Conceptual/Intent (FTS5 baseline should be low)

```json
[
  {
    "id": "C1",
    "query": "ideas that failed validation",
    "expected_ids": [],
    "category": "C",
    "fts5_today": "FAIL — returns irrelevant results (Langfuse CONTRIBUTING.md, Celadon pipeline validation)",
    "notes": "Intent: find idea-validator-pro runs that scored below threshold. Requires understanding 'failed' in context of scoring, not software failures. Note: idea validation observations may not be synced to remote memory yet. Expected IDs to be populated after backfill."
  },
  {
    "id": "C2",
    "query": "which ideas scored highest validation",
    "expected_ids": [],
    "category": "C",
    "fts5_today": "FAIL — 0 results",
    "notes": "Intent: rank idea-validator-pro runs by score. Same data gap as C1. Include after backfill."
  },
  {
    "id": "C3",
    "query": "recurring technical risks idea validations",
    "expected_ids": [],
    "category": "C",
    "fts5_today": "FAIL — 0 results",
    "notes": "Cross-observation pattern query. Requires finding common risk themes across multiple validation reports. Even semantic search may struggle here — this is a stretch goal."
  },
  {
    "id": "C4",
    "query": "lessons learned mistakes",
    "expected_ids": [226, 227, 181, 809],
    "category": "C",
    "fts5_today": "FAIL — 0 results",
    "notes": "Intent: find retrospective observations where something went wrong. Expected results include OOM crashes, Docker build failures, performance bottlenecks. None use 'lessons' or 'mistakes' — stored as 'bugfix' type observations with technical descriptions."
  },
  {
    "id": "C5",
    "query": "build versus buy decision",
    "expected_ids": [],
    "category": "C",
    "fts5_today": "FAIL — 1 irrelevant result (Celadon test suite doc mentioning Hebbia accuracy)",
    "notes": "Intent: find the AI due diligence build-vs-buy analysis. May not be synced to remote memory. Populate expected IDs after backfill."
  },
  {
    "id": "C6",
    "query": "what architectural patterns do I reuse across projects",
    "expected_ids": [33, 63, 152, 259, 637],
    "category": "C",
    "fts5_today": "FAIL — 0 results",
    "notes": "Meta-query about cross-project patterns. Expected results: Docker+Caddy deployment pattern, Express+SQLite stack, structured observation model. Requires semantic understanding that these are instances of the same pattern."
  }
]
```

### Metrics

Three standard retrieval metrics, computed per query and aggregated per category:

**Recall@K** (K=5 and K=10): Fraction of expected IDs appearing in top K results. Primary metric. Measures whether the right observations are surfaced at all.

```
Recall@K = |expected ∩ top_K| / |expected|
```

**Mean Reciprocal Rank (MRR):** Measures ranking quality. For the highest-ranked expected result, what position does it appear at?

```
MRR = 1 / rank_of_first_relevant_result  (0 if none found)
```

**Precision@K** (K=10): Of the top 10 results returned, how many are actually relevant? Measures noise. High recall with low precision means Claude's context window fills with irrelevant observations.

```
Precision@K = |expected ∩ top_K| / K
```

### Eval Harness Implementation

Single-file Node.js script. Runs against the production API (or a local copy of the database). Outputs a markdown results table.

**File:** `eval/retrieval-eval.js`

```javascript
#!/usr/bin/env node

/**
 * claude-bridge retrieval eval harness
 *
 * Usage:
 *   CLAUDE_MEM_REMOTE_URL=https://memory.example.com \
 *   CLAUDE_MEM_REMOTE_API_KEY=... \
 *   node eval/retrieval-eval.js [--mode keyword|semantic|hybrid|all]
 *
 * Outputs: eval/results-{timestamp}.md
 */

const EVAL_SET = [
  // Category A — paste from ground-truth set above
  // Category B
  // Category C
];

async function search(query, { mode = 'keyword', limit = 20, project } = {}) {
  // For keyword mode: call GET /api/search?query=...
  // For semantic/hybrid: call MCP tools/call with mode param
  // (Post-implementation, the REST endpoint also accepts mode)
  const url = new URL('/api/search', process.env.CLAUDE_MEM_REMOTE_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  if (mode !== 'keyword') url.searchParams.set('mode', mode);
  if (project) url.searchParams.set('project', project);

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${process.env.CLAUDE_MEM_REMOTE_API_KEY}` }
  });
  const data = await res.json();
  return data.results || [];
}

function recallAtK(expectedIds, resultIds, k) {
  const topK = resultIds.slice(0, k);
  const hits = expectedIds.filter(id => topK.includes(id));
  return expectedIds.length > 0 ? hits.length / expectedIds.length : null;
}

function mrr(expectedIds, resultIds) {
  for (let i = 0; i < resultIds.length; i++) {
    if (expectedIds.includes(resultIds[i])) return 1 / (i + 1);
  }
  return 0;
}

function precisionAtK(expectedIds, resultIds, k) {
  const topK = resultIds.slice(0, k);
  const hits = expectedIds.filter(id => topK.includes(id));
  return hits.length / k;
}

async function runEval(modes = ['keyword']) {
  const results = [];

  for (const testCase of EVAL_SET) {
    if (testCase.expected_ids.length === 0) {
      // Skip queries with no expected IDs (data not yet synced)
      results.push({
        ...testCase,
        skipped: true,
        reason: 'No expected IDs defined — awaiting data backfill'
      });
      continue;
    }

    const modeResults = {};
    for (const mode of modes) {
      const searchResults = await search(testCase.query, { mode, limit: 20 });
      const resultIds = searchResults.map(r => r.id);

      modeResults[mode] = {
        recall_5: recallAtK(testCase.expected_ids, resultIds, 5),
        recall_10: recallAtK(testCase.expected_ids, resultIds, 10),
        mrr: mrr(testCase.expected_ids, resultIds),
        precision_10: precisionAtK(testCase.expected_ids, resultIds, 10),
        top_10_ids: resultIds.slice(0, 10),
        total_returned: searchResults.length
      };
    }

    results.push({ ...testCase, modeResults });
  }

  return results;
}

function formatReport(results, modes) {
  const lines = [];
  lines.push(`# Retrieval Eval Results`);
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push(`**Modes tested:** ${modes.join(', ')}`);
  lines.push('');

  // Per-category aggregate table
  for (const cat of ['A', 'B', 'C']) {
    const catResults = results.filter(r => r.category === cat && !r.skipped);
    const catLabel = { A: 'Keyword-Friendly', B: 'Synonym/Paraphrase', C: 'Conceptual/Intent' }[cat];
    lines.push(`## Category ${cat}: ${catLabel} (${catResults.length} queries)`);
    lines.push('');

    if (catResults.length === 0) {
      lines.push('*No testable queries (expected IDs not yet populated)*');
      lines.push('');
      continue;
    }

    // Header row
    const modeCols = modes.map(m => `${m} R@5 | ${m} R@10 | ${m} MRR`).join(' | ');
    lines.push(`| Query | ${modeCols} |`);
    lines.push(`|-------|${modes.map(() => '-------|-------|-------').join('|')}|`);

    for (const r of catResults) {
      const vals = modes.map(m => {
        const mr = r.modeResults[m];
        return `${(mr.recall_5 ?? 0).toFixed(2)} | ${(mr.recall_10 ?? 0).toFixed(2)} | ${mr.mrr.toFixed(2)}`;
      }).join(' | ');
      lines.push(`| ${r.id}: "${r.query}" | ${vals} |`);
    }

    // Category averages
    for (const m of modes) {
      const avgR5 = catResults.reduce((s, r) => s + (r.modeResults[m]?.recall_5 ?? 0), 0) / catResults.length;
      const avgR10 = catResults.reduce((s, r) => s + (r.modeResults[m]?.recall_10 ?? 0), 0) / catResults.length;
      const avgMRR = catResults.reduce((s, r) => s + (r.modeResults[m]?.mrr ?? 0), 0) / catResults.length;
      lines.push(`| **${m} avg** | **${avgR5.toFixed(2)}** | **${avgR10.toFixed(2)}** | **${avgMRR.toFixed(2)}** |`);
    }
    lines.push('');
  }

  // Skipped queries
  const skipped = results.filter(r => r.skipped);
  if (skipped.length > 0) {
    lines.push(`## Skipped Queries (${skipped.length})`);
    lines.push('');
    for (const r of skipped) {
      lines.push(`- **${r.id}:** "${r.query}" — ${r.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const modeArg = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'all';
  const modes = modeArg === 'all'
    ? ['keyword', 'semantic', 'hybrid']
    : [modeArg];

  // Pre-implementation: only keyword mode is available
  const availableModes = modes.filter(m => {
    if (m === 'keyword') return true;
    // Test if semantic search is configured
    // (will fail gracefully if not)
    return true;
  });

  console.log(`Running eval with modes: ${availableModes.join(', ')}`);
  console.log(`Eval set: ${EVAL_SET.length} queries`);
  console.log('');

  const results = await runEval(availableModes);
  const report = formatReport(results, availableModes);

  const fs = await import('fs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `eval/results-${timestamp}.md`;
  fs.mkdirSync('eval', { recursive: true });
  fs.writeFileSync(outPath, report);

  console.log(report);
  console.log(`\nResults written to ${outPath}`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
```

### Abstract Layer Eval: Tool Call Reduction

The abstraction layer's value is measured by how many `get_observations` calls Claude needs per search. This cannot be evaluated with a script alone — it requires observing real MCP tool call patterns.

**Method:** Instrument the MCP endpoint to log tool call sequences per conversation session.

**New log fields on `POST /mcp` (tools/call handler):**

```javascript
// server/mcp.js — add to tools/call handler
const toolCallLog = {
  timestamp: new Date().toISOString(),
  tool: toolName,
  // Hash the auth token to group calls by session/client without logging credentials
  client_hash: crypto.createHash('sha256').update(authToken).digest('hex').slice(0, 12),
  // For search calls, log the mode and result count
  ...(toolName === 'search' && {
    mode: params.mode || 'keyword',
    result_count: results.length,
    has_abstracts: results.some(r => r.abstract !== null)
  })
};
console.log(JSON.stringify(toolCallLog));
```

**Baseline measurement (before upgrade):** Run for one week of normal usage. Count:

- Total `search` calls per day
- Total `get_observations` calls per day
- Ratio: `get_observations / search` (the "triage ratio")
- Average IDs per `get_observations` call (batch size)

**Post-upgrade measurement:** Run for one week after abstracts are populated. Same metrics.

**Success criterion:** Triage ratio drops by ≥40%. If Claude currently calls `get_observations` 3 times per search (to inspect candidates), the target is ≤1.8 times per search.

**Why 40%?** With abstracts, Claude can read the one-line summary inline and skip fetching full content for observations that are clearly irrelevant. Based on typical search result quality (5-7 relevant out of 15-20 returned), roughly half the `get_observations` calls today are for observations that turn out to be irrelevant after inspection. The abstract eliminates that round-trip.

### Latency Regression Test

The upgrades must not degrade keyword search latency. Keyword mode is the default and handles the majority of queries.

**Benchmark script:** `eval/latency-bench.js`

```javascript
#!/usr/bin/env node

/**
 * Measures p50/p95/p99 latency for keyword search.
 * Run before and after upgrade to detect regressions.
 *
 * Usage: node eval/latency-bench.js
 */

const QUERIES = [
  'OAuth PKCE',
  'Docker container',
  'blue green deployment',
  'OOM memory crash',
  'claude-bridge MCP',
  'Redshore Kubernetes',
  'performance bottleneck',
  'deployment strategy',
  'report generation',
  'skill architecture'
];

async function bench(query) {
  const start = performance.now();
  const url = new URL('/api/search', process.env.CLAUDE_MEM_REMOTE_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', '20');
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${process.env.CLAUDE_MEM_REMOTE_API_KEY}` }
  });
  await res.json();
  return performance.now() - start;
}

async function main() {
  const iterations = 100;
  const allLatencies = [];

  for (let i = 0; i < iterations; i++) {
    const query = QUERIES[i % QUERIES.length];
    const latency = await bench(query);
    allLatencies.push(latency);
    if (i % 20 === 0) process.stdout.write('.');
  }

  allLatencies.sort((a, b) => a - b);
  const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)];
  const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)];
  const p99 = allLatencies[Math.floor(allLatencies.length * 0.99)];
  const mean = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;

  console.log(`\nKeyword search latency (${iterations} iterations):`);
  console.log(`  Mean:  ${mean.toFixed(1)}ms`);
  console.log(`  p50:   ${p50.toFixed(1)}ms`);
  console.log(`  p95:   ${p95.toFixed(1)}ms`);
  console.log(`  p99:   ${p99.toFixed(1)}ms`);
}

main();
```

**Regression threshold:** p95 keyword latency must not increase by more than 20% over baseline. The new `abstract` column in FTS5 adds negligible index overhead. The embedding tables are not touched during keyword search. If keyword latency regresses, the cause is likely the background enrichment worker competing for SQLite WAL locks during writes — fixable by tuning the worker's batch timing.

### Execution Order

1. **Week 0 (before any code changes):**
   - Run `retrieval-eval.js --mode=keyword` to establish baseline scores
   - Run `latency-bench.js` to establish baseline latency
   - Begin logging MCP tool calls for triage ratio baseline
   - Save results as `eval/baseline-keyword.md` and `eval/baseline-latency.md`

2. **Week 1 (after implementation + backfill):**
   - Run `retrieval-eval.js --mode=all` to compare all three modes
   - Run `latency-bench.js` to check for keyword latency regression
   - Verify hybrid mode beats keyword on Category B/C (kill criterion)
   - Verify keyword mode is not degraded on Category A

3. **Week 2 (after abstracts are populated):**
   - Compare MCP tool call logs: triage ratio before vs. after
   - Verify ≥40% reduction in `get_observations` calls per search

4. **Ongoing:**
   - Add new queries to eval set as real retrieval failures are observed
   - Re-run eval after any search logic changes
   - Monitor latency weekly via `latency-bench.js`

### Eval Set Maintenance

The ground-truth query set has known gaps: several Category C queries have empty `expected_ids` because the relevant observations (idea validation runs, multi-agent architecture analysis, build-vs-buy research) may not yet be synced to the remote server. These are marked as `skipped` in the eval output.

**Action items before first eval run:**

1. Verify which idea-validator-pro observations are in remote memory. If missing, trigger a sync daemon cycle with the correct `CLAUDE_MEM_SYNC_PROJECT_ROOT` pointing to each skill project.
2. Populate `expected_ids` for C1, C2, C3, C5 after confirming data availability.
3. Consider adding 5-10 more queries from real usage over the first week of logging MCP tool calls. Queries where Claude calls `search` followed by multiple `get_observations` calls that return irrelevant results are ideal candidates for Category B/C additions.

The eval set is a living artifact. It grows as new failure modes are discovered and shrinks as resolved queries graduate to regression tests.
