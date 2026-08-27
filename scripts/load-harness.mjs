#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// siraGPT — Load harness (QA Cargas Estrés)
// ──────────────────────────────────────────────────────────────
// Zero-dependency load/stress harness for the single-VPS production
// topology. Measures what the VPS can actually take: concurrency
// ramps, p50/p95/p99 latency, error rate, and RPS — with hard SLO
// gates suitable for CI.
//
// Design constraints:
//   - No new npm dependencies (Node built-in fetch/AbortController).
//   - Read-only by default: hits only GET endpoints unless --post is
//     given an explicit JSON body; never touches auth or writes.
//   - Fail-safe ramp: each stage completes before the next starts,
//     and a failing stage stops the run (no pile-on against a
//     struggling target).
//
// Usage:
//   node scripts/load-harness.mjs --url https://siragpt.com/api/version \
//     --stages 10,50,100 --duration 10
//
// Modes:
//   default      — fixed VU count per stage (--concurrency or --stages)
//   --ramp       — linear ramp 1..max over total duration
//   --open       — open-loop: fire at a fixed requests/second rate
//
// Exit codes: 0 = all SLO gates pass; 1 = gate violation or run error.
// ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function parseArgs() {
  const opts = {
    url: '',
    method: 'GET',
    body: null,
    contentType: 'application/json',
    header: [],
    concurrency: 10,
    stages: null,
    duration: 10,
    ramp: false,
    open: false,
    rps: 20,
    timeoutMs: 10000,
    sloP95: 2000,
    sloErrorRate: 0.01,
    sloRps: 0,
    warmup: 2,
    quiet: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--url': opts.url = next(); break;
      case '--method': opts.method = String(next()).toUpperCase(); break;
      case '--body': opts.body = next(); break;
      case '--content-type': opts.contentType = next(); break;
      case '--header': opts.header.push(next()); break;
      case '-H': opts.header.push(next()); break;
      case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
      case '--stages': opts.stages = next().split(',').map((n) => parseInt(n.trim(), 10)).filter(Number.isFinite); break;
      case '--duration': opts.duration = parseFloat(next()); break;
      case '--ramp': opts.ramp = true; break;
      case '--open': opts.open = true; break;
      case '--rps': opts.rps = parseFloat(next()); break;
      case '--timeout-ms': opts.timeoutMs = parseInt(next(), 10); break;
      case '--slo-p95': opts.sloP95 = parseInt(next(), 10); break;
      case '--slo-error-rate': opts.sloErrorRate = parseFloat(next()); break;
      case '--slo-rps': opts.sloRps = parseFloat(next()); break;
      case '--warmup': opts.warmup = parseInt(next(), 10); break;
      case '--quiet': opts.quiet = true; break;
      case '--json': opts.json = true; break;
      default:
        console.error(`[load-harness] Unknown option: ${a}`);
        process.exit(2);
    }
  }
  if (!opts.url) {
    console.error('[load-harness] --url is required');
    process.exit(2);
  }
  if (!(opts.duration > 0)) opts.duration = 10;
  return opts;
}

const opts = parseArgs();

