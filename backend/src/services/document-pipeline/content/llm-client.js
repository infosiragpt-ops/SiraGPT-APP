const OpenAI = require('openai');

// Provider client factory for the document content generator. Mirrors the
// provider switch used in routes/ai.js so a future caller can flow the
// user's selected model (DeepSeek V4 Flash, Gemini, OpenRouter, …) into
// the pipeline without rewriting this file.
//
// The returned client is OpenAI-SDK-compatible (chat.completions.create
// with response_format), so all callers use one shape regardless of the
// underlying provider.
function createContentClient(provider = 'OpenAI', env = process.env) {
  switch ((provider || 'OpenAI').trim()) {
    case 'Cerebras':
      return new OpenAI({
        apiKey: env.CEREBRAS_API_KEY,
        baseURL: env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
      });
    case 'Gemini':
      return new OpenAI({
        apiKey: env.GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      });
    case 'DeepSeek':
      return new OpenAI({
        apiKey: env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com',
      });
    case 'OpenRouter':
      return new OpenAI({
        apiKey: env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      });
    case 'OpenAI':
    default:
      return new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
}

// Legacy default kept for callers that pass an explicit provider.
const DEFAULT_MODEL = process.env.DOC_CONTENT_MODEL || 'gpt-4o-mini';

// ── Provider fallback ladder ────────────────────────────────────────────────
// The document writers were hardwired to OpenAI; with a dead/absent
// OPENAI_API_KEY every section silently degraded to template filler that
// LOOKED like a finished document. The ladder walks the providers that are
// actually configured in this deployment and returns the first usable one.
// Order: Cerebras (the always-provisioned FlashGPT key; gpt-oss-120b honours
// response_format json_schema — verified live) → OpenRouter → OpenAI.
// DOC_CONTENT_PROVIDER forces the head of the ladder for a deployment.
const LADDER = [
  { provider: 'Cerebras', key: 'CEREBRAS_API_KEY', model: (env) => env.DOC_CONTENT_CEREBRAS_MODEL || env.FREE_IA_MODEL_ID || 'gpt-oss-120b' },
  { provider: 'OpenRouter', key: 'OPENROUTER_API_KEY', model: (env) => env.DOC_CONTENT_OPENROUTER_MODEL || 'openai/gpt-4o-mini' },
  { provider: 'OpenAI', key: 'OPENAI_API_KEY', model: (env) => env.DOC_CONTENT_MODEL || 'gpt-4o-mini' },
];

/** Is at least one content-writer provider configured? */
function hasAnyContentKey(env = process.env) {
  return LADDER.some((step) => !!env[step.key]);
}

/**
 * Resolve the first configured provider on the ladder.
 * Returns { client, provider, model } or null when nothing is configured.
 * A caller-supplied preferred provider wins when its key exists.
 */
function resolveContentClient({ preferred, env = process.env } = {}) {
  const forced = (preferred || env.DOC_CONTENT_PROVIDER || '').trim();
  const ordered = forced
    ? [...LADDER.filter((s) => s.provider === forced), ...LADDER.filter((s) => s.provider !== forced)]
    : LADDER;
  for (const step of ordered) {
    if (!env[step.key]) continue;
    return {
      client: createContentClient(step.provider, env),
      provider: step.provider,
      model: step.model(env),
    };
  }
  return null;
}

module.exports = { createContentClient, DEFAULT_MODEL, resolveContentClient, hasAnyContentKey };
