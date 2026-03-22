const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("Abstract Generator", () => {
  it("NoopAbstractGenerator.generate returns null", async () => {
    const { NoopAbstractGenerator } = require("../server/abstracts");
    const gen = new NoopAbstractGenerator();
    const result = await gen.generate({ title: "Test", type: "discovery", project: "alpha" });
    assert.strictEqual(result, null);
  });

  it("buildObservationPrompt includes title, type, project, content", () => {
    const { buildObservationPrompt } = require("../server/abstracts");
    const prompt = buildObservationPrompt({
      title: "OAuth spec",
      type: "decision",
      project: "claude-bridge",
      narrative: "We decided to use PKCE",
      facts: "PKCE is more secure",
    });
    assert.ok(prompt.includes("OAuth spec"));
    assert.ok(prompt.includes("decision"));
    assert.ok(prompt.includes("claude-bridge"));
    assert.ok(prompt.includes("We decided to use PKCE"));
  });

  it("buildSessionPrompt includes request, completed, learned", () => {
    const { buildSessionPrompt } = require("../server/abstracts");
    const prompt = buildSessionPrompt({
      project: "alpha",
      request: "Build search",
      completed: "Implemented endpoint",
      learned: "FTS5 works great",
    });
    assert.ok(prompt.includes("Build search"));
    assert.ok(prompt.includes("Implemented endpoint"));
    assert.ok(prompt.includes("FTS5 works great"));
  });

  it("createAbstractGenerator returns Noop when no config", () => {
    const { createAbstractGenerator, NoopAbstractGenerator } = require("../server/abstracts");
    const gen = createAbstractGenerator({});
    assert.ok(gen instanceof NoopAbstractGenerator);
  });

  it("createAbstractGenerator returns OpenAIAbstractGenerator with API key", () => {
    const { createAbstractGenerator, OpenAIAbstractGenerator } = require("../server/abstracts");
    const gen = createAbstractGenerator({ apiKey: "sk-test", model: "gpt-4.1-mini" });
    assert.ok(gen instanceof OpenAIAbstractGenerator);
  });
});
