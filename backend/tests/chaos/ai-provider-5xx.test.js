'use strict';

/**
 * Chaos: AI provider returns 5xx — retry-with-backoff exhausts → caller
 * is expected to translate to a 503-shaped error.
 *
 * Uses `createChaosProvider` from src/chaos to produce realistic failure
 * shapes (always-fail and burst-of-5). The route-layer equivalent of
 * "translate to 503" is simulated with a tiny helper so we exercise the
 * full classify → retry → fail-mapped pipeline.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createChaosProvider } = require('../../src/chaos/provider-mock');
const { withRetry } = require('../../src/utils/retry-with-backoff');
const { CircuitBreaker } = require('../../src/utils/circuit-breaker');

function classify5xx(err) {
  // Pretend every chaos error is a synthetic HTTP 5xx — retryable up to budget.
  return { retryable: true, reason: 'upstream_5xx', ttlMs: 1 };
}

/** Wraps a callable so callers see { status, body } instead of throws. */
async function asRoute(fn) {
  try {
    const body = await fn();
    return { status: 200, body };
  } catch (err) {
    // Production route: any error escaping the retry loop → 503.
    return { status: 503, body: { error: 'upstream_unavailable', code: err.code || 'EUPSTREAM' } };
  }
}

describe('chaos: AI provider 5xx', () => {
  it('always-fail provider exhausts retries and yields a 503', async () => {
    const provider = createChaosProvider({ errorRate: 1, seed: 7 });
    const cb = new CircuitBreaker({ name: 'openai-mock', threshold: 99, windowMs: 5_000 });
    const { status, body } = await asRoute(() => withRetry(
      () => provider.call(),
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 4, classifyError: classify5xx, circuitBreaker: cb }
    ));
    assert.equal(status, 503);
    assert.equal(body.error, 'upstream_unavailable');
    assert.equal(provider.stats.calls, 4, 'should have attempted 1 + 3 retries');
  });

  it('transient 5xx burst → success after backoff (no 503)', async () => {
    const provider = createChaosProvider({ errorBurst: 2, seed: 11 });
    const cb = new CircuitBreaker({ name: 'anthropic-mock', threshold: 99, windowMs: 5_000 });
    const { status, body } = await asRoute(() => withRetry(
      () => provider.call(),
      { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 4, classifyError: classify5xx, circuitBreaker: cb }
    ));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(provider.stats.failures, 2);
    assert.equal(provider.stats.successes, 1);
  });

  it('circuit-breaker fast-fail short-circuits the retry loop', async () => {
    const provider = createChaosProvider({ errorRate: 1, seed: 3 });
    const cb = new CircuitBreaker({ name: 'mock', threshold: 2, cooldownMs: 5_000, windowMs: 5_000 });
    // First call (with retries) trips the breaker.
    const r1 = await asRoute(() => withRetry(() => provider.call(), {
      maxRetries: 5, baseDelayMs: 1, maxDelayMs: 4, classifyError: classify5xx, circuitBreaker: cb,
    }));
    assert.equal(r1.status, 503);
    const callsAfter1 = provider.stats.calls;
    // Second call should fast-fail without invoking provider.
    const r2 = await asRoute(() => withRetry(() => provider.call(), {
      maxRetries: 5, baseDelayMs: 1, maxDelayMs: 4, classifyError: classify5xx, circuitBreaker: cb,
    }));
    assert.equal(r2.status, 503);
    assert.equal(provider.stats.calls, callsAfter1, 'breaker should prevent further provider calls');
  });
});
