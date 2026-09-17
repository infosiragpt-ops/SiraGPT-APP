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

test('generateImage retries dall-e without response_format when OpenAI rejects it', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async (payload) => {
      calls.push(payload);
      if (payload.response_format) throw new Error("400 Unknown parameter: 'response_format'.");
      return { data: [{ url: 'https://openai.example/generated.png' }] };
    },
  }));
  _internal.setFetchImpl(async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('openai-url-bytes'),
  }));
  try {
    const result = await engine.generateImage({ prompt: 'a cat', model: 'dall-e-3', aspectRatio: 'portrait', failover: false });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].response_format, 'b64_json');
    assert.equal(calls[1].response_format, undefined);
    assert.equal(Buffer.from(result.images[0].b64, 'base64').toString(), 'openai-url-bytes');
  } finally {
    restoreEnv();
  }
});

test('generateImage rejects a selected chat model instead of replacing it', async () => {
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
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PARAMS');
    assert.equal(calls.length, 0);
  } finally {
    restoreEnv();
  }
});

test('generateImage reports failure without changing the selected provider', async () => {
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
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PROVIDER');
    assert.equal(geminiCalled, false);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].ok, false);
  } finally {
    restoreEnv();
  }
});

test('generateImage aborts a hung selected provider without fallback', async () => {
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
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PROVIDER');
    assert.equal(openAiAborted, true);
    assert.equal(result.attempts.length, 1);
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

test('generateImage rejects missing credentials for the selected provider', async () => {
  setEnv({ GEMINI_API_KEY: 'g-x' });
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async () => ({ data: [{ b64_json: 'G' }] }),
  }));
  try {
    // A missing key cannot authorize silently switching to another provider.
    const result = await engine.generateImage({ prompt: 'x', model: 'fal-ai/flux/schnell' });
    assert.equal(result.ok, false);
    assert.equal(result.attempts.length, 1);
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

test('generateImage records internal error detail and exposes a safe provider error', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async () => { throw new Error('quota exceeded'); },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PROVIDER');
    assert.doesNotMatch(result.error, /quota exceeded/);
    assert.match(result.attempts[0].error, /quota exceeded/);
    assert.equal(result.attempts.length, 1);
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

test('Grok image selection uses its exact xAI model and never falls back when unavailable', async () => {
  const calls = [];
  let unavailable = false;
  try {
    setEnv({ XAI_API_KEY: 'test-xai', OPENAI_API_KEY: 'test-openai' });
    _internal.setOpenAIFactory(fakeOpenAIFactory({
      onGenerate: async (payload, _opts, config) => {
        calls.push({ model: payload.model, endpoint: config.baseURL });
        if (!unavailable) return { data: [{ b64_json: Buffer.from('grok-image').toString('base64') }] };
        const error = new Error('provider unavailable');
        error.status = 503;
        throw error;
      },
    }));
    const spec = {
      prompt: 'a landscape', model: 'grok-imagine-image-2.0', provider: 'xai', failover: false,
    };
    const generated = await engine.generateImage(spec);
    assert.equal(generated.ok, true);
    assert.equal(generated.provider, 'xai');
    assert.equal(generated.model, spec.model);
    assert.equal(generated.images[0].b64, Buffer.from('grok-image').toString('base64'));
    assert.deepEqual(calls, [{ model: spec.model, endpoint: 'https://api.x.ai/v1' }]);
    calls.length = 0;
    unavailable = true;
    const result = await engine.generateImage(spec);
    assert.equal(result.ok, false);
    assert.deepEqual(calls, [{ model: 'grok-imagine-image-2.0', endpoint: 'https://api.x.ai/v1' }]);
    assert.equal(result.attempts.length, 1);
  } finally { restoreEnv(); }
});

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

test('editImage reports a failed selected/default provider without substitution', async () => {
  setEnv({ GEMINI_API_KEY: 'g-x', OPENAI_API_KEY: 'sk-x' });
  _internal.setGoogleGenAIFactory(() => ({
    models: { generateContent: async () => { throw new Error('gemini down'); } },
  }));
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onEdit: async () => ({ data: [{ b64_json: 'OPENAI_EDIT' }] }),
  }));
  try {
    const result = await engine.editImage({ prompt: 'add a hat', imageBuffer: Buffer.from('img') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PROVIDER');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].provider, 'gemini');
  } finally {
    restoreEnv();
  }
});

test('editImage cannot switch an OpenRouter selection to another API when credentials are absent', async () => {
  setEnv({ GEMINI_API_KEY: 'g-x', OPENAI_API_KEY: 'sk-x' });
  _internal.setGoogleGenAIFactory(() => ({
    models: { generateContent: async () => { throw new Error('RESOURCE_EXHAUSTED quota exceeded'); } },
  }));
  const edits = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onEdit: async (payload) => {
      edits.push(payload);
      return { data: [{ b64_json: 'OPENAI_EDIT_AFTER_OPENROUTER_SELECTION' }] };
    },
  }));
  try {
    const result = await engine.editImage({
      prompt: 'change the selected area to pink',
      imageBuffer: Buffer.from('img'),
      model: 'google/gemini-3.1-flash-image-preview',
      provider: 'openrouter',
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].provider, 'openrouter');
    assert.equal(edits.length, 0);
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

test('editImage OpenAI uses portrait size when reframing vertical', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  const edits = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onEdit: async (payload) => {
      edits.push(payload);
      return { data: [{ b64_json: 'PORTRAIT_EDIT' }] };
    },
  }));
  try {
    const result = await engine.editImage({
      prompt: 'reframe vertical',
      imageBuffer: Buffer.from('img'),
      provider: 'openai',
      aspectRatio: '3:4',
    });
    assert.equal(result.ok, true);
    assert.equal(edits[0].size, '1024x1536');
  } finally {
    restoreEnv();
  }
});

