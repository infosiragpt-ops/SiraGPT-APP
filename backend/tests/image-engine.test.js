/**
 * Tests for services/media/image-engine.js — the provider-agnostic image
 * generation + edit engine (model→provider routing, per-provider payload
 * quirks, failover chain, abort handling). Fully offline via the engine's
 * injectable client seams.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/media/image-engine');
const { _internal } = engine;

const ENV_KEYS = [
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY', 'FAL_KEY', 'FAL_API_KEY', 'XAI_API_KEY',
  'SIRAGPT_IMAGE_FAILOVER_ORDER',
];
const savedEnv = {};

function setEnv(overrides) {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    process.env[key] = value;
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  _internal.resetTestSeams();
}

function fakeOpenAIFactory({ onGenerate, onChat, onEdit } = {}) {
  return (config) => ({
    __config: config,
    images: {
      generate: async (payload, opts) => {
        if (!onGenerate) throw new Error('images.generate not stubbed');
        return onGenerate(payload, opts, config);
      },
      edit: async (payload, opts) => {
        if (!onEdit) throw new Error('images.edit not stubbed');
        return onEdit(payload, opts, config);
      },
    },
    chat: {
      completions: {
        create: async (payload, opts) => {
          if (!onChat) throw new Error('chat.completions.create not stubbed');
          return onChat(payload, opts, config);
        },
      },
    },
  });
}

// ── Pure helpers ──────────────────────────────────────────────────────────

test('resolveImageModelRoute maps model ids to providers', () => {
  assert.deepEqual(engine.resolveImageModelRoute('gpt-image-2'), { provider: 'openai', model: 'gpt-image-2' });
  assert.deepEqual(engine.resolveImageModelRoute('dall-e-3'), { provider: 'openai', model: 'dall-e-3' });
  assert.deepEqual(engine.resolveImageModelRoute('imagen-4.0-generate-001'), { provider: 'gemini', model: 'imagen-4.0-generate-001' });
  assert.deepEqual(engine.resolveImageModelRoute('gemini-2.5-flash-image'), { provider: 'gemini', model: 'gemini-2.5-flash-image' });
  assert.deepEqual(engine.resolveImageModelRoute('fal-ai/flux/schnell'), { provider: 'fal', model: 'fal-ai/flux/schnell' });
  assert.deepEqual(engine.resolveImageModelRoute('google/gemini-2.5-flash-image'), { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });
  assert.deepEqual(engine.resolveImageModelRoute('grok-2-image'), { provider: 'xai', model: 'grok-2-image' });
  assert.equal(engine.resolveImageModelRoute('mystery-model'), null);
  assert.equal(engine.resolveImageModelRoute(''), null);
  assert.equal(engine.resolveImageModelRoute(null), null);
});

test('normalizeAspectRatio accepts orientations, ratios and w x h forms', () => {
  assert.equal(_internal.normalizeAspectRatio('square'), '1:1');
  assert.equal(_internal.normalizeAspectRatio('wide'), '16:9');
  assert.equal(_internal.normalizeAspectRatio('portrait'), '3:4');
  assert.equal(_internal.normalizeAspectRatio('9:16'), '9:16');
  assert.equal(_internal.normalizeAspectRatio('16x9'), '16:9');
  assert.equal(_internal.normalizeAspectRatio('weird'), '1:1');
  assert.equal(_internal.normalizeAspectRatio(''), '1:1');
});

test('gpt-image size/quality mapping honors the fixed allowed sets', () => {
  assert.equal(_internal.gptImageSizeFor('16:9'), '1536x1024');
  assert.equal(_internal.gptImageSizeFor('9:16'), '1024x1536');
  assert.equal(_internal.gptImageSizeFor('1:1'), '1024x1024');
  assert.equal(_internal.gptImageQualityFor('512px'), 'low');
  assert.equal(_internal.gptImageQualityFor('1K'), 'medium');
  assert.equal(_internal.gptImageQualityFor('2K'), 'high');
  assert.equal(_internal.gptImageQualityFor('4K'), 'high');
});

test('quality normalization accepts both token spaces', () => {
  assert.equal(_internal.normalizeQuality('hd'), '2K');
  assert.equal(_internal.normalizeQuality('standard'), '1K');
  assert.equal(_internal.normalizeQuality('4K'), '4K');
  assert.equal(_internal.normalizeQuality(''), '2K');
});

test('fal image_size enum mapping', () => {
  assert.equal(_internal.falImageSizeFor('1:1'), 'square_hd');
  assert.equal(_internal.falImageSizeFor('16:9'), 'landscape_16_9');
  assert.equal(_internal.falImageSizeFor('3:4'), 'portrait_4_3');
  assert.equal(_internal.falImageSizeFor('9:16'), 'portrait_16_9');
});

test('stripImageDataUrl strips the data: prefix and keeps bare base64', () => {
  assert.equal(_internal.stripImageDataUrl('data:image/png;base64,AAAA'), 'AAAA');
  assert.equal(_internal.stripImageDataUrl('AAAA'), 'AAAA');
  assert.equal(_internal.stripImageDataUrl(42), null);
});

// ── Configuration ─────────────────────────────────────────────────────────

test('listConfiguredProviders reflects non-empty env keys only', () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: '   ' });
  try {
    assert.deepEqual(engine.listConfiguredProviders(), ['openai']);
    assert.equal(engine.isProviderConfigured('gemini'), false);
  } finally {
    restoreEnv();
  }
});

test('SIRAGPT_IMAGE_FAILOVER_ORDER reorders the chain', () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', FAL_KEY: 'fal-x', SIRAGPT_IMAGE_FAILOVER_ORDER: 'fal,openai' });
  try {
    assert.deepEqual(engine.listConfiguredProviders(), ['fal', 'openai']);
  } finally {
    restoreEnv();
  }
});

// ── generateImage ─────────────────────────────────────────────────────────

test('generateImage routes a gpt-image model to OpenAI with the right payload', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async (payload) => {
      calls.push(payload);
      return { data: [{ b64_json: 'IMGDATA' }] };
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'a dog', model: 'gpt-image-2', aspectRatio: 'wide', quality: 'hd' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-image-2');
    assert.equal(result.images[0].b64, 'IMGDATA');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].size, '1536x1024');
    assert.equal(calls[0].quality, 'high');
    assert.equal(calls[0].response_format, undefined); // gpt-image-* rejects it
  } finally {
    restoreEnv();
  }
});

test('generateImage sends response_format for dall-e models', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async (payload) => { calls.push(payload); return { data: [{ b64_json: 'D' }] }; },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'a cat', model: 'dall-e-3', aspectRatio: 'portrait' });
    assert.equal(result.ok, true);
    assert.equal(calls[0].response_format, 'b64_json');
    assert.equal(calls[0].size, '1024x1792');
  } finally {
    restoreEnv();
  }
});

test('generateImage falls back to the configured image model for chat model ids', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async (payload) => {
      calls.push(payload);
      return { data: [{ b64_json: 'IMG_FROM_DEFAULT_IMAGE_MODEL' }] };
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'a product photo', model: 'gpt-4o' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-image-2');
    assert.equal(calls[0].model, 'gpt-image-2');
    assert.equal(result.images[0].b64, 'IMG_FROM_DEFAULT_IMAGE_MODEL');
  } finally {
    restoreEnv();
  }
});

test('generateImage fails over to the next configured provider', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  let geminiCalled = false;
  _internal.setOpenAIFactory((config) => ({
    images: {
      generate: async (payload) => {
        if (config.baseURL && config.baseURL.includes('generativelanguage')) {
          geminiCalled = true;
          return { data: [{ b64_json: 'FROM_GEMINI' }] };
        }
        throw new Error('openai is down');
      },
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'a bird', model: 'gpt-image-2' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.images[0].b64, 'FROM_GEMINI');
    assert.equal(geminiCalled, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].ok, false);
    assert.equal(result.attempts[1].ok, true);
  } finally {
    restoreEnv();
  }
});

test('generateImage aborts a hung provider attempt and fails over', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  let openAiAborted = false;
  _internal.setOpenAIFactory((config) => ({
    images: {
      generate: async (payload, opts = {}) => {
        if (config.baseURL && config.baseURL.includes('generativelanguage')) {
          return { data: [{ b64_json: 'FROM_GEMINI_AFTER_TIMEOUT' }] };
        }
        return new Promise((_, reject) => {
          if (opts.signal?.aborted) {
            openAiAborted = true;
            reject(new Error('already aborted'));
            return;
          }
          opts.signal?.addEventListener('abort', () => {
            openAiAborted = true;
            reject(new Error(opts.signal.reason?.message || 'aborted'));
          }, { once: true });
        });
      },
    },
  }));
  try {
    const result = await engine.generateImage({
      prompt: 'a slow provider should not block fallback',
      model: 'gpt-image-2',
      timeoutMs: 20,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.images[0].b64, 'FROM_GEMINI_AFTER_TIMEOUT');
    assert.equal(openAiAborted, true);
    assert.equal(result.attempts.length, 2);
    assert.match(result.attempts[0].error, /timed out|aborted/);
  } finally {
    restoreEnv();
  }
});

test('generateImage with failover disabled stops after the requested provider', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async () => { throw new Error('boom'); },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x', model: 'gpt-image-2', failover: false });
    assert.equal(result.ok, false);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].provider, 'openai');
  } finally {
    restoreEnv();
  }
});

test('generateImage returns NO_PROVIDER when nothing is configured', async () => {
  setEnv({});
  try {
    const result = await engine.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_PROVIDER');
  } finally {
    restoreEnv();
  }
});

test('generateImage skips an unconfigured requested provider and records it', async () => {
  setEnv({ GEMINI_API_KEY: 'g-x' });
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async () => ({ data: [{ b64_json: 'G' }] }),
  }));
  try {
    // fal requested but FAL_KEY missing → failover lands on gemini.
    const result = await engine.generateImage({ prompt: 'x', model: 'fal-ai/flux/schnell' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.attempts[0].provider, 'fal');
    assert.match(result.attempts[0].error, /api key missing/);
  } finally {
    restoreEnv();
  }
});

test('generateImage via OpenRouter extracts images from chat completions', async () => {
  setEnv({ OPENROUTER_API_KEY: 'or-x' });
  const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onChat: async (payload) => {
      calls.push(payload);
      return { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,ORDATA' } }] } }] };
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x', model: 'google/gemini-2.5-flash-image', aspectRatio: '16:9', quality: '2K' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.images[0].b64, 'ORDATA');
    assert.deepEqual(calls[0].modalities, ['image', 'text']);
    assert.equal(calls[0].image_config.aspect_ratio, '16:9');
    assert.equal(calls[0].image_config.image_size, '2K');
  } finally {
    restoreEnv();
  }
});

test('generateImage via fal downloads the generated image as base64', async () => {
  setEnv({ FAL_KEY: 'fal-x' });
  const subscribed = [];
  _internal.setFalFactory(() => ({
    subscribe: async (endpoint, opts) => {
      subscribed.push({ endpoint, input: opts.input });
      return { data: { images: [{ url: 'https://fal.example/img.png' }] } };
    },
  }));
  _internal.setFetchImpl(async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('fal-bytes'),
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x', model: 'fal-ai/flux/schnell', aspectRatio: '9:16' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'fal');
    assert.equal(subscribed[0].endpoint, 'fal-ai/flux/schnell');
    assert.equal(subscribed[0].input.image_size, 'portrait_16_9');
    assert.equal(Buffer.from(result.images[0].b64, 'base64').toString(), 'fal-bytes');
  } finally {
    restoreEnv();
  }
});

test('generateImage reports ALL_PROVIDERS_FAILED with per-provider detail', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async () => { throw new Error('quota exceeded'); },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ALL_PROVIDERS_FAILED');
    assert.match(result.error, /quota exceeded/);
    assert.equal(result.attempts.length, 2);
  } finally {
    restoreEnv();
  }
});

test('generateImage stops the chain when the caller aborts', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  const controller = new AbortController();
  let callCount = 0;
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async () => {
      callCount += 1;
      controller.abort();
      throw new Error('aborted by user');
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x', signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ABORTED');
    assert.equal(callCount, 1); // no failover after an abort
  } finally {
    restoreEnv();
  }
});

test('generateImage requires a prompt', async () => {
  const result = await engine.generateImage({ prompt: '   ' });
  assert.equal(result.ok, false);
  assert.match(result.error, /prompt/);
});

// ── editImage ─────────────────────────────────────────────────────────────

test('editImage prefers Gemini and returns the edited image', async () => {
  setEnv({ GEMINI_API_KEY: 'g-x', OPENAI_API_KEY: 'sk-x' });
  const calls = [];
  _internal.setGoogleGenAIFactory(() => ({
    models: {
      generateContent: async (payload) => {
        calls.push(payload);
        return { candidates: [{ content: { parts: [{ inlineData: { data: 'EDITED' } }] } }] };
      },
    },
  }));
  try {
    const result = await engine.editImage({ prompt: 'remove background', imageBuffer: Buffer.from('img') });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.images[0].b64, 'EDITED');
    assert.equal(calls[0].model, 'gemini-2.5-flash-image');
  } finally {
    restoreEnv();
  }
});

test('editImage falls back to OpenAI when Gemini fails', async () => {
  setEnv({ GEMINI_API_KEY: 'g-x', OPENAI_API_KEY: 'sk-x' });
  _internal.setGoogleGenAIFactory(() => ({
    models: { generateContent: async () => { throw new Error('gemini down'); } },
  }));
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onEdit: async () => ({ data: [{ b64_json: 'OPENAI_EDIT' }] }),
  }));
  try {
    const result = await engine.editImage({ prompt: 'add a hat', imageBuffer: Buffer.from('img') });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.images[0].b64, 'OPENAI_EDIT');
    assert.equal(result.attempts.length, 2);
  } finally {
    restoreEnv();
  }
});

test('editImage returns NO_PROVIDER without Gemini/OpenAI keys', async () => {
  setEnv({ FAL_KEY: 'fal-x' });
  try {
    const result = await engine.editImage({ prompt: 'x', imageBuffer: Buffer.from('img') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_PROVIDER');
  } finally {
    restoreEnv();
  }
});

test('editImage validates inputs', async () => {
  assert.equal((await engine.editImage({ prompt: '', imageBuffer: Buffer.from('x') })).ok, false);
  assert.equal((await engine.editImage({ prompt: 'x' })).ok, false);
  assert.equal((await engine.editImage({ prompt: 'x', imageBuffer: Buffer.alloc(0) })).ok, false);
});
