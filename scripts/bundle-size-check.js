#!/usr/bin/env node
/**
 * Bundle-size budget gate.
 *
 * Scans a Next.js production build (`.next/static`, or the standalone copy
 * after `postbuild:slim`) and compares the total/gzipped sizes against a
 * budget file. Exits non-zero on overage so it can be wired as a CI gate after
 * `next build`.
 *
 * Usage:
 *   node scripts/bundle-size-check.js
 *   node scripts/bundle-size-check.js --root .next/static --budget scripts/bundle-size-budget.json
 *   node scripts/bundle-size-check.js --update-baseline
 *
 * The budget file is JSON with KB caps:
 *   {
 *     "totalJsKB":      number,   // sum of gzipped JS in chunks/
 *     "totalCssKB":     number,   // sum of gzipped CSS in css/
 *     "totalKB":        number,   // totalJsKB + totalCssKB
 *     "largestChunkKB": number,   // biggest individual JS chunk (gzipped)
 *     "tolerancePct":   number?   // optional slack (defaults to 0)
 *   }
 *
 * The output report file (`bundle-size-report.json`) is written next to the
 * budget so the team can inspect what was measured even when the gate passes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KB = 1024;

function parseArgs(argv) {
  const args = {
    root: null,
    budget: null,
    report: null,
    updateBaseline: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--budget') args.budget = argv[++i];
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--update-baseline') args.updateBaseline = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: bundle-size-check [--root DIR] [--budget FILE] [--report FILE]\n'
          + '                         [--update-baseline] [--quiet]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function gzipSize(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length;
}

function fileEntry(absPath, rootDir) {
  const buf = fs.readFileSync(absPath);
  return {
    path: path.relative(rootDir, absPath).split(path.sep).join('/'),
    bytes: buf.length,
    gzipBytes: gzipSize(buf),
  };
}

/**
 * Measure a Next.js build output directory (`<repoRoot>/.next/static`).
 * Returns aggregate sizes plus the per-chunk breakdown so callers can render
 * a report or apply a budget.
 */
function measureBundle(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return { exists: false, root: rootDir };
  }
  const chunksDir = path.join(rootDir, 'chunks');
  const cssDir = path.join(rootDir, 'css');

  const jsFiles = walk(chunksDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fileEntry(f, rootDir));
  const cssFiles = walk(cssDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => fileEntry(f, rootDir));

  const sumGz = (files) => files.reduce((acc, f) => acc + f.gzipBytes, 0);
  const sumRaw = (files) => files.reduce((acc, f) => acc + f.bytes, 0);

  const totalJsGz = sumGz(jsFiles);
  const totalCssGz = sumGz(cssFiles);
  const largestChunk = jsFiles.reduce(
    (max, f) => (f.gzipBytes > max ? f.gzipBytes : max),
    0,
  );

  const top = [...jsFiles]
    .sort((a, b) => b.gzipBytes - a.gzipBytes)
    .slice(0, 10);

  return {
    exists: true,
    root: rootDir,
    totals: {
      jsBytes: sumRaw(jsFiles),
      jsGzipBytes: totalJsGz,
      cssBytes: sumRaw(cssFiles),
      cssGzipBytes: totalCssGz,
      totalGzipBytes: totalJsGz + totalCssGz,
      largestChunkGzipBytes: largestChunk,
      jsFileCount: jsFiles.length,
      cssFileCount: cssFiles.length,
    },
    top10Chunks: top,
  };
}

function bytesToKB(b) {
  return Math.round((b / KB) * 100) / 100;
}

/**
 * Compare a measurement against a budget. Returns a list of violations and
 * a normalized summary. Tolerance is applied multiplicatively, e.g. 0.05 = +5 %.
 */
function evaluateBudget(measurement, budget) {
  const tol = Number(budget.tolerancePct) > 0 ? Number(budget.tolerancePct) : 0;
  const slack = 1 + tol / 100;

  const checks = [
    {
      name: 'totalJsKB',
      actualBytes: measurement.totals.jsGzipBytes,
      capKB: budget.totalJsKB,
    },
    {
      name: 'totalCssKB',
      actualBytes: measurement.totals.cssGzipBytes,
      capKB: budget.totalCssKB,
    },
    {
      name: 'totalKB',
      actualBytes: measurement.totals.totalGzipBytes,
      capKB: budget.totalKB,
    },
    {
      name: 'largestChunkKB',
      actualBytes: measurement.totals.largestChunkGzipBytes,
      capKB: budget.largestChunkKB,
    },
  ];

  const violations = [];
  const normalized = checks.map((c) => {
    const actualKB = bytesToKB(c.actualBytes);
    const cap = Number(c.capKB);
    if (!Number.isFinite(cap) || cap <= 0) {
      return { ...c, actualKB, status: 'skipped' };
    }
    const allowedKB = cap * slack;
    const exceeded = actualKB > allowedKB;
    if (exceeded) {
      violations.push({
        metric: c.name,
        actualKB,
        capKB: cap,
        allowedKB: Math.round(allowedKB * 100) / 100,
        overageKB: Math.round((actualKB - allowedKB) * 100) / 100,
      });
    }
    return {
      name: c.name,
      actualKB,
      capKB: cap,
      allowedKB: Math.round(allowedKB * 100) / 100,
      status: exceeded ? 'fail' : 'pass',
    };
  });

  return { violations, checks: normalized, tolerancePct: tol };
}

