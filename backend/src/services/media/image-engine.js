'use strict';

/**
 * image-engine — provider-agnostic image GENERATION + EDIT engine.
 *
 * One stable surface for every caller (agent tools, routes, pipelines):
 *
 *   generateImage(spec) → { ok, images:[{ b64, mime }], provider, model, attempts }
 *   editImage(spec)     → { ok, images:[{ b64, mime }], provider, model, attempts }
 *
 * The engine routes a model id to its provider (gpt-image-* → OpenAI,
 * imagen-* or gemini-* → Gemini, fal-ai prefixes → fal.ai, grok-* → xAI,
 * any vendor/slug → OpenRouter) and — when the chosen provider fails or has no
 * API key — fails over to the next CONFIGURED provider so "crea una imagen"
 * produces a result with whichever image model the deployment has available.
 * Every attempt is recorded in `attempts` so callers can surface what
 * actually happened (provider used, fallbacks taken).
 *
 * Provider quirks honored here (mined from the battle-tested
 * /api/ai/generate-image route):
 *   - gpt-image-* only accepts sizes 1024x1024|1536x1024|1024x1536 and
 *     quality auto|high|medium|low; it REJECTS response_format.
 *   - dall-e-* needs response_format:'b64_json' and the legacy sizes.
 *   - Google's OpenAI-compatible images endpoint REJECTS response_format.
 *   - OpenRouter generates images via chat.completions with
 *     modalities:['image','text']; some models intermittently 404 → one
 *     retry against a broadly-available fallback model.
 *   - fal.ai uses its own SDK with an image_size enum.
 *   - xAI images.generate supports model/prompt/n/response_format only.
 *
 * All network clients are lazy-required and injectable (see _internal
 * seams) so unit tests run fully offline.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 120_000;

const PROVIDERS = ['openai', 'gemini', 'fal', 'openrouter', 'xai'];

const DEFAULT_MODEL_BY_PROVIDER = {
  openai: process.env.SIRAGPT_IMAGE_MODEL_OPENAI || 'gpt-image-2',
  gemini: process.env.SIRAGPT_IMAGE_MODEL_GEMINI || 'imagen-4.0-generate-001',
  fal: process.env.SIRAGPT_IMAGE_MODEL_FAL || 'fal-ai/flux/schnell',
  openrouter: process.env.SIRAGPT_IMAGE_MODEL_OPENROUTER || 'google/gemini-2.5-flash-image',
  xai: process.env.SIRAGPT_IMAGE_MODEL_XAI || 'grok-2-image',
};

// Broadly-available OpenRouter image model used as the in-provider retry
// when the requested model has no endpoint for image output modalities.
const OPENROUTER_FALLBACK_MODEL = 'google/gemini-2.5-flash-image';

const EDIT_MODEL_BY_PROVIDER = {
  gemini: process.env.SIRAGPT_IMAGE_EDIT_MODEL_GEMINI || 'gemini-2.5-flash-image',
  openai: process.env.SIRAGPT_IMAGE_EDIT_MODEL_OPENAI || 'gpt-image-1',
};

// ── Test seams ────────────────────────────────────────────────────────────

let _openAIFactory = null;   // (config) => OpenAI-shaped client
let _googleGenAIFactory = null; // () => GoogleGenAI-shaped client
let _falFactory = null;      // () => fal-shaped client ({ config, subscribe })
let _fetchImpl = null;

function getFetch() {
  if (_fetchImpl) return _fetchImpl;
  return typeof fetch === 'function' ? fetch : null;
}

// ── Configuration helpers ─────────────────────────────────────────────────

function envKey(name) {
  return String(process.env[name] || '').trim();
}

function providerApiKey(provider) {
  switch (provider) {
    case 'openai': return envKey('OPENAI_API_KEY');
    case 'gemini': return envKey('GEMINI_API_KEY') || envKey('GOOGLE_GENERATIVE_AI_API_KEY');
    case 'openrouter': return envKey('OPENROUTER_API_KEY');
    case 'fal': return envKey('FAL_KEY') || envKey('FAL_API_KEY');
    case 'xai': return envKey('XAI_API_KEY');
    default: return '';
  }
}

function isProviderConfigured(provider) {
  return providerApiKey(provider).length > 0;
}

/** Configured providers in failover order (env-overridable). */
function listConfiguredProviders() {
  const order = String(process.env.SIRAGPT_IMAGE_FAILOVER_ORDER || '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => PROVIDERS.includes(p));
  const chain = order.length ? order : PROVIDERS;
  return chain.filter(isProviderConfigured);
}

// ── Model → provider routing ──────────────────────────────────────────────

/**
 * Infer the provider for an image model id. Returns null for unknown ids
 * (caller falls back to the configured-provider chain).
 */
function resolveImageModelRoute(model) {
  const m = String(model || '').trim();
  if (!m) return null;
  const low = m.toLowerCase();
  if (low.startsWith('fal-ai/') || low.startsWith('fal/')) return { provider: 'fal', model: m };
  if (/^(gpt-image|dall-e|chatgpt-image)/.test(low)) return { provider: 'openai', model: m };
  if (/^(imagen-|gemini)/.test(low)) return { provider: 'gemini', model: m };
  if (/grok/.test(low) && !low.includes('/')) return { provider: 'xai', model: m };
  if (low.includes('/')) return { provider: 'openrouter', model: m };
  return null;
}

// ── Spec normalization ────────────────────────────────────────────────────

const ORIENTATION_TO_RATIO = { square: '1:1', wide: '16:9', portrait: '3:4', landscape: '16:9', vertical: '3:4', horizontal: '16:9' };
const KNOWN_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']);

function normalizeAspectRatio(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '1:1';
  if (ORIENTATION_TO_RATIO[v]) return ORIENTATION_TO_RATIO[v];
  const ratio = v.replace('x', ':');
  if (KNOWN_RATIOS.has(ratio)) return ratio;
  return '1:1';
}

function ratioOrientation(ratio) {
  const [w, h] = String(ratio).split(':').map((n) => Number.parseFloat(n));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w === h) return 'square';
  return w > h ? 'wide' : 'portrait';
}

