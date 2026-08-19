#!/usr/bin/env node
/**
 * stress-test.js — siraGPT backend stress-test driver
 *
 * Uses `autocannon` (already a backend devDependency) to run three
 * scenarios against a running backend:
 *
 *   1. /health/ready                       — warmup, no auth
 *   2. /api/scientific-search/providers    — cached read path, no auth
 *   3. /api/auth/login                     — cold auth path (POST creds)
 *
 * Outputs P50/P95/P99 latency, requests/sec, and a non-zero exit code
 * if any scenario fails to complete.
 *
 * Usage:
 *   node backend/scripts/stress-test.js \
 *     --url http://localhost:5000 \
 *     --connections 50 \
 *     --duration 10 \
 *     --email test@example.com \
 *     --password testpass
 *
 * Env-var equivalents are supported (STRESS_URL, STRESS_CONNECTIONS,
 * STRESS_DURATION, STRESS_EMAIL, STRESS_PASSWORD). When credentials
 * aren't provided the login scenario is skipped (not failed).
 */

'use strict';

const autocannon = require('autocannon');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function fmt(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return 'n/a';
  return `${Number(ms).toFixed(2)}ms`;
}

function runScenario(name, opts) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (err, result) => {
      if (err) return reject(err);
      resolve({ name, result });
    });
    // Render a compact progress line so long runs are visible.
    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false });
  });
}

function summarise({ name, result }) {
  const lat = result.latency || {};
  const req = result.requests || {};
  const errors = (result.errors || 0) + (result.timeouts || 0) + (result.non2xx || 0);
  return {
    name,
    duration_s: result.duration,
    requests_total: req.total || 0,
    requests_per_sec_avg: req.average || 0,
    latency_p50_ms: lat.p50,
    latency_p95_ms: lat.p95,
    latency_p99_ms: lat.p99,
    latency_max_ms: lat.max,
    errors,
    non2xx: result.non2xx || 0,
    timeouts: result.timeouts || 0,
  };
}

function printSummary(summary) {
  console.log(`\n── ${summary.name} ──────────────────────────────────────`);
  console.log(`  duration:       ${summary.duration_s}s`);
  console.log(`  requests:       ${summary.requests_total} (avg ${(summary.requests_per_sec_avg || 0).toFixed(1)} req/s)`);
  console.log(`  p50 latency:    ${fmt(summary.latency_p50_ms)}`);
  console.log(`  p95 latency:    ${fmt(summary.latency_p95_ms)}`);
  console.log(`  p99 latency:    ${fmt(summary.latency_p99_ms)}`);
  console.log(`  max latency:    ${fmt(summary.latency_max_ms)}`);
  console.log(`  errors:         ${summary.errors} (non2xx=${summary.non2xx}, timeouts=${summary.timeouts})`);
}

async function main() {
  const args = parseArgs(process.argv);
  const url = args.url || process.env.STRESS_URL || 'http://localhost:5000';
  const connections = Number(args.connections || process.env.STRESS_CONNECTIONS || 25);
  const duration = Number(args.duration || process.env.STRESS_DURATION || 10);
  const email = args.email || process.env.STRESS_EMAIL || '';
  const password = args.password || process.env.STRESS_PASSWORD || '';
  const pipelining = Number(args.pipelining || process.env.STRESS_PIPELINING || 1);

  console.log(`siraGPT stress test`);
  console.log(`  target:       ${url}`);
  console.log(`  connections:  ${connections}`);
  console.log(`  duration:     ${duration}s per scenario`);
  console.log(`  pipelining:   ${pipelining}`);

  const summaries = [];
  let exitCode = 0;

  // ── 1. Warmup: /health/ready
  try {
    const r = await runScenario('warmup: GET /health/ready', {
      url: `${url}/health/ready`,
      method: 'GET',
      connections,
      duration,
      pipelining,
    });
    const s = summarise(r);
    summaries.push(s);
    if (s.errors > 0) exitCode = 1;
  } catch (err) {
    console.error('[stress] warmup failed:', err.message);
    exitCode = 1;
  }

  // ── 2. Cached read: /api/scientific-search/providers
  try {
    const r = await runScenario('cached: GET /api/scientific-search/providers', {
      url: `${url}/api/scientific-search/providers`,
      method: 'GET',
      connections,
      duration,
      pipelining,
    });
    const s = summarise(r);
    summaries.push(s);
    // This endpoint may be 401 if behind auth in some envs — only fail
    // on transport errors / timeouts.
    if (s.timeouts > 0 || (r.result.errors || 0) > 0) exitCode = 1;
  } catch (err) {
    console.error('[stress] providers failed:', err.message);
    exitCode = 1;
  }

  // ── 3. Cold auth: /api/auth/login (only when creds provided)
  if (email && password) {
    try {
      const r = await runScenario('cold-auth: POST /api/auth/login', {
        url: `${url}/api/auth/login`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        connections,
        duration,
        pipelining,
      });
      const s = summarise(r);
      summaries.push(s);
      if (s.timeouts > 0) exitCode = 1;
    } catch (err) {
      console.error('[stress] login failed:', err.message);
      exitCode = 1;
    }
  } else {
    console.log('\n── cold-auth scenario skipped (no --email/--password) ──');
  }

  summaries.forEach(printSummary);

  // Machine-readable footer for CI.
  console.log('\n── JSON summary ──');
  console.log(JSON.stringify({ scenarios: summaries, exitCode }, null, 2));

  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[stress] fatal:', err);
    process.exit(2);
  });
}

module.exports = { parseArgs, summarise };
