#!/usr/bin/env node
'use strict';

/**
 * scripts/chaos.js — Chaos test harness.
 *
 * Drives a configurable mock provider through CircuitBreaker + withRetry to
 * validate end-to-end resilience behavior:
 *
 *   - Latency injection (p50/p95 sanity)
 *   - Error injection (rate / burst / every-N)
 *   - Circuit breaker opens after threshold and fast-fails
 *   - HALF_OPEN probe and recovery to CLOSED
 *   - Retry with exponential backoff respecting CircuitOpenError
 *
 * Usage:
 *   node scripts/chaos.js                 # run all scenarios
 *   node scripts/chaos.js latency         # single scenario
 *   node scripts/chaos.js --json          # machine-readable output
 *
 * Exit codes:
 *   0  all scenarios met expectations
 *   1  one or more scenarios failed
 */

const path = require('node:path');
const { createChaosProvider } = require(path.join(
  __dirname,
  '..',
  'backend',
  'src',
  'chaos',
  'provider-mock',
));
const { CircuitBreaker, STATE, CircuitOpenError } = require(path.join(
  __dirname,
  '..',
  'backend',
  'src',
  'utils',
  'circuit-breaker',
));
const { withRetry } = require(path.join(
  __dirname,
  '..',
  'backend',
  'src',
  'utils',
  'retry-with-backoff',
));

// ── CLI parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const jsonOut = flags.has('--json');
const verbose = flags.has('--verbose');

function log(...parts) {
  if (jsonOut) return;
  // eslint-disable-next-line no-console
  console.log(...parts);
}

function summarize(arr) {
  if (!arr.length) return { p50: 0, p95: 0, max: 0, n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
  };
}

// ── Scenarios ─────────────────────────────────────────────────────────────

async function scenarioLatency() {
  const provider = createChaosProvider({
    name: 'latency-mock',
    latencyMs: 30,
    jitterMs: 20,
    seed: 1,
  });
  const samples = [];
  const N = 25;
  for (let i = 0; i < N; i += 1) {
    const t0 = Date.now();
    await provider.call();
    samples.push(Date.now() - t0);
  }
  const stats = summarize(samples);
  return {
    name: 'latency',
    description: 'baseline latency injection (no errors)',
    stats,
    expectations: {
      successes: provider.stats.successes,
      expected: N,
      p50InRange: stats.p50 >= 25 && stats.p50 <= 80,
    },
    pass: provider.stats.successes === N && stats.p50 >= 25 && stats.p50 <= 80,
  };
}

async function scenarioBreakerOpens() {
  // 100% errors: confirm breaker opens after `threshold` failures and
  // subsequent calls fast-fail with CircuitOpenError.
  const provider = createChaosProvider({
    name: 'fail-mock',
    latencyMs: 5,
    errorRate: 1,
    seed: 2,
  });
  const cb = new CircuitBreaker({
    name: 'fail-mock',
    threshold: 3,
    cooldownMs: 200,
    windowMs: 5_000,
  });

  const transitions = [];
  cb.on('stateChange', ({ from, to }) => transitions.push(`${from}->${to}`));

  let fastFails = 0;
  let upstreamFails = 0;
  for (let i = 0; i < 10; i += 1) {
    try {
      await cb.call(() => provider.call());
    } catch (err) {
      if (err instanceof CircuitOpenError) fastFails += 1;
      else upstreamFails += 1;
    }
  }

  const opened = transitions.includes('CLOSED->OPEN');
  return {
    name: 'breaker-opens',
    description: 'breaker opens after threshold failures and fast-fails further calls',
    transitions,
    upstreamFails,
    fastFails,
    state: cb.state,
    pass: opened && fastFails > 0 && upstreamFails === cb.threshold && cb.state === STATE.OPEN,
  };
}

async function scenarioHalfOpenRecovery() {
  // Provider fails 3 calls then recovers. Breaker should OPEN at threshold,
  // cool down, probe in HALF_OPEN, then CLOSE.
  const provider = createChaosProvider({
    name: 'recover-mock',
    latencyMs: 5,
    errorBurst: 3,
    seed: 3,
  });
  const cb = new CircuitBreaker({
    name: 'recover-mock',
    threshold: 3,
    cooldownMs: 120,
    probeCount: 1,
    windowMs: 5_000,
  });

  const transitions = [];
  cb.on('stateChange', ({ from, to }) => transitions.push(`${from}->${to}`));

  // Drive it to OPEN.
  for (let i = 0; i < 3; i += 1) {
    try { await cb.call(() => provider.call()); } catch (_) { /* expected */ }
  }
  const openedAt = cb.state;

  // Wait for cooldown, then issue a probe — should close.
  await new Promise((r) => setTimeout(r, 150));
  let probeError = null;
  try {
    await cb.call(() => provider.call());
  } catch (err) {
    probeError = err;
  }

  const closedAgain = cb.state === STATE.CLOSED;
  return {
    name: 'half-open-recovery',
    description: 'OPEN → HALF_OPEN → CLOSED after probe success',
    transitions,
    openedAt,
    finalState: cb.state,
    probeError: probeError ? probeError.message : null,
    pass:
      openedAt === STATE.OPEN
      && transitions.includes('CLOSED->OPEN')
      && transitions.includes('OPEN->HALF_OPEN')
      && transitions.includes('HALF_OPEN->CLOSED')
      && closedAgain,
  };
}

