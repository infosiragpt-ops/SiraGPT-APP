'use strict';

// AgentRunner BullMQ worker lifecycle: Redis faults surface as 'error'
// events on the worker (unhandled without a listener), the worker must close
// in the graceful shutdown, and a failed job keeps its cause (code + reason)
// for the waiting side. Offline: fake Worker classes, no Redis.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const queue = require('../src/services/agent-runner/queue');
const shutdown = require('../src/utils/shutdown');

afterEach(() => {
  shutdown._resetForTests();
  delete process.env.SIRAGPT_AGENT_RUNNER_IN_TESTS;
});

function makeFakeWorker() {
  const state = { processor: null, closed: 0, instance: null };
  class FakeWorker extends EventEmitter {
    constructor(_name, fn) {
      super();
      state.processor = fn;
      state.instance = this;
    }

    async close() { state.closed += 1; }
  }
  return { FakeWorker, state };
}

function captureConsole() {
  const out = { error: [], warn: [] };
  const original = { error: console.error, warn: console.warn };
  console.error = (...a) => out.error.push(a.join(' '));
  console.warn = (...a) => out.warn.push(a.join(' '));
  return { out, restore: () => { console.error = original.error; console.warn = original.warn; } };
}

test('worker errors: transient Redis faults warn once a minute; anything else logs one line', () => {
  const { FakeWorker, state } = makeFakeWorker();
  queue.startAgentRunnerWorker({ WorkerImpl: FakeWorker, connection: {}, run: async () => ({}) });
  const cap = captureConsole();
  try {
    assert.doesNotThrow(() => state.instance.emit('error', new Error('Connection is closed.')));
    assert.doesNotThrow(() => state.instance.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
    assert.equal(cap.out.error.length, 0, 'a Redis hiccup is not an error log');
    assert.equal(cap.out.warn.length, 1, 'throttled to one warn per minute');
    state.instance.emit('error', new Error('Missing key for job 42. moveToFinished'));
    assert.equal(cap.out.error.length, 1);
    assert.match(cap.out.error[0], /^\[agent-runner\] worker error: Missing key for job 42/);
  } finally {
    cap.restore();
  }
});

test('under node --test the worker registers no shutdown hook', () => {
  const { FakeWorker } = makeFakeWorker();
  queue.startAgentRunnerWorker({ WorkerImpl: FakeWorker, connection: {}, run: async () => ({}) });
  assert.equal(shutdown.snapshot().hooks.some((h) => h.name === 'agent_runner_worker_close'), false);
});

test('in a real process the worker closes in the graceful shutdown', async () => {
  process.env.SIRAGPT_AGENT_RUNNER_IN_TESTS = '1';
  const { FakeWorker, state } = makeFakeWorker();
  queue.startAgentRunnerWorker({ WorkerImpl: FakeWorker, connection: {}, run: async () => ({}) });
  const hook = shutdown.snapshot().hooks.find((h) => h.name === 'agent_runner_worker_close');
  assert.ok(hook, 'hook registered');
  assert.equal(hook.timeoutMs, 5000);
  shutdown.configure({ logger: { info() {}, warn() {}, error() {} } });
  const outcome = await shutdown.shutdown('test');
  assert.equal(outcome.steps.find((s) => s.name === 'agent_runner_worker_close').ok, true);
  assert.equal(state.closed, 1);
});

test('a fake worker without on/close still processes jobs', async () => {
  let processor;
  class BareWorker {
    constructor(_name, fn) { processor = fn; }
  }
  const published = [];
  queue.startAgentRunnerWorker({
    WorkerImpl: BareWorker,
    connection: {},
    run: async () => ({ summary: 'Listo', artifacts: [] }),
    publish: async (_ch, ev) => published.push(ev),
  });
  const result = await processor({ id: '7', data: { instruction: 'x' } });
  assert.equal(result.summary, 'Listo');
  assert.ok(published.some((ev) => ev.type === 'job_done'));
});

test('job_error keeps the failure code and a stable reason', async () => {
  const cases = [
    [Object.assign(new Error('El modelo seleccionado no está disponible.'), { code: 'E_PROVIDER' }), 'E_PROVIDER', 'E_PROVIDER'],
    [new Error('remote_sandbox_timeout'), null, 'sandbox_timeout'],
    [new Error('sandbox at_capacity'), null, 'sandbox_capacity'],
    [Object.assign(new Error('Insufficient credits'), { status: 402 }), null, 'llm_402'],
    [new Error('402 Payment Required'), null, 'llm_402'],
    [new Error('Fila 402 inválida en ventas.xlsx'), null, 'exception'],
    [new Error('boom'), null, 'exception'],
  ];
  for (const [error, code, reason] of cases) {
    let processor;
    class BareWorker {
      constructor(_name, fn) { processor = fn; }
    }
    const published = [];
    queue.startAgentRunnerWorker({
      WorkerImpl: BareWorker,
      connection: {},
      run: async () => { throw error; },
      publish: async (_ch, ev) => published.push(ev),
    });
    await assert.rejects(() => processor({ id: '9', data: { instruction: 'x' } }));
    const failed = published.find((ev) => ev.type === 'job_error');
    assert.equal(failed.code, code);
    assert.equal(failed.reason, reason);
    assert.equal(failed.message, error.message);
  }
});