// Accepts the app's '512px'|'1K'|'2K'|'4K' tokens AND the agent tool's
// 'standard'|'hd' tokens; normalizes to the app token space.
function normalizeQuality(value) {
  const v = String(value || '').trim();
  if (['512px', '1K', '2K', '4K'].includes(v)) return v;
  const low = v.toLowerCase();
  if (low === 'hd' || low === 'high') return '2K';
  if (low === 'standard' || low === 'medium') return '1K';
  if (low === 'low') return '512px';
  return '2K';
}

function gptImageSizeFor(ratio) {
  const o = ratioOrientation(ratio);
  if (o === 'wide') return '1536x1024';
  if (o === 'portrait') return '1024x1536';
  return '1024x1024';
}

function gptImageQualityFor(quality) {
  switch (quality) {
    case '512px': return 'low';
    case '1K': return 'medium';
    case '2K':
    case '4K': return 'high';
    default: return 'auto';
  }
}

function dallESizeFor(ratio) {
  const o = ratioOrientation(ratio);
  if (o === 'wide') return '1792x1024';
  if (o === 'portrait') return '1024x1792';
  return '1024x1024';
}

function dallEQualityFor(quality) {
  return quality === '2K' || quality === '4K' ? 'hd' : 'standard';
}

function falImageSizeFor(ratio) {
  switch (ratio) {
    case '9:16':
    case '2:3': return 'portrait_16_9';
    case '3:4': return 'portrait_4_3';
    case '16:9':
    case '3:2': return 'landscape_16_9';
    case '4:3': return 'landscape_4_3';
    case '1:1':
    default: return 'square_hd';
  }
}

function openRouterImageSizeFor(quality) {
  return quality === '2K' || quality === '4K' ? '2K' : '1K';
}

function stripImageDataUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  return match ? match[1] : trimmed;
}

// ── Client factories (lazy + injectable) ──────────────────────────────────

function createOpenAIClient({ apiKey, baseURL, defaultHeaders }) {
  if (_openAIFactory) return _openAIFactory({ apiKey, baseURL, defaultHeaders });
  // eslint-disable-next-line global-require
  const OpenAI = require('openai');
  const Ctor = OpenAI.OpenAI || OpenAI;
  return new Ctor({ apiKey, ...(baseURL ? { baseURL } : {}), ...(defaultHeaders ? { defaultHeaders } : {}) });
}

