'use strict';

/**
 * aiService.generateStream `onProgress` (live progress, services/turn-progress
 * modelSink): structured events only, real facts only.
 * - a silent model gets «waiting» at 8 s and 20 s, then «first_byte»;
 * - our first-byte timeout is an «attempt_failed» with category timeout;
 * - a throwing sink never touches the streamed answer;
 * - no event carries the provider's error text.
 */

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');

const billing = require('../src/services/ai/billing-failover');
const { resetAll } = require('../src/services/circuit-breaker');

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'FALLBACK_MODELS', 'SIRAGPT_BILLING_FAILOVER',
];
let savedEnv = {};
// ai-service logs every attempt to stdout; the test runner's child protocol
// shares that pipe, and heavy unrelated output there occasionally breaks
// its framing («Unable to deserialize cloned data»). Quiet during tests.
const savedConsole = { log: console.log, warn: console.warn, error: console.error };

test.beforeEach(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DEEPSEEK_API_KEY = 'ds-test-key';
  billing.__resetForTests();
  resetAll();
});

test.afterEach(() => {
  Object.assign(console, savedConsole);
  try { mock.timers.reset(); } catch (_) { /* not enabled */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  billing.__resetForTests();
  resetAll();
});

function chunks(parts) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield p;
    },
  };
}

function startGenerate({ create, onProgress, model = 'deepseek-v4-flash', qualityGuard = false }) {
  const service = require('../src/services/ai-service');
  const frames = [];
  const client = { chat: { completions: { create } } };
  const promise = service.generateStream({
    provider: 'DeepSeek',
    model,
    client,
    messages: [{ role: 'user', content: 'Explica la fotosíntesis en detalle.' }],
    res: { write: (chunk) => { frames.push(String(chunk)); return true; } },
    qualityGuard,
    skipDoneSentinel: true,
    onProgress,
  });
  return { promise, frames };
}

async function drain(n = 20) {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a silent model: waiting at 8 s and 20 s, then first_byte when it starts reasoning', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { promise } = startGenerate({
    onProgress: (ev) => events.push(ev),
    create: async () => ({
      async *[Symbol.asyncIterator]() {
        await gate;
        yield { choices: [{ delta: { reasoning_content: 'Pienso en la clorofila…' } }] };
        yield { choices: [{ delta: { content: 'La fotosíntesis convierte luz en energía química.' } }] };
      },
    }),
  });
  await drain();
  assert.deepEqual(events.map((e) => e.type), ['attempt_start']);
  assert.equal(events[0].model, 'deepseek-v4-flash');
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].maxAttempts, 2);

  mock.timers.tick(8000);
  await drain();
  mock.timers.tick(12000);
  await drain();
  const waiting = events.filter((e) => e.type === 'waiting');
  assert.deepEqual(waiting.map((e) => e.waitedMs), [8000, 20000]);
  assert.equal(waiting[1].timeoutMs, 30000);
  assert.equal(waiting[1].willRetry, true);

  mock.timers.tick(1500);
  release();
  await drain();
  const out = await promise;
  assert.match(out, /fotosíntesis/);
  const firstByte = events.filter((e) => e.type === 'first_byte');
  assert.equal(firstByte.length, 1, 'one first byte per attempt');
  assert.equal(firstByte[0].kind, 'reasoning');
  assert.equal(firstByte[0].ms, 21500);
  // Nothing after the first byte: the 30 s timer and the notices were cleared.
  mock.timers.tick(60000);
  await drain();
  assert.equal(events.filter((e) => e.type === 'waiting').length, 2);
  assert.equal(events.some((e) => e.type === 'attempt_failed'), false);
});

