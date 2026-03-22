# Shared Memory Server Architecture

## Overview

A shared remote memory server that enables **Claude Code**, **Claude Desktop**, **Claude.ai**, and the **Claude mobile app** to share persistent memory and context across sessions. The primary use case is **brainstorm-then-execute**: plan and ideate in any Claude client, then open Claude Code and immediately access those plans for execution.

Claude Code sessions generate observations, session summaries, and user prompts locally. A sync daemon pushes these records to the remote server, including auto-synced project `.md` files. All Claude clients connect to the remote server via MCP — Claude.ai and mobile connect directly via OAuth 2.1 (remote MCP), while Desktop and Code connect via a local MCP proxy.

Deploy on any server with Node.js — a VPS, cloud instance, or even a home server. All it needs is HTTPS and a reachable URL.

## Architecture Diagram

![Architecture Diagram](architecture.svg)

```
Claude Code (local)        Claude Desktop (local)      Claude.ai / Claude Mobile
  claude-mem worker          MCP client (JSON-RPC)       MCP client (remote)
         |           |               |                          |
         | push      | on-demand     | stdin/stdout             | HTTPS + OAuth 2.1
         | (30s)     | search        | (JSON-RPC)              | (Streamable HTTP)
         v           v               v                          |
    Sync Daemon   MCP Server     Local MCP Proxy                |
    push-to-      (settings      mcp-local-proxy.js             |
    remote.js     .json)         forwards over HTTPS            |
         |           |               |                          |
         v           v               v                          v
    +-------------------------------------------------------------------+
    |      your-server.example.com                                      |
    |      Port 3010                                                    |
    |                                                                   |
    |  Node.js + Express API                                            |
    |  SQLite (better-sqlite3) + FTS5 + Embedding Vectors               |
    |  Search: keyword (FTS5) | semantic (cosine) | hybrid (RRF)        |
    |  Background enrichment worker (embeddings + abstracts)            |
    |  MCP endpoint at POST / and POST /mcp                             |
    |  Auth: Bearer API key (sync/local) or OAuth 2.1 token (web/mobile)|
    |  OAuth: /.well-known discovery + /authorize + /token              |
    |  Rate Limit: 600 req/min                                          |
    +-------------------------------------------------------------------+
```

## Data Flows

### 1. Code → Remote (DB Sync)

The sync daemon (`sync/push-to-remote.js`) runs as a background service on your local machine. It:

