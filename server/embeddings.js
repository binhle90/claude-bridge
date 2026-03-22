const { createHash } = require("node:crypto");

function composeEmbeddingText(obs) {
  const parts = [obs.title, obs.narrative, obs.facts, obs.concepts, obs.text]
    .filter(Boolean);
  return parts.join("\n\n").slice(0, 8000);
}

function composeSessionEmbeddingText(session) {
  const parts = [session.request, session.investigated, session.learned,
    session.completed, session.next_steps].filter(Boolean);
  return parts.join("\n\n").slice(0, 8000);
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

class EmbeddingProvider {
  async embed(texts) {
    throw new Error("Not implemented");
  }
}

class NoopEmbeddings extends EmbeddingProvider {
  async embed(texts) {
    return texts.map(() => null);
  }
}

class OpenAIEmbeddings extends EmbeddingProvider {
  constructor({ model, apiKey, dimensions }) {
    super();
    this.model = model || "text-embedding-3-small";
    this.apiKey = apiKey;
    this.dimensions = dimensions || 1536;
  }

  async embed(texts) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI embedding API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => new Float32Array(d.embedding));
  }
}

function createEmbeddingProvider(config) {
  if (!config.provider || config.provider === "noop") {
    return new NoopEmbeddings();
  }
  if (config.provider === "openai") {
    return new OpenAIEmbeddings(config);
  }
  throw new Error(`Unknown embedding provider: ${config.provider}`);
}

module.exports = {
  composeEmbeddingText,
  composeSessionEmbeddingText,
  hashText,
  EmbeddingProvider,
  NoopEmbeddings,
  OpenAIEmbeddings,
  createEmbeddingProvider,
};