function buildRequestInit() {
  const headers = {};
  for (const h of opts.header) {
    const idx = h.indexOf(':');
    if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  const init = { method: opts.method, headers, signal: undefined };
  if (opts.body != null && opts.method !== 'GET' && opts.method !== 'HEAD') {
    headers['content-type'] = opts.contentType;
    init.body = opts.body;
  }
  return init;
}

const REQUEST_INIT = buildRequestInit();

class Latencies {
  constructor() { this.samples = []; }
  add(ms) { this.samples.push(ms); }
  percentile(p) {
    if (this.samples.length === 0) return 0;
    const sorted = this.samples.slice().sort((a, b) => a - b);
    // Nearest-rank on the upper side so p100 == max and p50 is stable at small n.
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
  }
  get count() { return this.samples.length; }
}

function fmtMs(ms) { return `${ms.toFixed(0)}ms`; }

async function fireOnce(signal) {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout>${opts.timeoutMs}ms`)), opts.timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(new Error('run-aborted')), { once: true });
    let res;
    try {
      res = await fetch(opts.url, { ...REQUEST_INIT, signal: controller.signal });
      await res.arrayBuffer(); // drain body so sockets free for reuse
    } finally {
      clearTimeout(timer);
    }
    const latency = performance.now() - start;
    const ok = res.status >= 200 && res.status < 400;
    return { ok, status: res.status, latency, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const latency = performance.now() - start;
    return { ok: false, status: 0, latency, error: err && err.message ? err.message : 'network error' };
  }
}

// ── Closed-loop stage: N virtual users issuing back-to-back requests ──
async function runStage(vus, durationSec, globalSignal) {
  const latencies = new Latencies();
  let okCount = 0;
  let failCount = 0;
  const statusCounts = new Map();
  const errors = new Map();

  const deadline = performance.now() + durationSec * 1000;
  const workers = Array.from({ length: Math.max(1, vus) }, async () => {
    while (!globalSignal.aborted && performance.now() < deadline) {
      const result = await fireOnce(globalSignal);
      latencies.add(result.latency);
      if (result.ok) okCount++;
      else {
        failCount++;
        const key = result.error || 'unknown';
        errors.set(key, (errors.get(key) || 0) + 1);
      }
      statusCounts.set(result.status, (statusCounts.get(result.status) || 0) + 1);
    }
  });
  await Promise.all(workers);

  const total = okCount + failCount;
  const elapsed = durationSec;
  const errorRate = total === 0 ? 1 : failCount / total;
  return {
    vus,
    total,
    rps: +(total / elapsed).toFixed(2),
    errorRate,
    p50: latencies.percentile(50),
    p95: latencies.percentile(95),
    p99: latencies.percentile(99),
    max: latencies.percentile(100),
    statusCounts: Object.fromEntries(statusCounts),
    topErrors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

// ── Open-loop implemented with a simple interval scheduler + in-flight tracking.
async function runOpenStageReal(targetRps, durationSec, globalSignal) {
  const latencies = new Latencies();
  let started = 0;
  let done = 0;
  let okCount = 0;
  let failCount = 0;
  const errors = new Map();
  const interval = 1000 / targetRps;
  const deadline = performance.now() + durationSec * 1000;

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (globalSignal.aborted || performance.now() >= deadline) {
        clearInterval(timer);
        resolve();
        return;
      }
      started++;
      fireOnce(globalSignal).then((result) => {
        done++;
        latencies.add(result.latency);
        if (result.ok) okCount++; else {
          failCount++;
          const key = result.error || 'unknown';
          errors.set(key, (errors.get(key) || 0) + 1);
        }
      }).catch(() => {});
    }, interval);
  });
  // Grace period for stragglers (bounded by per-request timeout).
  const graceDeadline = performance.now() + opts.timeoutMs + 500;
  while (done < started && performance.now() < graceDeadline && !globalSignal.aborted) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const total = okCount + failCount;
  const errorRate = total === 0 ? 1 : failCount / total;
  return {
    vus: `open@${targetRps}rps`,
    total,
    rps: +(total / durationSec).toFixed(2),
    errorRate,
    p50: latencies.percentile(50),
    p95: latencies.percentile(95),
    p99: latencies.percentile(99),
    max: latencies.percentile(100),
    statusCounts: {},
    topErrors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

async function warmup(seconds, globalSignal) {
  if (seconds <= 0) return;
  if (!opts.quiet) console.log(`[load-harness] warmup ${seconds}s → ${opts.url}`);
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline && !globalSignal.aborted) {
    await fireOnce(globalSignal);
  }
}

function printStage(stage, idx, totalStages) {
  const statuses = Object.entries(stage.statusCounts)
    .map(([code, n]) => `${code}×${n}`)
    .join(' ');
  console.log(
    `[stage ${idx + 1}/${totalStages}] vus=${stage.vus} reqs=${stage.total} rps=${stage.rps} `
    + `p50=${fmtMs(stage.p50)} p95=${fmtMs(stage.p95)} p99=${fmtMs(stage.p99)} max=${fmtMs(stage.max)} `
    + `errors=${(stage.errorRate * 100).toFixed(2)}%${statuses ? ` [${statuses}]` : ''}`
    + (stage.topErrors.length ? ` worst=${stage.topErrors.map(([e, n]) => `${e}×${n}`).join(', ')}` : ''),
  );
}

function checkSlo(stage, label) {
  const failures = [];
  if (stage.errorRate > opts.sloErrorRate) {
    failures.push(`error rate ${(stage.errorRate * 100).toFixed(2)}% > ${(opts.sloErrorRate * 100).toFixed(2)}%`);
  }
  if (opts.sloP95 > 0 && stage.p95 > opts.sloP95) {
    failures.push(`p95 ${stage.p95.toFixed(0)}ms > ${opts.sloP95}ms`);
  }
  if (opts.sloRps > 0 && stage.rps < opts.sloRps) {
    failures.push(`throughput ${stage.rps}rps < ${opts.sloRps}rps`);
  }
  if (failures.length > 0) {
    console.error(`[load-harness] SLO GATE FAILED at ${label}: ${failures.join('; ')}`);
    return false;
  }
  return true;
}

async function main() {
  const globalSignal = new AbortController().signal;

  process.on('SIGINT', () => {
    console.error('\n[load-harness] interrupted');
    process.exit(130);
  });

  if (!opts.quiet) {
    console.log(`[load-harness] target=${opts.url} method=${opts.method} mode=${opts.open ? 'open' : opts.ramp ? 'ramp' : 'stages'}`);
  }

  await warmup(opts.warmup, globalSignal);

  const results = [];
  let allPassed = true;

  if (opts.open) {
    const stage = await runOpenStageReal(opts.rps, opts.duration, globalSignal);
    printStage(stage, 0, 1);
    results.push(stage);
    allPassed = checkSlo(stage, `open ${opts.rps}rps`);
  } else if (opts.ramp) {
    // Linear ramp: sample increasing VU levels across the total duration.
    const levels = [];
    const steps = Math.max(4, Math.min(10, opts.concurrency));
    for (let i = 1; i <= steps; i++) levels.push(Math.max(1, Math.round((i / steps) * opts.concurrency)));
    const perStage = opts.duration / steps;
    for (let i = 0; i < levels.length; i++) {
      const stage = await runStage(levels[i], perStage, globalSignal);
      printStage(stage, i, levels.length);
      results.push(stage);
      if (!checkSlo(stage, `ramp level ${levels[i]} vus`)) {
        allPassed = false;
        break; // stop the ramp at first failing level — do not pile on
      }
    }
  } else {
    const stages = opts.stages && opts.stages.length > 0 ? opts.stages : [opts.concurrency];
    for (let i = 0; i < stages.length; i++) {
      const stage = await runStage(stages[i], opts.duration, globalSignal);
      printStage(stage, i, stages.length);
      results.push(stage);
      if (!checkSlo(stage, `stage ${stages[i]} vus`)) {
        allPassed = false;
        break;
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ url: opts.url, passed: allPassed, slo: { p95: opts.sloP95, errorRate: opts.sloErrorRate, minRps: opts.sloRps }, results }, null, 2));
  }

  if (!allPassed) process.exit(1);
  if (!opts.quiet) console.log('[load-harness] PASS — all stages within SLO');
}

main().catch((err) => {
  console.error(`[load-harness] fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
