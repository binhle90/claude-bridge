const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("Embedding Provider", () => {
  it("NoopEmbeddings.embed returns null array", async () => {
    const { NoopEmbeddings } = require("../server/embeddings");
    const provider = new NoopEmbeddings();
    const result = await provider.embed(["hello world"]);
    assert.deepStrictEqual(result, [null]);
  });

  it("composeEmbeddingText joins observation fields", () => {
    const { composeEmbeddingText } = require("../server/embeddings");
    const text = composeEmbeddingText({
      title: "OAuth spec",
      narrative: "We designed the auth flow",
      facts: "Using PKCE",
      concepts: null,
      text: "Full details here",
    });
    assert.ok(text.includes("OAuth spec"));
    assert.ok(text.includes("We designed the auth flow"));
    assert.ok(text.includes("Using PKCE"));
    assert.ok(text.includes("Full details here"));
    assert.ok(!text.includes("null"));
  });

  it("composeEmbeddingText truncates to 8000 chars", () => {
    const { composeEmbeddingText } = require("../server/embeddings");
    const text = composeEmbeddingText({
      title: "x",
      narrative: "y".repeat(10000),
    });
    assert.ok(text.length <= 8000);
  });

  it("composeSessionEmbeddingText joins session fields", () => {
    const { composeSessionEmbeddingText } = require("../server/embeddings");
    const text = composeSessionEmbeddingText({
      request: "Build search",
      investigated: "FTS5",
      learned: "It works well",
      completed: "Implemented endpoint",
      next_steps: "Add pagination",
    });
    assert.ok(text.includes("Build search"));
    assert.ok(text.includes("FTS5"));
  });

  it("hashText returns consistent SHA-256 hex", () => {
    const { hashText } = require("../server/embeddings");
    const h1 = hashText("hello");
    const h2 = hashText("hello");
    const h3 = hashText("world");
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, h3);
    assert.strictEqual(h1.length, 64);
  });

  it("createEmbeddingProvider returns NoopEmbeddings when no config", () => {
    const { createEmbeddingProvider, NoopEmbeddings } = require("../server/embeddings");
    const provider = createEmbeddingProvider({});
    assert.ok(provider instanceof NoopEmbeddings);
  });

  it("createEmbeddingProvider returns OpenAIEmbeddings with config", () => {
    const { createEmbeddingProvider, OpenAIEmbeddings } = require("../server/embeddings");
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      dimensions: 1536,
    });
    assert.ok(provider instanceof OpenAIEmbeddings);
  });
});
