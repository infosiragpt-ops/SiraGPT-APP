/**
 * llmClient — thin OpenRouter-compatible JSON-mode completion helper
 * for SearchBrain's decomposer + reranker.
 *
 * siraGPT's existing ai-service.js owns a streaming chat path; we don't
 * need streaming for SearchBrain (each call is one-shot). Rather than
 * couple to that 900-line class, we spin a minimal OpenAI SDK handle
 * pointing at the same OpenRouter base URL the rest of the backend
 * already uses.
 *
 * When no API key is set, `callLLM` returns `null` so the orchestrator
 * gracefully falls back to its non-LLM paths (regex-based decomposer,
 * heuristic reranker).
 */

const OpenAI = require("openai");

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  cachedClient = new OpenAI({
    apiKey,
    baseURL: useOpenRouter ? "https://openrouter.ai/api/v1" : undefined,
    defaultHeaders: useOpenRouter
      ? {
          "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://siragpt.io",
          "X-Title": "siraGPT-SearchBrain",
        }
      : undefined,
  });
  return cachedClient;
}

function getDefaultModel() {
  return (
    process.env.SEARCH_BRAIN_MODEL ||
    process.env.SMALL_MODEL ||
    (process.env.OPENROUTER_API_KEY ? "anthropic/claude-3-haiku" : "gpt-4o-mini")
  );
}

/**
 * callLLM({ system, user, temperature, maxTokens }) → { content }
 * Returns null when no client is configured OR when a transient
 * network error occurs. Callers MUST treat null as "fallback to
 * non-LLM path".
 */
async function callLLM({ system, user, temperature = 0.2, maxTokens = 600, model }) {
  const client = getClient();
  if (!client) return null;
  try {
    const resp = await client.chat.completions.create({
      model: model || getDefaultModel(),
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const content = resp?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return { content };
  } catch {
    return null;
  }
}

/** Test hook — clear the cached client after env mutations in tests. */
function __resetClient() {
  cachedClient = null;
}

module.exports = {
  callLLM,
  getClient,
  getDefaultModel,
  __resetClient,
};
