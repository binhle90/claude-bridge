#!/usr/bin/env node
/**
 * Local MCP stdio proxy for Claude Desktop.
 * Reads JSON-RPC from stdin, forwards to remote memory server, writes response to stdout.
 *
 * Env vars (from ~/.claude-mem/remote-sync-env):
 *   CLAUDE_MEM_REMOTE_URL — e.g. https://memory.example.com
 *   CLAUDE_MEM_REMOTE_API_KEY — Bearer token
 */

const { createInterface } = require("readline");
const { existsSync, readFileSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

const ENV_PATH = join(homedir(), ".claude-mem", "remote-sync-env");

// Load env
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?(\w+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const REMOTE_URL = process.env.CLAUDE_MEM_REMOTE_URL;
const API_KEY = process.env.CLAUDE_MEM_REMOTE_API_KEY;

if (!REMOTE_URL || !API_KEY) {
  process.stderr.write("Missing CLAUDE_MEM_REMOTE_URL or CLAUDE_MEM_REMOTE_API_KEY in ~/.claude-mem/remote-sync-env\n");
  process.exit(1);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleMessage(msg) {
  const { id, method } = msg;

  // Handle initialize locally (must respond before forwarding)
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-bridge", version: "1.0.0" },
      },
    });
    return;
  }

  // Notifications don't need a response
  if (method === "notifications/initialized") {
    return;
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Forward everything else to the remote server
  try {
    const res = await fetch(`${REMOTE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Remote returned ${res.status}` },
      });
      return;
    }

    const result = await res.json();
    send(result);
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Remote error: ${err.message}` },
    });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    await handleMessage(msg);
  } catch (err) {
    process.stderr.write(`Parse error: ${err.message}\n`);
  }
});
rl.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