function loadJson(file) {
  const txt = fs.readFileSync(file, 'utf8');
  return JSON.parse(txt);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildBaselineFromMeasurement(measurement, tolerancePct = 10) {
  const t = measurement.totals;
  const round = (b) => Math.ceil(b / KB);
  return {
    totalJsKB: round(t.jsGzipBytes),
    totalCssKB: round(t.cssGzipBytes),
    totalKB: round(t.totalGzipBytes),
    largestChunkKB: round(t.largestChunkGzipBytes),
    tolerancePct,
  };
}

function formatHumanReport(measurement, evaluation, budget) {
  const lines = [];
  lines.push('Bundle-size report');
  lines.push('==================');
  lines.push(`root: ${measurement.root}`);
  lines.push(`tolerance: ${evaluation.tolerancePct}%`);
  lines.push('');
  for (const c of evaluation.checks) {
    const cap = c.capKB ? `${c.capKB} KB` : '(unset)';
    const state = c.status === 'fail' ? 'FAIL' : c.status === 'skipped' ? 'skip' : 'ok';
    lines.push(`  [${state}] ${c.name}: ${c.actualKB} KB (cap ${cap}, allowed ${c.allowedKB} KB)`);
  }
  lines.push('');
  lines.push('Top JS chunks (gzipped):');
  for (const f of measurement.top10Chunks) {
    lines.push(`  ${bytesToKB(f.gzipBytes).toString().padStart(8)} KB  ${f.path}`);
  }
  if (evaluation.violations.length) {
    lines.push('');
    lines.push('VIOLATIONS:');
    for (const v of evaluation.violations) {
      lines.push(
        `  - ${v.metric}: ${v.actualKB} KB exceeds allowed ${v.allowedKB} KB`
          + ` (cap ${v.capKB} KB) by ${v.overageKB} KB`,
      );
    }
  }
  // Reference budget file path so consumers know where to tweak limits.
  if (budget && budget.__source) lines.push(`\nbudget: ${budget.__source}`);
  return lines.join('\n');
}

function resolveBundleRoot(args, repoRoot = path.resolve(__dirname, '..')) {
  if (args.root) return path.resolve(args.root);
  const primary = path.join(repoRoot, '.next', 'static');
  if (fs.existsSync(primary)) return primary;
  return path.join(repoRoot, '.next', 'standalone', '.next', 'static');
}

function resolveDefaults(args) {
  const repoRoot = path.resolve(__dirname, '..');
  return {
    root: resolveBundleRoot(args, repoRoot),
    budget:
      args.budget
        ? path.resolve(args.budget)
        : path.join(repoRoot, 'scripts', 'bundle-size-budget.json'),
    report:
      args.report
        ? path.resolve(args.report)
        : path.join(repoRoot, 'bundle-size-report.json'),
  };
}

async function run(argv = process.argv) {
  const args = parseArgs(argv);
  const paths = resolveDefaults(args);

  const measurement = measureBundle(paths.root);
  if (!measurement.exists) {
    process.stderr.write(
      `bundle-size-check: build directory not found at ${paths.root}.\n`
        + 'Run `npm run build` before invoking this gate.\n',
    );
    return 2;
  }

  if (args.updateBaseline) {
    const baseline = buildBaselineFromMeasurement(measurement);
    writeJson(paths.budget, baseline);
    if (!args.quiet) {
      process.stdout.write(`Baseline written to ${paths.budget}\n`);
      process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
    }
    return 0;
  }

  if (!fs.existsSync(paths.budget)) {
    process.stderr.write(
      `bundle-size-check: budget file missing at ${paths.budget}.\n`
        + 'Re-run with --update-baseline to seed it from the current build.\n',
    );
    return 2;
  }

  const budget = loadJson(paths.budget);
  budget.__source = paths.budget;

  const evaluation = evaluateBudget(measurement, budget);

  const report = {
    generatedAt: new Date().toISOString(),
    root: paths.root,
    budget: { ...budget, __source: undefined },
    measurement: {
      totals: {
        jsKB: bytesToKB(measurement.totals.jsGzipBytes),
        cssKB: bytesToKB(measurement.totals.cssGzipBytes),
        totalKB: bytesToKB(measurement.totals.totalGzipBytes),
        largestChunkKB: bytesToKB(measurement.totals.largestChunkGzipBytes),
        jsFileCount: measurement.totals.jsFileCount,
        cssFileCount: measurement.totals.cssFileCount,
      },
      top10Chunks: measurement.top10Chunks.map((f) => ({
        path: f.path,
        gzipKB: bytesToKB(f.gzipBytes),
        rawKB: bytesToKB(f.bytes),
      })),
    },
    checks: evaluation.checks,
    violations: evaluation.violations,
  };
  writeJson(paths.report, report);

  if (!args.quiet) process.stdout.write(`${formatHumanReport(measurement, evaluation, budget)}\n`);

  if (evaluation.violations.length) {
    process.stderr.write(
      `\n::error::Bundle size budget exceeded — ${evaluation.violations.length} metric(s) over cap.\n`,
    );
    return 1;
  }
  return 0;
}

module.exports = {
  measureBundle,
  evaluateBudget,
  buildBaselineFromMeasurement,
  parseArgs,
  resolveBundleRoot,
  bytesToKB,
  run,
};

if (require.main === module) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`bundle-size-check: ${err.stack || err.message || err}\n`);
      process.exit(2);
    },
  );
}