test('editImage sends count, quality and the real PNG mask to the pinned OpenAI model', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({ onEdit: async (payload) => {
    calls.push(payload); return { data: [{ b64_json: 'ONE' }, { b64_json: 'TWO' }] };
  } }));
  try {
    const result = await engine.editImage({ model: 'gpt-image-2', provider: 'openai', prompt: 'erase selection',
      imageBuffer: Buffer.from('original'), maskBuffer: Buffer.from('mask'), aspectRatio: '16:9', quality: '2K', n: 2 });
    assert.equal(result.ok, true); assert.equal(result.images.length, 2);
    assert.equal(calls.length, 1); assert.equal(calls[0].model, 'gpt-image-2');
    assert.equal(calls[0].n, 2); assert.equal(calls[0].quality, 'high'); assert.equal(calls[0].size, '1536x1024');
    assert.ok(calls[0].mask);
  } finally { restoreEnv(); }
});

test('OpenRouter edit uses its own API, preserves model and transmits original image bytes', async () => {
  setEnv({ OPENROUTER_API_KEY: 'or-x', OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({ onChat: async (payload, opts, config) => {
    calls.push({ payload, config }); return { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,RURJVA==' } }] } }] };
  } }));
  try {
    const result = await engine.editImage({ model: 'openai/gpt-image-2', provider: 'openrouter', prompt: 'keep scene', imageBuffer: Buffer.from('beach'), aspectRatio: '3:4', quality: '2K', n: 2 });
    assert.equal(result.ok, true); assert.equal(result.images.length, 2);
    assert.equal(result.model, 'openai/gpt-image-2'); assert.equal(result.provider, 'openrouter');
    assert.equal(calls.length, 2);
    for (const { payload, config } of calls) {
      assert.equal(config.baseURL, 'https://openrouter.ai/api/v1'); assert.equal(payload.model, 'openai/gpt-image-2');
      assert.equal(payload.messages[0].content[1].image_url.url, `data:image/png;base64,${Buffer.from('beach').toString('base64')}`);
      assert.equal(payload.image_config.aspect_ratio, '3:4');
    }
  } finally { restoreEnv(); }
});

test('OpenRouter model errors cannot trigger a different image model within the same API', async () => {
  setEnv({ OPENROUTER_API_KEY: 'or-x' }); const models = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({ onChat: async (payload) => {
    models.push(payload.model); const error = new Error('no endpoints'); error.status = 404; throw error;
  } }));
  try {
    const result = await engine.generateImage({ model: 'openai/gpt-image-2', prompt: 'beach' });
    assert.equal(result.ok, false); assert.equal(result.code, 'E_PROVIDER'); assert.deepEqual(models, ['openai/gpt-image-2']);
  } finally { restoreEnv(); }
});

// ── Multi-image batching (1..5) ───────────────────────────────────────────

test('generateImage clamps n to 1..5', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  const seen = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async (payload) => {
      seen.push(payload.n);
      return { data: Array.from({ length: payload.n }, (_, i) => ({ b64_json: `IMG${i}` })) };
    },
  }));
  try {
    const nine = await engine.generateImage({ prompt: 'x', model: 'gpt-image-2', n: 9, failover: false });
    assert.equal(nine.ok, true);
    assert.equal(nine.images.length, 5);
    assert.deepEqual(seen, [5]);
    const zero = await engine.generateImage({ prompt: 'x', model: 'gpt-image-2', n: 0, failover: false });
    assert.equal(zero.ok, true);
    assert.equal(zero.images.length, 1);
  } finally {
    restoreEnv();
  }
});

