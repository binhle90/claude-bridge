#!/usr/bin/env node

/**
 * Measures p50/p95/p99 latency for keyword search.
 * Run before and after upgrade to detect regressions.
 *
 * Usage: CLAUDE_MEM_REMOTE_URL=... CLAUDE_MEM_REMOTE_API_KEY=... node eval/latency-bench.js
 */

const QUERIES = [
  "OAuth PKCE",
  "Docker container",
  "blue green deployment",
  "OOM memory crash",
  "claude-bridge MCP",
  "Redshore Kubernetes",
  "performance bottleneck",
  "deployment strategy",
  "report generation",
  "skill architecture",
];

async function bench(query) {
  const start = performance.now();
  const url = new URL("/api/search", process.env.CLAUDE_MEM_REMOTE_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "20");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.CLAUDE_MEM_REMOTE_API_KEY}` },
  });
  await res.json();
  return performance.now() - start;
}

async function main() {
  if (!process.env.CLAUDE_MEM_REMOTE_URL || !process.env.CLAUDE_MEM_REMOTE_API_KEY) {
    console.error("Required: CLAUDE_MEM_REMOTE_URL and CLAUDE_MEM_REMOTE_API_KEY");
    process.exit(1);
  }

  const iterations = 100;
  const allLatencies = [];

  for (let i = 0; i < iterations; i++) {
    const query = QUERIES[i % QUERIES.length];
    const latency = await bench(query);
    allLatencies.push(latency);
    if (i % 20 === 0) process.stdout.write(".");
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
