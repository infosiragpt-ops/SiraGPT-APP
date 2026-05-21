/**
 * Tests for retry-with-backoff.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  CircuitBreaker,
  CircuitOpenError,
} = require('../src/utils/circuit-breaker');
const {
  withRetry,
  computeBackoff,
  sleep,
} = require('../src/utils/retry-with-backoff');

// ── Sleep helper ──────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('retry-with-backoff', () => {

  // ── computeBackoff ────────────────────────────────────────────

  describe('computeBackoff', () => {
    it('returns a number within [0, cap]', () => {
      for (let i = 0; i < 50; i++) {
        const result = computeBackoff({ baseDelayMs: 1000, maxDelayMs: 8000, attempt: 2 });
        assert.ok(Number.isInteger(result));
        assert.ok(result >= 0, `result ${result} should be >= 0`);
        assert.ok(result <= 4000, `result ${result} should be <= 4000 (min(maxDelay, base*2^attempt))`);
      }
    });

    it('caps at maxDelayMs', () => {
      const result = computeBackoff({ baseDelayMs: 1000, maxDelayMs: 2000, attempt: 10 });
      assert.ok(result <= 2000);
    });

    it('defaults baseDelayMs to 1000 and maxDelayMs to 30000', () => {
      const result = computeBackoff({ attempt: 0 });
      assert.ok(result >= 0);
      assert.ok(result <= 1000);
    });
  });

  // ── Success path ──────────────────────────────────────────────

  describe('success path', () => {
    it('resolves with fn() result on first try', async () => {
      const result = await withRetry(async () => 'ok', { maxRetries: 3 });
      assert.equal(result, 'ok');
    });

    it('does not call onRetry on success', async () => {
      const calls = [];
      await withRetry(async () => 'ok', {
        maxRetries: 1,
        onRetry: (...args) => calls.push(args),
      });
      assert.equal(calls.length, 0);
    });
  });

  // ── Retry logic ───────────────────────────────────────────────

  describe('retry logic', () => {
    it('retries retryable errors up to maxRetries', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls += 1;
        if (calls <= 2) throw new Error('transient');
        return 'recovered';
      }, {
        maxRetries: 3,
        baseDelayMs: 10,
        classifyError: () => ({ retryable: true, reason: 'transient', ttlMs: 10 }),
      });
      assert.equal(result, 'recovered');
      assert.equal(calls, 3); // 2 failures + 1 success
    });

    it('gives up after maxRetries and throws last error', async () => {
      const err = new Error('still-broken');
      await assert.rejects(
        withRetry(async () => { throw err; }, {
          maxRetries: 2,
          baseDelayMs: 10,
          classifyError: () => ({ retryable: true, reason: 'transient', ttlMs: 10 }),
        }),
        { message: 'still-broken' },
      );
    });

    it('calls onRetry with attempt, delay, error, reason', async () => {
      const err = new Error('retry-me');
      const retryLog = [];
      const maxRetries = 2;

      await assert.rejects(
        withRetry(async () => { throw err; }, {
          maxRetries,
          baseDelayMs: 10,
          classifyError: () => ({ retryable: true, reason: 'rate-limited', ttlMs: 10 }),
          onRetry: (info) => retryLog.push(info),
        }),
      );

      assert.equal(retryLog.length, maxRetries);
      for (let i = 0; i < maxRetries; i++) {
        assert.ok(retryLog[i].attempt > 0);
        assert.ok(retryLog[i].delayMs >= 0);
        assert.equal(retryLog[i].error.message, 'retry-me');
        assert.equal(retryLog[i].reason, 'rate-limited');
      }
    });

    it('does NOT retry non-retryable errors', async () => {
      let calls = 0;
      const err = new Error('quota-exhausted');
      await assert.rejects(
        withRetry(async () => {
          calls += 1;
          throw err;
        }, {
          maxRetries: 3,
          baseDelayMs: 10,
          classifyError: () => ({ retryable: false, reason: 'quota-exhausted' }),
        }),
      );
      assert.equal(calls, 1); // only 1 attempt
    });

    it('respects classifyError per attempt (different errors each time)', async () => {
      const classifyLog = [];
      let calls = 0;
      const transientErr = new Error('transient');
      const permanentErr = new Error('permanent');

      await assert.rejects(
        withRetry(async () => {
          calls += 1;
          if (calls === 1) throw transientErr;
          throw permanentErr;
        }, {
          maxRetries: 3,
          baseDelayMs: 10,
          classifyError: (e) => {
            const isRetryable = e.message === 'transient';
            classifyLog.push({ call: calls, message: e.message });
            return { retryable: isRetryable, reason: isRetryable ? 'transient' : 'permanent' };
          },
        }),
        { message: 'permanent' },
      );

      assert.equal(calls, 2); // first retried, second not
    });
  });

  // ── Circuit breaker integration ──────────────────────────────

  describe('circuit breaker integration', () => {
    let cb;
    const classifyRetryable = () => ({ retryable: true, reason: 'transient', ttlMs: 10 });

    beforeEach(() => {
      cb = new CircuitBreaker({
        name: 'test-cb',
        threshold: 3,
        cooldownMs: 500,
        windowMs: 500,
        probeCount: 1,
      });
    });

    afterEach(() => {
      cb.reset();
    });

    it('records failures into the circuit breaker via cb.call()', async () => {
      const err = new Error('fail');
      await assert.rejects(
        withRetry(async () => { throw err; }, {
          maxRetries: 1,
          baseDelayMs: 10,
          classifyError: classifyRetryable,
          circuitBreaker: cb,
        }),
      );
      // 2 attempts (initial + 1 retry), each recorded by cb.call()
      assert.ok(cb.failureCount >= 2, `expected >=2 failures, got ${cb.failureCount}`);
    });

    it('fast-fails with CircuitOpenError when circuit is OPEN', async () => {
      // Manually open the circuit via repeated failures
      while (cb.state !== 'OPEN' && cb.state !== 'HALF_OPEN') {
        try { await cb.call(async () => { throw new Error('open-me'); }); } catch { /* expected */ }
      }
      assert.equal(cb.state, 'OPEN');

      const fnCalls = [];
      await assert.rejects(
        withRetry(async () => {
          fnCalls.push('called');
          return 'should-not-reach';
        }, {
          maxRetries: 3,
          baseDelayMs: 10,
          classifyError: classifyRetryable,
          circuitBreaker: cb,
        }),
        (e) => {
          assert.equal(e.name, 'CircuitOpenError');
          return true;
        },
      );

      // fn() should never have been called — fast-fail via cb.call()
      assert.equal(fnCalls.length, 0);
    });

    it('passes through when circuit is CLOSED', async () => {
      const result = await withRetry(async () => 'success', {
        maxRetries: 2,
        circuitBreaker: cb,
        classifyError: classifyRetryable,
      });
      assert.equal(result, 'success');
    });

    it('opens circuit after repeated failures and subsequent calls fail-fast', async () => {
      const err = new Error('chain-failure');

      // First call: circuit is CLOSED, but the call keeps failing
      // After 3 failures (threshold=3), the circuit opens
      await assert.rejects(
        withRetry(async () => { throw err; }, {
          maxRetries: 2, // initial + 2 retries = 3 total failures
          baseDelayMs: 10,
          classifyError: classifyRetryable,
          circuitBreaker: cb,
        }),
      );

      // The circuit should now be OPEN (3 failures = threshold)
      assert.equal(cb.state, 'OPEN', `expected OPEN, got ${cb.state}`);

      // Now a new withRetry call should fast-fail immediately
      await assert.rejects(
        withRetry(async () => {
          throw new Error('never-called');
        }, {
          maxRetries: 3,
          baseDelayMs: 10,
          classifyError: classifyRetryable,
          circuitBreaker: cb,
        }),
        (e) => e.name === 'CircuitOpenError',
      );
    });

    it('recovers after cooldown when the call succeeds', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try { await cb.call(async () => { throw new Error('open'); }); } catch { /* ok */ }
      }
      assert.equal(cb.state, 'OPEN');

      // Wait for cooldown
      await delay(600);

      // Now the circuit should transition to HALF_OPEN on next call
      // withRetry should try and succeed
      const result = await withRetry(async () => 'recovered', {
        maxRetries: 1,
        baseDelayMs: 10,
        circuitBreaker: cb,
        classifyError: classifyRetryable,
      });
      assert.equal(result, 'recovered');
    });
  });

  // ── AbortSignal ──────────────────────────────────────────────

  describe('AbortSignal', () => {
    it('throws signal.reason when aborted before retry', async () => {
      const ac = new AbortController();
      const reason = new Error('user-cancelled');
      ac.abort(reason);

      const err = new Error('transient');

      // No circuit breaker — fn() is called directly
      await assert.rejects(
        withRetry(async () => { throw err; }, {
          maxRetries: 3,
          baseDelayMs: 1000,
          classifyError: () => ({ retryable: true, reason: 'transient', ttlMs: 10 }),
          signal: ac.signal,
        }),
        { message: 'user-cancelled' },
      );
    });

    it('throws signal.reason when aborted during backoff delay', async () => {
      const ac = new AbortController();
      const err = new Error('transient');

      const promise = withRetry(async () => { throw err; }, {
        maxRetries: 3,
        baseDelayMs: 5000,
        classifyError: () => ({ retryable: true, reason: 'transient', ttlMs: 10 }),
        signal: ac.signal,
      });

      await delay(10);
      const reason = new Error('cancelled-during-sleep');
      ac.abort(reason);

      await assert.rejects(promise, { message: 'cancelled-during-sleep' });
    });

    it('removes abort listeners once backoff sleep resolves', async () => {
      const listeners = new Set();
      const fakeSignal = {
        aborted: false,
        addEventListener(event, listener) {
          assert.equal(event, 'abort');
          listeners.add(listener);
        },
        removeEventListener(event, listener) {
          assert.equal(event, 'abort');
          listeners.delete(listener);
        },
      };

      await sleep(0, fakeSignal);

      assert.equal(listeners.size, 0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles maxRetries = 0 (no retry at all)', async () => {
      let calls = 0;
      const err = new Error('no-retry');
      await assert.rejects(
        withRetry(async () => { calls += 1; throw err; }, {
          maxRetries: 0,
          classifyError: () => ({ retryable: true, reason: 'transient', ttlMs: 10 }),
        }),
        { message: 'no-retry' },
      );
      assert.equal(calls, 1);
    });

    it('handles default classifier (always retryable with 1s delay)', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return 'ok';
      }, { maxRetries: 2, baseDelayMs: 10 });
      assert.equal(result, 'ok');
      assert.equal(calls, 2);
    });

    it('resolves immediately if fn() succeeds without error', async () => {
      const result = await withRetry(async () => 42, { maxRetries: 5 });
      assert.equal(result, 42);
    });
  });
});
