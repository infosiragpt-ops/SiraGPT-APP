'use strict';

/**
 * post-deploy-error-canary.js — error-rate canary for production deploys.
 *
 * Runs on the VPS inside the freshly recreated backend container, right
 * after the deploy workflow's version check. It compares the HTTP 5xx
 * ratio of the post-deploy window against the pre-deploy baseline using
 * the same standard-class SLO counters the burn-rate rules consume
 * (siragpt_http_slo_requests_total), queried from the co-located
 * Prometheus instance.
 *
 * Gate semantics (both must hold to roll back):
 *   G1 absolute — recent 5xx ratio exceeds CANARY_ERROR_RATIO_MAX
 *   G2 relative — recent ratio exceeds baseline × CANARY_RATIO_MULTIPLIER
 *                 by more than CANARY_MIN_ABS_DELTA
 *
 * Low-traffic windows never trip the gates: below CANARY_MIN_REQUESTS
 * recent samples the canary keeps polling until its budget expires and
 * then passes (traffic-gated, mirroring docs/slo.md semantics).
 *
 * Exit codes: 0 = healthy/insufficient traffic, 1 = breach (the deploy
 * workflow's rollback trap fires), 2 = misconfiguration.
 *
 * Environment:
 *   CANARY_PROM_URL              default http://prometheus:9090
 *   CANARY_BASELINE_MINUTES      default 60
 *   CANARY_RECENT_MINUTES        default 10
 *   CANARY_ERROR_RATIO_MAX       default 0.05
 *   CANARY_RATIO_MULTIPLIER      default 3
 *   CANARY_MIN_ABS_DELTA         default 0.01
 *   CANARY_MIN_REQUESTS          default 20
 *   CANARY_POLL_INTERVAL_SECONDS default 30
 *   CANARY_TIMEOUT_SECONDS       default 600
 */

const http = require('node:http');

function resolveConfig(env) {
  const num = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
  };
  const config = {
    promUrl: (env.CANARY_PROM_URL || 'http://prometheus:9090').replace(/\/+$/, ''),
    baselineMinutes: num(env.CANARY_BASELINE_MINUTES, 60, { min: 1 }),
    recentMinutes: num(env.CANARY_RECENT_MINUTES, 10, { min: 1 }),
    errorRatioMax: num(env.CANARY_ERROR_RATIO_MAX, 0.05, { min: 0, max: 1 }),
    ratioMultiplier: num(env.CANARY_RATIO_MULTIPLIER, 3, { min: 1 }),
    minAbsDelta: num(env.CANARY_MIN_ABS_DELTA, 0.01, { min: 0, max: 1 }),
    minRequests: num(env.CANARY_MIN_REQUESTS, 20, { min: 1 }),
    pollIntervalSeconds: num(env.CANARY_POLL_INTERVAL_SECONDS, 30, { min: 1 }),
    timeoutSeconds: num(env.CANARY_TIMEOUT_SECONDS, 600, { min: 1 }),
  };
  if (config.recentMinutes >= config.baselineMinutes) {
    config.recentMinutes = Math.max(1, Math.floor(config.baselineMinutes / 2));
  }
  return config;
}

function buildQueries(config) {
  const base = `${Math.round(config.baselineMinutes)}m`;
  const rec = `${Math.round(config.recentMinutes)}m`;
  const off = `offset ${rec}`;
  const selector = 'siragpt_http_slo_requests_total{request_class="standard"}';
  return {
    baselineErrors: `sum(increase(${selector.replace('}', ',status_class="5xx"}')}[${base}] ${off}))`,
    baselineTotal: `sum(increase(${selector}[${base}] ${off}))`,
    recentErrors: `sum(increase(${selector.replace('}', ',status_class="5xx"}')}[${rec}]))`,
    recentTotal: `sum(increase(${selector}[${rec}]))`,
  };
}

/**
 * Decide from one observation. Pure so the contract is testable.
 * Returns 'rollback' | 'pass' | 'wait'.
 */
