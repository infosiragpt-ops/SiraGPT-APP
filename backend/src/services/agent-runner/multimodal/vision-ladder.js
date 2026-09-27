'use strict';

/**
 * Vision models for the visual review of office edits (edición milimétrica,
 * Fase C). The loop model is usually text-only, so the before/after image is
 * shown to a separate vision-capable model.
 *
 * Candidate order (only providers with a configured key):
 *   1. SIRAGPT_VISION_VERIFY_MODEL — operator override ("Provider:model" or bare id)
 *   2. the model picked in the composer, when model-capabilities says it sees images
 *   3. DeepSeek `deepseek-flash` — verified live on 2026-09-26 (sees images;
 *      `deepseek-v4-pro` answers "Unknown": text-only)
 *   4. xAI `grok-4.6` (verified live)
 *   5. Gemini `gemini-3.5-flash`, then `gemini-3-flash-preview` (verified live)
 *   6. OpenAI `gpt-5.6-sol`
 *
 * Per call: quota / auth / transport / 5xx errors move to the next candidate;
 * a 400/404/415/422 (this model cannot take the image) also moves on AND
 * demotes that candidate for DEMOTE_MS — a live probe on first use, cached,
 * instead of trusting a capability table. An answer the caller cannot use
 * (`accept` → false: empty content because a reasoning model spent its budget
 * thinking, or no JSON) also moves on, without demotion. When no candidate
 * answers, the verifier returns ok:null and the reply says no visual review ran.
 */

const { LADDER, inferProvider } = require('../../doc-agent/llm-runtime');

const DEMOTE_MS = 6 * 60 * 60 * 1000;
const PLACEHOLDER_KEY_RE = /dummy|not-used|ci-dummy|test-key|^your_|^sk-xxx|^changeme$/i;
const PROVIDER_ALIASES = Object.freeze({
  deepseek: 'DeepSeek', meta: 'Meta', llama: 'Meta', gemini: 'Gemini', google: 'Gemini',
  xai: 'xAI', grok: 'xAI', openrouter: 'OpenRouter', openai: 'OpenAI',
});

// Vision model per provider, env-overridable (verified ids, see header).
const VISION_DEFAULTS = Object.freeze([
  { provider: 'DeepSeek', models: ['deepseek-flash'], env: 'SIRAGPT_DEEPSEEK_VISION_MODEL' },
  { provider: 'xAI', models: ['grok-4.6'], env: 'SIRAGPT_XAI_VISION_MODEL' },
  { provider: 'Gemini', models: ['gemini-3.5-flash', 'gemini-3-flash-preview'], env: 'SIRAGPT_GEMINI_VISION_MODEL' },
  { provider: 'OpenAI', models: ['gpt-5.6-sol'], env: 'SIRAGPT_OPENAI_VISION_MODEL' },
]);

// provider:model → demoted-until timestamp (module lifetime = process lifetime).
const demoted = new Map();

function ladderEntry(provider) {
  return LADDER.find((e) => e.provider === provider) || null;
}

function keyFor(entry, env) {
  for (const name of entry.keys) {
    const value = env && env[name];
    if (value && String(value).trim() && !PLACEHOLDER_KEY_RE.test(String(value).trim())) return String(value).trim();
  }
  return null;
}

function parseSpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx > 0 && idx < 24 && !raw.slice(0, idx).includes('/')) {
    const provider = PROVIDER_ALIASES[raw.slice(0, idx).trim().toLowerCase()] || null;
    const model = raw.slice(idx + 1).trim();
    if (provider && model) return { provider, model };
  }
  return { provider: inferProvider(raw), model: raw };
}

function pickedModelSeesImages(model) {
  try {
    const { resolveModelCapabilities } = require('../../agent-harness/model-capabilities');
    const caps = resolveModelCapabilities(model);
    return Boolean(caps && caps.supportsImages);
  } catch (_) {
    return false;
  }
}

/**
 * @returns {Array<{provider, model, apiKey, baseURL, extra, headers}>}
 */
