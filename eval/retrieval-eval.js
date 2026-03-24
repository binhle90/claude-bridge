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
  // Category A: Keyword-Friendly (FTS5 baseline should be high)
  { id: "A1", query: "OAuth PKCE token", expected_ids: [658, 659, 1089, 1090, 1091, 1092], category: "A", notes: "Direct keyword match" },
  { id: "A2", query: "Docker container Caddy reverse proxy", expected_ids: [33, 63, 82, 85, 152], category: "A", notes: "Infrastructure keywords match exactly" },
  { id: "A3", query: "blue green deployment", expected_ids: [63, 65, 154], category: "A", notes: "Technical term matches verbatim" },
  { id: "A4", query: "OOM memory crash container", expected_ids: [226, 227, 228, 229, 230], category: "A", notes: "Exact keyword overlap" },
  { id: "A5", query: "performance bottleneck slow", expected_ids: [809, 810], category: "A", notes: "Keywords appear verbatim" },
  { id: "A6", query: "Redshore Kubernetes admission", expected_ids: [108, 148, 181, 182, 184], category: "A", notes: "Project name + technical terms" },
  { id: "A7", query: "claude-bridge MCP protocol", expected_ids: [658, 659, 1081], category: "A", notes: "Product name + protocol name" },

  // Category B: Synonym/Paraphrase (FTS5 baseline should be low)
  { id: "B1", query: "making sure apps stay running when I push updates", expected_ids: [63, 154, 205, 230], category: "B", notes: "Natural language for zero-downtime deployment" },
  { id: "B2", query: "preventing data loss server crash", expected_ids: [226, 227, 228, 229, 230], category: "B", notes: "Semantic equivalent of OOM crash chain" },
  { id: "B3", query: "protecting against unauthorized access", expected_ids: [637, 1082, 1091, 1095], category: "B", notes: "Security concept, different vocabulary" },
  { id: "B4", query: "infrastructure setup hosting web apps HTTPS", expected_ids: [33, 63, 82, 85, 152], category: "B", notes: "Finds docs but misses deployment records" },
  { id: "B5", query: "user experience delays frustrating", expected_ids: [809, 810], category: "B", notes: "Natural language for performance bottleneck" },
  { id: "B6", query: "change governance compliance enforcement", expected_ids: [108, 502, 506], category: "B", notes: "Related but different vocabulary" },
  { id: "B7", query: "how I connect Claude.ai to my memory server", expected_ids: [1079, 1081, 1106, 1112, 1216, 1218], category: "B", notes: "Natural phrasing for OAuth/MCP connector" },

  // Category C: Conceptual/Intent (FTS5 baseline should be low)
  { id: "C1", query: "ideas that failed validation", expected_ids: [], category: "C", notes: "Requires understanding scoring context" },
  { id: "C2", query: "which ideas scored highest validation", expected_ids: [], category: "C", notes: "Requires ranking validation runs" },
  { id: "C3", query: "recurring technical risks idea validations", expected_ids: [], category: "C", notes: "Cross-observation pattern query" },
  { id: "C4", query: "lessons learned mistakes", expected_ids: [226, 227, 181, 809], category: "C", notes: "Intent: find retrospective observations" },
  { id: "C5", query: "build versus buy decision", expected_ids: [], category: "C", notes: "May not be synced to remote memory" },
  { id: "C6", query: "what architectural patterns do I reuse across projects", expected_ids: [33, 63, 152, 259, 637], category: "C", notes: "Meta-query about cross-project patterns" },

  // Category D: Filter-Assisted (structured filters improve precision)
  { id: "D1", query: "embeddings", filters: { obs_type: "decision", after: "30d" }, expected_ids: [2154], category: "D", notes: "obs_type=decision + recency filter narrows to Bedrock decision" },
  { id: "D2", query: "architecture", filters: { source: "file-sync", obs_type: "reference" }, expected_ids: [658, 659, 681], category: "D", notes: "Synced docs about architecture" },
  { id: "D3", query: "deployment", filters: { obs_type: "change", after: "7d" }, expected_ids: [], category: "D", notes: "Recent deployment changes — populate after checking" },
];

