'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { createChaosProvider, ChaosError } = require('../src/chaos/provider-mock');
const { CircuitBreaker, CircuitOpenError, STATE } = require('../src/utils/circuit-breaker');
const { withRetry } = require('../src/utils/retry-with-backoff');

describe('createChaosProvider', () => {
  it('rejects invalid errorRate', () => {
    assert.throws(() => createChaosProvider({ errorRate: 2 }), RangeError);
    assert.throws(() => createChaosProvider({ errorRate: -0.5 }), RangeError);
  });

  it('rejects negative latency', () => {
    assert.throws(() => createChaosProvider({ latencyMs: -1 }), RangeError);
  });

  it('returns success when no chaos configured', async () => {
    const p = createChaosProvider({ seed: 1 });
    const r = await p.call();
    assert.equal(r.ok, true);
    assert.equal(p.stats.calls, 1);
    assert.equal(p.stats.successes, 1);
    assert.equal(p.stats.failures, 0);
  });

  it('always fails when errorRate=1', async () => {
    const p = createChaosProvider({ errorRate: 1, seed: 1 });
    let thrown = null;
    try { await p.call(); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof ChaosError);
    assert.equal(thrown.code, 'CHAOS_INJECTED');
    assert.equal(p.stats.failures, 1);
    assert.equal(p.stats.rateFailures, 1);
  });

  it('honors errorBurst exactly', async () => {
    const p = createChaosProvider({ errorBurst: 3, seed: 1 });
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => p.call(), ChaosError);
    }
    const r = await p.call();
    assert.equal(r.ok, true);
    assert.equal(p.stats.burstFailures, 3);
    assert.equal(p.stats.successes, 1);
  });

  it('honors errorEvery pattern', async () => {
    // every 2nd call (calls 2,4,6...) fails
    const p = createChaosProvider({ errorEvery: 2, seed: 1 });
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) {
      try { await p.call(); outcomes.push('ok'); }
      catch { outcomes.push('err'); }
    }
    assert.deepEqual(outcomes, ['ok', 'err', 'ok', 'err', 'ok', 'err']);
    assert.equal(p.stats.everyFailures, 3);
  });

  it('is deterministic with seed', async () => {
    const make = () => createChaosProvider({ errorRate: 0.5, seed: 99 });
    const seq = async (p) => {
      const out = [];
      for (let i = 0; i < 20; i += 1) {
        try { await p.call(); out.push(1); } catch { out.push(0); }
      }
      return out;
    };
    assert.deepEqual(await seq(make()), await seq(make()));
  });

  it('injects latency in expected band', async () => {
    const p = createChaosProvider({ latencyMs: 25, jitterMs: 0, seed: 1 });
    const t0 = Date.now();
    await p.call();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 20, `expected >=20ms, got ${elapsed}`);
    assert.ok(elapsed < 200, `expected <200ms, got ${elapsed}`);
  });

  it('recoverAfterMs stops error injection', async () => {
    const p = createChaosProvider({
      errorRate: 1,
      recoverAfterMs: 30,
      seed: 1,
    });
    // initial calls fail
    await assert.rejects(() => p.call(), ChaosError);
    await new Promise((r) => setTimeout(r, 50));
    const r = await p.call();
    assert.equal(r.ok, true);
  });

  it('forceFail / clearForceFail toggle behavior at runtime', async () => {
    const p = createChaosProvider({ seed: 1 });
    p.forceFail(new Error('manual'));
    await assert.rejects(() => p.call(), /manual/);
    p.clearForceFail();
    const r = await p.call();
    assert.equal(r.ok, true);
  });

  it('reset() zeroes stats', async () => {
    const p = createChaosProvider({ errorBurst: 2, seed: 1 });
    try { await p.call(); } catch {}
    try { await p.call(); } catch {}
    p.reset();
    assert.equal(p.stats.calls, 0);
    assert.equal(p.stats.failures, 0);
  });
});

describe('chaos provider × CircuitBreaker', () => {
  it('opens breaker after threshold consecutive failures', async () => {
    const p = createChaosProvider({ errorRate: 1, seed: 1 });
    const cb = new CircuitBreaker({
      name: 't1', threshold: 3, cooldownMs: 1_000, windowMs: 5_000,
    });
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => cb.call(() => p.call()));
    }
    assert.equal(cb.state, STATE.OPEN);
    // next call fast-fails without touching provider
    const before = p.stats.calls;
    await assert.rejects(() => cb.call(() => p.call()), CircuitOpenError);
    assert.equal(p.stats.calls, before, 'provider should not be invoked when OPEN');
  });

  it('closes again via HALF_OPEN probe after recovery', async () => {
    const p = createChaosProvider({ errorBurst: 3, seed: 1 });
    const cb = new CircuitBreaker({
      name: 't2', threshold: 3, cooldownMs: 80, probeCount: 1, windowMs: 5_000,
    });
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => cb.call(() => p.call()));
    }
    assert.equal(cb.state, STATE.OPEN);
    await new Promise((r) => setTimeout(r, 100));
    const result = await cb.call(() => p.call());
    assert.equal(result.ok, true);
    assert.equal(cb.state, STATE.CLOSED);
  });
});

describe('chaos provider × withRetry', () => {
  it('retry succeeds when failures end within budget', async () => {
    const p = createChaosProvider({ errorBurst: 2, seed: 1 });
    const cb = new CircuitBreaker({ name: 'r1', threshold: 10, windowMs: 5_000 });
    const retries = [];
    const r = await withRetry(() => p.call(), {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      classifyError: () => ({ retryable: true, reason: 'chaos', ttlMs: 1 }),
      circuitBreaker: cb,
      onRetry: (info) => retries.push(info),
    });
    assert.equal(r.ok, true);
    assert.equal(p.stats.failures, 2);
    assert.equal(p.stats.successes, 1);
    assert.equal(retries.length, 2);
  });

  it('retry bails out once circuit opens', async () => {
    const p = createChaosProvider({ errorRate: 1, seed: 1 });
    const cb = new CircuitBreaker({
      name: 'r2', threshold: 2, cooldownMs: 5_000, windowMs: 5_000,
    });
    let caught = null;
    try {
      await withRetry(() => p.call(), {
        maxRetries: 5,
        baseDelayMs: 1,
        maxDelayMs: 5,
        classifyError: () => ({ retryable: true, reason: 'chaos', ttlMs: 1 }),
        circuitBreaker: cb,
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof CircuitOpenError);
    assert.equal(cb.state, STATE.OPEN);
    assert.equal(p.stats.calls, 2, 'no further provider calls after OPEN');
  });
});
