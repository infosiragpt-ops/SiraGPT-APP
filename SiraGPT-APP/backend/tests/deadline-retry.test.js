'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  runWithDeadlineRetry,
  DeadlineExceededError,
  AbortedError,
} = require('../src/services/ai-product-os/deadline-retry');

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { t += ms; },
  };
}

describe('runWithDeadlineRetry — happy path', () => {
  test('first-success returns immediately', async () => {
    const r = await runWithDeadlineRetry({
      run: async () => 'ok',
      deadlineMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.value, 'ok');
    assert.equal(r.attempts, 1);
  });

  test('retries on retryable error and eventually succeeds', async () => {
    const c = fakeClock();
    let n = 0;
    const r = await runWithDeadlineRetry({
      run: async () => {
        n += 1;
        if (n < 3) { const e = new Error('rl'); e.status = 429; throw e; }
        return 'ok';
      },
      deadlineMs: 60_000,
      now: c.now, sleep: c.sleep,
      backoff: { next: () => 100 },
    });
    assert.equal(r.attempts, 3);
    assert.equal(r.value, 'ok');
  });
});

describe('runWithDeadlineRetry — failure modes', () => {
  test('non-retryable error is thrown immediately, not retried', async () => {
    let n = 0;
    await assert.rejects(
      runWithDeadlineRetry({
        run: async () => { n += 1; const e = new Error('auth'); e.status = 401; throw e; },
        deadlineMs: 60_000,
        backoff: { next: () => 0 },
      }),
      /auth/,
    );
    assert.equal(n, 1);
  });

  test('budget exhausted throws DeadlineExceededError with cause', async () => {
    const c = fakeClock();
    await assert.rejects(
      runWithDeadlineRetry({
        run: async () => { const e = new Error('rl'); e.status = 503; throw e; },
        deadlineMs: 100,
        now: c.now, sleep: c.sleep,
        backoff: { next: () => 50 },
      }),
      (err) => err instanceof DeadlineExceededError && err.cause && err.cause.status === 503,
    );
  });

  test('next backoff overshooting deadline halts before sleeping', async () => {
    const c = fakeClock();
    let attempts = 0;
    await assert.rejects(
      runWithDeadlineRetry({
        run: async () => { attempts += 1; const e = new Error('rl'); e.status = 503; throw e; },
        deadlineMs: 50,
        now: c.now, sleep: c.sleep,
        backoff: { next: () => 100 }, // each backoff would overshoot
      }),
      DeadlineExceededError,
    );
    assert.equal(attempts, 1);
  });

  test('maxAttempts cap honored independently of deadline', async () => {
    const c = fakeClock();
    let attempts = 0;
    await assert.rejects(
      runWithDeadlineRetry({
        run: async () => { attempts += 1; const e = new Error('rl'); e.status = 503; throw e; },
        deadlineMs: 60_000,
        maxAttempts: 3,
        now: c.now, sleep: c.sleep,
        backoff: { next: () => 1 },
      }),
      DeadlineExceededError,
    );
    assert.equal(attempts, 3);
  });
});

describe('runWithDeadlineRetry — abort signal', () => {
  test('pre-aborted signal throws AbortedError before first run', async () => {
    const ctrl = new AbortController();
    ctrl.abort('test');
    await assert.rejects(
      runWithDeadlineRetry({
        run: async () => 'never',
        deadlineMs: 1000,
        signal: ctrl.signal,
      }),
      AbortedError,
    );
  });

  test('passes abort signal into retry sleep so backoff can stop promptly', async () => {
    const ctrl = new AbortController();
    let attempts = 0;
    let seenSignal = null;

    await assert.rejects(
      runWithDeadlineRetry({
        run: async () => {
          attempts += 1;
          const e = new Error('temporary outage');
          e.status = 503;
          throw e;
        },
        deadlineMs: 60_000,
        maxAttempts: 3,
        signal: ctrl.signal,
        backoff: { next: () => 1_000 },
        sleep: async (_ms, signal) => {
          seenSignal = signal;
          ctrl.abort('caller_cancelled');
          throw new Error('sleep interrupted');
        },
      }),
      AbortedError,
    );

    assert.equal(seenSignal, ctrl.signal);
    assert.equal(attempts, 1);
  });
});

describe('runWithDeadlineRetry — onAttempt sink', () => {
  test('fires per attempt with success/failure detail', async () => {
    const c = fakeClock();
    const events = [];
    let n = 0;
    await runWithDeadlineRetry({
      run: async () => {
        n += 1;
        if (n === 1) { const e = new Error('rl'); e.status = 503; throw e; }
        return 'ok';
      },
      deadlineMs: 10_000,
      now: c.now, sleep: c.sleep,
      backoff: { next: () => 10 },
      onAttempt: (e) => events.push({ attempt: e.attempt, ok: e.ok }),
    });
    assert.deepEqual(events, [
      { attempt: 1, ok: false },
      { attempt: 2, ok: true },
    ]);
  });

  test('throwing onAttempt is swallowed', async () => {
    const c = fakeClock();
    const r = await runWithDeadlineRetry({
      run: async () => 'ok',
      deadlineMs: 100,
      now: c.now, sleep: c.sleep,
      onAttempt: () => { throw new Error('sink bad'); },
    });
    assert.equal(r.value, 'ok');
  });
});

describe('runWithDeadlineRetry — sleep failures', () => {
  test('an unexpected (non-abort) sleep failure is surfaced, not swallowed', async () => {
    let attempts = 0;
    await assert.rejects(
      runWithDeadlineRetry({
        run: async () => { attempts += 1; const e = new Error('rl'); e.status = 503; throw e; },
        deadlineMs: 60_000,
        maxAttempts: 5,
        backoff: { next: () => 1 },
        // Rejects WITHOUT aborting the signal — previously this was swallowed
        // and the loop kept retrying, masking the real failure.
        sleep: async () => { throw new Error('clock exploded'); },
      }),
      /clock exploded/,
    );
    // The loop must stop at the first failed sleep, not retry to exhaustion.
    assert.equal(attempts, 1);
  });
});

describe('runWithDeadlineRetry — guards', () => {
  test('rejects missing run', async () => {
    await assert.rejects(runWithDeadlineRetry({}), TypeError);
  });
});