function evaluateGates(observation, config) {
  const { recentTotal, recentErrors, baselineTotal, baselineErrors } = observation;
  if (!Number.isFinite(recentTotal) || recentTotal < config.minRequests) {
    return { decision: 'wait', reason: 'insufficient_recent_traffic' };
  }
  const recentRatio = recentErrors / recentTotal;
  if (recentRatio > config.errorRatioMax) {
    return {
      decision: 'rollback',
      gate: 'absolute',
      recentRatio,
      threshold: config.errorRatioMax,
    };
  }
  if (!Number.isFinite(baselineTotal) || baselineTotal < config.minRequests) {
    return { decision: 'pass', reason: 'healthy_without_usable_baseline', recentRatio };
  }
  const baselineRatio = baselineErrors / baselineTotal;
  const relativeThreshold = baselineRatio * config.ratioMultiplier + config.minAbsDelta;
  if (recentRatio > relativeThreshold) {
    return {
      decision: 'rollback',
      gate: 'relative',
      recentRatio,
      baselineRatio,
      threshold: relativeThreshold,
    };
  }
  return { decision: 'pass', reason: 'healthy', recentRatio, baselineRatio };
}

function queryPrometheus(promUrl, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/query', promUrl);
    url.searchParams.set('query', query);
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`prometheus_query_status_${response.statusCode}`));
          return;
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          reject(new Error('prometheus_invalid_json'));
          return;
        }
        if (payload.status !== 'success') {
          reject(new Error(`prometheus_status_${payload.status}`));
          return;
        }
        const result = Array.isArray(payload.data?.result) ? payload.data.result : [];
        const value = result.length > 0 ? Number(result[0].value?.[1]) : NaN;
        resolve(Number.isFinite(value) && value >= 0 ? value : 0);
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('prometheus_query_timeout'));
    });
    request.on('error', reject);
  });
}

async function observe(config, queryFn) {
  const queries = buildQueries(config);
  const [recentTotal, recentErrors, baselineTotal, baselineErrors] = await Promise.all([
    queryFn(queries.recentTotal),
    queryFn(queries.recentErrors),
    queryFn(queries.baselineTotal),
    queryFn(queries.baselineErrors),
  ]);
  return { recentTotal, recentErrors, baselineTotal, baselineErrors };
}

async function runCanary(config, { queryFn, sleep, now, log } = {}) {
  const effectiveQueryFn = queryFn || ((query) => queryPrometheus(config.promUrl, query, 5000));
  const effectiveSleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const effectiveNow = now || (() => Date.now());
  const effectiveLog = log || ((line) => process.stdout.write(`[canary] ${line}\n`));
  const startedAt = effectiveNow();
  let lastError = null;

  while (effectiveNow() - startedAt < config.timeoutSeconds * 1000) {
    let observation;
    try {
      observation = await observe(config, effectiveQueryFn);
      lastError = null;
    } catch (error) {
      lastError = String(error?.message || error);
      effectiveLog(`prometheus unavailable (${lastError}); retrying`);
      await effectiveSleep(config.pollIntervalSeconds * 1000);
      continue;
    }

    const verdict = evaluateGates(observation, config);
    effectiveLog(JSON.stringify(verdict));
    if (verdict.decision === 'rollback') {
      return { ok: false, outcome: 'rollback', verdict, observation };
    }
    if (verdict.decision === 'pass') {
      return { ok: true, outcome: 'pass', verdict, observation };
    }
    await effectiveSleep(config.pollIntervalSeconds * 1000);
  }

  if (lastError) {
    // Prometheus never answered within budget: cannot claim health, but a
    // dead canary must not strand production mid-deploy either. Fail closed
    // so the workflow surfaces it and ops decides.
    return { ok: false, outcome: 'unobservable', error: lastError };
  }
  return {
    ok: true,
    outcome: 'pass',
    reason: 'timeout_with_insufficient_traffic',
  };
}

async function main() {
  const config = resolveConfig(process.env);
  const result = await runCanary(config);
  process.stdout.write(`${JSON.stringify({ config, result })}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[canary] fatal: ${String(error?.message || error)}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  buildQueries,
  evaluateGates,
  observe,
  resolveConfig,
  runCanary,
};