async function scenarioRetrySucceeds() {
  // First 2 calls fail; with maxRetries=2 the third succeeds.
  const provider = createChaosProvider({
    name: 'retry-mock',
    latencyMs: 5,
    errorBurst: 2,
    seed: 4,
  });
  const cb = new CircuitBreaker({
    name: 'retry-mock',
    threshold: 10,
    cooldownMs: 1_000,
    windowMs: 5_000,
  });

  const retryAttempts = [];
  const result = await withRetry(() => provider.call(), {
    maxRetries: 3,
    baseDelayMs: 5,
    maxDelayMs: 20,
    classifyError: () => ({ retryable: true, reason: 'chaos', ttlMs: 5 }),
    circuitBreaker: cb,
    onRetry: (info) => retryAttempts.push({ attempt: info.attempt, reason: info.reason }),
  });

  return {
    name: 'retry-succeeds',
    description: 'withRetry recovers when failures stop within budget',
    result,
    retryAttempts,
    providerCalls: provider.stats.calls,
    failures: provider.stats.failures,
    pass:
      result && result.ok === true
      && provider.stats.failures === 2
      && provider.stats.successes === 1
      && retryAttempts.length >= 2,
  };
}

async function scenarioRetryStopsOnOpenCircuit() {
  // Permanent failures: breaker opens, withRetry should bail (not keep retrying).
  const provider = createChaosProvider({
    name: 'permafail-mock',
    latencyMs: 2,
    errorRate: 1,
    seed: 5,
  });
  const cb = new CircuitBreaker({
    name: 'permafail-mock',
    threshold: 2,
    cooldownMs: 5_000,
    windowMs: 5_000,
  });

  let caught = null;
  try {
    await withRetry(() => provider.call(), {
      maxRetries: 5,
      baseDelayMs: 5,
      maxDelayMs: 20,
      classifyError: () => ({ retryable: true, reason: 'chaos', ttlMs: 5 }),
      circuitBreaker: cb,
    });
  } catch (err) {
    caught = err;
  }

  return {
    name: 'retry-stops-on-open',
    description: 'withRetry stops once breaker opens (no further upstream calls)',
    caughtName: caught && caught.name,
    providerCalls: provider.stats.calls,
    state: cb.state,
    pass:
      cb.state === STATE.OPEN
      && caught instanceof CircuitOpenError
      // upstream calls = threshold (2) before opening; retry then sees CircuitOpenError.
      && provider.stats.calls === cb.threshold,
  };
}

const SCENARIOS = {
  latency: scenarioLatency,
  'breaker-opens': scenarioBreakerOpens,
  'half-open-recovery': scenarioHalfOpenRecovery,
  'retry-succeeds': scenarioRetrySucceeds,
  'retry-stops-on-open': scenarioRetryStopsOnOpenCircuit,
};

// ── Runner ────────────────────────────────────────────────────────────────

async function main() {
  const requested = positional.length ? positional : Object.keys(SCENARIOS);
  const results = [];

  for (const name of requested) {
    const fn = SCENARIOS[name];
    if (!fn) {
      log(`unknown scenario: ${name}`);
      log(`available: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    log(`▶ ${name}`);
    const t0 = Date.now();
    try {
      const r = await fn();
      r.elapsedMs = Date.now() - t0;
      results.push(r);
      log(`  ${r.pass ? 'PASS' : 'FAIL'} (${r.elapsedMs}ms) — ${r.description}`);
      if (verbose || !r.pass) log('  ', JSON.stringify(r, null, 2));
    } catch (err) {
      results.push({ name, pass: false, error: err.message, stack: err.stack });
      log(`  FAIL — threw: ${err.message}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ results, ok: failed.length === 0 }, null, 2) + '\n');
  } else {
    log('');
    log(`${results.length - failed.length}/${results.length} scenarios passed`);
  }
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('chaos harness crashed:', err);
    process.exitCode = 2;
  });
}

module.exports = { SCENARIOS, main };
