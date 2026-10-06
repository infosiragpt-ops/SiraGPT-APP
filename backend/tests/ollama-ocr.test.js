/**
 * GLM-OCR via Ollama as the first vision-OCR rung.
 * All offline: fetch is injected, sharp is bypassed with a pass-through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ollamaOcr = require('../src/services/ollama-ocr');
const ocrEngine = require('../src/services/ocr-engine');

const passthroughSharp = () => ({
  rotate() { return this; },
  resize() { return this; },
  png() { return this; },
  async toBuffer() { return Buffer.from('prepared'); },
});

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function makeClient({ env = {}, responder, now } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init, calls.length);
  };
  let clock = 1_000_000;
  const client = ollamaOcr.createOllamaOcrClient({
    env: { NODE_ENV: 'test', SIRAGPT_OLLAMA_OCR: '1', ...env },
    fetchImpl,
    now: now || (() => clock),
    sharpImpl: passthroughSharp,
    logger: { log() {}, warn() {} },
  });
  return { client, calls, tick: (ms) => { clock += ms; } };
}

const TAGS_WITH_MODEL = { models: [{ name: 'gemma4:26b' }, { name: 'glm-ocr:latest', model: 'glm-ocr:latest' }] };

test('config: defaults point at the Lenovo Ollama with glm-ocr, strip /v1, and stay off under NODE_ENV=test unless forced', () => {
  const prod = ollamaOcr.getOllamaOcrConfig({ NODE_ENV: 'production' });
  assert.equal(prod.enabled, true);
  assert.equal(prod.baseUrl, 'http://siragpt-ollama:11434');
  assert.equal(prod.model, 'glm-ocr');
  assert.equal(prod.task, 'text');

  const testEnv = ollamaOcr.getOllamaOcrConfig({ NODE_ENV: 'test' });
  assert.equal(testEnv.enabled, false);
  assert.equal(ollamaOcr.getOllamaOcrConfig({ NODE_ENV: 'test', SIRAGPT_OLLAMA_OCR: '1' }).enabled, true);
  assert.equal(ollamaOcr.getOllamaOcrConfig({ NODE_ENV: 'production', SIRAGPT_OLLAMA_OCR: '0' }).enabled, false);

  const custom = ollamaOcr.getOllamaOcrConfig({
    NODE_ENV: 'production',
    OLLAMA_OCR_BASE_URL: 'http://10.0.0.5:11434/v1/',
    OLLAMA_OCR_MODEL: 'glm-ocr:q8_0',
    OLLAMA_OCR_TIMEOUT_MS: '500',
    OLLAMA_OCR_TASK: 'table',
  });
  assert.equal(custom.baseUrl, 'http://10.0.0.5:11434');
  assert.equal(custom.model, 'glm-ocr:q8_0');
  assert.equal(custom.timeoutMs, 1000, 'timeout floor is 1 s');
  assert.equal(custom.task, 'table');
  assert.equal(ollamaOcr.getOllamaOcrConfig({ NODE_ENV: 'production', OLLAMA_BASE_URL: 'ollama.local:11434' }).baseUrl, 'http://ollama.local:11434');
});

test('isModelListed: a bare name only matches :latest; an explicit tag matches exactly', () => {
  assert.equal(ollamaOcr.isModelListed(TAGS_WITH_MODEL.models, 'glm-ocr'), true);
  assert.equal(ollamaOcr.isModelListed([{ name: 'glm-ocr:q8_0' }], 'glm-ocr'), false);
  assert.equal(ollamaOcr.isModelListed([{ name: 'glm-ocr:q8_0' }], 'glm-ocr:q8_0'), true);
  assert.equal(ollamaOcr.isModelListed([{ model: 'glm-ocr:latest' }], 'glm-ocr:latest'), true);
  assert.equal(ollamaOcr.isModelListed(null, 'glm-ocr'), false);
});

test('ensureAvailable: probes /api/tags once, memoises the verdict, and re-probes after the TTL', async () => {
  const { client, calls, tick } = makeClient({
    env: { OLLAMA_OCR_PROBE_TTL_MS: '60000' },
    responder: (url) => {
      assert.match(url, /^http:\/\/siragpt-ollama:11434\/api\/tags$/);
      return jsonResponse(TAGS_WITH_MODEL);
    },
  });
  const first = await client.ensureAvailable();
  assert.equal(first.available, true);
  const second = await client.ensureAvailable();
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1, 'second call served from the memo');
  tick(61_000);
  await client.ensureAvailable();
  assert.equal(calls.length, 2, 're-probed after TTL');
  assert.equal(client.describe().available, true);
});

test('ensureAvailable: a model that was never pulled, or an unreachable Ollama, is memoised as unavailable with a reason', async () => {
  const missing = makeClient({ env: { OLLAMA_OCR_AUTO_PULL: '0' }, responder: () => jsonResponse({ models: [{ name: 'gemma4:26b' }] }) });
  const verdict = await missing.client.ensureAvailable();
  assert.equal(verdict.available, false);
  assert.equal(verdict.reason, 'model_not_found');
  await missing.client.ensureAvailable();
  assert.equal(missing.calls.length, 1, 'negative verdict is memoised too');

  const down = makeClient({ responder: () => { throw new Error('connect ECONNREFUSED'); } });
  const downVerdict = await down.client.ensureAvailable();
  assert.equal(downVerdict.available, false);
  assert.equal(downVerdict.reason, 'ollama_unreachable');

  const disabled = makeClient({ env: { SIRAGPT_OLLAMA_OCR: '0' }, responder: () => jsonResponse(TAGS_WITH_MODEL) });
  assert.equal(disabled.client.isEnabled(), false);
  assert.deepEqual(await disabled.client.ensureAvailable(), { available: false, reason: 'ollama_ocr_disabled' });
  assert.equal(disabled.calls.length, 0);
});

test('auto-pull: a missing model triggers ONE background POST /api/pull, probes read model_pulling meanwhile, and the next probe after the pull finds it', async () => {
  let listed = false;
  let resolvePull;
  const calls = { tags: 0, pull: 0 };
  const { client } = makeClient({
    responder: (url, init) => {
      if (url.endsWith('/api/tags')) {
        calls.tags += 1;
        return jsonResponse(listed ? TAGS_WITH_MODEL : { models: [{ name: 'gemma4:26b' }] });
      }
      if (url.endsWith('/api/pull')) {
        calls.pull += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'glm-ocr');
        assert.equal(body.stream, false);
        return new Promise((resolve) => { resolvePull = () => { listed = true; resolve(jsonResponse({ status: 'success' })); }; });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const first = await client.ensureAvailable();
  assert.deepEqual([first.available, first.reason], [false, 'model_pulling']);
  assert.equal(client.describe().pulling, true);
  // Concurrent/next probes do not start a second pull.
  await client.resetCache();
  const again = await client.ensureAvailable();
  assert.equal(again.reason, 'model_pulling');
  assert.equal(calls.pull, 1);
  resolvePull();
  await client.waitForPull();
  assert.equal(client.describe().pulling, false);
  const after = await client.ensureAvailable();
  assert.equal(after.available, true, 'memo dropped after the pull so the probe re-ran immediately');
  assert.equal(after.cached, undefined);
  assert.equal(calls.pull, 1);
});

test('auto-pull: a failed pull parks retries for OLLAMA_OCR_PULL_RETRY_MS and OLLAMA_OCR_AUTO_PULL=0 never pulls', async () => {
  const calls = { pull: 0 };
  const failing = makeClient({
    env: { OLLAMA_OCR_PULL_RETRY_MS: '60000', OLLAMA_OCR_PROBE_TTL_MS: '30000' },
    responder: (url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [] });
      calls.pull += 1;
      return jsonResponse({ error: 'pull model manifest: file does not exist' }, { status: 500 });
    },
  });
  assert.equal((await failing.client.ensureAvailable()).reason, 'model_pulling');
  await failing.client.waitForPull();
  assert.equal(calls.pull, 1);
  assert.match(failing.client.describe().lastPullFailure.reason, /pull answered 500/);
  const parked = await failing.client.ensureAvailable();
  assert.equal(parked.reason, 'model_not_found', 'no second pull inside the retry window');
  assert.equal(calls.pull, 1);
  failing.tick(61_000);
  assert.equal((await failing.client.ensureAvailable()).reason, 'model_pulling', 'retried after the window');
  assert.equal(calls.pull, 2);
  await failing.client.waitForPull();

  const off = makeClient({
    env: { OLLAMA_OCR_AUTO_PULL: '0' },
    responder: (url) => {
      assert.ok(url.endsWith('/api/tags'), 'never calls /api/pull');
      return jsonResponse({ models: [] });
    },
  });
  assert.equal((await off.client.ensureAvailable()).reason, 'model_not_found');
  assert.equal(off.client.describe().autoPull, false);
});

test('recognize: posts the GLM-OCR task prompt + base64 image to /api/chat and returns the cleaned transcription', async () => {
  let seenBody = null;
  const { client } = makeClient({
    responder: (url, init) => {
      assert.equal(url, 'http://siragpt-ollama:11434/api/chat');
      assert.equal(init.method, 'POST');
      seenBody = JSON.parse(init.body);
      return jsonResponse({ message: { role: 'assistant', content: '<|begin_of_box|># Factura 001\n\n| Item | Total |\n|---|---|\n| Café | $12 |<|end_of_box|>' }, eval_count: 42 });
    },
  });
  const result = await client.recognize({ buffer: Buffer.from('fake-png'), mimeType: 'image/png' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'ollama:glm-ocr');
  assert.equal(result.text, '# Factura 001\n\n| Item | Total |\n|---|---|\n| Café | $12 |');
  assert.equal(result.evalCount, 42);
  assert.equal(seenBody.model, 'glm-ocr');
  assert.equal(seenBody.stream, false);
  assert.equal(seenBody.messages[0].content, 'Text Recognition:');
  assert.equal(seenBody.messages[0].images[0], Buffer.from('prepared').toString('base64'));
  assert.equal(seenBody.options.temperature, 0);

  const table = makeClient({ responder: (_u, init) => jsonResponse({ message: { content: `ok ${JSON.parse(init.body).messages[0].content}` } }) });
  assert.equal((await table.client.recognize({ buffer: Buffer.from('x'), task: 'table' })).text, 'ok Table Recognition:');
});

test('recognize: HTTP failures, empty output and timeouts come back as reasons, never throws', async () => {
  const notFound = makeClient({ responder: () => jsonResponse({ error: "model 'glm-ocr' not found, try pulling it first" }, { status: 404 }) });
  const nf = await notFound.client.recognize({ buffer: Buffer.from('x') });
  assert.deepEqual([nf.ok, nf.reason, nf.status], [false, 'model_not_found', 404]);
  assert.equal(notFound.client.describe().available, false, 'a 404 memoises the model as missing');

  const empty = makeClient({ responder: () => jsonResponse({ message: { content: '   ' } }) });
  assert.equal((await empty.client.recognize({ buffer: Buffer.from('x') })).reason, 'empty_output');

  const slow = makeClient({
    env: { OLLAMA_OCR_TIMEOUT_MS: '1000' },
    responder: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      // Fire the abort ourselves instead of waiting the real second.
      setTimeout(() => init.signal.dispatchEvent(new Event('abort')), 5);
    }),
  });
  const timedOut = await slow.client.recognize({ buffer: Buffer.from('x') });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout');

  const refused = makeClient({ responder: () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); } });
  assert.equal((await refused.client.recognize({ buffer: Buffer.from('x') })).reason, 'ollama_unreachable');
  assert.equal((await refused.client.recognize({ buffer: Buffer.alloc(0) })).reason, 'empty_image');
});

test('classifyHttpFailure / cleanModelOutput / normalizeBaseUrl helpers', () => {
  assert.equal(ollamaOcr.classifyHttpFailure(404, ''), 'model_not_found');
  assert.equal(ollamaOcr.classifyHttpFailure(500, 'model "glm-ocr" not found'), 'model_not_found');
  assert.equal(ollamaOcr.classifyHttpFailure(413, ''), 'image_too_large');
  assert.equal(ollamaOcr.classifyHttpFailure(503, ''), 'ollama_http_503');
  assert.equal(ollamaOcr.cleanModelOutput('a\r\nb <|im_end|>'), 'a\nb');
  assert.equal(ollamaOcr.normalizeBaseUrl('https://ocr.example.com/v1'), 'https://ocr.example.com');
  assert.equal(ollamaOcr.normalizeBaseUrl(''), '');
});

// ── Engine integration ───────────────────────────────────────────────────────

function fakeEngineClient({ available = true, text = '', reason = null, enabled = true } = {}) {
  const calls = { ensure: 0, recognize: 0 };
  return {
    calls,
    isEnabled: () => enabled,
    config: () => ({ model: 'glm-ocr' }),
    ensureAvailable: async () => { calls.ensure += 1; return available ? { available: true, reason: null } : { available: false, reason: reason || 'model_not_found' }; },
    recognize: async () => {
      calls.recognize += 1;
      if (reason && available) return { ok: false, reason };
      return { ok: true, text, provider: 'ollama:glm-ocr', durationMs: 120 };
    },
  };
}

async function withEngineClient(client, fn) {
  const saved = ocrEngine.ollamaOcr;
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  ocrEngine.ollamaOcr = client;
  try {
    return await fn();
  } finally {
    ocrEngine.ollamaOcr = saved;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
}

test('engine: runVisionFallback returns the GLM-OCR read as vision_fallback without needing an OpenAI key', async () => {
  const client = fakeEngineClient({ text: 'FACULTAD DE NEGOCIOS\nAdministración y negocios internacionales\nSemestre 2026-II' });
  await withEngineClient(client, async () => {
    const result = await ocrEngine.runVisionFallback({ buffer: Buffer.from('png'), mimeType: 'image/png' });
    assert.equal(result.ocr.status, 'vision_fallback');
    assert.equal(result.ocr.provider, 'ollama:glm-ocr');
    assert.match(result.text, /FACULTAD DE NEGOCIOS/);
    assert.equal(result.ocr.confidence, 95);
    assert.equal(result.ocr.elapsedMs, 120);
    assert.equal(client.calls.recognize, 1);
  });
});

test('engine: an unavailable or empty GLM-OCR falls through to the cloud rung and surfaces the local reason', async () => {
  await withEngineClient(fakeEngineClient({ available: false, reason: 'model_not_found' }), async () => {
    const result = await ocrEngine.runVisionFallback({ buffer: Buffer.from('png') });
    assert.equal(result.ocr.status, 'failed');
    assert.equal(result.ocr.reason, 'vision_api_unavailable');
    assert.equal(result.ocr.ollamaOcr, 'model_not_found');
  });
  await withEngineClient(fakeEngineClient({ text: 'OCR_EMPTY' }), async () => {
    const result = await ocrEngine.runVisionFallback({ buffer: Buffer.from('png') });
    assert.equal(result.ocr.status, 'failed');
    assert.equal(result.ocr.ollamaOcr, 'ollama_ocr_empty');
  });
  await withEngineClient(fakeEngineClient({ enabled: false }), async () => {
    assert.equal(await ocrEngine.runOllamaOcrFallback({ buffer: Buffer.from('png') }), null);
  });
  await withEngineClient({ isEnabled: () => true, config: () => ({ model: 'glm-ocr' }), ensureAvailable: async () => { throw new Error('boom'); } }, async () => {
    const result = await ocrEngine.runOllamaOcrFallback({ buffer: Buffer.from('png') });
    assert.equal(result.ocr.status, 'failed');
    assert.equal(result.ocr.reason, 'boom');
  });
});

test('engine: runVisionPdfFallback labels the provider from the pages GLM-OCR actually read', async () => {
  const client = fakeEngineClient({ text: 'Página con suficiente texto para pasar el umbral de calidad del OCR por visión.' });
  await withEngineClient(client, async () => {
    const result = await ocrEngine.runVisionPdfFallback([Buffer.from('p1'), Buffer.from('p2')]);
    assert.equal(result.ocr.status, 'vision_fallback');
    assert.equal(result.ocr.provider, 'ollama:glm-ocr');
    assert.equal(result.ocr.pagesReadByVision, 2);
    assert.equal(client.calls.recognize, 2);
  });
});
