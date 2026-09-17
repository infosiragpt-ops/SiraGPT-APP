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
    { retrySafe: true, classify: retryable, sleep, baseDelayMs: 10, onRetry: (i) => retries.push(i) },
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
    () => runToolWithRetry(async () => { attempts += 1; throw new Error('bad input'); }, {}, {}, { retrySafe: true, classify: terminal, sleep }),
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
      { retrySafe: true, classify: retryable, sleep, maxRetries: 2 },
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
    { retrySafe: true, classify: retryable, sleep, maxRetries: 3 },
  );
  assert.deepEqual(out, { error: 'invalid_url' });
  assert.equal(attempts, 1, 'returned errors are intentional answers, not retried');
  assert.equal(calls.length, 0);
});

test('default classifier treats an unknown thrown error as terminal', async () => {
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  await assert.rejects(
    () => runToolWithRetry(async () => { attempts += 1; throw new Error('mystery'); }, {}, {}, { retrySafe: true, sleep }),
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

test('unknown and side-effecting calls do not retry after an uncertain error', async () => {
  for (const retrySafe of [undefined, false, 'true', 1]) {
    let effects = 0;
    const { sleep, calls } = recordingSleep();
    const uncertain = new Error('socket closed after accepting the operation');
    await assert.rejects(runToolWithRetry(async () => {
      effects += 1;
      throw uncertain;
    }, {}, {}, { retrySafe, classify: retryable, maxRetries: 10, sleep }), (err) => err === uncertain);
    assert.equal(effects, 1, 'an uncertain result is not permission to repeat the action');
    assert.deepEqual(calls, []);
  }
});

test('Stop before dispatch prevents the first invocation', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancelled by user'), { code: 'E_CANCELLED' });
  controller.abort(reason);
  let attempts = 0;
  await assert.rejects(runToolWithRetry(async () => { attempts += 1; }, {}, {
    signal: controller.signal,
  }, { retrySafe: true }), (err) => err === reason);
  assert.equal(attempts, 0);
});

test('Stop after an uncertain failure wins over a retryable classification', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancelled by user'), { code: 'E_CANCELLED' });
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  let classifications = 0;
  await assert.rejects(runToolWithRetry(async () => {
    attempts += 1;
    controller.abort(reason);
    throw new Error('connection reset');
  }, {}, { signal: controller.signal }, {
    retrySafe: true,
    classify: () => { classifications += 1; return retryable(); },
    sleep,
  }), (err) => err === reason);
  assert.equal(attempts, 1);
  assert.equal(classifications, 0);
  assert.deepEqual(calls, []);
});

test('Stop interrupts a real backoff timer and removes its listener', async () => {
  const { getEventListeners } = require('node:events');
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancelled by user'), { code: 'E_CANCELLED' });
  let attempts = 0;
  let ready;
  const retryStarted = new Promise((resolve) => { ready = resolve; });
  const operation = runToolWithRetry(async () => {
    attempts += 1;
    throw new Error('connection reset');
  }, {}, { signal: controller.signal }, {
    retrySafe: true,
    classify: () => ({ retryable: true, ttlMs: 200 }),
    onRetry: ready,
  });
  const rejected = assert.rejects(operation, (err) => err === reason);
  await retryStarted;
  const listenersDuringWait = getEventListeners(controller.signal, 'abort').length;
  controller.abort(reason);
  await rejected;
  assert.equal(listenersDuringWait, 1, 'backoff installs an abort listener');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(attempts, 1);
});

test('a late successful handler result after Stop is not reported as successful', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancelled by user'), { code: 'E_CANCELLED' });
  await assert.rejects(runToolWithRetry(async (_args, ctx) => {
    assert.equal(ctx.signal, controller.signal);
    controller.abort(reason);
    return { ok: true };
  }, {}, { signal: controller.signal }), (err) => err === reason);
});

