const { semanticSearch, mergeRRF } = require("./search-semantic");
const { keywordSearch } = require("./routes/search");

const PROTOCOL_VERSION = "2025-03-26";

const TOOL_DEFINITIONS = [
  {
    name: "search",
    description:
      "Full-text and semantic search across observations and sessions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        limit: {
          type: "number",
          description: "Maximum number of results (default 20, max 100)",
        },
        project: {
          type: "string",
          description: "Filter results to a specific project",
        },
        mode: {
          type: "string",
          enum: ["keyword", "semantic", "hybrid"],
          default: "hybrid",
          description:
            "keyword: FTS5 only. semantic: embedding similarity. hybrid: both, merged via RRF. Default is hybrid when embeddings are configured, keyword otherwise.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "timeline",
    description:
      "Retrieve a chronological timeline of observations, sessions, and prompts.",
    inputSchema: {
      type: "object",
      properties: {
        anchor: {
          type: "string",
          description:
            "Anchor point: observation ID (number), S{id} for session, or ISO timestamp",
        },
        query: {
          type: "string",
          description: "FTS query to find anchor automatically",
        },
        depth_before: {
          type: "number",
          description: "Number of items before anchor (default 10)",
        },
        depth_after: {
          type: "number",
          description: "Number of items after anchor (default 10)",
        },
        project: {
          type: "string",
          description: "Filter results to a specific project",
        },
      },
    },
  },
  {
    name: "get_observations",
    description: "Batch fetch observations by their IDs.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Array of observation IDs to fetch",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "save_memory",
    description:
      'Save a structured memory from a brainstorming or planning session. Use structured fields (summary, decisions, plan, etc.) for rich saves, or "text" for simple notes. Structured saves are more searchable and token-efficient on retrieval.',
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the memory (required for structured saves)",
        },
        text: {
          type: "string",
          description:
            "Simple memory text. Use this for quick notes. For richer saves, use the structured fields below instead.",
        },
        summary: {
          type: "string",
          description:
            "Executive summary of the session — the key takeaway in 2-3 sentences",
        },
        decisions: {
          type: "string",
          description:
            "Key decisions and conclusions reached during the session",
        },
        requirements: {
          type: "string",
          description:
            "Technical requirements, constraints, or specifications identified",
        },
        plan: {
          type: "string",
          description:
            "Implementation plan, roadmap, or ordered steps to execute",
        },
        open_questions: {
          type: "string",
          description:
            "Unresolved questions, risks, or items needing further investigation",
        },
        type: {
          type: "string",
          description:
            'Observation type: "plan", "discovery", "decision", "feature", "reference" (defaults to "plan" for structured, "discovery" for text-only)',
        },
        project: {
          type: "string",
          description: 'Project name (defaults to "desktop")',
        },
      },
      oneOf: [
        { required: ["text"] },
        { required: ["title", "summary"] },
      ],
    },
  },
];