test('our first-byte timeout is attempt_failed{category: timeout} with the retry, then the cause', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 2_000_000 });
  const events = [];
  let calls = 0;
  const { promise, frames } = startGenerate({
    onProgress: (ev) => events.push(ev),
    create: (_payload, opts) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const signal = opts && opts.signal;
        // The OpenAI SDK's APIUserAbortError: a plain Error, not an AbortError.
        const fail = () => reject(new Error('Request was aborted. upstream sk-secret-123'));
        if (signal) signal.addEventListener('abort', fail, { once: true });
      });
    },
  });
  await drain();
  mock.timers.tick(30000);
  await drain();
  const firstFail = events.find((e) => e.type === 'attempt_failed');
  assert.ok(firstFail, 'the timeout is reported');
  assert.equal(firstFail.category, 'timeout');
  assert.equal(firstFail.timeoutMs, 30000);
  assert.equal(firstFail.willRetry, true);
  assert.equal(firstFail.attempt, 1);
  mock.timers.tick(1000); // backoff
  await drain();
  mock.timers.tick(30000);
  await drain(40);
  const out = await promise;
  assert.equal(calls, 2);
  const failures = events.filter((e) => e.type === 'attempt_failed');
  assert.equal(failures.length, 2);
  assert.equal(failures[1].willRetry, false);
  const starts = events.filter((e) => e.type === 'attempt_start').map((e) => e.attempt);
  assert.deepEqual(starts, [1, 2]);
  const failed = events.find((e) => e.type === 'failed');
  assert.ok(failed, 'the turn ends with the failed event');
  assert.equal(failed.model, 'deepseek-v4-flash');
  assert.equal(failed.category, 'unavailable');
  assert.match(out, /DeepSeek V4 Flash no pudo responder/);
  assert.doesNotMatch(frames.join(''), /sk-secret/);
  for (const ev of events) {
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'message'), false, JSON.stringify(ev));
    assert.doesNotMatch(JSON.stringify(ev), /sk-secret|aborted/i);
  }
});

test('a throwing onProgress never changes the streamed answer', async () => {
  let seen = 0;
  const { promise, frames } = startGenerate({
    onProgress: () => { seen += 1; throw new Error('sink exploded'); },
    create: async () => chunks([
      { choices: [{ delta: { content: 'Respuesta ' } }] },
      { choices: [{ delta: { content: 'completa y útil.' } }] },
    ]),
  });
  const out = await promise;
  assert.equal(out, 'Respuesta completa y útil.');
  assert.ok(seen >= 2, 'the sink was called (attempt_start, first_byte)');
  const text = frames.join('');
  assert.match(text, /"type":"text_delta","content":"Respuesta "/);
  assert.doesNotMatch(text, /sink exploded/);
});

test('events are structured facts: no message field, no provider text, first_byte before the first text frame', async () => {
  const events = [];
  const order = [];
  const service = require('../src/services/ai-service');
  const frames = [];
  const out = await service.generateStream({
    provider: 'DeepSeek',
    model: 'deepseek-v4-pro',
    client: {
      chat: {
        completions: {
          create: async () => chunks([
            { choices: [{ delta: { content: 'Hola, ' } }] },
            { choices: [{ delta: { content: 'aquí está la explicación completa.' } }] },
          ]),
        },
      },
    },
    messages: [{ role: 'user', content: 'Explícame algo.' }],
    res: { write: (chunk) => { frames.push(String(chunk)); order.push(`frame:${String(chunk).slice(0, 30)}`); return true; } },
    qualityGuard: false,
    skipDoneSentinel: true,
    onProgress: (ev) => { events.push(ev); order.push(`event:${ev.type}`); },
  });
  assert.equal(out, 'Hola, aquí está la explicación completa.');
  assert.deepEqual(events.map((e) => e.type), ['attempt_start', 'first_byte']);
  assert.equal(events[1].kind, 'content');
  const firstByteAt = order.indexOf('event:first_byte');
  const firstTextAt = order.findIndex((o) => o.includes('text_delta'));
  assert.ok(firstByteAt >= 0 && firstByteAt < firstTextAt, 'the model row settles before the text arrives');
  for (const ev of events) assert.equal(Object.prototype.hasOwnProperty.call(ev, 'message'), false);
});

