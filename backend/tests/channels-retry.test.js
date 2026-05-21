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

const {
  retryWithBackoff,
  backoffDelay,
  retryAfterDelay,
  parseRetryAfterHeader,
  abortableSleep,
} = require('../src/channels/retry');

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

  it('caps excessive retryAfterMs to maxDelayMs', async () => {
    const { waits, sleep } = recorderSleep();
    let calls = 0;
    await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 429, retryAfterMs: 60_000 };
      return { ok: true, status: 200 };
    }, { sleep, baseDelayMs: 10, maxDelayMs: 5_000, jitter: false });
    assert.equal(waits[0], 5_000);
  });

  it('ignores invalid retryAfterMs and falls back to exponential backoff', async () => {
    const { waits, sleep } = recorderSleep();
    let calls = 0;
    await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 429, retryAfterMs: -100 };
      return { ok: true, status: 200 };
    }, { sleep, baseDelayMs: 10, maxDelayMs: 5_000, jitter: false });
    assert.equal(waits[0], 10);
  });

  it('honours Retry-After date strings before falling back to exponential backoff', async () => {
    const { waits, sleep } = recorderSleep();
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    const retryAt = 'Wed, 21 Oct 2015 07:28:02 GMT';
    let calls = 0;

    await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 429, retryAfterMs: retryAt };
      return { ok: true, status: 200 };
    }, { sleep, baseDelayMs: 10, jitter: false, now });

    assert.equal(waits[0], 2000);
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

  it('honours an already-aborted signal before the first attempt', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller-cancelled'));

    let calls = 0;
    await assert.rejects(
      retryWithBackoff(async () => {
        calls += 1;
        return { ok: true, status: 200 };
      }, { signal: controller.signal }),
      /caller-cancelled/,
    );
    assert.equal(calls, 0);
  });

  it('cancels the default retry sleep when the signal aborts', async () => {
    const controller = new AbortController();
    let calls = 0;

    setTimeout(() => controller.abort(new Error('stop-retrying')), 5);
    await assert.rejects(
      retryWithBackoff(async () => {
        calls += 1;
        return { ok: false, status: 503 };
      }, { signal: controller.signal, baseDelayMs: 1_000, jitter: false, maxAttempts: 3 }),
      /stop-retrying/,
    );
    assert.equal(calls, 1);
  });
});

describe('abortableSleep', () => {
  it('rejects promptly on abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('sleep-cancelled')), 5);

    const started = Date.now();
    await assert.rejects(abortableSleep(1_000, controller.signal), /sleep-cancelled/);
    assert.ok(Date.now() - started < 250, 'sleep should not wait for the full delay after abort');
  });
});

describe('parseRetryAfterHeader', () => {
  it('parses delta seconds into milliseconds', () => {
    assert.equal(parseRetryAfterHeader('3'), 3000);
    assert.equal(parseRetryAfterHeader('0.25'), 250);
  });

  it('parses HTTP-date values relative to a supplied clock', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    const retryAt = 'Wed, 21 Oct 2015 07:28:05 GMT';

    assert.equal(parseRetryAfterHeader(retryAt, now), 5000);
  });

  it('ignores invalid, negative, or stale values', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');

    assert.equal(parseRetryAfterHeader('not-a-date', now), undefined);
    assert.equal(parseRetryAfterHeader('-1', now), undefined);
    assert.equal(parseRetryAfterHeader('Wed, 21 Oct 2015 07:27:59 GMT', now), undefined);
  });
});

describe('retryAfterDelay', () => {
  it('returns undefined when retryAfterMs is absent or invalid', () => {
    assert.equal(retryAfterDelay(undefined, 5_000), undefined);
    assert.equal(retryAfterDelay(null, 5_000), undefined);
    assert.equal(retryAfterDelay(-1, 5_000), undefined);
    assert.equal(retryAfterDelay(Number.POSITIVE_INFINITY, 5_000), undefined);
    assert.equal(retryAfterDelay('not-a-number', 5_000), undefined);
  });

  it('preserves finite delays up to maxDelayMs and caps larger values', () => {
    assert.equal(retryAfterDelay(0, 5_000), 0);
    assert.equal(retryAfterDelay('250', 5_000), 250);
    assert.equal(retryAfterDelay(60_000, 5_000), 5_000);
    assert.equal(retryAfterDelay('Wed, 21 Oct 2015 07:29:00 GMT', 10_000, Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 10_000);
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