async function handleSearch(db, args, { embeddingProvider } = {}) {
  const { query, project, mode: searchMode } = args;
  const hasEmbeddings = embeddingProvider && embeddingProvider.constructor.name !== "NoopEmbeddings";
  const mode = searchMode || (hasEmbeddings ? "hybrid" : "keyword");
  const limit = Math.min(parseInt(args.limit) || 20, 100);

  if (!query || !query.trim()) {
    return { content: [{ type: "text", text: JSON.stringify({ results: [], total: 0 }) }] };
  }

  let results;

  if (mode === "keyword") {
    results = keywordSearch(db, query, { project, limit });
  } else if (mode === "semantic") {
    if (!hasEmbeddings) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Semantic search not configured. Set EMBEDDING_PROVIDER.", results: [], total: 0 }) }] };
    }
    results = await semanticSearch(db, embeddingProvider, query, { limit, project });
  } else if (mode === "hybrid") {
    if (!embeddingProvider || embeddingProvider.constructor.name === "NoopEmbeddings") {
      results = keywordSearch(db, query, { project, limit });
    } else {
      const [ftsResults, semResults] = await Promise.all([
        Promise.resolve(keywordSearch(db, query, { project, limit: 50 })),
        semanticSearch(db, embeddingProvider, query, { limit: 50, project }),
      ]);
      results = mergeRRF(ftsResults, semResults).slice(0, limit);
    }
  } else {
    return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid mode: ${mode}` }) }], isError: true };
  }

  return { content: [{ type: "text", text: JSON.stringify({ results, total: results.length }) }] };
}

function handleTimeline(db, args) {
  const depthBefore = parseInt(args.depth_before) || 10;
  const depthAfter = parseInt(args.depth_after) || 10;
  const { project, anchor, query } = args;

  const items = [];

  // Observations
  let obsSql = "SELECT * FROM observations";
  const obsParams = [];
  if (project) {
    obsSql += " WHERE project = ?";
    obsParams.push(project);
  }
  for (const o of db.prepare(obsSql).all(...obsParams)) {
    items.push({ type: "observation", data: o, epoch: o.created_at_epoch || 0 });
  }

  // Session summaries
  let ssSql = "SELECT * FROM session_summaries";
  const ssParams = [];
  if (project) {
    ssSql += " WHERE project = ?";
    ssParams.push(project);
  }
  for (const s of db.prepare(ssSql).all(...ssParams)) {
    items.push({ type: "session", data: s, epoch: s.created_at_epoch || 0 });
  }

  // User prompts
  let upSql = "SELECT * FROM user_prompts";
  const upParams = [];
  if (project) {
    upSql += " WHERE project = ?";
    upParams.push(project);
  }
  for (const p of db.prepare(upSql).all(...upParams)) {
    items.push({ type: "prompt", data: p, epoch: p.created_at_epoch || 0 });
  }

  items.sort((a, b) => a.epoch - b.epoch);

  let anchorIdx = -1;

  if (anchor) {
    if (/^S\d+$/i.test(anchor)) {
      const sessionId = parseInt(anchor.slice(1));
      anchorIdx = items.findIndex((i) => i.type === "session" && i.data.id === sessionId);
    } else if (/^\d+$/.test(anchor)) {
      const obsId = parseInt(anchor);
      anchorIdx = items.findIndex((i) => i.type === "observation" && i.data.id === obsId);
    } else {
      const ts = new Date(anchor).getTime();
      if (!isNaN(ts)) {
        let minDist = Infinity;
        items.forEach((item, idx) => {
          const dist = Math.abs(item.epoch - ts);
          if (dist < minDist) {
            minDist = dist;
            anchorIdx = idx;
          }
        });
      }
    }
  } else if (query) {
    try {
      const obsMatch = db
        .prepare(
          `SELECT o.id FROM observations_fts fts
           JOIN observations o ON o.id = fts.rowid
           WHERE observations_fts MATCH ?
           LIMIT 1`
        )
        .get(query);
      if (obsMatch) {
        anchorIdx = items.findIndex((i) => i.type === "observation" && i.data.id === obsMatch.id);
      }
    } catch {
      // Invalid FTS query
    }
  }

  let result;
  if (anchorIdx >= 0) {
    const start = Math.max(0, anchorIdx - depthBefore);
    const end = Math.min(items.length, anchorIdx + depthAfter + 1);
    result = items.slice(start, end);
  } else {
    const total = depthBefore + depthAfter;
    result = items.slice(-total);
  }

  return { content: [{ type: "text", text: JSON.stringify({ items: result }) }] };
}

function formatObservation(row) {
  // Remap DB column names to semantic field names for structured Desktop observations
  if (row.source === "claude-desktop" && row.type === "plan") {
    return {
      id: row.id,
      source: row.source,
      project: row.project,
      type: row.type,
      title: row.title,
      summary: row.narrative,
      decisions: row.facts,
      requirements: row.text,
      plan: row.concepts,
      open_questions: row.subtitle,
      created_at: row.created_at,
      created_at_epoch: row.created_at_epoch,
    };
  }
  return row;
}

function handleGetObservations(db, args) {
  const { ids } = args;

  if (!Array.isArray(ids) || ids.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "ids must be a non-empty array" }) }],
      isError: true,
    };
  }

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`).all(...ids);

  return { content: [{ type: "text", text: JSON.stringify(rows.map(formatObservation)) }] };
}

