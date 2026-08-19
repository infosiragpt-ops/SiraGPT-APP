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

    it('does not count an external abort as a failure even when the error is falsy', async () => {
      // Regression: the guard was `err && externalSignal && externalSignal.aborted`,
      // so an abort that surfaced as a FALSY error (a bare throw / null reason) fell
      // through and was mis-counted as a circuit failure. Gate on the signal only.
      const cb = new CircuitBreaker({ threshold: 5 });
      const ac = new AbortController();
      await cb.call(async () => { ac.abort(); throw undefined; }, { signal: ac.signal }).catch(() => {});
      assert.equal(cb.failureCount, 0, 'a falsy-error abort must not count as a circuit failure');
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
    it('lifetime success counter (windowMs=0) counts correctly across many calls without leaking', async () => {
      // Regression: kSuccesses is a RollingCounter(0) whose _prune is a no-op, so
      // it used to store one object per success forever (unbounded memory). It now
      // aggregates into a single entry — count stays correct and memory is O(1).
      const cb = new CircuitBreaker({ threshold: 1_000_000, windowMs: 0 });
      for (let i = 0; i < 3000; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(async () => 'ok');
      }
      assert.equal(cb.successCount, 3000, 'aggregated lifetime count is exact');
      cb.reset();
      assert.equal(cb.successCount, 0, 'reset clears the aggregate');
    });

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

  // ── Invalid-config clamping ───────────────────────────────────────────
  describe('invalid config clamping', () => {
    it('clamps a NaN threshold to the default so the breaker still opens', async () => {
      // Before clamping: `count >= NaN` is always false → breaker NEVER opens.
      const cb = new CircuitBreaker({ threshold: NaN, cooldownMs: 1000 });
      assert.equal(cb.threshold, 5, 'NaN threshold should fall back to default 5');
      for (let i = 0; i < 5; i++) {
        await assert.rejects(() => cb.call(async () => { throw new Error(`e${i}`); }));
      }
      assert.equal(cb.state, STATE.OPEN);
    });

    it('clamps a zero / negative threshold to a minimum of 1', async () => {
      const cbZero = new CircuitBreaker({ threshold: 0 });
      assert.equal(cbZero.threshold, 1);
      const cbNeg = new CircuitBreaker({ threshold: -5 });
      assert.equal(cbNeg.threshold, 1);

      // With threshold 1, a single SUCCESS must NOT open the circuit.
      await cbNeg.call(async () => 'ok');
      assert.equal(cbNeg.state, STATE.CLOSED);
      // ...but a single failure should.
      await assert.rejects(() => cbNeg.call(async () => { throw new Error('boom'); }));
      assert.equal(cbNeg.state, STATE.OPEN);
    });

    it('clamps a NaN cooldownMs to the default (no NaN in nextAttempt / snapshot)', async () => {
      // Before clamping: nextAttempt = now + NaN → OPEN→HALF_OPEN never fires
      // and toJSON().cooldownRemainingMs leaked NaN.
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: NaN });
      assert.equal(cb.cooldownMs, 30_000);
      await assert.rejects(() => cb.call(async () => { throw new Error('boom'); }));
      assert.equal(cb.state, STATE.OPEN);
      const json = cb.toJSON();
      assert.equal(Number.isFinite(json.cooldownRemainingMs), true);
      assert.equal(Number.isNaN(json.cooldownRemainingMs), false);
      assert.ok(json.cooldownRemainingMs > 0 && json.cooldownRemainingMs <= 30_000);
    });

    it('clamps a NaN / zero probeCount to 1 so HALF_OPEN can recover to CLOSED', async () => {
      // Before clamping: `successCount >= NaN` is always false → stuck HALF_OPEN.
      const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 30, probeCount: NaN });
      assert.equal(cb.probeCount, 1);
      await assert.rejects(() => cb.call(async () => { throw new Error('boom'); }));
      assert.equal(cb.state, STATE.OPEN);
      await delay(40);
      assert.equal(cb.state, STATE.HALF_OPEN);
      await cb.call(async () => 'probe-ok');
      assert.equal(cb.state, STATE.CLOSED);
    });

    it('clamps NaN / negative timeoutMs and windowMs to 0', () => {
      const cb = new CircuitBreaker({ timeoutMs: NaN, windowMs: -100 });
      assert.equal(cb.timeoutMs, 0);
      assert.equal(cb.windowMs, 0);
    });

    it('clamps Infinity knobs back to their finite defaults', () => {
      const cb = new CircuitBreaker({
        threshold: Infinity,
        cooldownMs: Infinity,
        probeCount: Infinity,
        windowMs: Infinity,
        timeoutMs: Infinity,
      });
      assert.equal(cb.threshold, 5);
      assert.equal(cb.cooldownMs, 30_000);
      assert.equal(cb.probeCount, 1);
      assert.equal(cb.windowMs, 60_000);
      assert.equal(cb.timeoutMs, 0);
    });

    it('truncates fractional numeric knobs to integers', () => {
      const cb = new CircuitBreaker({ threshold: 3.9, probeCount: 2.7, cooldownMs: 100.6 });
      assert.equal(cb.threshold, 3);
      assert.equal(cb.probeCount, 2);
      assert.equal(cb.cooldownMs, 100);
    });

    it('falls back to a default name when name is empty or nullish', () => {
      assert.equal(new CircuitBreaker({ name: '' }).name, 'default');
      assert.equal(new CircuitBreaker({ name: null }).name, 'default');
      assert.equal(new CircuitBreaker({ name: undefined }).name, 'default');
      // A real name is preserved and coerced to string.
      assert.equal(new CircuitBreaker({ name: 'svc-1' }).name, 'svc-1');
      assert.equal(new CircuitBreaker({ name: 42 }).name, '42');
    });

    it('toJSON() never throws and never leaks non-finite values, even when forced OPEN', () => {
      const cb = new CircuitBreaker({ threshold: NaN, cooldownMs: NaN, timeoutMs: NaN });
      cb.forceState(STATE.OPEN);
      let json;
      assert.doesNotThrow(() => { json = cb.toJSON(); });
      for (const key of ['threshold', 'cooldownMs', 'probeCount', 'windowMs', 'timeoutMs', 'cooldownRemainingMs']) {
        assert.equal(Number.isFinite(json[key]), true, `${key} should be finite, got ${json[key]}`);
      }
      // Round-trips through JSON.stringify without producing the literal "null".
      assert.doesNotThrow(() => JSON.stringify(cb));
    });
  });

  // ── external signal listener cleanup ──────────────────────────────────
  describe('external signal listener cleanup', () => {
    it('detaches the abort listener after a successful call (no leak on reused signal)', async () => {
      const { getEventListeners } = require('node:events');
      const cb = new CircuitBreaker({ name: 'leak-test', timeoutMs: 1000 });
      const ac = new AbortController();
      const out = await cb.call(async () => 'ok', { signal: ac.signal });
      assert.equal(out, 'ok');
      assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    });

    it('does not accumulate listeners across repeated calls on a reused signal', async () => {
      const cb = new CircuitBreaker({ name: 'leak-test-2', timeoutMs: 1000 });
      const ac = new AbortController();
      for (let i = 0; i < 6; i++) {
        await cb.call(async () => i, { signal: ac.signal });
      }
      const { getEventListeners } = require('node:events');
      assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    });
  });

  // ── HALF_OPEN in-flight probe cap ─────────────────────────────────────
  describe('HALF_OPEN probe concurrency cap', () => {
    it('admits at most probeCount concurrent probes; the rest fast-fail as OPEN', async () => {
      // cooldownMs: 0 so the OPEN → HALF_OPEN auto-transition fires immediately
      // on the next call. probeCount defaults to 1.
      const cb = new CircuitBreaker({ name: 'herd', cooldownMs: 0 });
      cb.forceState(STATE.OPEN);
      assert.equal(cb.probeCount, 1);

      let invocations = 0;
      // fn returns a promise that never settles → probes stay in-flight.
      const fn = () => { invocations++; return never(); };

      const results = [];
      // Fire 5 concurrent calls. First (probeCount) admitted; rest reject.
      for (let i = 0; i < 5; i++) {
        results.push(
          cb.call(fn).then(
            () => ({ ok: true }),
            (err) => ({ ok: false, err })
          )
        );
      }

      // Let the rejections settle (admitted probes hang forever on never()).
      // Give the microtask/event loop a tick to resolve the fast-fail paths.
      await delay(20);

      // Only probeCount fns actually ran.
      assert.equal(invocations, cb.probeCount);

      // The 4 non-admitted callers must have rejected with CircuitOpenError.
      let rejected = 0;
      let stillPending = 0;
      for (const p of results) {
        const settled = await Promise.race([p, delay(0, '__pending__')]);
        if (settled === '__pending__') {
          stillPending++;
        } else if (!settled.ok) {
          assert.ok(settled.err instanceof CircuitOpenError,
            `expected CircuitOpenError, got ${settled.err}`);
          rejected++;
        }
      }
      assert.equal(rejected, 5 - cb.probeCount, 'non-admitted callers reject');
      assert.equal(stillPending, cb.probeCount, 'admitted probes stay in-flight');
    });

    it('releasing a probe slot (probe resolves) admits the next caller', async () => {
      const cb = new CircuitBreaker({ name: 'slot-release', cooldownMs: 0 });
      cb.forceState(STATE.OPEN);

      let invocations = 0;
      // First probe: controllable resolution. Later calls resolve instantly.
      let resolveFirst;
      const firstProbe = new Promise((res) => { resolveFirst = res; });

      const fn = () => {
        invocations++;
        return invocations === 1 ? firstProbe : Promise.resolve('ok');
      };

      // Admitted probe (in-flight, not yet resolved).
      const p1 = cb.call(fn);
      // Second concurrent caller: no free slot → fast-fail.
      await assert.rejects(cb.call(fn), CircuitOpenError);
      assert.equal(invocations, 1, 'second caller never executed fn');

      // Resolve the first probe → it succeeds and closes the breaker (probeCount=1).
      resolveFirst('done');
      assert.equal(await p1, 'done');

      // Slot released: the breaker is now CLOSED and admits normal calls again.
      assert.equal(cb.state, STATE.CLOSED);
      assert.equal(await cb.call(fn), 'ok');
      assert.equal(invocations, 2);
    });

    it('a probe that rejects releases its slot (does not permanently wedge HALF_OPEN)', async () => {
      // probeCount 2 so a failing probe does not immediately re-open; verify the
      // slot is freed for a subsequent probe rather than leaked.
      const cb = new CircuitBreaker({ name: 'reject-release', cooldownMs: 0, probeCount: 2, threshold: 10 });
      cb.forceState(STATE.OPEN);

      // First probe rejects (counts as a failure but slot must free).
      await assert.rejects(cb.call(async () => { throw new Error('boom'); }), /boom/);
      // Breaker re-opened on HALF_OPEN failure, but cooldownMs:0 → next call
      // re-enters HALF_OPEN. A fresh probe must be admitted (slot not leaked).
      assert.equal(await cb.call(async () => 'ok'), 'ok');
    });
  });
});