function createGoogleGenAIClient() {
  if (_googleGenAIFactory) return _googleGenAIFactory();
  // eslint-disable-next-line global-require
  const { GoogleGenAI } = require('@google/genai');
  return new GoogleGenAI({ apiKey: providerApiKey('gemini') });
}

function createFalClient() {
  if (_falFactory) return _falFactory();
  // eslint-disable-next-line global-require
  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: providerApiKey('fal') });
  return fal;
}

// ── Timeout helper ────────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createAttemptSignal(parentSignal, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  if (timeout.unref) timeout.unref();

  const forwardAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason || new Error('aborted'));
    }
  };

  if (parentSignal) {
    if (parentSignal.aborted) forwardAbort();
    else parentSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
        parentSignal.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

// ── Generation adapters (one per provider) ────────────────────────────────
// Each returns an array of base64 PNG strings (no data: prefix) or throws.

async function generateWithOpenAI({ model, prompt, ratio, quality, n, signal, timeoutMs }) {
  const client = createOpenAIClient({ apiKey: providerApiKey('openai') });
  const useModel = model || DEFAULT_MODEL_BY_PROVIDER.openai;
  const isGptImage = /^(gpt-image|chatgpt-image)/.test(useModel.toLowerCase());
  const payload = isGptImage
    ? { model: useModel, prompt, n, size: gptImageSizeFor(ratio), quality: gptImageQualityFor(quality) }
    : { model: useModel, prompt, n, size: dallESizeFor(ratio), quality: dallEQualityFor(quality), response_format: 'b64_json' };
  const response = await withTimeout(
    client.images.generate(payload, { signal, timeout: timeoutMs }),
    timeoutMs,
    `openai:${useModel}`
  );
  return (response?.data || []).map((d) => d.b64_json || stripImageDataUrl(d.url)).filter(Boolean);
}

async function generateWithGemini({ model, prompt, n, signal, timeoutMs }) {
  const client = createOpenAIClient({
    apiKey: providerApiKey('gemini'),
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  });
  const useModel = model || DEFAULT_MODEL_BY_PROVIDER.gemini;
  // Google's OpenAI-compatible endpoint returns b64_json by default and
  // rejects the response_format parameter.
  const response = await withTimeout(
    client.images.generate({ model: useModel, prompt, n, size: '1024x1024' }, { signal }),
    timeoutMs,
    `gemini:${useModel}`
  );
  return (response?.data || []).map((d) => d.b64_json || stripImageDataUrl(d.url)).filter(Boolean);
}

function extractOpenRouterImageBase64s(response) {
  const message = response?.choices?.[0]?.message || {};
  const candidates = [];
  if (Array.isArray(message.images)) {
    for (const image of message.images) {
      candidates.push(image?.image_url?.url || image?.imageUrl?.url || image?.url || image?.data);
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      candidates.push(part?.image_url?.url || part?.imageUrl?.url || part?.url || part?.data);
    }
  }
  if (typeof message.content === 'string' && message.content.startsWith('data:image/')) {
    candidates.push(message.content);
  }
  return candidates.map(stripImageDataUrl).filter(Boolean);
}

async function generateWithOpenRouter({ model, prompt, ratio, quality, n, signal, timeoutMs }) {
  const client = createOpenAIClient({
    apiKey: providerApiKey('openrouter'),
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.BASE_URL || 'http://localhost:3000',
      'X-Title': 'siraGPT',
    },
  });

  const callOnce = async (useModel) => {
    const response = await withTimeout(
      client.chat.completions.create({
        model: useModel,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
        image_config: { aspect_ratio: ratio, image_size: openRouterImageSizeFor(quality) },
        stream: false,
      }, { signal }),
      timeoutMs,
      `openrouter:${useModel}`
    );
    const images = extractOpenRouterImageBase64s(response);
    if (!images.length) throw new Error('OpenRouter did not return an image.');
    return images.slice(0, n);
  };

  const useModel = model || DEFAULT_MODEL_BY_PROVIDER.openrouter;
  try {
    return await callOnce(useModel);
  } catch (err) {
    const msg = String((err && err.message) || '').toLowerCase();
    const status = err && (err.status || err.statusCode);
    const recoverable =
      status === 404 ||
      msg.includes('no endpoints') ||
      msg.includes('output modalities') ||
      msg.includes('did not return an image') ||
      msg.includes('not a valid model');
    if (recoverable && useModel !== OPENROUTER_FALLBACK_MODEL) {
      return await callOnce(OPENROUTER_FALLBACK_MODEL);
    }
    throw err;
  }
}