test('generateImage retries sequential singles when the provider rejects batch n', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  const seen = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async (payload) => {
      seen.push(payload.n);
      if (payload.n > 1) {
        const err = new Error('Invalid value for n: must be 1, got 3');
        err.status = 400;
        throw err;
      }
      return { data: [{ b64_json: `SINGLE${seen.length}` }] };
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x', model: 'gpt-image-2', n: 3, failover: false });
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 3);
    // 1 rejected batch call + 3 sequential singles.
    assert.deepEqual(seen, [3, 1, 1, 1]);
  } finally {
    restoreEnv();
  }
});

test('generateImage never multiplies quota failures into sequential retries', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-x' });
  let calls = 0;
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onGenerate: async () => {
      calls += 1;
      const err = new Error('RESOURCE_EXHAUSTED quota exceeded');
      err.status = 429;
      throw err;
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x', model: 'gpt-image-2', n: 3, failover: false });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  } finally {
    restoreEnv();
  }
});

test('generateImage fills up to n when a provider returns fewer images', async () => {
  setEnv({ OPENROUTER_API_KEY: 'or-x' });
  let calls = 0;
  _internal.setOpenAIFactory(fakeOpenAIFactory({
    onChat: async () => {
      calls += 1;
      return { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,OR${calls}` } }] } }] };
    },
  }));
  try {
    const result = await engine.generateImage({ prompt: 'x', model: 'google/gemini-2.5-flash-image', n: 3, failover: false });
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 3);
    assert.equal(calls, 3);
    assert.deepEqual(result.images.map((i) => i.b64), ['OR1', 'OR2', 'OR3']);
  } finally {
    restoreEnv();
  }
});

test('isBatchSizeError ignores quota/auth/moderation failures', () => {
  const { isBatchSizeError } = _internal;
  assert.equal(isBatchSizeError(Object.assign(new Error('Invalid value for n: must be 1'), { status: 400 })), true);
  assert.equal(isBatchSizeError(Object.assign(new Error('quota exceeded'), { status: 429 })), false);
  assert.equal(isBatchSizeError(Object.assign(new Error('incorrect api key'), { status: 401 })), false);
  assert.equal(isBatchSizeError(new Error('content policy violation: blocked')), false);
  assert.equal(isBatchSizeError(new Error('openai is down')), false);
});

test('remove background requests native transparency and rejects opaque provider results', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-test' });
  const sharp = require('sharp');
  let opaque = false; const calls = [];
  _internal.setOpenAIFactory(fakeOpenAIFactory({ onEdit: async (payload) => {
    calls.push(payload);
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: opaque ? '#ff0000ff' : '#ff000080' } }).png().toBuffer();
    return { data: [{ b64_json: bytes.toString('base64') }] };
  } }));
  try {
    const spec = { model: 'gpt-image-2', provider: 'openai', prompt: 'remove background', imageBuffer: Buffer.from('source'), background: 'transparent' };
    assert.equal((await engine.editImage(spec)).ok, true);
    assert.equal(calls[0].background, 'transparent'); assert.equal(calls[0].output_format, 'png');
    opaque = true;
    const failed = await engine.editImage(spec);
    assert.equal(failed.ok, false); assert.equal(failed.code, 'E_PROVIDER');
    const unsupported = await engine.editImage({ ...spec, provider: 'openrouter', model: 'openai/gpt-image-2' });
    assert.equal(unsupported.code, 'E_PARAMS'); assert.equal(calls.length, 2);
  } finally { restoreEnv(); }
});

test('prefixed Grok image catalog identifiers remain on their own API', () => {
  assert.deepEqual(engine.resolveImageModelRoute('x-ai/grok-2-image'), { provider: 'xai', model: 'grok-2-image' });
});

test('editImage aborts the actual provider request when its deadline expires', async () => {
  setEnv({ OPENAI_API_KEY: 'sk-test' }); let providerAborted = false;
  _internal.setOpenAIFactory(fakeOpenAIFactory({ onEdit: async (_payload, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => { providerAborted = true; reject(opts.signal.reason); }, { once: true });
  }) }));
  try {
    const result = await engine.editImage({ model: 'gpt-image-2', prompt: 'edit', imageBuffer: Buffer.from('source'), timeoutMs: 20 });
    assert.equal(result.ok, false); assert.equal(result.code, 'E_PROVIDER'); assert.equal(providerAborted, true);
    assert.equal(result.attempts.length, 1);
  } finally { restoreEnv(); }
});
