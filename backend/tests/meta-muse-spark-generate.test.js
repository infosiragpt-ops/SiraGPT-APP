'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gateway = require('../src/services/ai-product-os/litellm-gateway');
const service = require('../src/services/ai-service');
const {
  CONNECTION_UNAVAILABLE_MESSAGE,
  publicGenerateErrorMessage,
  isProviderClientError,
  closeGenerateSseWithError,
  writeGenerateSseError,
  endGenerateSse,
  generateStreamFailure,
} = require('../src/services/ai/generate-sse-close');
const { waitForActiveTurn } = require('../src/services/chat-turn-idempotency');
const { inferProviderFromModelId, resolveGenerateProvider } = require('../src/services/ai/provider-inference');
const { getBreaker } = require('../src/services/circuit-breaker');
const { openGuardedStream, readGuardedStream, firstByteTimeoutError } = require('../src/services/ai/generate-stream-guard');

const turn = (client, res, signal) => ({
  provider: 'Meta', model: 'muse-spark-1.3-contributor', client, res, signal,
  messages: [{ role: 'user', content: 'programa un juego de ajedrez' }],
  userPrompt: 'programa un juego de ajedrez', qualityGuard: false,
  skipDoneSentinel: true, thinkingLevel: 'high',
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('first-byte timeout is an explicit terminal error even if the SDK ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  let calls = 0;
  const signals = [];
  const client = { chat: { completions: { create: (_payload, options) => {
    calls += 1;
    signals.push(options.signal);
    return new Promise(() => {});
  } } } };
  const res = mockRes();
  const cancel = new AbortController();
  let result;
  const run = service.generateStream(turn(client, res, cancel.signal)).then((value) => { result = value; });
  try {
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    // No retry is safe when the first request has not acknowledged abort:
    // opening another generation could duplicate work and charges upstream.
    assert.equal(calls, 1);
    assert.equal(signals[0].aborted, true);
    assert.equal(typeof result, 'string', 'deadline must settle without provider cooperation');
    await run;
    assert.match(res.chunks.join(''), /"code":"E_TIMEOUT"/);
    assert.equal(res.writableEnded, true);
    assert.equal((res.chunks.join('').match(/data: \[DONE\]/g) || []).length, 1);
    assert.doesNotMatch(result, /Conexión no disponible|Meta|muse|AbortError/);
  } finally {
    cancel.abort();
    t.mock.timers.reset();
  }
});

test('reasoning already delivered is not replayed by an automatic retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    return (async function* () {
      yield { choices: [{ delta: { reasoning_content: 'Plan de prueba' } }] };
      throw Object.assign(new Error('upstream synthetic failure'), { status: 503 });
    })();
  } } } };
  const res = mockRes();
  let result;
  const run = service.generateStream(turn(client, res)).then((value) => { result = value; });
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 1, 'never repeat a stream after reasoning/tool progress');
  assert.equal(typeof result, 'string');
  await run;
  assert.match(res.chunks.join(''), /"code":"E_PROVIDER"/);
  assert.equal(res.writableEnded, true);
});

