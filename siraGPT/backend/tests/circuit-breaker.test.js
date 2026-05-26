/**
 * Tests for circuit-breaker.js
 *
 * @jest-environment node
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const {
  CircuitBreaker,
  CircuitOpenError,
  CircuitTimeoutError,
  STATE,
} = require('../src/utils/circuit-breaker');

// ── Helpers ────────────────────────────────────────────────────────────────

/** A promise that never settles. */
function never() { return new Promise(() => {}); }

/** Returns a promise that resolves to `value` after `ms` milliseconds. */
function delay(ms, value) {
  return new Promise(r => setTimeout(() => r(value), ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {

  describe('constructor', () => {
    it('starts CLOSED with defaults', () => {
      const cb = new CircuitBreaker();
      assert.equal(cb.state, STATE.CLOSED);
      assert.equal(cb.name, 'default');
      assert.equal(cb.threshold, 5);
      assert.equal(cb.cooldownMs, 30_000);
      assert.equal(cb.probeCount, 1);
      assert.equal(cb.windowMs, 60_000);
      assert.equal(cb.timeoutMs, 0);
      assert.equal(cb.failureCount, 0);
      assert.equal(cb.successCount, 0);
      assert.equal(cb.totalCalls, 0);
    });

    it('accepts custom options', () => {
      const cb = new CircuitBreaker({
        name: 'my-service',
        threshold: 3,
        cooldownMs: 5_000,
        probeCount: 2,
        windowMs: 10_000,
        timeoutMs: 500,
      });
      assert.equal(cb.name, 'my-service');
      assert.equal(cb.threshold, 3);
      assert.equal(cb.cooldownMs, 5_000);
      assert.equal(cb.probeCount, 2);
      assert.equal(cb.windowMs, 10_000);
      assert.equal(cb.timeoutMs, 500);
    });
  });

  // ── Basic call lifecycle in CLOSED state ──────────────────────────────

  describe('call() in CLOSED state', () => {
    it('resolves with the return value', async () => {
      const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
      const result = await cb.call(async () => 'hello');
      assert.equal(result, 'hello');
      assert.equal(cb.totalCalls, 1);
      assert.equal(cb.failureCount, 0);
      assert.equal(cb.successCount, 1);
    });

    it('re-throws errors from the wrapped function', async () => {
      const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
      const err = await assert.rejects(
        () => cb.call(async () => { throw new Error('boom'); }),
        { message: 'boom' }
      );
    });

    it('does NOT open the circuit below the failure threshold', async () => {
      const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('e1'); }));
      await assert.rejects(() => cb.call(async () => { throw new Error('e2'); }));
      assert.equal(cb.state, STATE.CLOSED);
      assert.equal(cb.failureCount, 2);

      // The 3rd failure should open the circuit
      await assert.rejects(() => cb.call(async () => { throw new Error('e3'); }));
      assert.equal(cb.state, STATE.OPEN);
      assert.equal(cb.failureCount, 3);
    });
  });

  // ── OPEN state – fast‑fail ────────────────────────────────────────────

  describe('OPEN state (fast‑fail)', () => {
    it('throws CircuitOpenError on every call while OPEN', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 100_000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));

      assert.equal(cb.state, STATE.OPEN);

      // Subsequent calls should fast-fail
      await assert.rejects(
        () => cb.call(async () => 'should-not-run'),
        { name: 'CircuitOpenError' },
      );
    });

    it('does not execute the wrapped function when OPEN', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 5_000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      assert.equal(cb.state, STATE.OPEN);

      let executed = false;
      await assert.rejects(() => cb.call(async () => { executed = true; return 'nope'; }));
      assert.equal(executed, false);
    });
  });

  // ── HALF_OPEN probes ───────────────────────────────────────────────────

  describe('HALF_OPEN probe logic', () => {
    it('transitions OPEN → HALF_OPEN after cooldown, then CLOSED on success', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 50 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      assert.equal(cb.state, STATE.OPEN);

      // Wait for cooldown to expire
      await delay(60);

      // Should be HALF_OPEN
      assert.equal(cb.state, STATE.HALF_OPEN);

      // Successful probe → back to CLOSED
      const result = await cb.call(async () => 'probe-ok');
      assert.equal(result, 'probe-ok');
      assert.equal(cb.state, STATE.CLOSED);
    });

    it('transitions HALF_OPEN → OPEN on probe failure', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 50 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      assert.equal(cb.state, STATE.OPEN);

      await delay(60);

      // Probe fails → back to OPEN
      await assert.rejects(() => cb.call(async () => { throw new Error('probe-fail'); }));
      assert.equal(cb.state, STATE.OPEN);
    });

    it('requires probeCount consecutive successes in HALF_OPEN', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 50, probeCount: 3 });
      await assert.rejects(() => cb.call(async () => { throw new Error('open'); }));
      assert.equal(cb.state, STATE.OPEN);

      await delay(60);

      // First probe success — stays HALF_OPEN
      await cb.call(async () => 'probe-1');
      assert.equal(cb.state, STATE.HALF_OPEN);

      // Second probe success — stays HALF_OPEN
      await cb.call(async () => 'probe-2');
      assert.equal(cb.state, STATE.HALF_OPEN);

      // Third probe success → CLOSED
      await cb.call(async () => 'probe-3');
      assert.equal(cb.state, STATE.CLOSED);
    });
  });

  // ── Timeout ───────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('throws CircuitTimeoutError when a call exceeds the timeout', async () => {
      const cb = new CircuitBreaker({ threshold: 1, timeoutMs: 50 });
      await assert.rejects(
        () => cb.call(async () => { await never(); }),
        { name: 'CircuitTimeoutError' },
      );
    });

    it('counts a timeout as a failure', async () => {
      const cb = new CircuitBreaker({ threshold: 1, timeoutMs: 50 });
      await assert.rejects(() => cb.call(async () => { await never(); }));
      assert.equal(cb.state, STATE.OPEN);
      assert.equal(cb.failureCount, 1);
    });

    it('per-call timeoutMs overrides instance default', async () => {
      const cb = new CircuitBreaker({ threshold: 5, timeoutMs: 5000 });
      const start = Date.now();
      await assert.rejects(() =>
        cb.call(async () => { await never(); }, { timeoutMs: 30 })
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1000, `expected <1000ms, got ${elapsed}ms`);
      assert.equal(cb.failureCount, 1);
    });
  });

  // ── External signal ───────────────────────────────────────────────────

  describe('external AbortSignal', () => {
    it('aborts when external signal is triggered', async () => {
      const cb = new CircuitBreaker({ threshold: 5 });
      const ac = new AbortController();
      const promise = cb.call(async () => { await never(); }, { signal: ac.signal });

      ac.abort(new Error('canceled'));

      const err = await promise.catch(e => e);
      // Should re-throw the abort reason, not count as a failure
      assert.equal(err.message, 'canceled');
      assert.equal(cb.failureCount, 0);
    });

    it('honours a pre-aborted signal', async () => {
      const cb = new CircuitBreaker({ threshold: 5 });
      const ac = new AbortController();
      ac.abort(new Error('already-aborted'));

      const err = await cb.call(
        async () => { await never(); },
        { signal: ac.signal }
      ).catch(e => e);
      assert.equal(err.message, 'already-aborted');
      assert.equal(cb.failureCount, 0);
    });
  });

  // ── reset() ───────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears all counters and returns to CLOSED', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      assert.equal(cb.state, STATE.OPEN);
      assert.equal(cb.failureCount, 1);

      cb.reset();
      assert.equal(cb.state, STATE.CLOSED);
      assert.equal(cb.failureCount, 0);
      assert.equal(cb.successCount, 0);
      assert.equal(cb.totalCalls, 0);
    });

    it('allows calls to succeed after reset', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      cb.reset();
      const result = await cb.call(async () => 'after-reset');
      assert.equal(result, 'after-reset');
      assert.equal(cb.state, STATE.CLOSED);
    });

    it('emits stateChange event when clearing OPEN state', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));

      const events = [];
      cb.on('stateChange', (ev) => events.push(ev));
      cb.reset();
      assert.equal(events.length, 1);
      assert.equal(events[0].from, STATE.OPEN);
      assert.equal(events[0].to, STATE.CLOSED);
    });

    it('does NOT emit stateChange when already CLOSED', async () => {
      const cb = new CircuitBreaker();
      const events = [];
      cb.on('stateChange', (ev) => events.push(ev));
      cb.reset();
      assert.equal(events.length, 0);
    });
  });

  // ── forceState() ──────────────────────────────────────────────────────

  describe('forceState()', () => {
    it('forces into OPEN state', async () => {
      const cb = new CircuitBreaker();
      cb.forceState(STATE.OPEN);
      assert.equal(cb.state, STATE.OPEN);
    });

    it('forces into HALF_OPEN state', async () => {
      const cb = new CircuitBreaker();
      cb.forceState(STATE.HALF_OPEN);
      assert.equal(cb.state, STATE.HALF_OPEN);
    });

    it('CLOSED via forceState delegates to reset()', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      cb.forceState(STATE.CLOSED);
      assert.equal(cb.state, STATE.CLOSED);
      assert.equal(cb.failureCount, 0);
    });

    it('throws on invalid state', () => {
      const cb = new CircuitBreaker();
      assert.throws(() => cb.forceState('BROKEN'), { message: /BROKEN/ });
    });
  });

  // ── toJSON() ──────────────────────────────────────────────────────────

  describe('toJSON()', () => {
    it('returns a snapshot including name, state, counters', () => {
      const cb = new CircuitBreaker({ name: 'test-api' });
      const json = cb.toJSON();
      assert.equal(json.name, 'test-api');
      assert.equal(json.state, STATE.CLOSED);
      assert.equal(json.failureCount, 0);
      assert.equal(json.successCount, 0);
      assert.equal(json.totalCalls, 0);
    });

    it('includes cooldownRemainingMs', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      const json = cb.toJSON();
      assert.equal(json.state, STATE.OPEN);
      assert.ok(json.cooldownRemainingMs > 0);
      assert.ok(json.cooldownRemainingMs <= 10_000);
    });
  });

  // ── Rolling window ────────────────────────────────────────────────────

  describe('rolling failure window', () => {
    it('does not count failures outside the window', async () => {
      // Use a very short window
      const cb = new CircuitBreaker({ threshold: 3, windowMs: 100, cooldownMs: 1000 });

      // Trigger 2 failures
      await assert.rejects(() => cb.call(async () => { throw new Error('e1'); }));
      await assert.rejects(() => cb.call(async () => { throw new Error('e2'); }));
      assert.equal(cb.failureCount, 2);

      // Wait for window to expire
      await delay(150);

      // Failures should have decayed
      assert.equal(cb.failureCount, 0);

      // Now 2 more failures shouldn't open the circuit (threshold is 3)
      await assert.rejects(() => cb.call(async () => { throw new Error('e3'); }));
      await assert.rejects(() => cb.call(async () => { throw new Error('e4'); }));
      assert.equal(cb.state, STATE.CLOSED);

      // 3rd within the new window → opens
      await assert.rejects(() => cb.call(async () => { throw new Error('e5'); }));
      assert.equal(cb.state, STATE.OPEN);
    });

    it('zero windowMs means lifetime counting', async () => {
      const cb = new CircuitBreaker({ threshold: 3, windowMs: 0, cooldownMs: 1000 });
      await assert.rejects(() => cb.call(async () => { throw new Error('e1'); }));
      await assert.rejects(() => cb.call(async () => { throw new Error('e2'); }));

      // Failures persist regardless of time
      await delay(50);
      assert.equal(cb.failureCount, 2);

      await assert.rejects(() => cb.call(async () => { throw new Error('e3'); }));
      assert.equal(cb.state, STATE.OPEN);
    });
  });

  // ── Event emission ────────────────────────────────────────────────────

  describe('stateChange events', () => {
    it('emits stateChange on CLOSED → OPEN', async () => {
      const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
      const events = [];
      cb.on('stateChange', (ev) => events.push(ev));

      await assert.rejects(() => cb.call(async () => { throw new Error('e1'); }));
      assert.equal(events.length, 0); // still CLOSED

      await assert.rejects(() => cb.call(async () => { throw new Error('e2'); }));
      assert.equal(events.length, 1);
      assert.equal(events[0].from, STATE.CLOSED);
      assert.equal(events[0].to, STATE.OPEN);
      assert.equal(events[0].name, 'default');
      assert.ok(events[0].timestamp);
    });

    it('emits stateChange on OPEN → HALF_OPEN → CLOSED', async () => {
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 50 });
      const events = [];
      cb.on('stateChange', (ev) => events.push(ev));

      await assert.rejects(() => cb.call(async () => { throw new Error('fail'); }));
      assert.equal(events.length, 1); // CLOSED → OPEN

      await delay(60);
      // Accessing state triggers transition
      assert.equal(cb.state, STATE.HALF_OPEN);
      assert.equal(events.length, 2); // OPEN → HALF_OPEN

      await cb.call(async () => 'ok');
      assert.equal(events.length, 3); // HALF_OPEN → CLOSED
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles concurrent calls without corrupting state', async () => {
      const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
      const results = await Promise.allSettled([
        cb.call(async () => { throw new Error('e1'); }),
        cb.call(async () => { throw new Error('e2'); }),
        cb.call(async () => { throw new Error('e3'); }),
      ]);
      // All should be rejected (the circuit opens after the 3rd)
      assert.equal(results.filter(r => r.status === 'rejected').length, 3);
      assert.equal(cb.state, STATE.OPEN);
    });

    it('handles mixed success and failure in CLOSED state', async () => {
      const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
      await cb.call(async () => 'ok');
      await assert.rejects(() => cb.call(async () => { throw new Error('e1'); }));
      await cb.call(async () => 'ok');
      await assert.rejects(() => cb.call(async () => { throw new Error('e2'); }));
      assert.equal(cb.state, STATE.CLOSED);

      // 3rd failure opens
      await assert.rejects(() => cb.call(async () => { throw new Error('e3'); }));
      assert.equal(cb.state, STATE.OPEN);
    });
  });

  // ── sanitize: CircuitOpenError / CircuitTimeoutError ──────────────────

  describe('error classes', () => {
    it('CircuitOpenError has correct name and message', () => {
      const err = new CircuitOpenError('my-svc');
      assert.equal(err.name, 'CircuitOpenError');
      assert.ok(err.message.includes('OPEN'));
      assert.ok(err.message.includes('my-svc'));
      assert.equal(err.breakerName, 'my-svc');
    });

    it('CircuitTimeoutError has correct name and message', () => {
      const err = new CircuitTimeoutError('my-svc', 500);
      assert.equal(err.name, 'CircuitTimeoutError');
      assert.ok(err.message.includes('500ms'));
      assert.ok(err.message.includes('my-svc'));
      assert.equal(err.breakerName, 'my-svc');
    });
  });
});