async function generateWithFal({ model, prompt, ratio, n, signal, timeoutMs }) {
  const fal = createFalClient();
  const endpoint = String(model || DEFAULT_MODEL_BY_PROVIDER.fal).trim() || DEFAULT_MODEL_BY_PROVIDER.fal;
  const result = await withTimeout(
    fal.subscribe(endpoint, {
      input: { prompt, image_size: falImageSizeFor(ratio), num_images: Math.min(n, 4) },
      logs: false,
    }),
    timeoutMs,
    `fal:${endpoint}`
  );
  const images = result?.data?.images || result?.images || [];
  const urls = images.map((img) => img && img.url).filter(Boolean);
  if (!urls.length) throw new Error('fal.ai no devolvió ninguna imagen.');

  const doFetch = getFetch();
  if (!doFetch) throw new Error('fetch is not available in this runtime.');
  const b64s = [];
  for (const url of urls.slice(0, n)) {
    const resp = await doFetch(url, signal ? { signal } : undefined);
    if (!resp || !resp.ok) {
      throw new Error(`fal.ai: no se pudo descargar la imagen generada (HTTP ${resp ? resp.status : 'sin respuesta'}).`);
    }
    b64s.push(Buffer.from(await resp.arrayBuffer()).toString('base64'));
  }
  return b64s;
}

async function generateWithXai({ model, prompt, n, signal, timeoutMs }) {
  const client = createOpenAIClient({ apiKey: providerApiKey('xai'), baseURL: 'https://api.x.ai/v1' });
  const useModel = model || DEFAULT_MODEL_BY_PROVIDER.xai;
  // xAI's images endpoint accepts model/prompt/n/response_format only —
  // no size/quality parameters.
  const response = await withTimeout(
    client.images.generate({ model: useModel, prompt, n, response_format: 'b64_json' }, { signal }),
    timeoutMs,
    `xai:${useModel}`
  );
  return (response?.data || []).map((d) => d.b64_json || stripImageDataUrl(d.url)).filter(Boolean);
}

const GENERATORS = {
  openai: generateWithOpenAI,
  gemini: generateWithGemini,
  openrouter: generateWithOpenRouter,
  fal: generateWithFal,
  xai: generateWithXai,
};

// ── Public: generateImage ─────────────────────────────────────────────────

/**
 * Generate image(s) with automatic provider routing + failover.
 *
 * @param {object} spec
 * @param {string} spec.prompt        required
 * @param {string} [spec.model]       image model id (any provider) — routed automatically
 * @param {string} [spec.provider]    explicit provider override ('openai'|'gemini'|'fal'|'openrouter'|'xai')
 * @param {string} [spec.aspectRatio] '1:1'|'16:9'|'3:4'|… or 'square'|'wide'|'portrait'
 * @param {string} [spec.quality]     '512px'|'1K'|'2K'|'4K' or 'standard'|'hd'
 * @param {number} [spec.n]           1..4 (default 1)
 * @param {AbortSignal} [spec.signal]
 * @param {boolean} [spec.failover]   default true — try other configured providers on failure
 * @returns {Promise<{ok:boolean, images?:Array<{b64:string,mime:string}>, provider?:string, model?:string, attempts:Array, error?:string}>}
 */