test('an E_CANCELLED error cannot be made retryable by a custom classifier', async () => {
  const { sleep, calls } = recordingSleep();
  const reason = Object.assign(new Error('stop requested'), { code: 'E_CANCELLED' });
  let attempts = 0;
  await assert.rejects(runToolWithRetry(async () => { attempts += 1; throw reason; }, {}, {}, {
    retrySafe: true, classify: retryable, sleep,
  }), (err) => err === reason);
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

test('a very large retry setting is bounded to four total attempts', async () => {
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  await assert.rejects(runToolWithRetry(async () => {
    attempts += 1;
    throw new Error('transient failure');
  }, {}, {}, { retrySafe: true, classify: retryable, sleep, maxRetries: 100 }), /transient failure/);
  assert.equal(attempts, 4);
  assert.equal(calls.length, 3);
});

test('unbounded classifier cooldowns fail closed instead of retrying early or waiting indefinitely', async () => {
  const { sleep, calls } = recordingSleep();
  const unavailable = new Error('temporarily unavailable');
  let attempts = 0;
  await assert.rejects(runToolWithRetry(async () => { attempts += 1; throw unavailable; }, {}, {}, {
    retrySafe: true, classify: () => ({ retryable: true, ttlMs: 60_000 }), sleep,
  }), (err) => err === unavailable);
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

test('configured delays are finite nonnegative and bounded', async () => {
  for (const config of [
    { baseDelayMs: -20, maxDelayMs: -10 },
    { baseDelayMs: Number.MAX_VALUE, maxDelayMs: Number.MAX_VALUE },
    { baseDelayMs: NaN, maxDelayMs: Infinity },
  ]) {
    const { sleep, calls } = recordingSleep();
    await assert.rejects(runToolWithRetry(async () => { throw new Error('transient failure'); }, {}, {}, {
      retrySafe: true, classify: retryable, sleep, ...config,
    }), /transient failure/);
    assert.equal(calls.length, 1);
    assert.ok(Number.isFinite(calls[0]) && calls[0] >= 0 && calls[0] <= 30_000);
  }
});

test('Stop from a retry observer prevents sleeping or another attempt', async () => {
  const controller = new AbortController();
  const { sleep, calls } = recordingSleep();
  let attempts = 0;
  await assert.rejects(runToolWithRetry(async () => {
    attempts += 1;
    throw new Error('connection reset');
  }, {}, { signal: controller.signal }, {
    retrySafe: true, classify: retryable, sleep,
    onRetry: () => { controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

test('invalid or throwing classifiers preserve the original error without retrying', async () => {
  const original = new Error('connection reset');
  for (const classify of [() => ({ retryable: 'true' }), () => null, () => { throw new Error('observer failed'); }]) {
    const { sleep, calls } = recordingSleep();
    await assert.rejects(runToolWithRetry(async () => { throw original; }, {}, {}, {
      retrySafe: true, classify, sleep,
    }), (err) => err === original);
    assert.deepEqual(calls, []);
  }
});

test('the existing environment setting cannot remove the hard retry ceiling', () => {
  const { spawnSync } = require('node:child_process');
  const modulePath = require.resolve('../src/services/agents/tool-call-retry');
  const result = spawnSync(process.execPath, ['-e',
    `process.stdout.write(String(require(${JSON.stringify(modulePath)})._internal.DEFAULT_MAX_RETRIES))`,
  ], {
    env: { SIRAGPT_TOOL_CALL_MAX_RETRIES: '1000000' },
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  assert.equal(result.status, 0, 'isolated configuration check must exit cleanly');
  assert.equal(result.stdout, '3');
});

test('a completed real backoff removes the abort listener without aborting the parent', async () => {
  const { getEventListeners } = require('node:events');
  const controller = new AbortController();
  let attempts = 0;
  assert.equal(await runToolWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient failure');
    return 'recovered';
  }, {}, { signal: controller.signal }, {
    retrySafe: true, classify: () => ({ retryable: true, ttlMs: 1 }),
  }), 'recovered');
  assert.equal(attempts, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(controller.signal.aborted, false);
});