function handleSaveMemory(db, args) {
  const { text, title, summary, decisions, requirements, plan, open_questions, type, project } = args;

  const isStructured = summary || decisions || requirements || plan || open_questions;

  if (!isStructured && (!text || !text.trim())) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Provide either 'text' for a simple note, or structured fields (summary, decisions, plan, etc.)" }) }],
      isError: true,
    };
  }

  // Compose a readable markdown narrative from structured fields
  let narrative;
  if (isStructured) {
    const sections = [];
    if (summary) sections.push(`## Summary\n${summary}`);
    if (decisions) sections.push(`## Decisions\n${decisions}`);
    if (requirements) sections.push(`## Requirements\n${requirements}`);
    if (plan) sections.push(`## Implementation Plan\n${plan}`);
    if (open_questions) sections.push(`## Open Questions\n${open_questions}`);
    narrative = sections.join("\n\n");
  } else {
    narrative = text;
  }

  const obsTitle = title || (summary || text || "").slice(0, 80);
  const obsType = type || (isStructured ? "plan" : "discovery");
  const obsProject = project || "desktop";
  const now = new Date();

  const insert = db.prepare(`
    INSERT INTO observations (
      source, source_id, session_source_id, project, type,
      title, subtitle, text, narrative, facts, concepts,
      files_read, files_modified, prompt_number,
      created_at, created_at_epoch
    ) VALUES (
      @source, @source_id, @session_source_id, @project, @type,
      @title, @subtitle, @text, @narrative, @facts, @concepts,
      @files_read, @files_modified, @prompt_number,
      @created_at, @created_at_epoch
    )
  `);

  const syncFts = db.prepare(`
    INSERT INTO observations_fts (rowid, title, subtitle, text, narrative, facts, concepts, abstract)
    SELECT id, title, subtitle, text, narrative, facts, concepts, abstract
    FROM observations WHERE id = ?
  `);

  // Map structured fields to existing columns for targeted FTS:
  //   summary    → narrative (primary search field, also gets composed markdown)
  //   decisions  → facts
  //   plan       → concepts
  //   requirements → text
  //   open_questions → subtitle
  const result = insert.run({
    source: "claude-desktop",
    source_id: null,
    session_source_id: null,
    project: obsProject,
    type: obsType,
    title: obsTitle,
    subtitle: open_questions || null,
    text: isStructured ? (requirements || null) : null,
    narrative,
    facts: decisions || null,
    concepts: plan || null,
    files_read: null,
    files_modified: null,
    prompt_number: null,
    created_at: now.toISOString(),
    created_at_epoch: now.getTime(),
  });

  syncFts.run(result.lastInsertRowid);

  const id = Number(result.lastInsertRowid);
  const saved = { success: true, id };
  if (isStructured) {
    saved.format = "structured";
    saved.fields = Object.keys({ summary, decisions, requirements, plan, open_questions }).filter(
      (k) => args[k]
    );
  }
  return {
    content: [{ type: "text", text: JSON.stringify(saved) }],
  };
}

function setupMcp(app, db, authMiddleware) {
  const toolHandlers = {
    search: (args) => handleSearch(db, args, { embeddingProvider: app.locals.embeddingProvider }),
    timeline: (args) => handleTimeline(db, args),
    get_observations: (args) => handleGetObservations(db, args),
    save_memory: (args) => {
      const result = handleSaveMemory(db, args);
      const parsed = JSON.parse(result.content[0].text);
      if (parsed.success && parsed.id && app.locals.enrichmentWorker) {
        app.locals.enrichmentWorker.enqueueObservation(parsed.id);
      }
      return result;
    },
  };

  // MCP handler — mounted at both /mcp (legacy) and / (Claude.ai sends to root)
  const mcpHandler = async (req, res) => {
    const { jsonrpc, method, params, id } = req.body;

    // Notifications have no id and expect no response body
    if (method === "notifications/initialized") {
      return res.status(204).end();
    }

    // JSON-RPC response helper
    function sendResult(result) {
      res.json({ jsonrpc: "2.0", id, result });
    }

    function sendError(code, message) {
      res.json({ jsonrpc: "2.0", id, error: { code, message } });
    }

    switch (method) {
      case "initialize":
        return sendResult({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "claude-memory", version: "1.0.0" },
        });

      case "ping":
        return sendResult({});

      case "tools/list":
        return sendResult({ tools: TOOL_DEFINITIONS });

      case "tools/call": {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        const handler = toolHandlers[toolName];

        if (!handler) {
          return sendResult({
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          });
        }

        try {
          const result = await handler(toolArgs);
          return sendResult(result);
        } catch (err) {
          return sendResult({
            content: [{ type: "text", text: `Tool error: ${err.message}` }],
            isError: true,
          });
        }
      }

      default:
        return sendError(-32601, `Method not found: ${method}`);
    }
  };

  app.post("/mcp", authMiddleware, mcpHandler);
  app.post("/", authMiddleware, mcpHandler);

  // Claude.ai opens GET / with Accept: text/event-stream for SSE notifications
  // We don't support server-initiated notifications, so return empty SSE that stays open
  app.get("/", authMiddleware, (req, res) => {
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Send initial comment to confirm connection
      res.write(": connected\n\n");
      // Keep alive — Claude.ai will close when done
      const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15000);
      req.on("close", () => clearInterval(keepAlive));
      return;
    }
    res.status(404).json({ error: "Not found" });
  });
}

module.exports = setupMcp;