async function generateImage(spec = {}) {
  const prompt = String(spec.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'prompt is required', attempts: [] };

  const ratio = normalizeAspectRatio(spec.aspectRatio);
  const quality = normalizeQuality(spec.quality);
  const n = Math.min(Math.max(Number.parseInt(spec.n, 10) || 1, 1), 4);
  const timeoutMs = Number(spec.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const allowFailover = spec.failover !== false;

  // Build the attempt plan: requested provider/model first, then the rest
  // of the configured chain with each provider's default model.
  const plan = [];
  const requestedProvider = String(spec.provider || '').trim().toLowerCase();
  const route = requestedProvider && PROVIDERS.includes(requestedProvider)
    ? { provider: requestedProvider, model: spec.model || null }
    : resolveImageModelRoute(spec.model);
  if (route) plan.push({ provider: route.provider, model: route.model || null, requested: true });
  if (allowFailover || plan.length === 0) {
    for (const provider of listConfiguredProviders()) {
      if (plan.some((p) => p.provider === provider)) continue;
      plan.push({ provider, model: null, requested: false });
      if (!allowFailover) break; // only one attempt when failover is disabled
    }
  }

  if (!plan.length) {
    return {
      ok: false,
      code: 'NO_PROVIDER',
      error: 'No hay ningún proveedor de imágenes configurado (OPENAI_API_KEY, GEMINI_API_KEY, FAL_KEY, OPENROUTER_API_KEY o XAI_API_KEY).',
      attempts: [],
    };
  }

  const attempts = [];
  for (const step of plan) {
    if (!isProviderConfigured(step.provider)) {
      attempts.push({ provider: step.provider, model: step.model, ok: false, error: 'api key missing' });
      continue;
    }
    const model = step.model || DEFAULT_MODEL_BY_PROVIDER[step.provider];
    const attemptSignal = createAttemptSignal(spec.signal, timeoutMs, `${step.provider}:${model}`);
    try {
      const b64s = await GENERATORS[step.provider]({
        model, prompt, ratio, quality, n,
        signal: attemptSignal.signal, timeoutMs,
      });
      if (!b64s || !b64s.length) throw new Error('provider returned no image data');
      attempts.push({ provider: step.provider, model, ok: true });
      return {
        ok: true,
        images: b64s.map((b64) => ({ b64, mime: 'image/png' })),
        provider: step.provider,
        model,
        attempts,
      };
    } catch (err) {
      if (spec.signal && spec.signal.aborted) {
        attempts.push({ provider: step.provider, model, ok: false, error: 'aborted' });
        return { ok: false, code: 'ABORTED', error: 'generation aborted', attempts };
      }
      attempts.push({ provider: step.provider, model, ok: false, error: (err && err.message) || String(err) });
    } finally {
      attemptSignal.cleanup();
    }
  }

  const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ');
  return { ok: false, code: 'ALL_PROVIDERS_FAILED', error: `No se pudo generar la imagen. ${detail}`.trim(), attempts };
}

// ── Edit adapters ─────────────────────────────────────────────────────────

async function editWithGemini({ model, prompt, imageBuffer, mimeType, timeoutMs }) {
  const ai = createGoogleGenAIClient();
  const useModel = model || EDIT_MODEL_BY_PROVIDER.gemini;
  const response = await withTimeout(
    ai.models.generateContent({
      model: useModel,
      contents: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'image/png', data: imageBuffer.toString('base64') } },
      ],
    }),
    timeoutMs,
    `gemini-edit:${useModel}`
  );
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) return [part.inlineData.data];
  }
  throw new Error('Gemini no devolvió una imagen editada.');
}

async function editWithOpenAI({ model, prompt, imageBuffer, mimeType, signal, timeoutMs }) {
  const client = createOpenAIClient({ apiKey: providerApiKey('openai') });
  // eslint-disable-next-line global-require
  const { toFile } = require('openai');
  const imageFile = await toFile(imageBuffer, 'source.png', { type: mimeType || 'image/png' });
  const useModel = model || EDIT_MODEL_BY_PROVIDER.openai;
  const response = await withTimeout(
    client.images.edit({
      image: imageFile,
      prompt,
      model: useModel,
      n: 1,
      size: '1024x1024',
      quality: 'auto',
    }, { signal }),
    timeoutMs,
    `openai-edit:${useModel}`
  );
  const b64 = response?.data?.[0]?.b64_json || stripImageDataUrl(response?.data?.[0]?.url);
  if (!b64) throw new Error('OpenAI no devolvió una imagen editada.');
  return [b64];
}