test('a provider failure of a picked model reports its category (sin saldo), never the provider text', async () => {
  const events = [];
  const { promise } = startGenerate({
    onProgress: (ev) => events.push(ev),
    create: async () => { throw Object.assign(new Error('Insufficient Balance for org_secret_42'), { status: 402 }); },
  });
  const out = await promise;
  assert.match(out, /DeepSeek V4 Flash no pudo responder: su proveedor no tiene saldo ahora/);
  const failed = events.filter((e) => e.type === 'attempt_failed');
  assert.equal(failed.length, 1, 'no credit is not retried');
  assert.equal(failed[0].category, 'billing');
  assert.equal(failed[0].willRetry, false);
  const end = events.find((e) => e.type === 'failed');
  assert.equal(end.category, 'billing');
  assert.doesNotMatch(JSON.stringify(events), /org_secret_42|Insufficient/);
});

test('an image that fails to load is reported as such (vision_ready loaded:0), never as ready', async () => {
  const events = [];
  const service = require('../src/services/ai-service');
  const res = { write: () => true, locals: {} };
  const out = await service.generateStream({
    provider: 'DeepSeek',
    model: 'deepseek-v4-flash',
    client: { chat: { completions: { create: async () => chunks([{ choices: [{ delta: { content: 'Respondo con el texto disponible.' } }] }]) } } },
    messages: [{ role: 'user', content: '¿Qué ves en esta foto?' }],
    files: [{ path: '/nonexistent/sira-test/foto.png', mimeType: 'image/png', originalName: 'foto.png', name: 'foto.png' }],
    res,
    qualityGuard: false,
    skipDoneSentinel: true,
    onProgress: (ev) => events.push(ev),
  });
  assert.match(out, /texto disponible/);
  const prep = events.find((e) => e.type === 'vision_prep');
  assert.ok(prep, 'the preparation is announced');
  const ready = events.find((e) => e.type === 'vision_ready');
  assert.ok(ready, 'what reached the model is reported');
  assert.deepEqual({ requested: ready.requested, loaded: ready.loaded, stripped: ready.stripped, failedName: ready.failedName }, {
    requested: 1, loaded: 0, stripped: 0, failedName: 'foto.png',
  });
  assert.ok(events.indexOf(ready) < events.findIndex((e) => e.type === 'attempt_start'));
  assert.equal(res.locals.imageLoadFailures, 1);

  // Through the sink: an error row, no «Imagen lista», no image in the model note.
  const tp = require('../src/services/turn-progress');
  const frames = [];
  const progress = tp.createTurnProgress({ emitStage: (label, extra) => frames.push({ label, ...extra }), protocol: 2 });
  const sink = progress.modelSink({});
  for (const ev of events) sink(ev);
  const vision = frames.filter((f) => f.phase === 'vision' && f.step === 'tool_result');
  assert.equal(vision.length, 1);
  assert.equal(vision[0].status, 'error');
  assert.equal(vision[0].label, 'No pude cargar «foto.png»');
  assert.doesNotMatch(JSON.stringify(frames), /Imagen lista|1 imagen/);
});

test('attempt_start carries the reasoning level really sent; waiting says what happens at the limit', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 3_000_000 });
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { promise } = startGenerate({
    onProgress: (ev) => events.push(ev),
    create: async () => ({
      async *[Symbol.asyncIterator]() {
        await gate;
        yield { choices: [{ delta: { content: 'Listo.' } }] };
      },
    }),
  });
  await drain();
  const start = events.find((e) => e.type === 'attempt_start');
  assert.ok(Object.prototype.hasOwnProperty.call(start, 'thinking'), 'the level sent is always reported');
  assert.equal(start.thinking, null, 'the default level is never claimed');
  mock.timers.tick(20000);
  await drain();
  const late = events.filter((e) => e.type === 'waiting').pop();
  assert.equal(late.retrySameModel, true, 'attempt 1 of 2: the same model is retried');
  assert.equal(late.nextModel, null);
  release();
  await drain();
  await promise;
});
