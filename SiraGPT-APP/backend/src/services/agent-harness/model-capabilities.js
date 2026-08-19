'use strict';

/**
 * model-capabilities — per-model capability registry for the agent harness
 * (Phase 1 of the multi-model agentic chat).
 *
 * One table answers, for ANY model id we route (OpenRouter slugs like
 * "anthropic/claude-opus-4.7", bare ids like "gpt-4o-mini", Cerebras
 * "llama-3.1-8b", …):
 *
 *   - supportsNativeTools        — OpenAI-style tool_calls work end-to-end.
 *   - supportsParallelToolCalls  — the provider honors parallel_tool_calls.
 *   - supportsReasoning          — extended thinking / CoT streaming.
 *   - reasoningParamStyle        — how to ASK for it:
 *       'openrouter-effort'  → payload.reasoning = { effort } (unified API)
 *       'deepseek'           → no param; reasoning_content arrives by itself
 *   - contextWindow / maxOutputTokens — conservative planning numbers.
 *   - supportsImages             — image parts accepted in user content.
 *   - supportsPromptCaching      — provider-side prompt caching exists.
 *
 * Resolution ladder (first hit wins per field):
 *   caller overrides  >  env overrides (SIRAGPT_MODEL_CAPS_OVERRIDES)
 *   >  exact-id table  >  family rules (ordered)  >  conservative defaults.
 *
 * The family rules are a SUPERSET of the legacy
 * `modelSupportsFunctionCalling` allowlist in agentic-chat-stream.js, so
 * `resolveToolCallMode` can delegate here without changing behavior for any
 * model that already reached the native loop. Being wrong here degrades to
 * the prompted ladder (or the plain stream), never to a crash.
 *
 * Persistable overrides: pass `overrides` (e.g. from `User.settings
 * .modelCapabilityOverrides`, a `{ "<model-id-or-substring>": {caps} }`
 * object) — the same shape the env override accepts. Conservative defaults
 * mean an unknown future model is treated as a plain chat-completions
 * endpoint until someone teaches the table otherwise.
 */

const CONSERVATIVE_DEFAULTS = Object.freeze({
  supportsNativeTools: false,
  supportsParallelToolCalls: false,
  supportsReasoning: false,
  reasoningParamStyle: null,
  contextWindow: 8192,
  maxOutputTokens: 4096,
  supportsImages: false,
  supportsPromptCaching: false,
});

/**
 * Normalize (provider, model) into one comparable slug. OpenRouter ids
 * already look like "vendor/model"; bare ids get the provider folded in
 * front when it adds signal ("openai" + "gpt-4o" → "openai/gpt-4o").
 */
function normalizeModelId(model, provider = '') {
  const m = String(model || '').trim().toLowerCase();
  const p = String(provider || '').trim().toLowerCase();
  if (!m) return '';
  if (m.includes('/')) return m;
  if (p && p !== 'openrouter' && p !== 'custom') return `${p}/${m}`;
  return m;
}