const EDITORS = { gemini: editWithGemini, openai: editWithOpenAI };

/**
 * Edit an existing image with a natural-language instruction (img2img).
 * Tries Gemini first (fast/cheap), then OpenAI — only configured providers.
 *
 * @param {object} spec
 * @param {string} spec.prompt       edit instruction (required)
 * @param {Buffer} spec.imageBuffer  source image bytes (required)
 * @param {string} [spec.mimeType]   default image/png
 * @param {string} [spec.model]      edit model override (routes provider)
 * @param {string} [spec.provider]   explicit provider ('gemini'|'openai')
 */
async function editImage(spec = {}) {
  const prompt = String(spec.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'prompt is required', attempts: [] };
  if (!spec.imageBuffer || !Buffer.isBuffer(spec.imageBuffer) || !spec.imageBuffer.length) {
    return { ok: false, error: 'imageBuffer is required', attempts: [] };
  }
  const timeoutMs = Number(spec.timeoutMs) || DEFAULT_TIMEOUT_MS;

  const plan = [];
  const requested = String(spec.provider || '').trim().toLowerCase();
  if (requested && EDITORS[requested]) {
    plan.push({ provider: requested, model: spec.model || null });
  } else if (spec.model) {
    const route = resolveImageModelRoute(spec.model);
    if (route && EDITORS[route.provider]) plan.push({ provider: route.provider, model: route.model });
  }
  for (const provider of ['gemini', 'openai']) {
    if (plan.some((p) => p.provider === provider)) continue;
    plan.push({ provider, model: null });
  }

  const attempts = [];
  for (const step of plan) {
    if (!isProviderConfigured(step.provider)) {
      attempts.push({ provider: step.provider, model: step.model, ok: false, error: 'api key missing' });
      continue;
    }
    const model = step.model || EDIT_MODEL_BY_PROVIDER[step.provider];
    try {
      const b64s = await EDITORS[step.provider]({
        model,
        prompt,
        imageBuffer: spec.imageBuffer,
        mimeType: spec.mimeType,
        signal: spec.signal,
        timeoutMs,
      });
      attempts.push({ provider: step.provider, model, ok: true });
      return {
        ok: true,
        images: b64s.map((b64) => ({ b64, mime: 'image/png' })),
        provider: step.provider,
        model,
        attempts,
      };
    } catch (err) {
      if (spec.signal && spec.signal.aborted) {
        attempts.push({ provider: step.provider, model, ok: false, error: 'aborted' });
        return { ok: false, code: 'ABORTED', error: 'edit aborted', attempts };
      }
      attempts.push({ provider: step.provider, model, ok: false, error: (err && err.message) || String(err) });
    }
  }

  if (!attempts.some((a) => a.error !== 'api key missing')) {
    return {
      ok: false,
      code: 'NO_PROVIDER',
      error: 'La edición de imágenes requiere GEMINI_API_KEY u OPENAI_API_KEY configuradas.',
      attempts,
    };
  }
  const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ');
  return { ok: false, code: 'ALL_PROVIDERS_FAILED', error: `No se pudo editar la imagen. ${detail}`.trim(), attempts };
}

module.exports = {
  generateImage,
  editImage,
  resolveImageModelRoute,
  listConfiguredProviders,
  isProviderConfigured,
  DEFAULT_MODEL_BY_PROVIDER,
  EDIT_MODEL_BY_PROVIDER,
  _internal: {
    normalizeAspectRatio,
    normalizeQuality,
    gptImageSizeFor,
    gptImageQualityFor,
    dallESizeFor,
    dallEQualityFor,
    falImageSizeFor,
    openRouterImageSizeFor,
    stripImageDataUrl,
    extractOpenRouterImageBase64s,
    withTimeout,
    createAttemptSignal,
    setOpenAIFactory: (fn) => { _openAIFactory = fn; },
    setGoogleGenAIFactory: (fn) => { _googleGenAIFactory = fn; },
    setFalFactory: (fn) => { _falFactory = fn; },
    setFetchImpl: (fn) => { _fetchImpl = fn; },
    resetTestSeams: () => { _openAIFactory = null; _googleGenAIFactory = null; _falFactory = null; _fetchImpl = null; },
  },
};
