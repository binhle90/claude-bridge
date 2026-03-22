/**
 * Semantic search utilities: cosine similarity, RRF merge, and full semantic search.
 *
 * Embeddings are stored as Float32 BLOBs in SQLite. When retrieved via better-sqlite3,
 * the BLOB is a Node.js Buffer whose underlying ArrayBuffer may not be 4-byte aligned.
 * We copy into a fresh Buffer before wrapping in Float32Array to guarantee alignment.
 */

/**
 * Compute cosine similarity between two Float32Arrays.
 * Returns a value in [-1, 1]: 1.0 = identical direction, 0 = orthogonal, -1 = opposite.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reciprocal Rank Fusion: merge two ranked result lists into a single ranked list.
 * Items appearing in both lists receive higher combined scores.
 *
 * Each item is keyed by `${type}:${id}`. The first object seen for a key is preserved.
 *
 * @param {Array<{id: number, type: string}>} ftsResults   - FTS-ranked results
 * @param {Array<{id: number, type: string}>} semanticResults - Semantically-ranked results
 * @param {number} [k=60] - RRF smoothing constant (higher = less rank-sensitive)
 * @returns {Array}  merged results sorted by descending RRF score
 */
function mergeRRF(ftsResults, semanticResults, k = 60) {
  const scores = new Map();
  const objects = new Map();

  ftsResults.forEach((r, i) => {
    const key = `${r.type}:${r.id}`;
    scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    if (!objects.has(key)) objects.set(key, r);
  });

  semanticResults.forEach((r, i) => {
    const key = `${r.type}:${r.id}`;
    scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    if (!objects.has(key)) objects.set(key, r);
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => objects.get(key));
}

/**
 * Brute-force semantic search over stored Float32 embeddings.
 *
 * Embeds the query text, then computes cosine similarity against every stored embedding
 * for observations and session summaries. Returns top `limit` results by score.
 *
 * Throws "not configured" if the embedding provider returns null (e.g. NoopEmbeddings).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('./embeddings').EmbeddingProvider} embeddingProvider
 * @param {string} queryText
 * @param {{ limit?: number, project?: string }} [opts]
 * @returns {Promise<Array>}
 */
async function semanticSearch(db, embeddingProvider, queryText, { limit = 20, project } = {}) {
  const [queryVec] = await embeddingProvider.embed([queryText]);
  if (!queryVec) throw new Error("Semantic search not configured. Set EMBEDDING_PROVIDER.");

  const results = [];

  // --- Observations ---
  {
    const sql = `
      SELECT o.id, o.type, o.title, o.project, o.narrative, o.abstract,
             o.created_at_epoch, o.source,
             e.embedding, e.dimensions
      FROM observations o
      JOIN observation_embeddings e ON e.observation_id = o.id
      ${project ? "WHERE o.project = ?" : ""}
    `;
    const rows = db.prepare(sql).all(...(project ? [project] : []));

    for (const row of rows) {
      // Copy BLOB into a fresh, aligned Buffer before creating Float32Array
      const aligned = Buffer.allocUnsafe(row.embedding.length);
      row.embedding.copy(aligned);
      const stored = new Float32Array(aligned.buffer, aligned.byteOffset, row.dimensions);
      const score = cosineSimilarity(queryVec, stored);
      results.push({
        id: row.id,
        type: "observation",
        title: row.title,
        abstract: row.abstract || null,
        snippet: (row.narrative || row.title || "").slice(0, 200),
        project: row.project,
        created_at_epoch: row.created_at_epoch,
        source: row.source,
        obs_type: row.type,
        _score: score,
      });
    }
  }

  // --- Session summaries ---
  {
    const sql = `
      SELECT ss.id, ss.project, ss.request, ss.abstract,
             ss.created_at_epoch, ss.source,
             e.embedding, e.dimensions
      FROM session_summaries ss
      JOIN session_embeddings e ON e.session_id = ss.id
      ${project ? "WHERE ss.project = ?" : ""}
    `;
    const rows = db.prepare(sql).all(...(project ? [project] : []));

    for (const row of rows) {
      const aligned = Buffer.allocUnsafe(row.embedding.length);
      row.embedding.copy(aligned);
      const stored = new Float32Array(aligned.buffer, aligned.byteOffset, row.dimensions);
      const score = cosineSimilarity(queryVec, stored);
      results.push({
        id: row.id,
        type: "session",
        title: row.request,
        abstract: row.abstract || null,
        snippet: (row.request || "").slice(0, 200),
        project: row.project,
        created_at_epoch: row.created_at_epoch,
        source: row.source,
        obs_type: null,
        _score: score,
      });
    }
  }

  results.sort((a, b) => b._score - a._score);
  return results.slice(0, limit).map(({ _score, ...rest }) => rest);
}

module.exports = { cosineSimilarity, mergeRRF, semanticSearch };