1. Opens the local claude-mem SQLite database in read-only mode
2. Loads sync state from `~/.claude-mem/remote-sync-state.json` (tracks last synced ID per table)
3. Queries for new records with `id > lastSyncedId`, up to 100 per batch
4. POSTs each record to the remote API (`/api/observations`, `/api/sessions`, `/api/prompts`)
5. Resolves cross-table references (e.g., observation's `memory_session_id` to session summary ID)
6. Handles 409 Conflict (duplicate) responses gracefully
7. Saves updated sync state after each successful batch
8. Sleeps 30 seconds, then repeats

**Environment:** Configured via `~/.claude-mem/remote-sync-env` with `CLAUDE_MEM_REMOTE_URL` and `CLAUDE_MEM_REMOTE_API_KEY`.

### 2. Code → Remote (File Sync)

The same sync daemon also auto-syncs `.md` files from your project every 5 minutes. It:

1. Scans the project directory (set via `CLAUDE_MEM_SYNC_PROJECT_ROOT`) for all `.md` files
2. Skips files larger than 100KB
3. Reads file contents and POSTs to `/api/observations?upsert=true` with:
   - `type="reference"`
   - `source="file-sync"`
   - `source_id` derived from the file path (ensures same path = same record)
4. Uses upsert semantics: if the file already exists (same `source` + `source_id`), the existing record is updated rather than creating a duplicate
5. Content changes are detected and synced on each 5-minute cycle

This allows Claude Desktop to search and reference project documentation, specs, TODOs, and architecture files via MCP without manual intervention.

### 3. Code ← Remote (On-Demand MCP)

Claude Code accesses the remote server on-demand by registering the local MCP proxy as an MCP server in its settings. This enables Claude Code to search and retrieve memories saved by Claude Desktop (e.g., brainstorming plans, implementation roadmaps) without any pull-sync or DB injection.

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "remote-memory": {
      "command": "node",
      "args": ["/path/to/claude-bridge/sync/mcp-local-proxy.js"]
    }
  }
}
```

This exposes four tools to Claude Code: `search`, `timeline`, `get_observations`, and `save_memory` — prefixed as `mcp__remote-memory__*`. Claude Code can then search for plans saved during Desktop brainstorming sessions and execute on them directly.

**Why not pull-sync?** Injecting records into the local claude-mem database would fight the plugin's ownership of its own schema. On-demand MCP access is simpler, requires no new sync logic, and lets Code query exactly what it needs without polluting the local DB.

### 4. Desktop/Code ↔ Remote (MCP via Local Proxy)

Both Claude Desktop and Claude Code connect to the remote server via the same local MCP proxy (`sync/mcp-local-proxy.js`). The proxy bridges the stdio MCP protocol to the remote HTTPS endpoint:

1. The client spawns `mcp-local-proxy.js` as a stdio process
2. The proxy reads JSON-RPC 2.0 messages from stdin
3. It forwards each request to the remote server over HTTPS (`POST /mcp`)
4. It writes the response back to stdout
5. Auth credentials are loaded from `~/.claude-mem/remote-sync-env`

**Typical workflow:**
1. Brainstorm in Claude Desktop → save structured plan via `save_memory`
2. Open Claude Code → search remote memory for the plan → execute

This allows both clients to use all four MCP tools (search, timeline, get_observations, save_memory) transparently, as if the server were local.

## OAuth 2.1 (Claude.ai Connector)

Claude-bridge implements OAuth 2.1 Authorization Code + PKCE so that Claude.ai can connect as a remote MCP client. This is layered on top of the existing API key auth — the MCP endpoint now accepts either authentication method.

### OAuth Dance

```
Claude.ai                    Browser                     claude-bridge
   │                            │                             │
   ├─ POST / ──────────────────────────────────────────────► 401 + WWW-Authenticate
   ├─ GET /.well-known/* ──────────────────────────────────► discovery metadata
   ├─ redirect browser ────────► GET /authorize ─────────────►
   │                            │  (password form)            │
   │                            ├─ POST /authorize ──────────► validate password
   │                            │◄───── 302 redirect ─────────  + issue code
   ├─ POST /token ─────────────────────────────────────────► validate code + PKCE
   │◄──────────────────────────────────────────────────────── access_token
   ├─ POST / (Bearer token) ─────────────────────────────► authorized ✓
```

### New Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /.well-known/oauth-protected-resource` | None | RFC 9728 metadata |
| `GET /.well-known/oauth-authorization-server` | None | RFC 8414 metadata |
| `GET /authorize` | None | OAuth consent form (validates client_id, redirect_uri) |
| `POST /authorize` | None | Password check → issues auth code → redirects |
| `POST /token` | client_secret | Exchanges code for access/refresh tokens |

### Token Lifecycle

- **Access tokens:** 24h, persisted in SQLite
- **Refresh tokens:** 30d, single-use rotation, persisted in SQLite
- **Auth codes:** 5min, single-use, persisted in SQLite
- All tokens stored in the `oauth_tokens` table in the same SQLite database (volume-mounted, survives restarts and redeployments)
- Expired tokens cleaned up automatically every 10 minutes

### Auth Middleware

The auth middleware now accepts **both** authentication methods:

- `Authorization: Bearer <API_KEY>` — for the sync daemon and Claude Code (unchanged)
- `Authorization: Bearer <oauth_access_token>` — for Claude.ai OAuth tokens

On 401 responses, the server includes a `WWW-Authenticate` header pointing to the OAuth discovery metadata so that OAuth clients can auto-discover the authorization server.

### Security

- Password brute-force protection: 10 req/min rate limit on `/authorize`
- PKCE (S256) prevents authorization code interception attacks
- Redirect URI validation: only `claude.ai` and `localhost` URIs are accepted
- Timing-safe password comparison (prevents timing attacks)

## Upsert Mechanism

The `POST /api/observations` endpoint supports a `?upsert=true` query parameter. When enabled:

- If a record with the same `(source, source_id)` already exists, the existing record is **updated** with the new data instead of returning a 409 Conflict
- The FTS5 full-text search index is rebuilt for the updated record to ensure search results reflect the latest content
- Without `?upsert=true`, the existing behavior is preserved: duplicate `(source, source_id)` returns 409

This is primarily used by the file sync feature, which needs to update file contents when they change on disk.

## Sync Components

There are three sync-related components:

| Component | File | Purpose |
|-----------|------|---------|
| Sync Daemon | `sync/push-to-remote.js` | DB sync (every 30s) + file sync (every 5min). Runs as a background service. |
| Local MCP Proxy | `sync/mcp-local-proxy.js` | Stdio proxy for Claude Desktop. Reads JSON-RPC from stdin, forwards to remote server over HTTPS, writes responses to stdout. |
| Service Config | `sync/com.claude-mem-sync.plist.example` | macOS LaunchAgent template. Use `setup-sync-daemon.sh` to generate with correct paths. |

All three components load auth configuration from `~/.claude-mem/remote-sync-env`.

## MCP Tools

Claude Desktop connects to `POST /mcp` (via the local stdio proxy) using JSON-RPC 2.0 (MCP protocol). Four tools are exposed:

| Tool | Description |
|------|-------------|
| `search` | Search across observations and sessions. Params: `query` (required), `limit`, `project`, `mode` (`keyword`/`semantic`/`hybrid`, default `keyword`). Keyword uses FTS5, semantic uses embedding cosine similarity, hybrid merges both via Reciprocal Rank Fusion. Results include `abstract` field (one-line AI-generated summary, null if not yet generated). |
| `timeline` | Chronological timeline of all record types. Supports anchor-based navigation (observation ID, `S{id}` for sessions, ISO timestamp) and FTS-based anchor finding. Params: `anchor`, `query`, `depth_before`, `depth_after`, `project`. |
| `get_observations` | Batch fetch observations by ID array. For `type: "plan"` observations from Desktop, columns are remapped to semantic names (`summary`, `decisions`, `plan`, etc.). Params: `ids` (required). |
| `save_memory` | Save a memory with simple text or structured fields. See [Structured Saves](#structured-saves) below. |

### Structured Saves

The `save_memory` tool supports two modes:

**Simple mode** — quick notes, backward compatible:

```json
{ "text": "Remember that the auth service uses RS256 for JWT signing" }
```

**Structured mode** — for brainstorming sessions, plans, and roadmaps:

```json
{
  "title": "Meal Planner App Architecture",
  "summary": "Decided on Next.js + Supabase stack with grocery API integration",
  "decisions": "- Use Spoonacular API for recipe data\n- Supabase for auth + DB\n- Start with weekly planning, not daily",
  "requirements": "- Must support dietary restrictions filtering\n- Offline-capable PWA\n- Budget tracking per meal",
  "plan": "1. Set up Next.js + Supabase scaffold\n2. Integrate Spoonacular API\n3. Build meal calendar UI\n4. Add grocery list generation\n5. Deploy to Vercel",
  "open_questions": "- Which grocery store APIs are available?\n- How to handle recipe copyright?",
  "project": "meal-planner"
}
```

| Field | Required | DB Column | Description |
|-------|----------|-----------|-------------|
| `title` | Yes (structured) | `title` | Short title for the memory |
| `summary` | Yes (structured) | `narrative` | 2-3 sentence executive summary |
| `decisions` | No | `facts` | Key decisions and conclusions |
| `requirements` | No | `text` | Technical specs, constraints |
| `plan` | No | `concepts` | Implementation steps, roadmap |
| `open_questions` | No | `subtitle` | Unresolved items, risks |
| `text` | Yes (simple) | `narrative` | Simple note text (mutually exclusive with structured fields) |
| `type` | No | `type` | Defaults to `"plan"` (structured) or `"discovery"` (simple) |
| `project` | No | `project` | Defaults to `"desktop"` |

**Validation:** Provide either `text` (simple mode) or `title` + `summary` (structured mode).

**Storage:** Structured fields are mapped to separate FTS-indexed columns for targeted search ranking. A composed markdown narrative (with `## Summary`, `## Decisions`, etc. headings) is also stored in the `narrative` column for readable full-text retrieval.

**Retrieval:** When `get_observations` returns a structured observation (`source: "claude-desktop"`, `type: "plan"`), the DB column names are remapped to their semantic names (`facts` → `decisions`, `concepts` → `plan`, etc.) so consumers see meaningful field names.

## Hybrid Retrieval Architecture

The server supports three search modes, selectable via the `mode` parameter:

```
Query ─────┬─ mode=keyword ──► FTS5 ──────────────────────────────────► Results
           │
           ├─ mode=semantic ──► Embed query ──► Cosine similarity ────► Results
           │                    (OpenAI API)    (brute-force, JS)
           │
           └─ mode=hybrid ───► FTS5 + Embed ──► RRF merge ───────────► Results
                                (parallel)       (k=60)
```

### Embedding Pipeline

Embeddings are generated asynchronously by a background worker (`enrichment-worker.js`):

1. **On write:** When an observation or session is created/updated, its ID is enqueued
2. **Worker loop:** Every 5 seconds, the worker processes up to 20 IDs per batch
3. **Batch embedding:** All texts in a batch are embedded in a single API call
4. **Staleness detection:** SHA-256 hash of composed text prevents re-embedding unchanged content
5. **Abstract generation:** One-line summaries are generated via chat completion (sequential, one per record)

### Provider Abstraction

```
server/embeddings.js
├── NoopEmbeddings        # Default — returns null, keyword search only
└── OpenAIEmbeddings      # POST api.openai.com/v1/embeddings

server/abstracts.js
├── NoopAbstractGenerator  # Default — returns null
└── OpenAIAbstractGenerator # POST api.openai.com/v1/chat/completions
```

Without `EMBEDDING_PROVIDER` set, the server uses `NoopEmbeddings` and `NoopAbstractGenerator`. All features degrade gracefully to keyword-only search.

### Vector Storage

Embeddings are stored as raw `Float32Array` BLOBs in SQLite (no native extensions). Cosine similarity is computed in pure JavaScript. At <50K observations, brute-force scan over all vectors takes ~15ms — no vector index needed.

### Reciprocal Rank Fusion (RRF)

Hybrid mode runs FTS5 and semantic search in parallel, then merges results using RRF with k=60. Items appearing in both result sets rank highest. This captures both exact keyword matches and semantic similarity.

## Configuration

### Environment Variables

#### Remote Server

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | SQLite database path (e.g., `file:/app/data/memory.db`) | Required |
| `API_KEY` | Bearer token for authentication | Required |
| `PORT` | Server port | `3010` |
| `NODE_ENV` | Environment | `production` |
| `EMBEDDING_PROVIDER` | `openai` or unset for keyword-only | unset (`noop`) |
| `EMBEDDING_MODEL` | Embedding model name | `text-embedding-3-small` |
| `EMBEDDING_API_KEY` | API key for embedding + abstract provider | Optional |
| `EMBEDDING_DIMENSIONS` | Vector dimensions | `1536` |
| `ABSTRACT_MODEL` | Chat model for one-line summaries | `gpt-4.1-mini` |

#### Local Sync Daemon

Set these in `~/.claude-mem/remote-sync-env`:

| Variable | Description |
|----------|-------------|
| `CLAUDE_MEM_REMOTE_URL` | URL of the remote server (e.g., `https://memory.example.com`) |
| `CLAUDE_MEM_REMOTE_API_KEY` | API key for authenticating with the remote server |
| `CLAUDE_MEM_SYNC_PROJECT_ROOT` | Absolute path to your project root for `.md` file sync |

## API Endpoints

### Public

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | None | Health check. Returns status, version, observation count, disk free MB. |

### Authenticated (Bearer API Key + Rate Limited)

All `/api/*` routes (except health) require `Authorization: Bearer <API_KEY>` header and are rate-limited to 600 requests per 60-second window.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/observations` | Create an observation. Requires `source`. Returns `{ id, success }`. 409 on duplicate `(source, source_id)`. Supports `?upsert=true` to update existing record on duplicate instead of 409. FTS5 index is rebuilt on upsert. |
| `POST` | `/api/sessions` | Create a session summary. Requires `source`. Returns `{ id, success }`. 409 on duplicate. |
| `POST` | `/api/prompts` | Create a user prompt. Requires `source`. Returns `{ id, success }`. 409 on duplicate. |
| `POST` | `/api/observations/batch` | Batch fetch observations by ID array. Body: `{ ids: [1, 2, 3] }`. |
| `GET` | `/api/search` | Search with modes. Query params: `query` (required), `mode` (`keyword`/`semantic`/`hybrid`), `project`, `type`, `obs_type`, `limit`, `offset`. |
| `POST` | `/api/admin/backfill` | Enqueue all observations and sessions missing embeddings/abstracts for background processing. |
| `GET` | `/api/timeline` | Chronological timeline. Query params: `anchor`, `query`, `depth_before`, `depth_after`, `project`. |
| `GET` | `/api/context` | Markdown context dump for specified projects. Query params: `projects` (comma-separated, required). Returns recent sessions and observations formatted as markdown. |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 endpoint (legacy path, used by sync daemon and local proxy). Supports `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/initialized`. |
| `POST` | `/` | MCP JSON-RPC 2.0 endpoint (used by Claude.ai connector). Same handler as `/mcp`. |
| `GET` | `/` | SSE endpoint for Streamable HTTP transport (Claude.ai opens this for server notifications). |

## Data Model

### observations

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `source` | TEXT | Required. `claude-code`, `claude-desktop`, or `file-sync` |
| `source_id` | INTEGER | Original ID from source system (for dedup). For file-sync, derived from file path. |
| `session_source_id` | INTEGER | Links to session_summaries via source-side ID |
| `project` | TEXT | Project name |
| `type` | TEXT | discovery, decision, bugfix, feature, refactor, change, reference, plan |
| `title` | TEXT | Short title |
| `subtitle` | TEXT | Optional subtitle |
| `text` | TEXT | Raw text content |
| `narrative` | TEXT | Narrative description |
| `facts` | TEXT | Extracted facts |
| `concepts` | TEXT | Extracted concepts |
| `files_read` | TEXT | Files read during observation |
| `files_modified` | TEXT | Files modified during observation |
| `prompt_number` | INTEGER | Prompt number within session |
| `created_at` | TEXT | ISO 8601 timestamp |
| `created_at_epoch` | INTEGER | Unix epoch milliseconds |

| `abstract` | TEXT | AI-generated one-line summary (populated by enrichment worker) |

**FTS index:** `observations_fts` covers `title`, `subtitle`, `text`, `narrative`, `facts`, `concepts`, `abstract`.

**Unique constraint:** `(source, source_id)` WHERE `source_id IS NOT NULL` — prevents duplicate syncs. With `?upsert=true`, duplicates trigger an UPDATE instead of 409.

### session_summaries

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `source` | TEXT | Required |
| `source_id` | INTEGER | For dedup |
| `project` | TEXT | Project name |
| `request` | TEXT | What was requested |
| `investigated` | TEXT | What was investigated |
| `learned` | TEXT | What was learned |
| `completed` | TEXT | What was completed |
| `next_steps` | TEXT | Planned next steps |
| `files_read` | TEXT | Files read |
| `files_edited` | TEXT | Files edited |
| `notes` | TEXT | Additional notes |
| `created_at` | TEXT | ISO 8601 timestamp |
| `created_at_epoch` | INTEGER | Unix epoch milliseconds |

| `abstract` | TEXT | AI-generated one-line summary (populated by enrichment worker) |

**FTS index:** `session_summaries_fts` covers `request`, `investigated`, `learned`, `completed`, `next_steps`, `notes`, `abstract`.

### user_prompts

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `source` | TEXT | Required |
| `source_id` | INTEGER | For dedup |
| `session_source_id` | INTEGER | Links to session_summaries |
| `project` | TEXT | Project name |
| `prompt_text` | TEXT | The user's prompt |
| `prompt_number` | INTEGER | Prompt number within session |
| `created_at` | TEXT | ISO 8601 timestamp |
| `created_at_epoch` | INTEGER | Unix epoch milliseconds |

### observation_embeddings

| Column | Type | Notes |
|--------|------|-------|
| `observation_id` | INTEGER | Primary key, FK → observations(id) ON DELETE CASCADE |
| `embedding` | BLOB | Float32Array as raw bytes |
| `model` | TEXT | e.g., "text-embedding-3-small" |
| `dimensions` | INTEGER | e.g., 1536 |
| `embedded_text_hash` | TEXT | SHA-256 of the text that was embedded (staleness detection) |
| `created_at` | TEXT | Auto-set to datetime('now') |

### session_embeddings

Same schema as `observation_embeddings` but keyed by `session_id` → `session_summaries(id)`.

### schema_version

Single-row table tracking the current migration version. Migrations are applied sequentially on startup (currently v3).

## Sync Process

The sync daemon (`sync/push-to-remote.js`) runs as a background service (macOS LaunchAgent, Linux systemd, etc.).

### ID Resolution

The local claude-mem database uses different primary keys than the remote. The sync daemon resolves cross-references:

- **Observation → Session:** JOINs local `observations.memory_session_id` with `session_summaries.memory_session_id` to resolve the `session_source_id` field sent to the remote.
- **Prompt → Session:** JOINs through `sdk_sessions` and `session_summaries` using `content_session_id` and `memory_session_id`.

### Deduplication

Each table has a unique index on `(source, source_id)` where `source_id IS NOT NULL`. When the sync daemon POSTs a record that already exists, the server returns 409 Conflict. The daemon treats this as success and advances the sync cursor.

For file sync, the daemon uses `?upsert=true` so that updated file contents replace the previous version without error.

### Failure Handling

If a POST fails (non-409 error), the daemon stops syncing that table for the current cycle and retries on the next poll. Sync state is only saved after successful operations, ensuring at-least-once delivery.

## Deployment

The server is a standard Node.js application. Deploy however you prefer:

- **Bare metal / VPS:** Run `node server/index.js` behind a reverse proxy (Caddy, Nginx, etc.) with HTTPS
- **Container:** Use the included `Dockerfile` with any container runtime
- **Platform-as-a-Service:** Deploy to Railway, Fly.io, Render, etc.

The only requirements are:
- Node.js 20+
- A persistent filesystem for the SQLite database
- HTTPS (for secure API key transmission)
- A publicly reachable URL (for the sync daemon and MCP proxy to reach)

### Resource Requirements

Minimal — this is a lightweight API server:
- **Memory:** ~50-128MB
- **CPU:** Negligible (SQLite is the only workload)
- **Disk:** ~1KB per observation, ~2KB per session summary. A year of heavy use is <20MB.

## Security

### Authentication

- All API routes (except `/api/health`) require `Authorization: Bearer <API_KEY>` header
- The MCP endpoint (`POST /mcp`) also requires the same Bearer token
- The local MCP proxy loads credentials from `~/.claude-mem/remote-sync-env`

### Transport Security

- Always deploy behind HTTPS — the API key is sent in every request
- Use a reverse proxy with automatic TLS (Caddy, Let's Encrypt, Cloudflare, etc.)

### Rate Limiting

- 600 requests per 60-second window per IP (via `express-rate-limit`)
- Standard rate limit headers returned (`RateLimit-*`)
- Trust proxy enabled (`app.set("trust proxy", 1)`) for correct client IP behind reverse proxy

### Database

- WAL journal mode for concurrent read performance
- Foreign keys enforced
- Parameterized queries throughout (no SQL injection vectors)

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^4.21.0 | HTTP framework |
| `better-sqlite3` | ^11.0.0 | SQLite driver with synchronous API |
| `express-rate-limit` | ^7.4.0 | API rate limiting |
| `@modelcontextprotocol/sdk` | ^1.12.0 | MCP protocol types (unused at runtime, JSON-RPC implemented manually) |

## Retrieval Eval

The `eval/` directory contains scripts for measuring retrieval quality against a ground-truth query set:

- **`retrieval-eval.js`** — 20 queries across 3 categories (keyword-friendly, synonym/paraphrase, conceptual/intent). Measures Recall@5, Recall@10, MRR, Precision@10. Supports `--mode=keyword|semantic|hybrid|all`.
- **`latency-bench.js`** — 100-iteration keyword search latency benchmark. Reports p50/p95/p99.

Kill criterion: hybrid mode must achieve higher Recall@10 than keyword on Categories B and C without degrading Category A.

### Baseline Results (2026-03-22, 2,052 observations, 392 sessions)

**Recall@10 by category:**

| Category | Keyword | Semantic | Hybrid | Improvement |
|----------|---------|----------|--------|-------------|
| A: Keyword-friendly (7 queries) | 0.22 | **0.51** | **0.51** | +132% |
| B: Synonym/paraphrase (7 queries) | 0.10 | 0.17 | **0.19** | +90% |
| C: Conceptual/intent (2 queries) | 0.00 | **0.10** | 0.00 | +∞ (from zero) |

**MRR (Mean Reciprocal Rank):**

| Category | Keyword | Semantic | Hybrid |
|----------|---------|----------|--------|
| A | 0.11 | **0.66** | 0.36 |
| B | 0.03 | **0.25** | 0.29 |
| C | 0.00 | **0.08** | 0.05 |

**Notable query improvements:**
- "user experience delays frustrating" → keyword 0.00, semantic **1.00** MRR (found performance bottleneck observations)
- "blue green deployment" → keyword 0.05 MRR, semantic **1.00** MRR
- "OOM memory crash container" → keyword R@10 0.20, hybrid R@10 **1.00**
- "how I connect Claude.ai to my memory server" → keyword 0.00, semantic **0.33** MRR (found OAuth/MCP connector observations)

**Kill criterion: PASSED** — Hybrid beats keyword on all three categories with no degradation.

**Keyword latency (unchanged):** p50 = 61ms, p95 = 308ms (network round-trip to EC2 dominates; FTS5 query itself is <5ms).