function resolveVisionCandidates({ pickedModel = null, env = process.env, now = Date.now() } = {}) {
  const out = [];
  const seen = new Set();
  const push = (provider, model) => {
    if (!provider || !model) return;
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    const until = demoted.get(key);
    if (until && until > now) return;
    const entry = ladderEntry(provider);
    if (!entry) return;
    const apiKey = keyFor(entry, env);
    if (!apiKey) return;
    seen.add(key);
    out.push({
      provider,
      model,
      apiKey,
      baseURL: provider === 'OpenRouter'
        ? ((env && env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1')
        : entry.baseURL,
      extra: entry.extra || null,
      headers: provider === 'OpenRouter'
        ? { 'HTTP-Referer': (env && env.OPENROUTER_SITE_URL) || 'https://siragpt.app', 'X-Title': 'SiraGPT Visual Review' }
        : null,
    });
  };

  const override = parseSpec(env && env.SIRAGPT_VISION_VERIFY_MODEL);
  if (override && override.model) push(override.provider || 'OpenRouter', override.model);

  const picked = parseSpec(pickedModel);
  if (picked && picked.model && picked.provider && pickedModelSeesImages(picked.model)) {
    push(picked.provider, picked.model);
  }

  for (const d of VISION_DEFAULTS) {
    const pinned = env && env[d.env] ? String(env[d.env]).trim() : '';
    for (const model of pinned ? [pinned] : d.models) push(d.provider, model);
  }
  return out;
}

function errorStatus(err) {
  if (!err) return null;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status));
  return Number.isFinite(status) ? status : null;
}

/** The model cannot handle this request (image input) — try another and remember. */
function isCapabilityError(err) {
  const status = errorStatus(err);
  return status === 400 || status === 404 || status === 415 || status === 422;
}

function isTransientError(err) {
  const status = errorStatus(err);
  if (status !== null) return [401, 402, 403, 408, 409, 425, 429].includes(status) || status >= 500;
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /econn|enotfound|etimedout|eai_again|fetch failed|network|timed? ?out|socket hang up/.test(msg);
}

function defaultCreateClient(candidate) {
  const OpenAI = require('openai');
  return new OpenAI({
    apiKey: candidate.apiKey,
    baseURL: candidate.baseURL,
    ...(candidate.headers ? { defaultHeaders: candidate.headers } : {}),
  });
}

/**
 * OpenAI-compatible façade over the vision candidates (same shape
 * makeVisionVerifier expects). Returns null when there is no candidate.
 */
function createVisionClient(candidates, {
  createClient = defaultCreateClient,
  onFailover = () => {},
  now = () => Date.now(),
} = {}) {
  const order = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!order.length) return null;
  const clients = new Map();
  let lastUsed = null;
  const clientFor = (c) => {
    const key = `${c.provider}:${c.model}`;
    if (!clients.has(key)) clients.set(key, createClient(c));
    return clients.get(key);
  };
  async function create(payload, opts, { accept } = {}) {
    let lastError = null;
    let unusable = null;
    for (const c of order) {
      const key = `${c.provider}:${c.model}`;
      const until = demoted.get(key);
      if (until && until > now()) continue;
      try {
        const response = await clientFor(c).chat.completions.create(
          { ...payload, model: c.model, ...(c.extra || {}) },
          opts,
        );
        if (typeof accept === 'function' && !accept(response)) {
          unusable = unusable || response;
          try {
            onFailover({ provider: c.provider, model: c.model, status: 'unusable', demoted: false,
              message: 'respuesta sin veredicto utilizable' });
          } catch (_) { /* observer errors never break the review */ }
          continue;
        }
        lastUsed = { provider: c.provider, model: c.model };
        return response;
      } catch (err) {
        if (opts && opts.signal && opts.signal.aborted) throw err;
        lastError = err;
        const capability = isCapabilityError(err);
        if (!capability && !isTransientError(err)) throw err;
        if (capability) demoted.set(key, now() + DEMOTE_MS);
        try {
          onFailover({ provider: c.provider, model: c.model, status: errorStatus(err), demoted: capability,
            message: String((err && err.message) || err).slice(0, 160) });
        } catch (_) { /* observer errors never break the review */ }
      }
    }
    if (unusable) return unusable;
    throw lastError || new Error('no hay modelo de visión disponible');
  }
  return {
    chat: { completions: { create } },
    describe: () => lastUsed,
    candidates: () => order.map((c) => ({ provider: c.provider, model: c.model })),
  };
}

function resetVisionDemotions() {
  demoted.clear();
}

module.exports = {
  DEMOTE_MS,
  VISION_DEFAULTS,
  resolveVisionCandidates,
  createVisionClient,
  isCapabilityError,
  isTransientError,
  resetVisionDemotions,
};
