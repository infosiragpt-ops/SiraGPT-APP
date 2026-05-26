'use strict';

/**
 * provider-mock.js — Configurable chaos provider for resilience testing.
 *
 * Builds a mock async "provider" whose call() can be tuned to inject:
 *   - constant latency + uniform jitter
 *   - random error rate (Bernoulli on each call)
 *   - deterministic burst of N consecutive errors at the start
 *   - "every Nth call fails" pattern
 *   - graceful recovery after a configurable elapsed time
 *
 * Designed to drive CircuitBreaker + withRetry through realistic failure
 * shapes without needing real network calls. Deterministic when seeded.
 *
 * Usage:
 *   const provider = createChaosProvider({
 *     name: 'openai-mock',
 *     latencyMs: 50,
 *     jitterMs: 20,
 *     errorRate: 0.3,
 *     errorBurst: 5,        // first 5 calls always fail
 *     recoverAfterMs: 2000, // after 2s no errors are injected anymore
 *     seed: 42,
 *   });
 *   const result = await provider.call({ prompt: 'hello' });
 *   provider.stats; // { calls, successes, failures, totalLatencyMs, ... }
 */

const DEFAULTS = Object.freeze({
  name: 'chaos-mock',
  latencyMs: 0,
  jitterMs: 0,
  errorRate: 0,
  errorBurst: 0,
  errorEvery: 0,
  recoverAfterMs: 0,
  errorMessage: 'chaos: injected provider error',
  errorCode: 'CHAOS_INJECTED',
  // factory ({ attempt }) => any — what call() resolves with on success.
  responseFactory: ({ attempt }) => ({ ok: true, attempt }),
  seed: null,
  timeSource: () => Date.now(),
});

/**
 * Tiny deterministic PRNG (Mulberry32). Used only when `seed` is set so
 * tests can reproduce failure patterns. Falls back to Math.random otherwise.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ChaosError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ChaosError';
    this.code = code;
    this.retryable = true;
  }
}

function createChaosProvider(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (cfg.errorRate < 0 || cfg.errorRate > 1) {
    throw new RangeError('errorRate must be in [0,1]');
  }
  if (cfg.latencyMs < 0 || cfg.jitterMs < 0) {
    throw new RangeError('latencyMs and jitterMs must be >= 0');
  }

  const rand = cfg.seed != null ? mulberry32(cfg.seed) : Math.random;
  const startedAt = cfg.timeSource();

  const stats = {
    calls: 0,
    successes: 0,
    failures: 0,
    burstFailures: 0,
    rateFailures: 0,
    everyFailures: 0,
    totalLatencyMs: 0,
    lastError: null,
    lastResult: null,
  };

  // Mutable runtime overrides — tests can flip behavior mid-flight.
  const state = {
    forceFail: false,
    forceFailError: null,
    paused: false,
  };

  function pickLatency() {
    const jitter = cfg.jitterMs > 0 ? rand() * cfg.jitterMs : 0;
    return Math.max(0, Math.round(cfg.latencyMs + jitter));
  }

  function shouldFail() {
    // Recovery window — once elapsed, no more injected errors.
    if (cfg.recoverAfterMs > 0) {
      const elapsed = cfg.timeSource() - startedAt;
      if (elapsed >= cfg.recoverAfterMs) return { fail: false };
    }
    if (state.forceFail) {
      return { fail: true, kind: 'force' };
    }
    // Initial deterministic burst.
    if (cfg.errorBurst > 0 && stats.calls <= cfg.errorBurst) {
      return { fail: true, kind: 'burst' };
    }
    if (cfg.errorEvery > 0 && stats.calls % cfg.errorEvery === 0) {
      return { fail: true, kind: 'every' };
    }
    if (cfg.errorRate > 0 && rand() < cfg.errorRate) {
      return { fail: true, kind: 'rate' };
    }
    return { fail: false };
  }

  async function call(args) {
    stats.calls += 1;
    const attempt = stats.calls;

    if (state.paused) {
      // Hang forever — useful for forcing timeouts in tests.
      await new Promise(() => {});
    }

    const latency = pickLatency();
    if (latency > 0) {
      await new Promise((r) => setTimeout(r, latency));
      stats.totalLatencyMs += latency;
    }

    const decision = shouldFail();
    if (decision.fail) {
      stats.failures += 1;
      if (decision.kind === 'burst') stats.burstFailures += 1;
      else if (decision.kind === 'every') stats.everyFailures += 1;
      else if (decision.kind === 'rate') stats.rateFailures += 1;

      const err = state.forceFailError instanceof Error
        ? state.forceFailError
        : new ChaosError(`${cfg.errorMessage} [${decision.kind}, call=${attempt}]`, cfg.errorCode);
      stats.lastError = err;
      throw err;
    }

    stats.successes += 1;
    const result = cfg.responseFactory({ attempt, args });
    stats.lastResult = result;
    return result;
  }

  return {
    name: cfg.name,
    call,
    stats,
    config: cfg,
    // Runtime controls
    forceFail(err) {
      state.forceFail = true;
      state.forceFailError = err || null;
    },
    clearForceFail() {
      state.forceFail = false;
      state.forceFailError = null;
    },
    pause() { state.paused = true; },
    resume() { state.paused = false; },
    snapshot() { return { ...stats }; },
    reset() {
      stats.calls = 0;
      stats.successes = 0;
      stats.failures = 0;
      stats.burstFailures = 0;
      stats.rateFailures = 0;
      stats.everyFailures = 0;
      stats.totalLatencyMs = 0;
      stats.lastError = null;
      stats.lastResult = null;
    },
  };
}

module.exports = {
  createChaosProvider,
  ChaosError,
};
