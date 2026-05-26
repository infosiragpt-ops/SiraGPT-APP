'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createFallbackCascade,
  defaultIsRetryable,
  CascadeAttemptTimeout,
  CascadeExhaustedError,
  DEFAULT_CASCADE,
} = require('../src/services/ai-product-os/model-fallback-cascade');

describe('defaultIsRetryable', () => {
  test('429 / 408 / 425 / 5xx are retryable', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      assert.equal(defaultIsRetryable({ status }), true, `status ${status}`);
    }
  });
  test('4xx auth/perm errors are not retryable', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(defaultIsRetryable({ status }), false, `status ${status}`);
    }
  });
  test('explicit retryable flag wins', () => {
    assert.equal(defaultIsRetryable({ status: 400, retryable: true }), true);
    assert.equal(defaultIsRetryable({ status: 503, retryable: false }), false);
  });
  test('network error names are retryable', () => {
    assert.equal(defaultIsRetryable({ name: 'AbortError' }), true);
    assert.equal(defaultIsRetryable({ name: 'TimeoutError' }), true);
    assert.equal(defaultIsRetryable({ code: 'ECONNRESET' }), true);
  });
  test('null / unknown errors are not retryable', () => {
    assert.equal(defaultIsRetryable(null), false);
    assert.equal(defaultIsRetryable({}), false);
  });
});

describe('createFallbackCascade — execute', () => {
  test('returns the primary on first success', async () => {
    const cascade = createFallbackCascade({ models: ['a', 'b', 'c'] });
    const r = await cascade.execute(async (m) => `ok:${m}`);
    assert.equal(r.ok, true);
    assert.equal(r.model, 'a');
    assert.equal(r.value, 'ok:a');
    assert.equal(r.attempts.length, 1);
  });

  test('falls back through the cascade on retryable errors', async () => {
    const cascade = createFallbackCascade({ models: ['a', 'b', 'c'] });
    const r = await cascade.execute(async (m) => {
      if (m === 'a') { const e = new Error('rl'); e.status = 429; throw e; }
      if (m === 'b') { const e = new Error('5xx'); e.status = 503; throw e; }
      return `ok:${m}`;
    });
    assert.equal(r.model, 'c');
    assert.equal(r.value, 'ok:c');
    assert.equal(r.attempts.length, 3);
    assert.equal(r.attempts[0].ok, false);
    assert.equal(r.attempts[1].ok, false);
    assert.equal(r.attempts[2].ok, true);
  });

  test('does not fall back on non-retryable errors', async () => {
    const cascade = createFallbackCascade({ models: ['a', 'b'] });
    let calls = 0;
    await assert.rejects(
      cascade.execute(async (m) => { calls += 1; const e = new Error('nope'); e.status = 401; throw e; }),
      CascadeExhaustedError,
    );
    assert.equal(calls, 1);
  });

  test('throws CascadeExhaustedError after all models fail', async () => {
    const cascade = createFallbackCascade({ models: ['a', 'b'] });
    try {
      await cascade.execute(async () => { const e = new Error('rl'); e.status = 429; throw e; });
      assert.fail('expected throw');
    } catch (e) {
      assert.ok(e instanceof CascadeExhaustedError);
      assert.equal(e.attempts.length, 2);
      assert.ok(e.cause);
    }
  });

  test('per-attempt timeout fires and is retryable', async () => {
    const cascade = createFallbackCascade({ models: ['a', 'b'], attemptTimeoutMs: 30 });
    const r = await cascade.execute(async (m, signal) => {
      if (m === 'a') {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve('late'), 200);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        });
      }
      return `ok:${m}`;
    });
    assert.equal(r.model, 'b');
    assert.equal(r.value, 'ok:b');
    const firstError = r.attempts[0].error || '';
    assert.ok(firstError.includes('timed out') || firstError.includes('aborted'));
  });

  test('default models matches the documented Anthropic cascade', () => {
    const cascade = createFallbackCascade({});
    assert.deepEqual(cascade.models(), [...DEFAULT_CASCADE]);
  });

  test('onAttempt fires per attempt with success/failure detail', async () => {
    const events = [];
    const cascade = createFallbackCascade({
      models: ['a', 'b'],
      onAttempt: (e) => events.push({ model: e.model, ok: e.ok, attempt: e.attempt }),
    });
    await cascade.execute(async (m) => {
      if (m === 'a') { const e = new Error('rl'); e.status = 429; throw e; }
      return 'ok';
    });
    assert.deepEqual(events, [
      { model: 'a', ok: false, attempt: 1 },
      { model: 'b', ok: true, attempt: 2 },
    ]);
  });

  test('total budget exhausted stops further attempts', async () => {
    let t = 0;
    const cascade = createFallbackCascade({
      models: ['a', 'b', 'c'],
      attemptTimeoutMs: 10_000,
      totalBudgetMs: 50,
      now: () => t,
    });
    const r = cascade.execute(async (m) => {
      t += 60; // each attempt consumes 60ms of clock
      const e = new Error('rl'); e.status = 503; throw e;
    });
    await assert.rejects(r, CascadeExhaustedError);
  });

  test('CascadeAttemptTimeout marks itself retryable', () => {
    const e = new CascadeAttemptTimeout('m', 100);
    assert.equal(e.retryable, true);
    assert.equal(e.model, 'm');
    assert.equal(defaultIsRetryable(e), true);
  });

  test('runner type-check', async () => {
    const cascade = createFallbackCascade({});
    await assert.rejects(cascade.execute('not a function'), TypeError);
  });

  test('attempts include elapsedMs', async () => {
    const cascade = createFallbackCascade({ models: ['a'] });
    const r = await cascade.execute(async () => 'ok');
    assert.ok(typeof r.attempts[0].elapsedMs === 'number');
    assert.ok(r.attempts[0].elapsedMs >= 0);
    assert.ok(typeof r.totalElapsedMs === 'number');
  });
});
