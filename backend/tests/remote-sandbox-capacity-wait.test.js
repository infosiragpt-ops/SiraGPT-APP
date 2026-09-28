'use strict';

/**
 * Remote sandbox capacity queue. Prod 2026-09-28: the sandbox service
 * (SANDBOX_MAX_CONCURRENCY=8) answered `429 at_capacity` during bursts of
 * 3–4 parallel document turns and the runner failed each turn instantly
 * («turn failed: exception sandbox service 429: at_capacity»). The client
 * must wait in a bounded queue, report progress, and fail as a transient
 * `capacity` error the admin tracker files as «Cancelado por el sistema».
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteSandbox, isAtCapacity, DEFAULT_QUEUE_WAIT_MS } = require('../src/services/doc-agent/remote-sandbox');
const classify = require('../src/services/observability/turn-failures/classify');

function response(body = {}, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function capacityFetch({ busyFor = 0, calls = [] } = {}) {
  let creates = 0;
  return async (url, opts) => {
    calls.push({ url, method: opts.method });
    if (opts.method === 'POST' && url.endsWith('/v1/sessions')) {
      creates += 1;
      if (creates <= busyFor) return response({ error: 'at_capacity', maxConcurrency: 8 }, 429);
      return response({ sessionId: `session-${creates}` }, 201);
    }
    if (opts.method === 'DELETE') return response({ ok: true });
    return response({ files: [] });
  };
}

test('429 at_capacity waits with 2→5 s backoff, reports progress, then gets a session', async () => {
  const sleeps = [];
  const waits = [];
  const calls = [];
  const sandbox = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key', env: {},
    fetchImpl: capacityFetch({ busyFor: 3, calls }),
    sleepImpl: async (ms) => { sleeps.push(ms); },
    onWait: (info) => waits.push(info),
  });
  const files = await sandbox.listFiles();
  assert.deepEqual(files, []);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/sessions')).length, 4);
  assert.deepEqual(sleeps, [2000, 3000, 4500]);
  assert.deepEqual(waits.map((w) => w.attempt), [1, 2, 3]);
  assert.equal(waits[0].maxWaitMs, DEFAULT_QUEUE_WAIT_MS);
  await sandbox.destroy();
});

test('when the queue wait is exhausted the failure is a retryable Spanish capacity error', async () => {
  const sleeps = [];
  const sandbox = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key', env: { DOC_SANDBOX_QUEUE_WAIT_MS: '5000' },
    fetchImpl: capacityFetch({ busyFor: 99 }),
    sleepImpl: async (ms) => { sleeps.push(ms); },
  });
  await assert.rejects(sandbox.exec('ls'), (err) => err.code === 'sandbox_at_capacity'
    && err.category === 'capacity'
    && err.retryable === true
    && err.status === 429
    && /ocupado; reintenta en un momento/.test(err.message));
  assert.ok(sleeps.length >= 1 && sleeps.length <= 3, `bounded polling, got ${sleeps.length}`);
  assert.ok(isAtCapacity({ status: 429, message: 'sandbox service 429: at_capacity' }));
  assert.equal(isAtCapacity({ status: 429, message: 'rate limited' }), false);
});

test('DOC_SANDBOX_QUEUE_WAIT_MS=0 fails on the first 429; other statuses never wait', async () => {
  let slept = 0;
  const immediate = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key', env: { DOC_SANDBOX_QUEUE_WAIT_MS: '0' },
    fetchImpl: capacityFetch({ busyFor: 99 }),
    sleepImpl: async () => { slept += 1; },
  });
  await assert.rejects(immediate.listFiles(), (err) => err.code === 'sandbox_at_capacity');
  assert.equal(slept, 0);

  const serverError = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key', env: {},
    fetchImpl: async () => response({ error: 'docker_unavailable' }, 503),
    sleepImpl: async () => { slept += 1; },
  });
  await assert.rejects(serverError.listFiles(), (err) => err.status === 503 && err.code !== 'sandbox_at_capacity');
  assert.equal(slept, 0);
});

test('a Stop while queued aborts the wait instead of holding the turn', async () => {
  const controller = new AbortController();
  const sandbox = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key', env: {}, signal: controller.signal,
    fetchImpl: capacityFetch({ busyFor: 99 }),
    sleepImpl: (ms, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
      setImmediate(() => controller.abort(new Error('user_stop')));
    }),
  });
  await assert.rejects(sandbox.listFiles(), (err) => err.code !== 'sandbox_at_capacity');
});

test('the runner maps capacity / remote timeouts to dedicated retryable reasons with Spanish copy', () => {
  const runner = require('../src/services/agent-runner');
  const capacity = Object.assign(new Error('El entorno de documentos está ocupado; reintenta en un momento'), { code: 'sandbox_at_capacity', category: 'capacity' });
  assert.equal(runner.sandboxFailureReason(capacity), 'sandbox_capacity');
  assert.equal(runner.sandboxFailureReason(new Error('sandbox service 429: at_capacity')), 'sandbox_capacity');
  assert.equal(runner.sandboxFailureReason(new Error('remote_sandbox_timeout')), 'sandbox_timeout');
  assert.equal(runner.sandboxFailureReason(new Error('boom')), null);
  assert.match(runner.buildAgentRunnerFailureMessage('sandbox_capacity'), /entorno de documentos está ocupado; reintenta en un momento/);
  assert.match(runner.buildAgentRunnerFailureMessage('sandbox_timeout'), /tardó demasiado en responder/);
});

test('the turn-failure tracker files capacity failures as cancelado_por_sistema, not herramienta_fallida', () => {
  const base = { startedAt: 1000, endedAt: 5000, visibleText: 'No pude generar el documento: el entorno de documentos está ocupado; reintenta en un momento.' };
  const capacity = classify.classifyTurnOutcome({
    ...base,
    notes: [
      { kind: 'tool_failure', data: { tool: 'agent_runner', reason: 'sandbox_capacity', category: 'capacity', fatal: true } },
      { kind: 'tool_failure', data: { tool: 'agent_runner', reason: 'agent_runner_failed', fatal: true } },
    ],
  });
  assert.equal(capacity.category, 'cancelado_por_sistema');
  assert.match(capacity.cause, /sin capacidad/);
  assert.ok(capacity.reasons.includes('capacity'));

  const timeout = classify.classifyTurnOutcome({
    ...base,
    notes: [{ kind: 'tool_failure', data: { tool: 'agent_runner', reason: 'sandbox_timeout', category: 'capacity', fatal: true } }],
  });
  assert.equal(timeout.category, 'cancelado_por_sistema');
  assert.match(timeout.cause, /tiempo de espera/);

  const generic = classify.classifyTurnOutcome({
    ...base,
    notes: [{ kind: 'tool_failure', data: { tool: 'agent_runner', reason: 'agent_runner_failed', fatal: true } }],
  });
  assert.equal(generic.category, 'herramienta_fallida');
});