// ── Family rules (ordered: first match wins per field) ─────────────────────
// `match` runs against the normalized id. `caps` is a partial overlay.
const FAMILY_RULES = Object.freeze([
  {
    family: 'anthropic-claude',
    match: /anthropic\/claude|(?:^|\/)claude-/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: true,
      reasoningParamStyle: 'openrouter-effort',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      supportsImages: true,
      supportsPromptCaching: true,
    },
  },
  {
    family: 'openai-reasoning', // o-series + gpt-5: reasoning models
    match: /(?:^|\/)(?:openai\/)?(?:o[134](?:-mini|-pro)?|gpt-5)/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: false, // o-series rejects parallel_tool_calls
      supportsReasoning: true,
      reasoningParamStyle: 'openrouter-effort',
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      supportsImages: true,
      supportsPromptCaching: true,
    },
  },
  {
    family: 'openai-gpt4',
    match: /(?:^|\/)(?:openai\/)?(?:gpt-4(?:o|\.1)?|chatgpt-4o|gpt-3\.5-turbo-(?:1106|0125))/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: true,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsImages: true,
      supportsPromptCaching: true,
    },
  },
  {
    family: 'google-gemini',
    match: /(?:^|\/)(?:google\/)?gemini-(?:1\.5|2|2\.5|3)/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: true, // 2.5+/3 thinking; harmless effort hint on 1.5
      reasoningParamStyle: 'openrouter-effort',
      contextWindow: 1_000_000,
      maxOutputTokens: 8192,
      supportsImages: true,
      supportsPromptCaching: true,
    },
  },
  {
    family: 'deepseek',
    match: /(?:^|\/)deepseek[/-]/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: false,
      supportsReasoning: true, // R1/reasoner streams reasoning_content
      reasoningParamStyle: 'deepseek',
      contextWindow: 64_000,
      maxOutputTokens: 8192,
      supportsImages: false,
      supportsPromptCaching: true,
    },
  },
  {
    family: 'meta-llama',
    match: /(?:^|[/_-])llama-?[34]/,
    caps: {
      supportsNativeTools: true, // Cerebras/Groq/OpenRouter normalise tool_calls
      supportsParallelToolCalls: false,
      contextWindow: 128_000,
      maxOutputTokens: 8192,
    },
  },
  {
    family: 'qwen',
    match: /(?:^|[/_-])(?:qwen|qwq)/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: false,
      supportsReasoning: true, // QwQ / Qwen3 thinking variants
      reasoningParamStyle: 'openrouter-effort',
      contextWindow: 32_768,
      maxOutputTokens: 8192,
    },
  },
  {
    family: 'mistral',
    match: /(?:^|\/)(?:mistralai\/|mistral-|codestral|magistral|devstral|ministral|pixtral)/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: true,
      contextWindow: 32_768,
      maxOutputTokens: 8192,
    },
  },
  {
    family: 'moonshot-kimi',
    match: /(?:^|[/_-])kimi-k2/,
    caps: {
      // Kimi emits tool calls as native tokens; react-agent parses them
      // (parseNativeToolCalls), so the native loop drives it correctly.
      supportsNativeTools: true,
      supportsParallelToolCalls: false,
      contextWindow: 128_000,
      maxOutputTokens: 8192,
    },
  },
  {
    family: 'xai-grok',
    match: /(?:^|\/)(?:x-ai\/)?grok-/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: true,
      supportsReasoning: true,
      reasoningParamStyle: 'openrouter-effort',
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      supportsImages: true,
    },
  },
  {
    family: 'openai-gpt-oss',
    match: /(?:^|[/_-])gpt-oss/,
    caps: {
      supportsNativeTools: true,
      supportsParallelToolCalls: false,
      supportsReasoning: true,
      reasoningParamStyle: 'openrouter-effort',
      contextWindow: 128_000,
      maxOutputTokens: 8192,
    },
  },
]);

// Exact-id tweaks on top of family rules (kept small on purpose: families
// carry the weight; this is for true outliers only).
const EXACT_OVERRIDES = Object.freeze({
  'openai/gpt-4.1': { contextWindow: 1_000_000 },
  'gpt-4.1': { contextWindow: 1_000_000 },
  'mistralai/mistral-large': { contextWindow: 128_000 },
});

function parseEnvOverrides(env = process.env) {
  const raw = env && env.SIRAGPT_MODEL_CAPS_OVERRIDES;
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    try { console.warn('[model-capabilities] invalid SIRAGPT_MODEL_CAPS_OVERRIDES JSON:', err.message); } catch (_) { /* noop */ }
    return null;
  }
}

const CAP_KEYS = Object.keys(CONSERVATIVE_DEFAULTS);