function mockRes() {
  const chunks = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    chunks,
    write(frame) {
      chunks.push(String(frame));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return res;
}

test('picker: Muse Spark stays Meta and is never remapped to Kimi/Sira/OpenRouter', () => {
  assert.equal(inferProviderFromModelId('muse-spark-1.2-contributor'), 'Meta');
  assert.equal(inferProviderFromModelId('muse-spark-1.2'), 'Meta');
  assert.equal(resolveGenerateProvider('Meta', 'muse-spark-1.2-contributor'), 'Meta');
  assert.equal(resolveGenerateProvider('OpenRouter', 'muse-spark-1.2-contributor'), 'Meta');
  assert.equal(resolveGenerateProvider('Kimi', 'muse-spark-1.2-contributor'), 'Meta');
  assert.equal(service.__test.providerForModel('muse-spark-1.2-contributor'), 'Meta');
  assert.equal(service.__test.isPinnedUserGenerate('Meta', 'muse-spark-1.2-contributor'), true);
  assert.deepEqual(service.__test.getFallbackChain('Meta', 'muse-spark-1.2-contributor'), []);
});

test('Meta/Muse Spark generate payload has no reasoning', () => {
  const built = gateway.buildProviderChatPayload({
    provider: 'Meta',
    model: 'muse-spark-1.2-contributor',
    stream: true,
    thinkingLevel: 'disabled',
    extra: { temperature: 0.55, reasoning: { exclude: true }, thinking: { type: 'disabled' } },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.equal(built.provider, 'meta');
  assert.equal('reasoning' in built.payload, false);
  // Disabled thinking → Meta's lowest accepted effort ("none" 400s on Muse Spark).
  assert.equal(built.payload.reasoning_effort, 'minimal');
  assert.equal('thinking' in built.payload, false);
});

test('Meta reasoning_effort follows the turn thinking level and the trivial cap leaves room for reasoning', () => {
  assert.equal(gateway.resolveMetaReasoningEffort('disabled'), 'minimal');
  assert.equal(gateway.resolveMetaReasoningEffort('off'), 'minimal');
  assert.equal(gateway.resolveMetaReasoningEffort('low'), 'low');
  assert.equal(gateway.resolveMetaReasoningEffort('high'), 'high');
  assert.equal(gateway.resolveMetaReasoningEffort('max'), 'xhigh');
  assert.equal(gateway.resolveMetaReasoningEffort('xhigh'), 'xhigh');
  assert.equal(gateway.resolveMetaReasoningEffort(''), 'medium');
  const max = gateway.buildProviderChatPayload({
    provider: 'Meta',
    model: 'muse-spark-1.2',
    stream: true,
    thinkingLevel: 'max',
    maxOutputTokens: 1024,
    messages: [{ role: 'user', content: 'explica' }],
  });
  assert.equal(max.payload.reasoning_effort, 'xhigh');
  assert.equal(max.payload.max_tokens, 1024);
  assert.equal('reasoning' in max.payload, false);
  // Live probe 2026-09-02: max_tokens 256 → finish_reason "length", 253/256
  // reasoning tokens, empty content. The trivial cap for Meta is 1024.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-service.js'), 'utf8');
  assert.match(src, /const trivialCap = \/\^\(meta\|llama\)\$\/i\.test\(String\(currentProvider \|\| ''\)\) \? 1024 : 256;/);
  assert.match(src, /Math\.min\(trivialCap, modelCap \|\| trivialCap\)/);
});

test('Anthropic keeps thinking; xAI keeps reasoning_effort; OpenRouter keeps reasoning', () => {
  const anthropic = gateway.buildProviderChatPayload({
    provider: 'Anthropic',
    model: 'claude-sonnet-5',
    extra: { thinking: { type: 'disabled' }, reasoning: { exclude: true } },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.deepEqual(anthropic.payload.thinking, { type: 'disabled' });
  assert.equal('reasoning' in anthropic.payload, false);

  const xai = gateway.buildProviderChatPayload({
    provider: 'xAI',
    model: 'grok-4.5',
    extra: { reasoning: { exclude: true }, reasoning_effort: 'low' },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.equal('reasoning' in xai.payload, false);
  assert.equal(xai.payload.reasoning_effort, 'low');

  const openrouter = gateway.buildProviderChatPayload({
    provider: 'OpenRouter',
    model: 'openai/gpt-oss-120b',
    thinkingLevel: 'disabled',
    extra: { reasoning: { exclude: true } },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.deepEqual(openrouter.payload.reasoning, { exclude: true });
});

test('ai-service does not attach reasoning extra for Meta trivial turns', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-service.js'), 'utf8');
  assert.match(src, /thinkingDisabled && currentProvider === 'OpenRouter'/);
  assert.match(src, /thinkingDisabled && currentProvider === 'Anthropic'/);
  assert.doesNotMatch(
    src,
    /if \(isTrivial \|\| String\(turnThinkingLevel\)[\s\S]{0,80}extraPayload\.reasoning = \{ exclude: true \}/,
  );
});

test('public generate error never leaks vendor or raw model_id', () => {
  assert.equal(
    publicGenerateErrorMessage({ message: '400 unknown parameter reasoning' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(
    publicGenerateErrorMessage({ message: 'OpenRouter 502 DeepSeek muse-spark-1.2-contributor' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(publicGenerateErrorMessage({ message: CONNECTION_UNAVAILABLE_MESSAGE }), CONNECTION_UNAVAILABLE_MESSAGE);
  assert.equal(isProviderClientError({ status: 400, message: 'unknown parameter reasoning' }), true);
  assert.equal(isProviderClientError({ name: 'AbortError', message: 'aborted' }), false);
});

test('simulated Meta 400 unknown parameter reasoning closes SSE with Spanish error, not HTTP 502', async () => {
  const res = mockRes();
  const err = new Error('400 unknown parameter reasoning');
  err.status = 400;
  const client = {
    chat: {
      completions: {
        create: async () => {
          throw err;
        },
      },
    },
  };

  const out = await service.generateStream({
    provider: 'Meta',
    model: 'muse-spark-1.2-contributor',
    client,
    messages: [{ role: 'user', content: 'hola' }],
    res,
    language: 'es',
    userPrompt: 'hola',
    qualityGuard: false,
    skipDoneSentinel: true,
    trivialTurn: true,
    thinkingLevel: 'disabled',
  });

  const body = res.chunks.join('');
  assert.equal(out, generateStreamFailure(err).message);
  assert.match(body, /"code":"E_PARAMS"/);
  assert.match(body, /"type":"error"/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(res.writableEnded, true);
  assert.doesNotMatch(body, /DeepSeek|OpenRouter|muse-spark-1\.2-contributor|unknown parameter/);
});

test('SSE error helper writes a complete body even when write/end wrappers no-op', () => {
  const rawChunks = [];
  let rawEnded = false;
  const res = {
    writableEnded: false,
    destroyed: false,
    write() { return true; },
    end() { /* wrapped no-op that used to cause Caddy 502 */ },
    _siraRawWrite(frame) { rawChunks.push(String(frame)); },
    _siraRawEnd() { rawEnded = true; this.writableEnded = true; },
  };
  closeGenerateSseWithError(res, {
    message: CONNECTION_UNAVAILABLE_MESSAGE,
    code: 'connection_unavailable',
  });
  const body = rawChunks.join('');
  assert.match(body, /Conexión no disponible/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(rawEnded, true);
  assert.equal(res._siraGenerateSseClosed, true);
});

test('duplicate retry while a turn is active replays or starts fresh — does not 502', async () => {
  const pending = {
    settled: false,
    promise: new Promise(() => {}),
  };
  const inFlight = await waitForActiveTurn(pending, {
    timeoutMs: 20,
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (id) => clearTimeout(id),
  });
  assert.equal(inFlight.outcome, 'in_progress');

  let resolveTurn;
  const completable = {
    promise: new Promise((resolve) => { resolveTurn = resolve; }),
  };
  const wait = waitForActiveTurn(completable, { timeoutMs: 5_000 });
  resolveTurn({
    assistantMessage: { id: 'a1', content: 'Hola' },
    userMessage: { id: 'u1' },
  });
  const replay = await wait;
  assert.equal(replay.outcome, 'replay');
  assert.equal(replay.turn.assistantMessage.content, 'Hola');

  const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(aiRoute, /Never skip end\(\) just because the client dropped/);
  assert.match(aiRoute, /start a fresh generate after that stream closed/);
  assert.match(aiRoute, /closeGenerateSseWithError/);
  assert.doesNotMatch(aiRoute, /if \(clientGone \|\| res\.destroyed \|\| res\.writableEnded\) return res;/);
});

test('getClient wires Meta to api.meta.ai — not OpenAI or OpenRouter', () => {
  const prev = {
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    META_API_KEY: process.env.META_API_KEY,
    LLAMA_API_KEY: process.env.LLAMA_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.MODEL_API_KEY;
  delete process.env.META_API_KEY;
  delete process.env.LLAMA_API_KEY;
  try {
    assert.throws(() => service.getClient('Meta'), (err) => {
      assert.match(String(err && err.message), /Conexión no disponible/);
      return true;
    });
    process.env.META_API_KEY = 'meta-test-key';
    const client = service.getClient('Meta');
    assert.ok(client);
    assert.match(String(client.baseURL || ''), /api\.meta\.ai/i);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('writeGenerateSseError + endGenerateSse produce a complete SSE trailer', () => {
  const res = mockRes();
  writeGenerateSseError(res, { message: CONNECTION_UNAVAILABLE_MESSAGE });
  endGenerateSse(res);
  assert.match(res.chunks.join(''), /data: \[DONE\]/);
  assert.equal(res.writableEnded, true);
});

test('a provider iterator hanging before content is bounded and closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  let aborted = 0;
  let returned = 0;
  const client = { chat: { completions: { create: async () => ({
    controller: { abort() { aborted++; } },
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
    return() { returned++; return Promise.resolve({ done: true }); },
  }) } } };
  const res = mockRes();
  const run = service.generateStream(turn(client, res));
  await flush();
  t.mock.timers.tick(30_000);
  await flush();
  assert.match(await run, /tardó demasiado/);
  assert.equal(aborted, 1);
  assert.equal(returned, 1);
  assert.match(res.chunks.join(''), /E_TIMEOUT/);
});

test('Stop cancels a hanging iterator without reporting a provider timeout', async () => {
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  const cancel = new AbortController();
  let aborted = 0;
  const client = { chat: { completions: { create: async () => ({
    controller: { abort() { aborted++; } },
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
  }) } } };
  const res = mockRes();
  const run = service.generateStream(turn(client, res, cancel.signal));
  await flush();
  cancel.abort();
  assert.equal(await run, '');
  assert.equal(aborted, 1);
  assert.doesNotMatch(res.chunks.join(''), /E_TIMEOUT|E_PROVIDER/);
});

test('tool argument progress is not mistaken for an empty first-byte timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  let continueStream;
  let requestSignal;
  let retryCount;
  const wait = new Promise((resolve) => { continueStream = resolve; });
  const client = { chat: { completions: { create: async (_payload, opts) => {
    requestSignal = opts.signal;
    retryCount = opts.maxRetries;
    return (async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'test_tool', arguments: '{}' } }] } }] };
      await wait;
      yield { choices: [{ delta: { content: 'Respuesta de prueba completa.' } }] };
    })();
  } } } };
  const res = mockRes();
  const run = service.generateStream(turn(client, res));
  await flush();
  t.mock.timers.tick(31_000);
  assert.equal(requestSignal.aborted, false);
  assert.equal(retryCount, 0, 'only the application may own retries');
  continueStream();
  assert.equal(await run, 'Respuesta de prueba completa.');
  assert.doesNotMatch(res.chunks.join(''), /\"type\":\"error\"/);
});

test('partial answer leaves DONE to the caller after persistence', async () => {
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls++;
    return (async function* () {
      yield { choices: [{ delta: { content: 'Código parcial de prueba.' } }] };
      throw Object.assign(new Error('synthetic private upstream detail'), { status: 503 });
    })();
  } } } };
  const res = mockRes();
  const output = await service.generateStream(turn(client, res));
  assert.ok(output.startsWith('Código parcial de prueba.'));
  assert.equal(calls, 1);
  assert.match(res.chunks.join(''), /\"code\":\"E_PROVIDER\"/);
  assert.doesNotMatch(res.chunks.join(''), /synthetic private upstream detail/);
  assert.equal((res.chunks.join('').match(/data: \[DONE\]/g) || []).length, 0);
  assert.equal(res.writableEnded, false, 'caller must still be able to persist and finish');
  // This is the route-owned terminal step, after its persistence completes.
  res.write('data: [DONE]\n\n');
  res.end();
  assert.equal((res.chunks.join('').match(/data: \[DONE\]/g) || []).length, 1);
});

test('partial answer without a persistence owner emits exactly one DONE', async () => {
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  const client = { chat: { completions: { create: async () => (async function* () {
    yield { choices: [{ delta: { content: 'Código parcial de prueba.' } }] };
    throw Object.assign(new Error('synthetic private upstream detail'), { status: 503 });
  })() } } };
  const res = mockRes();
  const output = await service.generateStream({ ...turn(client, res), skipDoneSentinel: false });
  assert.ok(output.startsWith('Código parcial de prueba.'));
  assert.match(res.chunks.join(''), /"recovered":true/);
  assert.equal((res.chunks.join('').match(/data: \[DONE\]/g) || []).length, 1);
});

test('late SDK arrival after cancellation is disposed without being read', async () => {
  const c = new AbortController();
  let resolve;
  let stopped = 0;
  const pending = new Promise((r) => { resolve = r; });
  const opened = openGuardedStream(() => pending, c.signal);
  await flush();
  c.abort(firstByteTimeoutError());
  await assert.rejects(opened, { code: 'ETIMEDOUT' });
  resolve({ controller: { abort() { stopped++; } } });
  await flush();
  assert.equal(stopped, 1);
});

test('guard rejects pre-cancelled calls and cancellation before dispatch', async () => {
  for (const before of [true, false]) {
    const c = new AbortController();
    let called = false;
    if (before) c.abort(firstByteTimeoutError());
    const promise = openGuardedStream(() => { called = true; }, c.signal);
    if (!before) c.abort(firstByteTimeoutError());
    await assert.rejects(promise, { code: 'ETIMEDOUT' });
    assert.equal(called, false);
  }
});

test('guard observes open/iterator errors and cleanup failures', async () => {
  const c = new AbortController();
  await assert.rejects(openGuardedStream(() => { throw new Error('synthetic'); }, c.signal), /synthetic/);
  for (const asyncReturn of [false, true]) {
    const stream = {
      [Symbol.asyncIterator]() { return this; },
      next() { return Promise.resolve({ done: true }); },
      return() {
        if (asyncReturn) return Promise.reject(new Error('synthetic cleanup'));
        throw new Error('synthetic cleanup');
      },
    };
    for await (const _ of readGuardedStream(stream, c.signal)) assert.fail('empty');
  }
  c.abort(firstByteTimeoutError());
  const stream = {
    controller: { abort() { throw new Error('synthetic cleanup'); } },
    [Symbol.asyncIterator]() { return this; },
    next() { assert.fail('cancelled'); },
  };
  await assert.rejects(async () => { for await (const _ of readGuardedStream(stream, c.signal)) {} }, { code: 'ETIMEDOUT' });
});

test('failure vocabulary classifies operational causes without SDK data', () => {
  for (const [err, code] of [
    [{ code: 'ETIMEDOUT' }, 'E_TIMEOUT'], [{ code: 'TIMEOUT' }, 'E_TIMEOUT'],
    [{ name: 'TimeoutError' }, 'E_TIMEOUT'], [{ status: 408 }, 'E_TIMEOUT'],
    [{ status: 429 }, 'E_QUOTA'], [{ statusCode: 402 }, 'E_QUOTA'],
    [{ status: 401 }, 'E_PROVIDER'], [{ status: 403 }, 'E_PROVIDER'],
    [{ status: 400 }, 'E_PARAMS'], [{ status: 422 }, 'E_PARAMS'],
    [{ code: 'EMPTY_COMPLETION' }, 'E_PROVIDER'], [{ status: 503 }, 'E_PROVIDER'],
    [null, 'E_PROVIDER'], [{}, 'E_PROVIDER'],
  ]) {
    const result = generateStreamFailure(err && { ...err, message: 'Bearer TEST_PRIVATE Meta muse-spark' });
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /Bearer|TEST_PRIVATE|Meta|muse-spark/);
  }
});

test('SSE close is safe for missing, closed and failing response transports', () => {
  for (const res of [null, {}, { writableEnded: true }, { destroyed: true },
    { write() { throw new Error('closed'); }, end() { throw new Error('closed'); } }]) {
    assert.doesNotThrow(() => writeGenerateSseError(res));
    assert.equal(endGenerateSse(res), false);
  }
  assert.equal(isProviderClientError(null), false);
  assert.equal(isProviderClientError('invalid request'), false);
  assert.equal(isProviderClientError({ response: { status: 503 } }), true);
  assert.equal(isProviderClientError({ message: 'invalid parameter' }), true);
  assert.equal(publicGenerateErrorMessage(null), CONNECTION_UNAVAILABLE_MESSAGE);
  assert.equal(publicGenerateErrorMessage({ code: 'connection_unavailable' }), CONNECTION_UNAVAILABLE_MESSAGE);
  assert.equal(publicGenerateErrorMessage({ message: 'upstream failed' }), CONNECTION_UNAVAILABLE_MESSAGE);
  assert.equal(publicGenerateErrorMessage({ message: 'La operación fue cancelada.' }), 'La operación fue cancelada.');
});

test('SDK-owned AbortError without user Stop is a visible failure, never empty success', async () => {
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  const client = { chat: { completions: { create: async () => {
    throw Object.assign(new Error('synthetic abort'), { name: 'AbortError' });
  } } } };
  const res = mockRes();
  const output = await service.generateStream({ ...turn(client, res), skipDoneSentinel: false });
  assert.match(output, /no pudo completar/);
  assert.match(res.chunks.join(''), /"code":"E_PROVIDER"/);
  assert.equal(res.writableEnded, true);
  assert.equal((res.chunks.join('').match(/data: \[DONE\]/g) || []).length, 1);
});

test('cooperative SDK deadline stays a timeout rather than a user cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getBreaker('Meta:muse-spark-1.3-contributor').reset();
  const client = { chat: { completions: { create: (_payload, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('SDK abort'), { name: 'AbortError' }));
    }, { once: true })),
  } } };
  const res = mockRes();
  const run = service.generateStream(turn(client, res));
  await flush();
  t.mock.timers.tick(30_000);
  assert.match(await run, /tardó demasiado/);
  assert.match(res.chunks.join(''), /"code":"E_TIMEOUT"/);
});
