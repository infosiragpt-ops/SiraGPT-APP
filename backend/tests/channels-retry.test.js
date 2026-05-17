/**
 * Tests for channels/retry.js — bounded exponential backoff for
 * outbound channel-adapter HTTP calls.
 *
 * Surface:
 *   - retryWithBackoff(fn, opts)
 *   - backoffDelay(attempt, base, max, jitter)
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { retryWithBackoff, backoffDelay } = require('../src/channels/retry');

// A fake sleep that records all the waits requested by the retry
// loop, so tests don't actually pause execution.
function recorderSleep() {
  const waits = [];
  return {
    waits,
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
  };
}

describe('retryWithBackoff', () => {
  it('returns immediately on first-attempt success', async () => {
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      return { ok: true, body: 'hi' };
    });
    assert.deepEqual(out, { ok: true, body: 'hi' });
    assert.equal(calls, 1);
  });

  it('passes attempt number to fn (1-indexed)', async () => {
    const attempts = [];
    const { sleep } = recorderSleep();
    await retryWithBackoff(async (n) => {
      attempts.push(n);
      return { ok: n >= 3, status: n >= 3 ? 200 : 500 };
    }, { sleep, baseDelayMs: 1, jitter: false });
    assert.deepEqual(attempts, [1, 2, 3]);
  });

  it('retries on status 429 and succeeds eventually', async () => {
    const { waits, sleep } = recorderSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 429 };
      return { ok: true, status: 200, body: 'ok' };
    }, { sleep, baseDelayMs: 10, jitter: false, maxAttempts: 5 });
    assert.equal(out.ok, true);
    assert.equal(calls, 3);
    assert.equal(waits.length, 2);
  });

  it('retries on 5xx and succeeds eventually', async () => {
    const { sleep } = recorderSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    }, { sleep, baseDelayMs: 1, jitter: false });
    assert.equal(out.ok, true);
    assert.equal(calls, 2);
  });

  it('does NOT retry on 4xx (other than 429)', async () => {
    const { waits, sleep } = recorderSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      return { ok: false, status: 401 };
    }, { sleep, baseDelayMs: 1, jitter: false });
    assert.equal(out.status, 401);
    assert.equal(calls, 1);
    assert.equal(waits.length, 0);
  });

  it('does NOT retry on 3xx', async () => {
    const { sleep } = recorderSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      return { ok: false, status: 302 };
    }, { sleep, baseDelayMs: 1 });
    assert.equal(out.status, 302);
    assert.equal(calls, 1);
  });

  it('honours retryAfterMs from the response', async () => {
    const { waits, sleep } = recorderSleep();
    let calls = 0;
    await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 429, retryAfterMs: 1234 };
      return { ok: true, status: 200 };
    }, { sleep, baseDelayMs: 9999, jitter: false });
    assert.equal(waits[0], 1234, 'retryAfterMs must override the backoff schedule');
  });

  it('exhausts attempts and returns the last retriable response', async () => {
    const { sleep } = recorderSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      return { ok: false, status: 500, body: `attempt-${calls}` };
    }, { sleep, baseDelayMs: 1, jitter: false, maxAttempts: 3 });
    assert.equal(calls, 3);
    assert.equal(out.body, 'attempt-3');
  });

  it('rethrows a transport error from the last attempt', async () => {
    const { sleep } = recorderSleep();
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(async () => {
        calls += 1;
        throw new Error(`boom-${calls}`);
      }, { sleep, baseDelayMs: 1, maxAttempts: 3 }),
      /boom-3/,
    );
    assert.equal(calls, 3);
  });

  it('retries on transport error and recovers on a later attempt', async () => {
    const { sleep } = recorderSleep();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first-call-network-fail');
      return { ok: true, status: 200, body: 'recovered' };
    }, { sleep, baseDelayMs: 1, jitter: false });
    assert.equal(out.body, 'recovered');
    assert.equal(calls, 2);
  });

  it('uses real sleep when none provided (smoke check)', async () => {
    const start = Date.now();
    let calls = 0;
    const out = await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    }, { baseDelayMs: 5, maxDelayMs: 10, jitter: false, maxAttempts: 3 });
    const elapsed = Date.now() - start;
    assert.equal(out.ok, true);
    // Should have slept ~5ms; allow generous slack on slow CI.
    assert.ok(elapsed >= 4, `expected ≥4ms elapsed, got ${elapsed}`);
  });
});

describe('backoffDelay', () => {
  it('doubles per attempt without jitter', () => {
    assert.equal(backoffDelay(1, 100, 10_000, false), 100);
    assert.equal(backoffDelay(2, 100, 10_000, false), 200);
    assert.equal(backoffDelay(3, 100, 10_000, false), 400);
    assert.equal(backoffDelay(4, 100, 10_000, false), 800);
  });

  it('caps at maxDelayMs', () => {
    assert.equal(backoffDelay(10, 100, 1_000, false), 1_000);
    assert.equal(backoffDelay(20, 100, 1_000, false), 1_000);
  });

  it('jitter keeps the value in [exp/2, exp)', () => {
    // The formula is: floor(exp/2 + Math.random() * exp/2)
    // → output is in [exp/2, exp). Sample many times.
    const exp = 200;
    for (let i = 0; i < 50; i++) {
      const v = backoffDelay(2, 100, 1_000, true);
      assert.ok(v >= exp / 2 && v < exp, `jittered value ${v} out of [${exp / 2}, ${exp})`);
    }
  });

  it('returns exactly base when attempt=1 with jitter off', () => {
    assert.equal(backoffDelay(1, 50, 1_000, false), 50);
  });
});
