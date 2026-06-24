'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runToolWithRetry, _internal } = require('../src/services/agents/tool-call-retry');

const retryable = () => ({ retryable: true, reason: 'network-timeout' });
const terminal = () => ({ retryable: false, reason: 'validation-error' });

function recordingSleep() {
  const calls = [];
  return { sleep: async (ms) => { calls.push(ms); }, calls };
}

test('happy path: returns the handler value on the first try, no sleep', async () => {
  const { sleep, calls } = recordingSleep();
  let n = 0;
  const out = await runToolWithRetry(async () => { n += 1; return { ok: true, n }; }, {}, {}, { sleep });
  assert.deepEqual(out, { ok: true, n: 1 });
  assert.equal(n, 1);
  assert.equal(calls.length, 0);
});

test('retries a thrown transient error, then succeeds', async () => {
  const { sleep, calls } = recordingSleep();
  const retries = [];
  let attempts = 0;
  const out = await runToolWithRetry(
    async () => { attempts += 1; if (attempts < 2) throw new Error('socket hang up'); return 'recovered'; },
    {}, {},
    { classify: retryable, sleep, baseDelayMs: 10, onRetry: (i) => retries.push(i) },
  );
  assert.equal(out, 'recovered');
  assert.equal(attempts, 2);
  assert.equal(calls.length, 1, 'slept once before the retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].reason, 'network-timeout');
});

test('does NOT retry a terminal (non-retryable) thrown error', async () => {
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  await assert.rejects(
    () => runToolWithRetry(async () => { attempts += 1; throw new Error('bad input'); }, {}, {}, { classify: terminal, sleep }),
    /bad input/,
  );
  assert.equal(attempts, 1, 'terminal error is thrown on the first attempt');
  assert.equal(calls.length, 0);
});

test('exhausts the retry budget and throws the last error', async () => {
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  await assert.rejects(
    () => runToolWithRetry(
      async () => { attempts += 1; throw new Error(`fail-${attempts}`); },
      {}, {},
      { classify: retryable, sleep, maxRetries: 2 },
    ),
    /fail-3/,
  );
  assert.equal(attempts, 3, 'maxRetries=2 → 3 total attempts');
  assert.equal(calls.length, 2, 'slept between each retry');
});

test('a deterministic returned {error} response is passed through, never retried', async () => {
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  const out = await runToolWithRetry(
    async () => { attempts += 1; return { error: 'invalid_url' }; },
    {}, {},
    { classify: retryable, sleep, maxRetries: 3 },
  );
  assert.deepEqual(out, { error: 'invalid_url' });
  assert.equal(attempts, 1, 'returned errors are intentional answers, not retried');
  assert.equal(calls.length, 0);
});

test('default classifier treats an unknown thrown error as terminal', async () => {
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  await assert.rejects(
    () => runToolWithRetry(async () => { attempts += 1; throw new Error('mystery'); }, {}, {}, { sleep }),
    /mystery/,
  );
  assert.equal(attempts, 1);
  assert.equal(calls.length, 0);
});

test('passes args + ctx through to the handler', async () => {
  let seen = null;
  await runToolWithRetry(async (a, c) => { seen = { a, c }; return 1; }, { q: 'hi' }, { userId: 'u1' }, {});
  assert.deepEqual(seen, { a: { q: 'hi' }, c: { userId: 'u1' } });
});

test('rejects a non-function handler', async () => {
  await assert.rejects(() => runToolWithRetry(null, {}, {}, {}), /handler must be a function/);
});

test('computeBackoff is bounded by maxMs and grows with attempts', () => {
  const { computeBackoff } = _internal;
  const a1 = computeBackoff(1, 100, 5000);
  const a5 = computeBackoff(5, 100, 5000);
  assert.ok(a1 >= 100 && a1 <= 5000);
  assert.ok(a5 <= 5000, 'never exceeds maxMs');
});
