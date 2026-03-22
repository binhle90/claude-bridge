const { composeEmbeddingText, composeSessionEmbeddingText, hashText } = require("./embeddings");
const { buildObservationPrompt, buildSessionPrompt } = require("./abstracts");

class EnrichmentWorker {
  constructor({ db, embeddingProvider, abstractGenerator, batchSize = 20 }) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.abstractGenerator = abstractGenerator;
    this.batchSize = batchSize;
    this._obsQueue = new Set();
    this._sessionQueue = new Set();
    this._timer = null;
  }

  enqueueObservation(id) {
    this._obsQueue.add(id);
  }

  enqueueSession(id) {
    this._sessionQueue.add(id);
  }

  pendingObservations() {
    return [...this._obsQueue];
  }

  pendingSessions() {
    return [...this._sessionQueue];
  }

  start(intervalMs = 5000) {
    if (this._timer) return;
    this._timer = setInterval(() => this.processOneBatch().catch(err => {
      console.error(JSON.stringify({
        level: "error",
        message: "Enrichment worker batch error",
        error: err.message,
        timestamp: new Date().toISOString(),
      }));
    }), intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async processOneBatch() {
    const obsIds = [...this._obsQueue].slice(0, this.batchSize);
    if (obsIds.length > 0) {
      for (const id of obsIds) this._obsQueue.delete(id);
      await this._processObservationBatch(obsIds);
    }

    const sessionIds = [...this._sessionQueue].slice(0, this.batchSize);
    if (sessionIds.length > 0) {
      for (const id of sessionIds) this._sessionQueue.delete(id);
      await this._processSessionBatch(sessionIds);
    }
  }

  async _processObservationBatch(ids) {
    const items = [];
    for (const id of ids) {
      const obs = this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id);
      if (!obs) continue;
      const text = composeEmbeddingText(obs);
      const textHash = hashText(text);
      const existingEmb = this.db.prepare(
        "SELECT embedded_text_hash FROM observation_embeddings WHERE observation_id = ?"
      ).get(id);
      const needsEmbedding = !existingEmb || existingEmb.embedded_text_hash !== textHash;
      const needsAbstract = !obs.abstract || (existingEmb && existingEmb.embedded_text_hash !== textHash);
      items.push({ id, obs, text, textHash, needsEmbedding, needsAbstract });
    }

    // Batch embed (single API call)
    const toEmbed = items.filter(i => i.needsEmbedding);
    if (toEmbed.length > 0) {
      try {
        const vectors = await this.embeddingProvider.embed(toEmbed.map(i => i.text));
        for (let j = 0; j < toEmbed.length; j++) {
          const vec = vectors[j];
          if (vec) {
            const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
            this.db.prepare(`
              INSERT OR REPLACE INTO observation_embeddings
              (observation_id, embedding, model, dimensions, embedded_text_hash)
              VALUES (?, ?, ?, ?, ?)
            `).run(toEmbed[j].id, blob, this.embeddingProvider.model || "noop", vec.length, toEmbed[j].textHash);
          }
        }
      } catch (err) {
        console.error(JSON.stringify({
          level: "error", message: `Batch embedding failed for observations`, error: err.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }

    // Abstracts one at a time (chat completions can't be batched)
    for (const item of items) {
      if (!item.needsAbstract) continue;
      try {
        const abstract = await this.abstractGenerator.generate(item.obs, buildObservationPrompt);
        if (abstract) {
          // CRITICAL: FTS delete BEFORE updating abstract (must match currently indexed values)
          this.db.prepare(
            "INSERT INTO observations_fts (observations_fts, rowid, title, subtitle, text, narrative, facts, concepts, abstract) SELECT 'delete', id, title, subtitle, text, narrative, facts, concepts, abstract FROM observations WHERE id = ?"
          ).run(item.id);
          this.db.prepare("UPDATE observations SET abstract = ? WHERE id = ?").run(abstract, item.id);
          this.db.prepare(
            "INSERT INTO observations_fts (rowid, title, subtitle, text, narrative, facts, concepts, abstract) SELECT id, title, subtitle, text, narrative, facts, concepts, abstract FROM observations WHERE id = ?"
          ).run(item.id);
        }
      } catch (err) {
        console.error(JSON.stringify({
          level: "error", message: `Abstract generation failed for obs ${item.id}`, error: err.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }

  async _processSessionBatch(ids) {
    const items = [];
    for (const id of ids) {
      const session = this.db.prepare("SELECT * FROM session_summaries WHERE id = ?").get(id);
      if (!session) continue;
      const text = composeSessionEmbeddingText(session);
      const textHash = hashText(text);
      const existingEmb = this.db.prepare(
        "SELECT embedded_text_hash FROM session_embeddings WHERE session_id = ?"
      ).get(id);
      const needsEmbedding = !existingEmb || existingEmb.embedded_text_hash !== textHash;
      const needsAbstract = !session.abstract || (existingEmb && existingEmb.embedded_text_hash !== textHash);
      items.push({ id, session, text, textHash, needsEmbedding, needsAbstract });
    }

    const toEmbed = items.filter(i => i.needsEmbedding);
    if (toEmbed.length > 0) {
      try {
        const vectors = await this.embeddingProvider.embed(toEmbed.map(i => i.text));
        for (let j = 0; j < toEmbed.length; j++) {
          const vec = vectors[j];
          if (vec) {
            const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
            this.db.prepare(`
              INSERT OR REPLACE INTO session_embeddings
              (session_id, embedding, model, dimensions, embedded_text_hash)
              VALUES (?, ?, ?, ?, ?)
            `).run(toEmbed[j].id, blob, this.embeddingProvider.model || "noop", vec.length, toEmbed[j].textHash);
          }
        }
      } catch (err) {
        console.error(JSON.stringify({
          level: "error", message: `Batch embedding failed for sessions`, error: err.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }

    for (const item of items) {
      if (!item.needsAbstract) continue;
      try {
        const abstract = await this.abstractGenerator.generate(item.session, buildSessionPrompt);
        if (abstract) {
          this.db.prepare("UPDATE session_summaries SET abstract = ? WHERE id = ?").run(abstract, item.id);
        }
      } catch (err) {
        console.error(JSON.stringify({
          level: "error", message: `Abstract generation failed for session ${item.id}`, error: err.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }
}

module.exports = { EnrichmentWorker };
