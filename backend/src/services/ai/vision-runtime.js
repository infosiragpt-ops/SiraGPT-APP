'use strict';

/**
 * Vision runtime selection shared by the chat generate path (ai-service) and
 * the file processor's vision-OCR fallback.
 *
 * Live incident 2026-09-02: an image sent to Meta Muse Spark was "routed
 * through a vision-capable runtime" = OpenAI gpt-4o-mini — a retired model id
 * — while the OpenAI key in production answered 401. Muse Spark, Grok 4.x and
 * Gemini all take OpenAI-style `image_url` parts natively, so the selected
 * model should be used when it can see, and the fallback order must prefer
 * runtimes that actually work in this deployment (Gemini → Meta → xAI →
 * OpenRouter → OpenAI). Every default model id is env-overridable.
 */

const { isSiraMiniAlias } = require('./custom-provider-client');

function normalizeProviderName(provider) {
  return String(provider || '').trim().toLowerCase();
}

function modelSupportsVision(provider, model) {
  const normalizedProvider = normalizeProviderName(provider);
  const normalizedModel = String(model || '').toLowerCase();

  if (normalizedProvider === 'deepseek') return false;
  if (isSiraMiniAlias(model) || isSiraMiniAlias(normalizedModel)) return true;
  if (/(^|\/)(moondream|llava|bakllava|minicpm-v)/i.test(normalizedModel)) return true;
  if (normalizedProvider === 'gemini' || normalizedProvider === 'google') return /^gemini/.test(normalizedModel);
  if (normalizedProvider === 'openai') {
    return /(gpt-4o|gpt-4\.1|gpt-5|o3|o4|vision)/i.test(normalizedModel);
  }
  // Meta Model API: Muse Spark is multimodal (images, video, PDFs); Llama 4 too.
  if (normalizedProvider === 'meta' || normalizedProvider === 'llama') {
    return /muse-spark|muse-image|llama-4/.test(normalizedModel);
  }
  // xAI: Grok 4.x accepts image inputs (jpg/png) in the OpenAI image_url format.
  if (normalizedProvider === 'xai' || normalizedProvider === 'x-ai' || normalizedProvider === 'grok') {
    return /grok-(4|5)/.test(normalizedModel);
  }
  if (normalizedProvider === 'openrouter') {
    return /(gpt-4o|gpt-4\.1|gpt-5|gemini|claude|qwen.*vl|vision|llava|pixtral|grok-4|muse-spark|llama-4)/i.test(normalizedModel);
  }
  return false;
}

function hasMetaKey(env = process.env) {
  return Boolean(env.MODEL_API_KEY || env.META_API_KEY || env.LLAMA_API_KEY);
}

/**
 * Ordered vision runtimes available in this deployment. Only providers whose
 * key is present are listed; model ids are env-overridable so a retired id
 * never needs a code change again.
 */
function visionRuntimeCandidates(env = process.env) {
  const out = [];
  if (env.GEMINI_API_KEY) {
    out.push({ provider: 'Gemini', model: env.GEMINI_VISION_MODEL || 'gemini-3.5-flash' });
  }
  if (hasMetaKey(env)) {
    out.push({ provider: 'Meta', model: env.META_VISION_MODEL || 'muse-spark-1.2' });
  }
  if (env.XAI_API_KEY) {
    out.push({ provider: 'xAI', model: env.XAI_VISION_MODEL || 'grok-4.5' });
  }
  if (env.OPENROUTER_API_KEY) {
    out.push({ provider: 'OpenRouter', model: env.OPENROUTER_VISION_MODEL || 'google/gemini-3.5-flash' });
  }
  if (env.OPENAI_API_KEY) {
    out.push({ provider: 'OpenAI', model: env.VISION_MODEL || 'gpt-5.6-sol' });
  }
  return out;
}

/**
 * Keep the selected model when it can see; otherwise the first available
 * vision runtime, with the remaining ones as `fallbacks` so a dead runtime
 * (401 key, 404 model id) does not end the turn.
 */
function selectVisionRuntime(provider, model, env = process.env) {
  if (modelSupportsVision(provider, model)) {
    return { provider, model, switched: false, fallbacks: [] };
  }
  const [first, ...rest] = visionRuntimeCandidates(env);
  if (!first) return { provider, model, switched: false, fallbacks: [] };
  return { provider: first.provider, model: first.model, switched: true, fallbacks: rest };
}

function shouldAttachVisionContent(provider, model, visionRuntime = selectVisionRuntime(provider, model)) {
  return Boolean(visionRuntime && visionRuntime.switched) || modelSupportsVision(provider, model);
}

/** Base URL + key for an OpenAI-SDK client of a vision runtime (non-streaming helpers). */
function visionClientConfig(provider, env = process.env) {
  const p = normalizeProviderName(provider);
  if (p === 'gemini' || p === 'google') {
    return { apiKey: env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', strictJsonSchema: false };
  }
  if (p === 'meta' || p === 'llama') {
    return {
      apiKey: env.MODEL_API_KEY || env.META_API_KEY || env.LLAMA_API_KEY,
      baseURL: env.META_BASE_URL || env.LLAMA_BASE_URL || 'https://api.meta.ai/v1',
      strictJsonSchema: false,
    };
  }
  if (p === 'xai' || p === 'x-ai' || p === 'grok') {
    return { apiKey: env.XAI_API_KEY, baseURL: env.XAI_BASE_URL || 'https://api.x.ai/v1', strictJsonSchema: false };
  }
  if (p === 'openrouter') {
    return { apiKey: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', strictJsonSchema: false };
  }
  return { apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL || undefined, strictJsonSchema: true };
}

module.exports = {
  modelSupportsVision,
  visionRuntimeCandidates,
  selectVisionRuntime,
  shouldAttachVisionContent,
  visionClientConfig,
};
