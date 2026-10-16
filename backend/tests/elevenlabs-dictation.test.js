'use strict';

// POST /api/elevenlabs/speech-to-text (dictation, C9):
// - every plan goes through the shared transcription ladder
//   (audio-transcriber.transcribe, short lane) with AUTOMATIC language;
// - free plans stay on-host by default (local whisper, Sira Voz): no paid
//   cloud rung unless an operator opts in;
// - paid plans try ElevenLabs Scribe first, inside its own sub-budget, and
//   fall back to the ladder on ANY Scribe failure; a quota / plan rejection
//   is never a fake «success» text; a transient 429/5xx never cools Scribe
//   down for every paid user;
// - the request bound answers BEFORE the browser's 30 s ApiClient timeout,
//   with a status ApiClient never retries (408);
// - the transcript is never logged; the uploaded file is always removed;
// - a client that hangs up (or the request bound) cancels the transcription.
// Offline: auth, Prisma, the ElevenLabs SDK and the transcriber are fakes.

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const FormData = require('form-data');

const { buildRouteTestApp, mockResolvedModule, reloadModule } = require('./http-test-utils');

const TRANSCRIPT = 'hola transcripcion secreta del dictado';
const SCRIBE_TEXT = 'texto secreto de scribe';

const state = {
  transcribeCalls: [],
  transcribeImpl: null,
  scribeCalls: [],
  scribeImpl: null,
  usage: [],
};

function ladderOk(extra = {}) {
  return {
    ok: true, status: 'ready', text: `Transcripción local — x\n---\n${TRANSCRIPT}`, transcript: TRANSCRIPT,
    method: 'local-whisper', model: 'base', language: 'es', providers: { local: 1 }, engine: 'local', ...extra,
  };
}

function ladderPlaceholder(reasonCode) {
  return {
    ok: false, status: reasonCode === 'no_speech' ? 'no_speech' : 'failed', reasonCode,
    text: 'Audio — dictation.webm\nTipo: audio/webm\nEstado: Transcripción no disponible.',
    method: 'placeholder', providers: {}, engine: null,
  };
}

// ElevenLabs' transient 429 bodies mention «subscription» and «tiers»: they
// must classify as 'rate' (no cooldown), never as a plan rejection.
const CONCURRENT_429 = 'Too many concurrent requests. Your current subscription is associated with a maximum of 2 concurrent requests running in parallel.';
const TRAFFIC_429 = 'We are experiencing heavy traffic right now. Higher subscription tiers get priority access.';

function sdkError(statusCode, message) {
  return Object.assign(new Error(`Status code: ${statusCode}\nBody: ${JSON.stringify({ detail: { message } })}`), {
    statusCode,
    body: { detail: { message } },
  });
}

