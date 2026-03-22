const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const TEST_API_KEY = "test-secret-key-12345";

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
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const AUTH = { Authorization: `Bearer ${TEST_API_KEY}` };

function jsonrpc(method, params, id) {
  return { jsonrpc: "2.0", method, params, id };
}

describe("MCP Endpoint", () => {
  let server;
  let baseUrl;

  before(async () => {
    process.env.API_KEY = TEST_API_KEY;
    const { createApp } = require("../server/index");
    const { app } = createApp(":memory:");
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Seed 1 observation for search testing
    await request(baseUrl, "POST", "/api/observations", {
      body: {
        source: "claude-code",
        source_id: 801,
        project: "my-app",
        type: "discovery",
        title: "MCP integration pattern",
        narrative:
          "Discovered how to wire MCP endpoints into Express for Claude Desktop",
        text: "MCP uses JSON-RPC 2.0 over HTTP",
        created_at: "2026-01-01T10:00:00Z",
        created_at_epoch: 1767261600000,
      },
      headers: AUTH,
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // --- Auth ---
  it("POST /mcp without auth returns 401", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc("ping", {}, 1),
    });
    assert.strictEqual(res.status, 401);
    assert.ok(res.body.error);
  });

  // --- initialize ---
  it("POST /mcp handles initialize", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        1
      ),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, 1);
    assert.ok(res.body.result);
    assert.ok(res.body.result.protocolVersion);
    assert.ok(res.body.result.serverInfo);
    assert.strictEqual(res.body.result.serverInfo.name, "claude-memory");
    assert.ok(res.body.result.capabilities);
  });

  // --- ping ---
  it("POST /mcp handles ping", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc("ping", {}, 2),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, 2);
    assert.deepStrictEqual(res.body.result, {});
  });

  // --- tools/list ---
  it("POST /mcp handles tools/list (returns 4+ tools including search, save_memory)", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc("tools/list", {}, 3),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, 3);
    assert.ok(res.body.result);
    assert.ok(Array.isArray(res.body.result.tools));
    assert.ok(res.body.result.tools.length >= 4);

    const toolNames = res.body.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("search"), "should include search tool");
    assert.ok(
      toolNames.includes("save_memory"),
      "should include save_memory tool"
    );
    assert.ok(
      toolNames.includes("timeline"),
      "should include timeline tool"
    );
    assert.ok(
      toolNames.includes("get_observations"),
      "should include get_observations tool"
    );

    // Check that tools have inputSchema
    for (const tool of res.body.result.tools) {
      assert.ok(tool.inputSchema, `${tool.name} should have inputSchema`);
      assert.strictEqual(tool.inputSchema.type, "object");
    }
  });

  // --- tools/call search ---
  it("POST /mcp handles tools/call search (returns content array)", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc(
        "tools/call",
        { name: "search", arguments: { query: "MCP" } },
        4
      ),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, 4);
    assert.ok(res.body.result);
    assert.ok(Array.isArray(res.body.result.content));
    assert.ok(res.body.result.content.length >= 1);
    assert.strictEqual(res.body.result.content[0].type, "text");
    // The text should contain something about the seeded observation
    const text = res.body.result.content[0].text;
    assert.ok(text.includes("MCP") || text.includes("integration"));
  });

  // --- tools/call save_memory ---
  it("POST /mcp handles tools/call save_memory (creates observation, returns success)", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc(
        "tools/call",
        {
          name: "save_memory",
          arguments: {
            text: "This is a memory saved from Claude Desktop via MCP",
            title: "Desktop memory test",
            type: "note",
            project: "desktop-test",
          },
        },
        5
      ),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, 5);
    assert.ok(res.body.result);
    assert.ok(Array.isArray(res.body.result.content));
    assert.strictEqual(res.body.result.content[0].type, "text");
    const parsed = JSON.parse(res.body.result.content[0].text);
    assert.ok(parsed.success);
    assert.strictEqual(typeof parsed.id, "number");

    // Verify it was actually saved by searching for it
    const searchRes = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc(
        "tools/call",
        { name: "search", arguments: { query: "Desktop" } },
        6
      ),
      headers: AUTH,
    });
    assert.strictEqual(searchRes.status, 200);
    const searchText = searchRes.body.result.content[0].text;
    assert.ok(
      searchText.includes("Desktop") || searchText.includes("desktop"),
      "Saved memory should be searchable"
    );
  });

  // --- notifications/initialized ---
  it("POST /mcp handles notifications/initialized with 204", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      headers: AUTH,
    });
    assert.strictEqual(res.status, 204);
  });

  // --- unknown method ---
  it("POST /mcp returns error for unknown method", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc("unknown/method", {}, 99),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, 99);
    assert.ok(res.body.error);
    assert.strictEqual(res.body.error.code, -32601);
  });

  // --- tools/call with unknown tool ---
  it("POST /mcp returns error for unknown tool", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc(
        "tools/call",
        { name: "nonexistent", arguments: {} },
        100
      ),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.result);
    assert.ok(res.body.result.isError);
  });

  // --- save_memory defaults ---
  it("POST /mcp save_memory uses defaults when optional fields omitted", async () => {
    const res = await request(baseUrl, "POST", "/mcp", {
      body: jsonrpc(
        "tools/call",
        {
          name: "save_memory",
          arguments: {
            text: "A short memory without optional fields for testing defaults behavior",
          },
        },
        7
      ),
      headers: AUTH,
    });
    assert.strictEqual(res.status, 200);
    const parsed = JSON.parse(res.body.result.content[0].text);
    assert.ok(parsed.success);
    assert.strictEqual(typeof parsed.id, "number");
  });
});
