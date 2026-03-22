const ABSTRACT_PROMPT = `Summarize this observation in exactly one sentence.
The sentence must capture: what was decided/discovered/built, which project,
and why it matters. Maximum 100 tokens. No preamble.

Title: {title}
Type: {type}
Project: {project}
Content:
{narrative}
{facts}`;

const SESSION_ABSTRACT_PROMPT = `Summarize this coding session in one sentence.
Capture: what was requested, what was accomplished, and the project name.
Maximum 100 tokens. No preamble.

Project: {project}
Request: {request}
Completed: {completed}
Learned: {learned}`;

function buildObservationPrompt(obs) {
  return ABSTRACT_PROMPT
    .replace("{title}", obs.title || "")
    .replace("{type}", obs.type || "")
    .replace("{project}", obs.project || "")
    .replace("{narrative}", obs.narrative || "")
    .replace("{facts}", obs.facts || "");
}

function buildSessionPrompt(session) {
  return SESSION_ABSTRACT_PROMPT
    .replace("{project}", session.project || "")
    .replace("{request}", session.request || "")
    .replace("{completed}", session.completed || "")
    .replace("{learned}", session.learned || "");
}

class AbstractGenerator {
  async generate(record) {
    throw new Error("Not implemented");
  }
}

class NoopAbstractGenerator extends AbstractGenerator {
  async generate() {
    return null;
  }
}

class OpenAIAbstractGenerator extends AbstractGenerator {
  constructor({ apiKey, model }) {
    super();
    this.apiKey = apiKey;
    this.model = model || "gpt-4.1-mini";
  }

  async generate(record, promptBuilder) {
    const prompt = promptBuilder(record);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI chat API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return (data.choices[0]?.message?.content || "").trim();
  }
}

function createAbstractGenerator(config) {
  if (!config.apiKey) {
    return new NoopAbstractGenerator();
  }
  return new OpenAIAbstractGenerator(config);
}

module.exports = {
  buildObservationPrompt,
  buildSessionPrompt,
  NoopAbstractGenerator,
  OpenAIAbstractGenerator,
  createAbstractGenerator,
};
