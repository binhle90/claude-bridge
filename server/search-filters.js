/**
 * Structured search filter utilities.
 *
 * Parses optional filter parameters (obs_type, source, after, before)
 * into parameterized SQL WHERE clauses for keyword and semantic search.
 */

/**
 * Parse a timestamp value into epoch milliseconds.
 * Accepts ISO 8601 strings or relative shorthand: "7d", "24h", "30d", "2h".
 *
 * @param {string|null|undefined} value
 * @returns {number|null} epoch milliseconds, or null if invalid/missing
 */
function parseTimestamp(value) {
  if (!value) return null;

  // Relative shorthand: "7d", "24h", "30d", "2h"
  const relMatch = value.match(/^(\d+)(h|d)$/);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const ms = unit === "h" ? amount * 3600000 : amount * 86400000;
    return Date.now() - ms;
  }

  // ISO 8601 timestamp (require at least YYYY-MM-DD to avoid ambiguous partials)
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  return null;
}

/**
 * Build parameterized SQL WHERE clauses from a filter object.
 *
 * @param {{ obs_type?: string, source?: string, after?: string, before?: string }} filters
 * @param {string} [tableAlias='o'] - SQL table alias prefix for column names
 * @returns {{ clauses: string[], params: (string|number)[] }}
 */
function buildFilterClauses(filters, tableAlias = "o") {
  const clauses = [];
  const params = [];

  if (filters.obs_type) {
    clauses.push(`${tableAlias}.type = ?`);
    params.push(filters.obs_type);
  }
  if (filters.source) {
    clauses.push(`${tableAlias}.source = ?`);
    params.push(filters.source);
  }

  const afterEpoch = parseTimestamp(filters.after);
  if (afterEpoch !== null) {
    clauses.push(`${tableAlias}.created_at_epoch > ?`);
    params.push(afterEpoch);
  }

  const beforeEpoch = parseTimestamp(filters.before);
  if (beforeEpoch !== null) {
    clauses.push(`${tableAlias}.created_at_epoch < ?`);
    params.push(beforeEpoch);
  }

  return { clauses, params };
}

module.exports = { parseTimestamp, buildFilterClauses };