async function search(query, { mode = "keyword", limit = 20, project, filters = {} } = {}) {
  const url = new URL("/api/search", process.env.CLAUDE_MEM_REMOTE_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  if (mode !== "keyword") url.searchParams.set("mode", mode);
  if (project) url.searchParams.set("project", project);
  if (filters.obs_type) url.searchParams.set("obs_type", filters.obs_type);
  if (filters.source) url.searchParams.set("source", filters.source);
  if (filters.after) url.searchParams.set("after", filters.after);
  if (filters.before) url.searchParams.set("before", filters.before);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.CLAUDE_MEM_REMOTE_API_KEY}` },
  });
  const data = await res.json();
  return data.results || [];
}

function recallAtK(expectedIds, resultIds, k) {
  const topK = resultIds.slice(0, k);
  const hits = expectedIds.filter((id) => topK.includes(id));
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
  const hits = expectedIds.filter((id) => topK.includes(id));
  return hits.length / k;
}

async function runEval(modes = ["keyword"]) {
  const results = [];

  for (const testCase of EVAL_SET) {
    if (testCase.expected_ids.length === 0) {
      results.push({ ...testCase, skipped: true, reason: "No expected IDs defined" });
      continue;
    }

    const modeResults = {};
    for (const mode of modes) {
      const searchResults = await search(testCase.query, { mode, limit: 20, filters: testCase.filters });
      const resultIds = searchResults.map((r) => r.id);

      modeResults[mode] = {
        recall_5: recallAtK(testCase.expected_ids, resultIds, 5),
        recall_10: recallAtK(testCase.expected_ids, resultIds, 10),
        mrr: mrr(testCase.expected_ids, resultIds),
        precision_10: precisionAtK(testCase.expected_ids, resultIds, 10),
        top_10_ids: resultIds.slice(0, 10),
        total_returned: searchResults.length,
      };
    }

    results.push({ ...testCase, modeResults });
  }

  return results;
}

function formatReport(results, modes) {
  const lines = [];
  lines.push("# Retrieval Eval Results");
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push(`**Modes tested:** ${modes.join(", ")}`);
  lines.push("");

  for (const cat of ["A", "B", "C", "D"]) {
    const catResults = results.filter((r) => r.category === cat && !r.skipped);
    const catLabel = { A: "Keyword-Friendly", B: "Synonym/Paraphrase", C: "Conceptual/Intent", D: "Filter-Assisted" }[cat];
    lines.push(`## Category ${cat}: ${catLabel} (${catResults.length} queries)`);
    lines.push("");

    if (catResults.length === 0) {
      lines.push("*No testable queries (expected IDs not yet populated)*");
      lines.push("");
      continue;
    }

    const modeCols = modes.map((m) => `${m} R@5 | ${m} R@10 | ${m} MRR`).join(" | ");
    lines.push(`| Query | ${modeCols} |`);
    lines.push(`|-------|${modes.map(() => "-------|-------|-------").join("|")}|`);

    for (const r of catResults) {
      const vals = modes
        .map((m) => {
          const mr = r.modeResults[m];
          return `${(mr.recall_5 ?? 0).toFixed(2)} | ${(mr.recall_10 ?? 0).toFixed(2)} | ${mr.mrr.toFixed(2)}`;
        })
        .join(" | ");
      lines.push(`| ${r.id}: "${r.query}" | ${vals} |`);
    }

    for (const m of modes) {
      const avgR5 = catResults.reduce((s, r) => s + (r.modeResults[m]?.recall_5 ?? 0), 0) / catResults.length;
      const avgR10 = catResults.reduce((s, r) => s + (r.modeResults[m]?.recall_10 ?? 0), 0) / catResults.length;
      const avgMRR = catResults.reduce((s, r) => s + (r.modeResults[m]?.mrr ?? 0), 0) / catResults.length;
      lines.push(`| **${m} avg** | **${avgR5.toFixed(2)}** | **${avgR10.toFixed(2)}** | **${avgMRR.toFixed(2)}** |`);
    }
    lines.push("");
  }

  const skipped = results.filter((r) => r.skipped);
  if (skipped.length > 0) {
    lines.push(`## Skipped Queries (${skipped.length})`);
    lines.push("");
    for (const r of skipped) {
      lines.push(`- **${r.id}:** "${r.query}" — ${r.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  if (!process.env.CLAUDE_MEM_REMOTE_URL || !process.env.CLAUDE_MEM_REMOTE_API_KEY) {
    console.error("Required: CLAUDE_MEM_REMOTE_URL and CLAUDE_MEM_REMOTE_API_KEY");
    process.exit(1);
  }

  const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "all";
  const modes = modeArg === "all" ? ["keyword", "semantic", "hybrid"] : [modeArg];

  console.log(`Running eval with modes: ${modes.join(", ")}`);
  console.log(`Eval set: ${EVAL_SET.length} queries`);
  console.log("");

  const results = await runEval(modes);
  const report = formatReport(results, modes);

  const fs = await import("fs");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `eval/results-${timestamp}.md`;
  fs.mkdirSync("eval", { recursive: true });
  fs.writeFileSync(outPath, report);

  console.log(report);
  console.log(`\nResults written to ${outPath}`);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
