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
// The memo follows the CURRENT key/route (the admin-connections bridge swaps
// provider keys at runtime; a first-use memo froze the old key).
let cachedClientSignature = null;

function getClient() {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) { cachedClient = null; cachedClientSignature = null; return null; }
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const signature = `${useOpenRouter ? "openrouter" : "openai"}:${require("../../utils/provider-key-health").fingerprint(apiKey)}`;
  if (cachedClient && cachedClientSignature === signature) return cachedClient;
  cachedClientSignature = signature;
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
    (process.env.OPENROUTER_API_KEY ? "moonshotai/kimi-k2.6" : "gpt-4o-mini")
  );
}

/**
 * callLLM({ system, user, temperature, maxTokens, signal }) → { content }
 * Returns null when no client is configured, when `signal` aborted the
 * request, OR when a transient network error occurs. Callers MUST treat
 * null as "fallback to non-LLM path".
 */
// SDK defaults are a 10-minute timeout with 2 retries: one slow re-ranking
// call kept an academic search silent for 334 s in production. These helpers
// all have a non-LLM fallback, so a short bound is always safe.
const DEFAULT_LLM_TIMEOUT_MS = 25_000;

function llmTimeoutMs() {
  const value = Math.floor(Number(process.env.SEARCH_BRAIN_LLM_TIMEOUT_MS));
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_LLM_TIMEOUT_MS;
}

async function callLLM({ system, user, temperature = 0.2, maxTokens = 600, model, signal, timeoutMs }) {
  const client = getClient();
  if (!client || signal?.aborted) return null;
  try {
    const resp = await client.chat.completions.create({
      model: model || getDefaultModel(),
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }, {
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : llmTimeoutMs(),
      maxRetries: 1,
      ...(signal ? { signal } : {}),
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
  cachedClientSignature = null;
}

module.exports = {
  callLLM,
  getClient,
  getDefaultModel,
  __resetClient,
};