/** Poll until `predicate()` holds (the handler's async cleanup may trail the response). */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function quotaError() {
  return Object.assign(new Error('Status code: 401\nBody: {"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}'), {
    statusCode: 401,
    body: { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota' } },
  });
}

const DICTATION_ENV = [
  'UPLOAD_DIR', 'ELEVENLABS_API_KEY', 'SIRAGPT_DICTATION_TIMEOUT_MS', 'SIRAGPT_DICTATION_SCRIBE_TIMEOUT_MS',
  'SIRAGPT_DICTATION_PROVIDERS', 'SIRAGPT_DICTATION_FREE_CLOUD', 'ELEVENLABS_STT_MODEL',
];

describe('dictation: shared ladder, Scribe for paid plans, typed errors', () => {
  const restores = [];
  let app;
  let tmpDir;
  let audioDir;
  let route;
  const saved = {};
  const logged = [];
  const originalConsole = {};

  before(() => {
    for (const k of DICTATION_ENV) saved[k] = process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-dictation-'));
    audioDir = path.join(tmpDir, 'audio');
    process.env.UPLOAD_DIR = tmpDir;
    delete process.env.SIRAGPT_DICTATION_PROVIDERS;
    delete process.env.ELEVENLABS_STT_MODEL;

    restores.push(mockResolvedModule(require.resolve('../src/middleware/auth'), {
      authenticateToken: (req, _res, next) => {
        req.user = req.headers['x-plan'] === 'paid'
          ? { id: 'paid-user', plan: 'PRO' }
          : { id: 'free-user', plan: 'FREE' };
        next();
      },
      requireAdmin: (_req, _res, next) => next(),
      requireSuperAdmin: (_req, _res, next) => next(),
    }));
    restores.push(mockResolvedModule(require.resolve('../src/config/database'), {
      apiUsage: {
        aggregate: async () => ({ _sum: { tokens: 0 } }),
        create: async ({ data }) => { state.usage.push(data); return data; },
      },
    }));
    restores.push(mockResolvedModule(require.resolve('@elevenlabs/elevenlabs-js'), {
      ElevenLabsClient: class {
        constructor({ apiKey }) { this.apiKey = apiKey; }
        get speechToText() {
          return {
            convert: async (req, opts) => {
              state.scribeCalls.push({ req, opts });
              return state.scribeImpl(req, opts);
            },
          };
        }
      },
    }));
    restores.push(mockResolvedModule(require.resolve('../src/services/audio-transcriber'), {
      transcribe: async (filePath, mimeType, originalName, options) => {
        state.transcribeCalls.push({ filePath, mimeType, originalName, options, existed: fs.existsSync(filePath) });
        return state.transcribeImpl(filePath, mimeType, originalName, options);
      },
    }));
    route = reloadModule('../src/routes/elevenlabs');
    app = buildRouteTestApp('/api/elevenlabs', route);

    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      originalConsole[level] = console[level];
      console[level] = (...args) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    }
  });

  after(() => {
    for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
    while (restores.length) restores.pop()();
    delete require.cache[require.resolve('../src/routes/elevenlabs')];
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.transcribeCalls = [];
    state.scribeCalls = [];
    state.usage = [];
    state.transcribeImpl = async () => ladderOk();
    state.scribeImpl = async () => ({ text: SCRIBE_TEXT, languageCode: 'spa' });
    logged.length = 0;
    for (const k of DICTATION_ENV) if (k !== 'UPLOAD_DIR') delete process.env[k];
    route._dictation.resetScribeCooldown();
  });

  function post({ plan = 'free', fields = {}, mime = 'audio/webm' } = {}) {
    let req = request(app).post('/api/elevenlabs/speech-to-text').set('x-plan', plan);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('audio', Buffer.from('fake-webm-audio-bytes'), { filename: 'dictation.webm', contentType: mime });
  }

  function assertNoTranscriptLogged() {
    const all = logged.join('\n');
    assert.ok(!all.includes(TRANSCRIPT), 'the ladder transcript must never be logged');
    assert.ok(!all.includes(SCRIBE_TEXT), 'the Scribe transcript must never be logged');
  }

  function uploadsLeft() {
    return fs.existsSync(audioDir) ? fs.readdirSync(audioDir) : [];
  }

  // The unlink runs in the handler's `finally`, after the response: wait for it.
  async function assertUploadsCleaned() {
    await waitFor(() => uploadsLeft().length === 0);
    assert.deepEqual(uploadsLeft(), [], 'the uploaded dictation must be removed');
  }

  async function assertLogged(re) {
    await waitFor(() => logged.some((l) => re.test(l)));
    assert.ok(logged.some((l) => re.test(l)), `expected a log line matching ${re}`);
  }

  it('free plan: on-host ladder by default (local, Sira Voz), short lane, automatic language, no Scribe', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    const res = await post({ fields: { model_id: 'scribe_v1' }, mime: 'audio/webm;codecs=opus' }).expect(200);
    assert.deepEqual(res.body, {
      success: true, text: TRANSCRIPT, provider: 'local-whisper', model: 'base', language: 'es', free: true,
    });
    assert.equal(state.scribeCalls.length, 0);
    assert.equal(state.transcribeCalls.length, 1);
    const { options, existed, originalName } = state.transcribeCalls[0];
    assert.ok(existed);
    assert.equal(originalName, 'dictation.webm');
    assert.equal(options.lane, 'interactive');
    assert.ok(options.signal && typeof options.signal.aborted === 'boolean');
    assert.ok(!('language' in options), 'no forced language: the ladder detects it');
    assert.deepEqual(options.providers, ['local', 'voicestudio'], 'free dictation never reaches a paid cloud rung by default');
    assert.deepEqual(options.escalationProviders, [], 'nor an operator-enabled paid escalation rung');
    await assertLogged(/^\[dictation\] tier=free outcome=ok provider=local-whisper chars=\d+ ms=\d+/);
    assertNoTranscriptLogged();
    await assertUploadsCleaned();
  });

  it('free plan: SIRAGPT_DICTATION_FREE_CLOUD=1 opts into the shared order; paid plans use it after Scribe', async () => {
    process.env.SIRAGPT_DICTATION_FREE_CLOUD = '1';
    await post().expect(200);
    assert.ok(!('providers' in state.transcribeCalls[0].options), 'shared TRANSCRIBE_PROVIDERS order');
    assert.ok(!('escalationProviders' in state.transcribeCalls[0].options));
    delete process.env.SIRAGPT_DICTATION_FREE_CLOUD;
    // Paid without an ElevenLabs key: straight to the shared ladder.
    await post({ plan: 'paid' }).expect(200);
    assert.ok(!('providers' in state.transcribeCalls[1].options));
    assert.ok(!('escalationProviders' in state.transcribeCalls[1].options));
    await assertUploadsCleaned();
  });

  it('an explicit client language is normalised and passed; SIRAGPT_DICTATION_PROVIDERS restricts the ladder', async () => {
    process.env.SIRAGPT_DICTATION_PROVIDERS = 'groq, local';
    await post({ fields: { language: 'es-PE' } }).expect(200);
    assert.equal(state.transcribeCalls[0].options.language, 'es');
    assert.deepEqual(state.transcribeCalls[0].options.providers, ['groq', 'local']);
    await post({ fields: { language: 'auto' } }).expect(200);
    assert.ok(!('language' in state.transcribeCalls[1].options));
    // The operator's list applies to paid plans too.
    await post({ plan: 'paid' }).expect(200);
    assert.deepEqual(state.transcribeCalls[2].options.providers, ['groq', 'local']);
    await assertUploadsCleaned();
  });

  it('paid plan: Scribe answers, events off, usage tracked, ladder untouched', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    const res = await post({ plan: 'paid', fields: { model_id: 'scribe_v1' } }).expect(200);
    assert.deepEqual(res.body, { success: true, text: SCRIBE_TEXT, provider: 'elevenlabs', model: 'scribe_v1', language: 'spa' });
    assert.equal(state.transcribeCalls.length, 0);
    assert.equal(state.scribeCalls.length, 1);
    const { req, opts } = state.scribeCalls[0];
    assert.equal(req.modelId, 'scribe_v1');
    assert.equal(req.tagAudioEvents, false);
    assert.ok(!('languageCode' in req));
    assert.equal(opts.maxRetries, 0);
    assert.ok(opts.abortSignal);
    assert.equal(opts.timeoutInSeconds, 10, 'Scribe gets its own sub-budget, not the whole request');
    assert.equal(state.usage.length, 1);
    assert.equal(state.usage[0].userId, 'paid-user');
    assert.ok(!('fullResult' in res.body));
    assertNoTranscriptLogged();
    await assertUploadsCleaned();
  });

  it('paid plan: a Scribe quota rejection falls back to the ladder (never a fake success) and is remembered', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    state.scribeImpl = async () => { throw quotaError(); };
    const res = await post({ plan: 'paid' }).expect(200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.text, TRANSCRIPT);
    assert.equal(res.body.scribeFallback, 'quota');
    assert.ok(!('fallback' in res.body), '`fallback` makes the composer drop the text');
    assert.ok(!('note' in res.body));
    assert.equal(state.transcribeCalls.length, 1);
    assert.ok(!('providers' in state.transcribeCalls[0].options), 'paid fallback: the shared ladder');
    assert.equal(state.usage.length, 0, 'no fake usage row for a rejected Scribe call');
    assert.ok(logged.some((l) => /\[dictation\] scribe failed \(quota 401\); using the transcription ladder/.test(l)));
    assert.ok(!logged.join('\n').includes('This request exceeds your quota'), 'provider text is not logged');

    // Next dictation: Scribe is cooling down, straight to the ladder.
    const again = await post({ plan: 'paid' }).expect(200);
    assert.equal(again.body.scribeFallback, 'quota');
    assert.equal(state.scribeCalls.length, 1);
    assert.equal(state.transcribeCalls.length, 2);
    await assertUploadsCleaned();
  });

  it('paid plan: Scribe rejected AND the ladder down → typed 503, no success, no sentence as text', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    state.scribeImpl = async () => { throw Object.assign(new Error('subscription plan does not include speech to text'), { statusCode: 403 }); };
    state.transcribeImpl = async () => ladderPlaceholder('local_unavailable');
    const res = await post({ plan: 'paid' }).expect(503);
    assert.deepEqual(res.body, {
      error: 'La transcripción no está disponible en este momento. Intenta de nuevo en unos segundos.',
      code: 'transcription_unavailable',
      scribe: 'plan',
    });
    await assertUploadsCleaned();
  });

  it('Scribe heard nothing → the ladder gives the second opinion before «no speech»', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    state.scribeImpl = async () => ({ text: '', words: [] });
    state.transcribeImpl = async () => ladderPlaceholder('no_speech');
    const res = await post({ plan: 'paid' }).expect(200);
    assert.deepEqual(res.body, { success: true, text: '', provider: 'transcriber', note: 'No se detectó voz en la grabación.' });
    assert.equal(state.scribeCalls.length, 1);
    assert.equal(state.transcribeCalls.length, 1);
  });

  it('no speech on the free ladder keeps the composer contract (empty text + note)', async () => {
    state.transcribeImpl = async () => ladderPlaceholder('no_speech');
    const res = await post().expect(200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.text, '');
    assert.equal(res.body.note, 'No se detectó voz en la grabación.');
    assert.equal(res.body.free, true);
  });

  it('an unreadable recording is a 422 (no retry), never the placeholder text', async () => {
    state.transcribeImpl = async () => ladderPlaceholder('audio_decode_failed');
    const res = await post().expect(422);
    assert.deepEqual(res.body, {
      error: 'No pude leer el audio de la grabación. Vuelve a grabar e inténtalo de nuevo.',
      code: 'audio_unreadable',
      reason: 'audio_decode_failed',
    });
    await assertUploadsCleaned();
  });

  it('a transcriber crash is a typed 503 without the error text', async () => {
    state.transcribeImpl = async () => { throw Object.assign(new Error('whisper exploded with secret path /root/x'), { code: 'LOCAL_WHISPER_FAILED' }); };
    const res = await post().expect(503);
    assert.equal(res.body.code, 'transcription_unavailable');
    assert.ok(!JSON.stringify(res.body).includes('exploded'));
    await assertUploadsCleaned();
  });

  it('the request bound aborts the transcription and answers a typed 408 (never retried by ApiClient)', async () => {
    process.env.SIRAGPT_DICTATION_TIMEOUT_MS = '1000';
    let sawAbort = false;
    state.transcribeImpl = (_f, _m, _n, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(Object.assign(new Error('aborted by user'), { name: 'AbortError' }));
      }, { once: true });
    });
    const res = await post().expect(408);
    assert.deepEqual(res.body, { error: 'La transcripción tardó más de lo esperado. Intenta de nuevo en unos segundos.', code: 'transcription_timeout' });
    assert.equal(sawAbort, true);
    await assertLogged(/\[dictation\] tier=free outcome=timeout/);
    await assertUploadsCleaned();
  });

  it('a transcribe call that NEVER settles (ignores the signal) still gets the typed answer at the bound', async () => {
    process.env.SIRAGPT_DICTATION_TIMEOUT_MS = '1000';
    let signalSeen = null;
    state.transcribeImpl = (_f, _m, _n, options) => { signalSeen = options.signal; return new Promise(() => {}); };
    const t0 = Date.now();
    const res = await post().expect(408);
    const elapsed = Date.now() - t0;
    assert.equal(res.body.code, 'transcription_timeout');
    assert.ok(elapsed < 5000, `answered after ${elapsed} ms`);
    assert.equal(signalSeen.aborted, true, 'the work underneath is told to stop');
    await assertUploadsCleaned();
  });

  it('the default bound answers before the browser ApiClient timeout (30 s) and cannot be raised past it', () => {
    const d = route._dictation;
    const apiSource = fs.readFileSync(path.join(__dirname, '../../lib/api.ts'), 'utf8');
    const clientTimeout = Number((apiSource.match(/DEFAULT_TIMEOUT_MS = (\d+)/) || [])[1]);
    assert.equal(clientTimeout, d.DICTATION_CLIENT_TIMEOUT_MS, 'lib/api.ts DEFAULT_TIMEOUT_MS changed: re-check the dictation bound');
    assert.equal(d.dictationTimeoutMs({}), 25000);
    assert.ok(d.dictationTimeoutMs({}) < clientTimeout);
    assert.equal(d.dictationTimeoutMs({ SIRAGPT_DICTATION_TIMEOUT_MS: '600000' }), d.DICTATION_MAX_TIMEOUT_MS);
    assert.ok(d.DICTATION_MAX_TIMEOUT_MS < clientTimeout);
    // Scribe never takes more than 40 % of the request bound.
    assert.equal(d.scribeTimeoutMs({}, 25000), 10000);
    assert.equal(d.scribeTimeoutMs({ SIRAGPT_DICTATION_SCRIBE_TIMEOUT_MS: '20000' }, 25000), 10000);
    assert.equal(d.scribeTimeoutMs({ SIRAGPT_DICTATION_SCRIBE_TIMEOUT_MS: '4000' }, 25000), 4000);
    assert.equal(d.scribeTimeoutMs({}, 5000), 2000);
    assert.equal(d.scribeTimeoutMs({}), 10000);
  });

  it('paid plan: a hung Scribe hits its sub-budget and the ladder answers with the time left (no cooldown)', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    process.env.SIRAGPT_DICTATION_TIMEOUT_MS = '3000';
    process.env.SIRAGPT_DICTATION_SCRIBE_TIMEOUT_MS = '300';
    state.scribeImpl = () => new Promise(() => {});
    const res = await post({ plan: 'paid' }).expect(200);
    assert.equal(res.body.text, TRANSCRIPT);
    assert.equal(res.body.scribeFallback, 'timeout');
    assert.equal(state.scribeCalls.length, 1);
    const { opts } = state.scribeCalls[0];
    assert.equal(opts.timeoutInSeconds, 1);
    assert.equal(opts.abortSignal.aborted, true, 'the hung Scribe request is cancelled');
    assert.equal(state.transcribeCalls.length, 1);
    assert.equal(state.transcribeCalls[0].options.signal.aborted, false, 'the ladder runs on the request signal');
    await assertLogged(/\[dictation\] scribe failed \(timeout\); using the transcription ladder/);

    // A timeout is not a rejection: the next dictation tries Scribe again.
    state.scribeImpl = async () => ({ text: SCRIBE_TEXT });
    const again = await post({ plan: 'paid' }).expect(200);
    assert.equal(again.body.provider, 'elevenlabs');
    assert.equal(state.scribeCalls.length, 2);
    assertNoTranscriptLogged();
    await assertUploadsCleaned();
  });

  it('paid plan: a transient Scribe 429 («subscription … concurrent») or 500 falls back without cooling Scribe down', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-key';
    state.scribeImpl = async () => { throw sdkError(429, CONCURRENT_429); };
    let res = await post({ plan: 'paid' }).expect(200);
    assert.equal(res.body.scribeFallback, 'rate');
    state.scribeImpl = async () => { throw sdkError(500, 'An internal error occurred; see the explanation field'); };
    res = await post({ plan: 'paid' }).expect(200);
    assert.equal(res.body.scribeFallback, 'error');
    state.scribeImpl = async () => { throw sdkError(429, TRAFFIC_429); };
    res = await post({ plan: 'paid' }).expect(200);
    assert.equal(res.body.scribeFallback, 'rate');
    assert.equal(state.scribeCalls.length, 3, 'every dictation still tried Scribe');
    state.scribeImpl = async () => ({ text: SCRIBE_TEXT });
    res = await post({ plan: 'paid' }).expect(200);
    assert.equal(res.body.provider, 'elevenlabs');
    assert.equal(state.scribeCalls.length, 4);
    await assertUploadsCleaned();
  });

  it('a client that hangs up cancels the transcription and the file is still removed', async () => {
    let started;
    const startedP = new Promise((resolve) => { started = resolve; });
    let aborted;
    const abortedP = new Promise((resolve) => { aborted = resolve; });
    state.transcribeImpl = (_f, _m, _n, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted(true);
        reject(Object.assign(new Error('aborted by user'), { name: 'AbortError' }));
      }, { once: true });
      started();
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const form = new FormData();
      form.append('audio', Buffer.from('fake-webm-audio-bytes'), { filename: 'dictation.webm', contentType: 'audio/webm' });
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/elevenlabs/speech-to-text', headers: form.getHeaders(),
      });
      req.on('error', () => {});
      form.pipe(req);
      await startedP;
      req.destroy();
      assert.equal(await abortedP, true);
      await assertLogged(/\[dictation\] tier=free outcome=client_gone/);
      await assertUploadsCleaned();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('helpers: classification, language, model, text extraction', () => {
    const d = route._dictation;
    assert.equal(d.classifyScribeError(quotaError()), 'quota');
    assert.equal(d.classifyScribeError({ statusCode: 402, message: 'x' }), 'quota');
    assert.equal(d.classifyScribeError({ statusCode: 401, message: 'Invalid API key' }), 'auth');
    assert.equal(d.classifyScribeError({ statusCode: 403, message: 'forbidden' }), 'plan');
    assert.equal(d.classifyScribeError({ statusCode: 429, message: 'too many requests' }), 'rate');
    assert.equal(d.classifyScribeError({ name: 'ElevenLabsTimeoutError', message: 'Timeout exceeded' }), 'timeout');
    assert.equal(d.classifyScribeError({ statusCode: 500, message: 'oops' }), 'error');
    // Status decides first: transient 429 / 5xx bodies that talk about
    // subscriptions, tiers or «explanation» are never a plan rejection.
    assert.equal(d.classifyScribeError(sdkError(429, CONCURRENT_429)), 'rate');
    assert.equal(d.classifyScribeError(sdkError(429, TRAFFIC_429)), 'rate');
    assert.equal(d.classifyScribeError(sdkError(500, 'see the explanation; upgrade your plan')), 'error');
    assert.equal(d.classifyScribeError(sdkError(503, 'service unavailable')), 'error');
    assert.equal(d.classifyScribeError(sdkError(408, 'request timeout')), 'timeout');
    assert.equal(d.classifyScribeError(sdkError(401, 'You have run out of credits')), 'quota');
    assert.equal(d.classifyScribeError(sdkError(403, 'insufficient credits for this request')), 'quota');
    assert.equal(d.classifyScribeError(sdkError(403, 'subscription plan does not include speech to text')), 'plan');
    assert.equal(d.classifyScribeError(sdkError(400, 'audio too short')), 'error');
    // No status: the text decides, and «plan» needs an explicit phrase.
    assert.equal(d.classifyScribeError(new Error(CONCURRENT_429)), 'rate');
    assert.equal(d.classifyScribeError(new Error(TRAFFIC_429)), 'rate');
    assert.equal(d.classifyScribeError(new Error('An explanation is attached')), 'error');
    assert.equal(d.classifyScribeError(new Error('Your subscription plan does not include this model')), 'plan');
    assert.equal(d.classifyScribeError(new Error('this request exceeds your quota')), 'quota');
    assert.equal(d.classifyScribeError(new Error('rate_limit_exceeded')), 'rate');
    assert.equal(d.dictationLanguage('EN-us'), 'en');
    assert.equal(d.dictationLanguage('auto'), undefined);
    assert.equal(d.dictationLanguage('es; rm -rf'), undefined);
    assert.equal(d.dictationLanguage(undefined), undefined);
    assert.equal(d.scribeModel({ model_id: 'scribe_v1' }, {}), 'scribe_v1');
    assert.equal(d.scribeModel({ model_id: '../evil' }, {}), 'scribe_v1');
    assert.equal(d.scribeModel({ model_id: 'scribe_v1' }, { ELEVENLABS_STT_MODEL: 'scribe_v2' }), 'scribe_v2');
    assert.equal(d.scribeText({}), '');
    assert.equal(d.scribeText(null), '');
    assert.equal(d.scribeText({ transcripts: [{ text: 'a' }, { text: 'b' }] }), 'a b');
    assert.equal(d.ladderProviderLabel({ providers: { groq: 1 } }), 'groq');
    assert.equal(d.ladderProviderLabel({ providers: { voicestudio: 1 } }), 'sira-voz');
    assert.equal(d.dictationTimeoutMs({ SIRAGPT_DICTATION_TIMEOUT_MS: '5' }), 1000);
    assert.deepEqual(d.dictationProviders({}), ['local', 'voicestudio']);
    assert.equal(d.dictationProviders({}, { paid: true }), undefined);
    assert.equal(d.dictationProviders({ SIRAGPT_DICTATION_FREE_CLOUD: '1' }), undefined);
    assert.deepEqual(d.dictationProviders({ SIRAGPT_DICTATION_PROVIDERS: 'Local,,bad name!,groq,local' }), ['local', 'groq']);
    assert.deepEqual(d.dictationLadderOptions({}), { providers: ['local', 'voicestudio'], escalationProviders: [] });
    assert.deepEqual(d.dictationLadderOptions({}, { paid: true }), {});
  });

  it('source: no fake success sentence, no transcript or full result in logs/responses', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/elevenlabs.js'), 'utf8');
    assert.doesNotMatch(src, /Transcription completed successfully/);
    assert.doesNotMatch(src, /Audio received successfully/);
    assert.doesNotMatch(src, /STT transcription result/);
    assert.doesNotMatch(src, /fullResult/);
    assert.doesNotMatch(src, /elevenlabs-stt-unavailable/);
    assert.match(src, /require\('\.\.\/services\/audio-transcriber'\)/);
    assert.doesNotMatch(src, /localWhisper\.transcribeLocal/);
  });
});