function sanitizePartialCaps(partial) {
  if (!partial || typeof partial !== 'object') return {};
  const out = {};
  for (const key of CAP_KEYS) {
    if (!(key in partial)) continue;
    const value = partial[key];
    if (key === 'contextWindow' || key === 'maxOutputTokens') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
    } else if (key === 'reasoningParamStyle') {
      out[key] = value == null ? null : String(value);
    } else {
      out[key] = Boolean(value);
    }
  }
  return out;
}

/**
 * Apply a `{ "<exact-id-or-substring>": {caps} }` override map. Exact id
 * match wins over substring match; later substring entries win over earlier.
 */
function overridesFor(normalizedId, overrideMap) {
  if (!overrideMap || typeof overrideMap !== 'object') return {};
  let merged = {};
  for (const [needle, caps] of Object.entries(overrideMap)) {
    const key = String(needle || '').trim().toLowerCase();
    if (!key || key === normalizedId) continue;
    if (normalizedId.includes(key)) merged = { ...merged, ...sanitizePartialCaps(caps) };
  }
  const exact = overrideMap[normalizedId];
  if (exact) merged = { ...merged, ...sanitizePartialCaps(exact) };
  return merged;
}

/**
 * Resolve the capability profile for a model.
 *
 * @param {string} model            — model id (slug or bare).
 * @param {object} [opts]
 * @param {string} [opts.provider]  — provider label when the id is bare.
 * @param {object} [opts.overrides] — persisted override map (e.g. from the
 *                                    user settings JSON), same shape as the
 *                                    SIRAGPT_MODEL_CAPS_OVERRIDES env var.
 * @param {object} [opts.env]       — env source (tests).
 * @returns {object} full capability object (never null; conservative
 *                   defaults for unknown models).
 */
function resolveModelCapabilities(model, opts = {}) {
  const normalizedId = normalizeModelId(model, opts.provider);
  let caps = { ...CONSERVATIVE_DEFAULTS };
  if (!normalizedId) return { ...caps, modelId: '', family: null };

  let family = null;
  for (const rule of FAMILY_RULES) {
    if (rule.match.test(normalizedId)) {
      caps = { ...caps, ...rule.caps };
      family = rule.family;
      break;
    }
  }
  if (EXACT_OVERRIDES[normalizedId]) {
    caps = { ...caps, ...sanitizePartialCaps(EXACT_OVERRIDES[normalizedId]) };
  }
  const envOverrides = parseEnvOverrides(opts.env || process.env);
  if (envOverrides) caps = { ...caps, ...overridesFor(normalizedId, envOverrides) };
  if (opts.overrides) caps = { ...caps, ...overridesFor(normalizedId, opts.overrides) };

  return { ...caps, modelId: normalizedId, family };
}

/** Convenience: does this (provider, model) support native tool calls? */
function supportsNativeTools(provider, model, opts = {}) {
  return resolveModelCapabilities(model, { ...opts, provider }).supportsNativeTools;
}

// Direct-SDK providers whose chat client in THIS backend does not speak
// OpenAI-style `tool_calls` (their slugged OpenRouter forms do — OpenRouter
// normalises tools). Direct Anthropic is intentionally absent: the native
// adapter translates Claude `tool_use` blocks to the loop's OpenAI envelope.
const NON_OPENAI_TOOL_TRANSPORTS = new Set(['mistral']);

/**
 * Transport-aware gate used by resolveToolCallMode: native only when BOTH
 * the model supports tools AND the provider path actually carries
 * OpenAI-shaped tool_calls end-to-end.
 */
function supportsNativeToolTransport(provider, model, opts = {}) {
  const p = String(provider || '').trim().toLowerCase();
  const m = String(model || '');
  if (!m.includes('/') && NON_OPENAI_TOOL_TRANSPORTS.has(p)) return false;
  return resolveModelCapabilities(model, { ...opts, provider }).supportsNativeTools;
}

module.exports = {
  CONSERVATIVE_DEFAULTS,
  FAMILY_RULES,
  normalizeModelId,
  resolveModelCapabilities,
  supportsNativeTools,
  supportsNativeToolTransport,
};
