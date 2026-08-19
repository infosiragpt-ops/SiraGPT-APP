#!/usr/bin/env node
'use strict';

/**
 * SiraGPT health snapshot CLI.
 *
 * Operator command that fetches a running SiraGPT backend's health snapshot
 * (liveness + composite readiness) and prints a structured report with a
 * status-based exit code. Use it locally, in CI, or against a deployed URL to
 * verify a publish — it codifies the manual `curl /health*` checks from the
 * deployment runbook into one reusable, testable command.
 *
 * Adapted from OpenClaw's `openclaw health` gateway-snapshot CLI (MIT). The
 * upstream reference lives at .agents/openclaw-upstream (reference-only); this
 * is a SiraGPT-native rewrite that targets SiraGPT's own /health endpoints,
 * exit-code policy, and warm-up semantics. No upstream code is imported.
 *
 * Usage:
 *   node backend/scripts/health-snapshot.js [--url <base>] [--json] [--strict]
 *                                           [--timeout <ms>] [--verbose] [-h]
 *
 *   --url <base>     Backend base URL (default http://127.0.0.1:5050).
 *   --json           Print machine-readable JSON instead of text.
 *   --timeout <ms>   Per-probe timeout in milliseconds (default 10000).
 *   --strict         Treat a "degraded" snapshot as a failure (exit 1).
 *   --verbose        Include per-check details in the output.
 *   --help, -h       Show this help.
 *
 * Exit codes:
 *   0  healthy (or degraded without --strict)
 *   1  unhealthy / unknown (or degraded with --strict)
 *   2  unreachable (no response from the backend)
 */

const DEFAULT_BASE_URL =
  process.env.HEALTH_SNAPSHOT_URL ||
  process.env.BACKEND_INTERNAL_URL ||
  'http://127.0.0.1:5050';

const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_SNAPSHOT_TIMEOUT_MS || 10_000);

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    strict: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') args.baseUrl = argv[++i];
    else if (arg === '--timeout' || arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--verbose' || arg === '--debug') args.verbose = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number of milliseconds');
  }
  if (!args.baseUrl) {
    throw new Error('--url must not be empty');
  }
  return args;
}

async function probe(url, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: true, httpStatus: res.status, body, latencyMs: Date.now() - start };
  } catch (err) {
    const reason =
      err && err.name === 'AbortError'
        ? `timeout after ${timeoutMs}ms`
        : (err && (err.code || err.message)) || 'request failed';
    return { ok: false, error: reason, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function runHealthSnapshot({
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable; pass fetchImpl explicitly');
  }
  const base = String(baseUrl).replace(/\/+$/, '');
  const startedAt = Date.now();

  const live = await probe(`${base}/health/live`, { timeoutMs, fetchImpl });
  const full = await probe(`${base}/health`, { timeoutMs, fetchImpl });

  const reachable = live.ok || full.ok;
  const checks = full.ok && full.body && Array.isArray(full.body.checks) ? full.body.checks : [];
  let status;
  let hint = null;

  if (!reachable) {
    status = 'unreachable';
    hint = `No response from ${base} (${live.error || full.error || 'connection failed'}).`;
  } else if (!full.ok) {
    // Liveness answered but the composite /health probe failed (timeout, reset,
    // or a non-JSON error). A wedged /health while the process still accepts
    // connections is a real outage signal — fail hard so deploy verification
    // never goes green on a broken backend.
    status = 'unhealthy';
    hint = `The process is accepting connections but /health did not return a report (${full.error || 'error'}).`;
  } else {
    status = (full.body && typeof full.body.status === 'string') ? full.body.status : 'unknown';
    // Only treat an authoritative composite "unhealthy" (with checks) as a
    // possible warm-up window. Never apply the hint to transport/probe failures.
    if (status === 'unhealthy' && live.ok && checks.length) {
      hint =
        'Process is live but a critical dependency is unhealthy. Right after a deploy ' +
        'this is usually the warm-up window — re-run in ~30-60s before treating it as a real outage.';
    }
  }

  return {
    url: base,
    status,
    reachable,
    hint,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    live: { ok: live.ok, httpStatus: live.httpStatus, latencyMs: live.latencyMs, error: live.error || null },
    full: { ok: full.ok, httpStatus: full.httpStatus, latencyMs: full.latencyMs, error: full.error || null },
    checks,
  };
}

function exitCodeFor(report, { strict = false } = {}) {
  switch (report.status) {
    case 'healthy':
      return 0;
    case 'degraded':
      return strict ? 1 : 0;
    case 'unreachable':
      return 2;
    default:
      // unhealthy, unknown, or anything unexpected
      return 1;
  }
}

function formatText(report, { verbose = false } = {}) {
  const lines = [];
  lines.push('SiraGPT health snapshot');
  lines.push(`Target: ${report.url}`);
  lines.push(`Status: ${report.status.toUpperCase()} (${report.durationMs}ms)`);
  lines.push(
    `Liveness: ${report.live.ok ? `up (${report.live.latencyMs}ms)` : `down (${report.live.error})`}`,
  );
  if (report.hint) lines.push(`Hint: ${report.hint}`);
  if (report.checks.length) {
    lines.push('Checks:');
    for (const c of report.checks) {
      const flag = c.critical ? 'critical' : 'optional';
      const latency = Number.isFinite(c.latency_ms) ? ` ${c.latency_ms}ms` : '';
      lines.push(`  - ${String(c.status).padEnd(9)} ${c.name} (${flag})${latency}`);
      if (verbose && c.details) {
        lines.push(`      ${JSON.stringify(c.details)}`);
      }
    }
  }
  return lines.join('\n');
}

function printHelp() {
  process.stdout.write(
    [
      'SiraGPT health snapshot',
      '',
      'Usage:',
      '  node backend/scripts/health-snapshot.js [--url <base>] [--json] [--strict]',
      '                                          [--timeout <ms>] [--verbose] [-h]',
      '',
      'Options:',
      '  --url <base>     Backend base URL (default http://127.0.0.1:5050)',
      '  --json           Print machine-readable JSON instead of text',
      '  --timeout <ms>   Per-probe timeout in milliseconds (default 10000)',
      '  --strict         Treat a degraded snapshot as a failure (exit 1)',
      '  --verbose        Include per-check details',
      '  --help, -h       Show this help',
      '',
      'Exit codes: 0 healthy/degraded, 1 unhealthy/unknown, 2 unreachable',
      '',
    ].join('\n'),
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
    return;
  }
  if (args.help) {
    printHelp();
    process.exit(0);
    return;
  }

  let report;
  try {
    report = await runHealthSnapshot({ baseUrl: args.baseUrl, timeoutMs: args.timeoutMs });
  } catch (err) {
    process.stderr.write(`health snapshot failed: ${err.message}\n`);
    process.exit(2);
    return;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatText(report, { verbose: args.verbose })}\n`);
  }
  process.exit(exitCodeFor(report, { strict: args.strict }));
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  runHealthSnapshot,
  exitCodeFor,
  formatText,
};
