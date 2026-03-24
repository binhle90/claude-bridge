const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("Search Filters", () => {
  it("parseTimestamp handles relative days", () => {
    const { parseTimestamp } = require("../server/search-filters");
    const result = parseTimestamp("7d");
    const expected = Date.now() - 7 * 86400000;
    assert.ok(Math.abs(result - expected) < 1000);
  });

  it("parseTimestamp handles relative hours", () => {
    const { parseTimestamp } = require("../server/search-filters");
    const result = parseTimestamp("24h");
    const expected = Date.now() - 24 * 3600000;
    assert.ok(Math.abs(result - expected) < 1000);
  });

  it("parseTimestamp handles ISO 8601", () => {
    const { parseTimestamp } = require("../server/search-filters");
    const result = parseTimestamp("2026-03-16T00:00:00Z");
    assert.strictEqual(result, new Date("2026-03-16T00:00:00Z").getTime());
  });

  it("parseTimestamp returns null for invalid input", () => {
    const { parseTimestamp } = require("../server/search-filters");
    assert.strictEqual(parseTimestamp(null), null);
    assert.strictEqual(parseTimestamp(""), null);
    assert.strictEqual(parseTimestamp(undefined), null);
    assert.strictEqual(parseTimestamp("garbage"), null);
  });

  it("buildFilterClauses generates correct SQL for all filters", () => {
    const { buildFilterClauses } = require("../server/search-filters");
    const { clauses, params } = buildFilterClauses({
      obs_type: "decision",
      source: "claude-desktop",
      after: "2026-03-16T00:00:00Z",
      before: "2026-03-20T00:00:00Z",
    });
    assert.strictEqual(clauses.length, 4);
    assert.ok(clauses[0].includes("type = ?"));
    assert.ok(clauses[1].includes("source = ?"));
    assert.ok(clauses[2].includes("created_at_epoch > ?"));
    assert.ok(clauses[3].includes("created_at_epoch < ?"));
    assert.strictEqual(params[0], "decision");
    assert.strictEqual(params[1], "claude-desktop");
    assert.strictEqual(typeof params[2], "number");
    assert.strictEqual(typeof params[3], "number");
  });

  it("buildFilterClauses skips missing filters", () => {
    const { buildFilterClauses } = require("../server/search-filters");
    const { clauses, params } = buildFilterClauses({});
    assert.strictEqual(clauses.length, 0);
    assert.strictEqual(params.length, 0);
  });

  it("buildFilterClauses uses custom table alias", () => {
    const { buildFilterClauses } = require("../server/search-filters");
    const { clauses } = buildFilterClauses({ obs_type: "plan" }, "ss");
    assert.ok(clauses[0].startsWith("ss."));
  });

  it("buildFilterClauses handles relative time in after/before", () => {
    const { buildFilterClauses } = require("../server/search-filters");
    const { clauses, params } = buildFilterClauses({ after: "7d", before: "1d" });
    assert.strictEqual(clauses.length, 2);
    assert.ok(params[0] < params[1], "after (7d ago) should be earlier than before (1d ago)");
  });
});
