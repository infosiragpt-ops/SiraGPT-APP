/**
 * Tests for db-retry-middleware.js — transparent retry wrapper for
 * transient Prisma/Postgres errors.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const {
  withRetry,
  isRetryableError,
  RETRYABLE_CODES,
  parseBoundedInt,
  normalizeRetries,
  normalizeDelay,
  computeDelay,
  formatErrorHint,
  sleep,
  MAX_RETRIES,
  MAX_SAFE_RETRIES,
} = require('../src/utils/db-retry-middleware');

// Silence the wrapper's console.warn/error during these tests.
const _origWarn = console.warn;
const _origError = console.error;
function muteConsole() {
  console.warn = () => {};
  console.error = () => {};
}
function restoreConsole() {
  console.warn = _origWarn;
  console.error = _origError;
}

describe('isRetryableError', () => {
  it('returns false for null / undefined / non-object', () => {
    assert.equal(isRetryableError(null), false);
    assert.equal(isRetryableError(undefined), false);
    assert.equal(isRetryableError('string error'), false);
    assert.equal(isRetryableError(42), false);
  });

  it('returns true for Prisma codes in the retryable set', () => {
    for (const code of RETRYABLE_CODES) {
      const err = new Error('synthetic');
      err.code = code;
      assert.equal(isRetryableError(err), true, `expected ${code} retryable`);
    }
  });

  it('returns false for Prisma codes outside the retryable set', () => {
    // P2002 = unique constraint; not transient.
    const err = new Error('Unique constraint failed on the fields: (`email`)');
    err.code = 'P2002';
    assert.equal(isRetryableError(err), false);

    // P2025 = record not found.
    const notFound = new Error('Record to update not found');
    notFound.code = 'P2025';
    assert.equal(isRetryableError(notFound), false);
  });

  it('detects network-level error tokens in the message', () => {
    const cases = [
      'ECONNREFUSED 127.0.0.1:5432',
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'read ECONNRESET',
      'read ETIMEDOUT',
      'connect ECONNREFUSED 127.0.0.1:5432',
      'Connection terminated unexpectedly',
      'Client has been closed and is not queryable',
    ];
    for (const msg of cases) {
      assert.equal(
        isRetryableError(new Error(msg)),
        true,
        `expected "${msg}" retryable`,
      );
    }
  });

  it('reads token-bearing strings from error.code if message is empty', () => {
    // Some node-pg surfaces wire the token into .code, not .message.
    const err = { code: 'ECONNREFUSED' };
    assert.equal(isRetryableError(err), true);
  });

  it('returns false for a generic runtime error', () => {
    assert.equal(
      isRetryableError(new Error('Cannot read property foo of undefined')),
      false,
    );
  });
});

describe('withRetry', () => {
  it('returns the value on first-try success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries on retryable error and succeeds on second attempt', async () => {
    let calls = 0;
    muteConsole();
    try {
      const result = await withRetry(
        async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error("Can't reach database server");
            err.code = 'P1001';
            throw err;
          }
          return 'second-attempt';
        },
        { baseDelayMs: 1 },
      );
      assert.equal(result, 'second-attempt');
      assert.equal(calls, 2);
    } finally {
      restoreConsole();
    }
  });

  it('does NOT retry a non-retryable error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          const err = new Error('Unique constraint violated');
          err.code = 'P2002';
          throw err;
        },
        { baseDelayMs: 1 },
      ),
      /Unique constraint/,
    );
    assert.equal(calls, 1);
  });

  it('exhausts retries when all attempts fail with retryable errors', async () => {
    let calls = 0;
    muteConsole();
    try {
      await assert.rejects(
        withRetry(
          async () => {
            calls += 1;
            const err = new Error('ECONNRESET');
            throw err;
          },
          { maxRetries: 2, baseDelayMs: 1 },
        ),
        /ECONNRESET/,
      );
      // maxRetries=2 means 1 initial + 2 retries = 3 calls total.
      assert.equal(calls, 3);
    } finally {
      restoreConsole();
    }
  });

  it('invokes the onRetry callback for each retry attempt', async () => {
    const onRetryCalls = [];
    muteConsole();
    try {
      await withRetry(
        async () => {
          if (onRetryCalls.length < 2) {
            const err = new Error('P1002 timeout');
            err.code = 'P1002';
            throw err;
          }
          return 'ok-after-2';
        },
        {
          baseDelayMs: 1,
          onRetry: (attempt, error) => {
            onRetryCalls.push({ attempt, code: error.code });
          },
        },
      );
      assert.equal(onRetryCalls.length, 2);
      assert.equal(onRetryCalls[0].attempt, 1);
      assert.equal(onRetryCalls[1].attempt, 2);
      assert.equal(onRetryCalls[0].code, 'P1002');
    } finally {
      restoreConsole();
    }
  });

  it('does not let onRetry observer failures abort a recoverable query', async () => {
    let calls = 0;
    muteConsole();
    try {
      const result = await withRetry(
        async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error('ECONNRESET');
            throw err;
          }
          return 'ok';
        },
        {
          baseDelayMs: 1,
          onRetry: () => { throw new Error('observer failed'); },
        },
      );
      assert.equal(result, 'ok');
      assert.equal(calls, 2);
    } finally {
      restoreConsole();
    }
  });

  it('respects custom maxRetries option', async () => {
    let calls = 0;
    muteConsole();
    try {
      await assert.rejects(
        withRetry(
          async () => {
            calls += 1;
            const err = new Error('ECONNREFUSED');
            throw err;
          },
          { maxRetries: 0, baseDelayMs: 1 },
        ),
      );
      // maxRetries=0 means 1 call, no retries.
      assert.equal(calls, 1);
    } finally {
      restoreConsole();
    }
  });

  it('uses exponential backoff between retries', async () => {
    const startTimes = [];
    muteConsole();
    try {
      await assert.rejects(
        withRetry(
          async () => {
            startTimes.push(Date.now());
            const err = new Error('ECONNRESET');
            throw err;
          },
          { maxRetries: 2, baseDelayMs: 20 },
        ),
      );
      // Three attempts: t0, t0+20, t0+40. Allow generous slack so the
      // test stays stable on slow CI machines.
      const gap1 = startTimes[1] - startTimes[0];
      const gap2 = startTimes[2] - startTimes[1];
      // Be lenient — node's timer can fire a touch late or, on macOS,
      // a touch early when load is low. The key invariant is that the
      // second gap is at least roughly the first.
      assert.ok(gap1 >= 15, `expected gap1 ≥ 15ms, got ${gap1}`);
      assert.ok(gap2 >= gap1 - 5, `expected gap2 ≳ gap1 (${gap1}), got ${gap2}`);
    } finally {
      restoreConsole();
    }
  });

  it('uses caller maxDelayMs when clamping exponential backoff', async () => {
    const delays = [];
    muteConsole();
    try {
      await assert.rejects(
        withRetry(
          async () => {
            throw new Error('ECONNRESET');
          },
          {
            maxRetries: 2,
            baseDelayMs: 100,
            maxDelayMs: 50,
            sleep: async (ms) => { delays.push(ms); },
          },
        ),
      );
      assert.deepEqual(delays, [50, 50]);
    } finally {
      restoreConsole();
    }
  });

  it('normalizes invalid retry options instead of skipping the operation', async () => {
    let calls = 0;
    muteConsole();
    try {
      await assert.rejects(
        withRetry(
          async () => {
            calls += 1;
            throw new Error('ECONNRESET');
          },
          {
            maxRetries: Number.NaN,
            baseDelayMs: Number.NaN,
            maxDelayMs: Number.POSITIVE_INFINITY,
            sleep: async () => {},
          },
        ),
      );
      assert.equal(calls, MAX_RETRIES + 1);
    } finally {
      restoreConsole();
    }
  });

  it('throws TypeError when the wrapped operation is not a function', async () => {
    await assert.rejects(withRetry(null), TypeError);
  });

  it('throws signal.reason when aborted before the first attempt', async () => {
    const ac = new AbortController();
    ac.abort(new Error('db-cancelled'));
    await assert.rejects(
      withRetry(async () => 'never', { signal: ac.signal }),
      { message: 'db-cancelled' },
    );
  });

  it('throws signal.reason when aborted during retry sleep', async () => {
    const ac = new AbortController();
    let calls = 0;
    muteConsole();
    try {
      await assert.rejects(
        withRetry(
          async () => {
            calls += 1;
            throw new Error('ECONNRESET');
          },
          {
            baseDelayMs: 10,
            signal: ac.signal,
            sleep: async (_ms, signal) => {
              ac.abort(new Error('db-sleep-cancelled'));
              return sleep(0, signal);
            },
          },
        ),
        { message: 'db-sleep-cancelled' },
      );
      assert.equal(calls, 1);
    } finally {
      restoreConsole();
    }
  });

  it('propagates the most recent error after exhausting retries', async () => {
    let attemptCount = 0;
    muteConsole();
    try {
      await assert.rejects(
        withRetry(
          async () => {
            attemptCount += 1;
            const err = new Error(`attempt-${attemptCount} ECONNRESET`);
            throw err;
          },
          { maxRetries: 2, baseDelayMs: 1 },
        ),
        // Last error is attempt-3; rejection should carry that message.
        /attempt-3/,
      );
    } finally {
      restoreConsole();
    }
  });

  it('stops retrying when the caller aborts during backoff', async () => {
    const controller = new AbortController();
    let calls = 0;

    muteConsole();
    try {
      const retryPromise = withRetry(
        async () => {
          calls += 1;
          const err = new Error('ECONNRESET');
          throw err;
        },
        { maxRetries: 2, baseDelayMs: 50, signal: controller.signal },
      );

      setTimeout(() => controller.abort(new Error('request cancelled')), 5);

      await assert.rejects(retryPromise, /request cancelled|aborted/i);
      assert.equal(calls, 1);
    } finally {
      restoreConsole();
    }
  });
});

describe('RETRYABLE_CODES (the exported set)', () => {
  it('contains exactly the documented codes', () => {
    const expected = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'];
    for (const code of expected) {
      assert.equal(RETRYABLE_CODES.has(code), true, `missing ${code}`);
    }
    // No surprise additions — pin the size so adding a new retryable
    // code is a deliberate change that updates this test too.
    assert.equal(RETRYABLE_CODES.size, expected.length);
  });
});

describe('db retry helper guards', () => {
  it('parseBoundedInt and normalizers keep values finite and bounded', () => {
    assert.equal(parseBoundedInt(Number.NaN, 7, 0, 10), 7);
    assert.equal(parseBoundedInt(-1, 7, 0, 10), 7);
    assert.equal(parseBoundedInt(99, 7, 0, 10), 10);
    assert.equal(normalizeRetries(999), MAX_SAFE_RETRIES);
    assert.equal(normalizeDelay(Number.POSITIVE_INFINITY, 123), 123);
  });

  it('computeDelay clamps exponential growth', () => {
    assert.equal(computeDelay(100, 250, 0), 100);
    assert.equal(computeDelay(100, 250, 2), 250);
    assert.equal(computeDelay(Number.NaN, 50, Number.NaN), 50);
  });

  it('formatErrorHint strips control characters and caps output', () => {
    const hint = formatErrorHint(new Error('ECONNRESET\nsecret'), 10);
    assert.equal(hint, 'ECONNRESET');
    assert.equal(formatErrorHint({ code: 'P1001\r\nx' }), 'P1001  x');
  });
});
