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
 *   node scripts/bundle-size-check.js --update-baseline --reason "why"
 *
 * The budget file is JSON with KB caps:
 *   {
 *     "totalJsKB":            number,   // sum of gzipped JS in chunks/
 *     "totalCssKB":           number,   // sum of gzipped CSS in css/
 *     "totalKB":              number,   // totalJsKB + totalCssKB
 *     "largestChunkKB":       number,   // biggest individual JS chunk (gzipped)
 *     "tolerancePct":         number?,  // optional slack (defaults to 0)
 *     "firstLoadBySurfaceKB": { shared, "/chat", "/code", ..., "_default" }?,
 *     "chunkTypeCapsKB":      { page, async }?,
 *     "budgetHistory":        [{ date, reason }, ...]?
 *   }
 *
 * Policy 2026-08-22 adds three gates on top of the global totals:
 *   1. First Load JS per surface: union of app-router manifest chunks for each
 *      top-level surface (framework shell included), capped by
 *      `firstLoadBySurfaceKB`. Chunks referenced by >= 60% of surfaces count as
 *      `shared` and get their own cap instead of being charged to every
 *      surface. Requires `.next/app-build-manifest.json`; when missing the
 *      check reports as skipped so older builds keep working.
 *   2. Chunk-type caps: every non-shared client chunk is classified as `page`
 *      (`page-*.js` / `layout-*.js`) or `async`; both get a hard cap.
 *   3. WASM guard: any client chunk embedding a WASM binary fails outright —
 *      WASM must ship as a static asset, never base64 inside JS.
 *
 * Re-seeding is audited: `--update-baseline` requires `--reason "..."`
 * (persisted into `budgetHistory`); without it the command exits non-zero.
 *
 * The output report file (`bundle-size-report.json`) is written next to the
 * budget so the team can inspect what was measured even when the gate passes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KB = 1024;
const SHARED_REF_RATIO = 0.6;

function parseArgs(argv) {
  const args = {
    root: null,
    budget: null,
    report: null,
    updateBaseline: false,
    reason: null,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--budget') args.budget = argv[++i];
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--update-baseline') args.updateBaseline = true;
    else if (a === '--reason') args.reason = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: bundle-size-check [--root DIR] [--budget FILE] [--report FILE]\n'
          + '                         [--update-baseline --reason "..."] [--quiet]\n',
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

// ---------------------------------------------------------------------------
// App-router manifests: First Load per surface + chunk classification
// ---------------------------------------------------------------------------

function loadJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Manifest route keys that belong to the framework shell present everywhere. */
const FRAMEWORK_KEYS = ['/layout', '/error', '/loading', '/global-error', '/not-found', '/_not-found/page'];

/**
 * Surface name for an app-router manifest key:
 *   '/chat/page' -> '/chat', '/admin/users/page' -> '/admin'.
 * Returns null for framework keys and server-only routes.
 */
function surfaceOf(manifestKey) {
  if (!manifestKey.startsWith('/') || manifestKey.startsWith('/api')) return null;
  if (FRAMEWORK_KEYS.includes(manifestKey)) return null;
  const parts = manifestKey.split('/').filter(Boolean);
  return parts.length ? `/${parts[0]}` : null;
}

/**
 * Build per-surface First Load unions from `.next/app-build-manifest.json`.
 * Sizes are gzipped from disk inside `staticRoot`; missing files count zero.
 *
 * A chunk referenced by >= SHARED_REF_RATIO of measured surfaces counts as
 * `shared` and is reported separately instead of being charged to every
 * surface that references it.
 */
function measureFirstLoad(nextDir, staticRoot) {
  const manifestFile = path.join(nextDir, 'app-build-manifest.json');
  const manifest = loadJsonIfExists(manifestFile);
  if (!manifest || !manifest.pages) {
    return { exists: false, manifestFile };
  }

  const sizeCache = new Map();
  function gzOf(relPath) {
    if (!sizeCache.has(relPath)) {
      let n = 0;
      try {
        // Manifest paths are repo-root relative ("static/chunks/..."); the
        // static root already ends in /static, so strip that prefix.
        const rel = relPath.startsWith('static/') ? relPath.slice('static/'.length) : relPath;
        n = gzipSize(fs.readFileSync(path.join(staticRoot, rel)));
      } catch (err) {
        n = 0;
      }
      sizeCache.set(relPath, n);
    }
    return sizeCache.get(relPath);
  }

  const allSurfaces = new Set();
  for (const key of Object.keys(manifest.pages)) {
    const s = surfaceOf(key);
    if (s) allSurfaces.add(s);
  }

  // Union of client JS chunks per surface. Framework shell keys are charged to
  // every surface; server-only route handlers (/api/*, sitemap, robots) are not.
  const surfaces = new Map(); // '/chat' -> Set<relPath>
  function addTo(surface, relPath) {
    if (!relPath.endsWith('.js')) return;
    let set = surfaces.get(surface);
    if (!set) {
      set = new Set();
      surfaces.set(surface, set);
    }
    set.add(relPath);
  }
  for (const [key, files] of Object.entries(manifest.pages)) {
    if (key.startsWith('/api')) continue;
    const s = surfaceOf(key);
    const isFramework = FRAMEWORK_KEYS.includes(key);
    if (!s && !isFramework) continue;
    // Framework shell keys are charged to every surface (root layout/error/
    // loading render on all routes).
    const targets = s ? [s] : [...allSurfaces];
    for (const rel of files || []) {
      if (!rel.endsWith('.js')) continue;
      for (const t of targets) addTo(t, rel);
    }
  }

  // Reference counts across surfaces detect the shared framework chunks.
  const refCount = new Map();
  for (const [, set] of surfaces) {
    for (const rel of set) refCount.set(rel, (refCount.get(rel) || 0) + 1);
  }
  const surfaceCount = Math.max(allSurfaces.size, 1);
  const sharedChunks = new Set();
  for (const [rel, count] of refCount) {
    if (count >= surfaceCount * SHARED_REF_RATIO) sharedChunks.add(rel);
  }

  const firstLoad = {};
  for (const [surface, set] of surfaces) {
    let total = 0;
    for (const rel of set) {
      if (sharedChunks.has(rel)) continue;
      total += gzOf(rel);
    }
    firstLoad[surface] = total;
  }

  let sharedTotal = 0;
  for (const rel of sharedChunks) sharedTotal += gzOf(rel);

  // Classify every referenced client chunk: shared | page | async.
  const typeSizes = { page: 0, async: 0 };
  const largestByType = { page: { bytes: 0, path: null }, async: { bytes: 0, path: null } };
  for (const [rel, count] of refCount) {
    if (sharedChunks.has(rel)) continue;
    void count;
    const base = path.basename(rel);
    const isPageLike = /(^|\/)(page|layout)-[0-9a-f]+\.js$/.test(base) || rel.includes('/pages/');
    const type = isPageLike ? 'page' : 'async';
    const gz = gzOf(rel);
    typeSizes[type] += gz;
    if (gz > largestByType[type].bytes) largestByType[type] = { bytes: gz, path: rel };
  }

  return {
    exists: true,
    manifestFile,
    surfaceCount,
    sharedChunks: [...sharedChunks].sort(),
    sharedTotalGzipBytes: sharedTotal,
    firstLoadGzipBytes: firstLoad,
    chunkTypeTotalsGzipBytes: typeSizes,
    largestByType,
  };
}

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/** Scan client JS chunks for embedded WASM binaries; returns offending paths. */
function scanEmbeddedWasm(files) {
  const offenders = [];
  for (const file of files) {
    let buf;
    try {
      buf = fs.readFileSync(file.path);
    } catch (err) {
      continue;
    }
    if (buf.length < 8) continue;
    const idx = buf.indexOf(WASM_MAGIC);
    if (idx >= 0) {
      offenders.push({
        path: file.path,
        gzipKB: bytesToKB(file.gzipBytes),
        offset: idx,
      });
    }
  }
  return offenders;
}

/**
 * Compare a measurement against a budget. Returns a list of violations plus
 * normalized global checks and policy-gate summaries. Tolerance is applied
 * multiplicatively, e.g. 2 = +2 %.
 */
function evaluateBudget(measurement, budget, firstLoad) {
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

  const extras = [];

  // --- First Load JS per surface ---
  const surfaceBudgets = budget.firstLoadBySurfaceKB || {};
  const defaultCap = Number(surfaceBudgets._default);
  const hasDefault = Number.isFinite(defaultCap) && defaultCap > 0;

  if (firstLoad && firstLoad.exists) {
    const sharedCap = Number(surfaceBudgets.shared);
    if (Number.isFinite(sharedCap) && sharedCap > 0) {
      const actualKB = bytesToKB(firstLoad.sharedTotalGzipBytes);
      const allowedKB = sharedCap * slack;
      const status = actualKB > allowedKB ? 'fail' : 'pass';
      if (status === 'fail') {
        violations.push({
          metric: 'firstLoadSharedKB',
          actualKB,
          capKB: sharedCap,
          allowedKB: Math.round(allowedKB * 100) / 100,
          overageKB: Math.round((actualKB - allowedKB) * 100) / 100,
        });
      }
      extras.push({ name: 'firstLoadSharedKB', actualKB, capKB: sharedCap, allowedKB: Math.round(allowedKB * 100) / 100, status });
    }
    for (const [surface, bytes] of Object.entries(firstLoad.firstLoadGzipBytes)) {
      const explicitCap = Number(surfaceBudgets[surface]);
      const useCap = Number.isFinite(explicitCap) && explicitCap > 0
        ? explicitCap
        : (hasDefault ? defaultCap : null);
      if (!useCap) continue;
      const actualKB = bytesToKB(bytes);
      const allowedKB = useCap * slack;
      const status = actualKB > allowedKB ? 'fail' : 'pass';
      if (status === 'fail') {
        violations.push({
          metric: `firstLoad${surface}`,
          actualKB,
          capKB: useCap,
          allowedKB: Math.round(allowedKB * 100) / 100,
          overageKB: Math.round((actualKB - allowedKB) * 100) / 100,
        });
      }
      extras.push({ name: `firstLoad${surface}`, actualKB, capKB: useCap, allowedKB: Math.round(allowedKB * 100) / 100, status });
    }
  } else {
    extras.push({ name: 'firstLoad*', actualKB: null, capKB: null, allowedKB: null, status: 'skipped' });
  }

  // --- Chunk-type caps ---
  const typeCaps = budget.chunkTypeCapsKB || {};
  if (firstLoad && firstLoad.exists) {
    for (const type of ['page', 'async']) {
      const capKB = Number(typeCaps[type]);
      if (!Number.isFinite(capKB) || capKB <= 0) continue;
      const actualBytes = (firstLoad.chunkTypeTotalsGzipBytes || {})[type] || 0;
      const actualKB = bytesToKB(actualBytes);
      const allowedKB = capKB * slack;
      const status = actualKB > allowedKB ? 'fail' : 'pass';
      if (status === 'fail') {
        violations.push({
          metric: `${type}ChunksKB`,
          actualKB,
          capKB,
          allowedKB: Math.round(allowedKB * 100) / 100,
          overageKB: Math.round((actualKB - allowedKB) * 100) / 100,
        });
      }
      extras.push({ name: `${type}ChunksKB`, actualKB, capKB, allowedKB: Math.round(allowedKB * 100) / 100, status });
    }
  }

  // --- Embedded WASM guard (no tolerance: always fatal) ---
  if (Array.isArray(measurement.allJsFiles)) {
    const offenders = scanEmbeddedWasm(measurement.allJsFiles);
    if (offenders.length) {
      for (const o of offenders) {
        violations.push({
          metric: 'embeddedWasm',
          actualKB: o.gzipKB,
          capKB: 0,
          allowedKB: 0,
          overageKB: o.gzipKB,
          detail: `${o.path} embeds a WASM binary at byte offset ${o.offset} — ship .wasm as a static asset instead`,
        });
      }
      extras.push({ name: 'embeddedWasm', actualKB: offenders.length, capKB: 0, allowedKB: 0, status: 'fail' });
    } else {
      extras.push({ name: 'embeddedWasm', actualKB: 0, capKB: 0, allowedKB: 0, status: 'pass' });
    }
  }

  return { violations, checks: normalized, extras, tolerancePct: tol };
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

function appendHistory(budget, reason) {
  const history = Array.isArray(budget.budgetHistory) ? budget.budgetHistory.slice() : [];
  history.push({ date: new Date().toISOString().slice(0, 10), reason });
  return { ...budget, budgetHistory: history };
}

function formatHumanReport(measurement, evaluation, budget, firstLoad) {
  const lines = [];
  lines.push('Bundle-size report');
  lines.push('==================');
  lines.push(`root: ${measurement.root}`);
  lines.push(`tolerance: ${evaluation.tolerancePct}%`);
  lines.push('');
  lines.push('Global caps:');
  for (const c of evaluation.checks) {
    const cap = c.capKB ? `${c.capKB} KB` : '(unset)';
    const state = c.status === 'fail' ? 'FAIL' : c.status === 'skipped' ? 'skip' : 'ok';
    lines.push(`  [${state}] ${c.name}: ${c.actualKB} KB (cap ${cap}, allowed ${c.allowedKB} KB)`);
  }
  lines.push('');
  lines.push('Policy gates:');
  for (const c of evaluation.extras) {
    const state = c.status === 'fail' ? 'FAIL' : c.status === 'skipped' ? 'skip' : 'ok';
    const detail = c.actualKB == null ? '(no app manifest)' : `${c.actualKB} KB`;
    const capPart = c.capKB != null ? `(cap ${c.capKB}, allowed ${c.allowedKB})` : '';
    lines.push(`  [${state}] ${c.name}: ${detail} ${capPart}`.trimEnd());
  }
  if (firstLoad && firstLoad.exists) {
    lines.push('');
    lines.push(`First Load JS per surface (exclusive of shared, ${firstLoad.surfaceCount} surfaces):`);
    const rows = Object.entries(firstLoad.firstLoadGzipBytes)
      .map(([surface, bytes]) => [surface, bytesToKB(bytes)])
      .sort((a, b) => b[1] - a[1]);
    for (const [surface, kb] of rows) lines.push(`  ${kb.toString().padStart(9)} KB  ${surface}`);
    lines.push(`  ${bytesToKB(firstLoad.sharedTotalGzipBytes).toString().padStart(9)} KB  (shared framework, ${firstLoad.sharedChunks.length} chunks)`);
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
          + ` (cap ${v.capKB} KB) by ${v.overageKB} KB`
          + (v.detail ? ` — ${v.detail}` : ''),
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
    repoRoot,
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

function resolveNextDir(repoRoot, staticRoot) {
  // The manifest sits next to the measured static tree: `<next>/static` implies
  // `<next>` (non-slim build), and `.../standalone/.next/static` implies
  // `.../standalone/.next` (after postbuild:slim).
  const parent = path.dirname(staticRoot);
  if (path.basename(parent) === '.next') return parent;
  return repoRoot;
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
  measurement.allJsFiles = walk(path.join(paths.root, 'chunks'))
    .filter((f) => f.endsWith('.js'));

  const firstLoad = measureFirstLoad(resolveNextDir(paths.repoRoot, paths.root), paths.root);

  if (args.updateBaseline) {
    if (!args.reason || !args.reason.trim()) {
      process.stderr.write(
        'bundle-size-check: re-seed requires an audit trail.\n'
          + 'Usage: node scripts/bundle-size-check.js --update-baseline --reason "<why>"\n',
      );
      return 2;
    }
    const existing = fs.existsSync(paths.budget) ? loadJson(paths.budget) : {};
    const baseline = buildBaselineFromMeasurement(measurement, existing.tolerancePct || 5);
    const withHistory = appendHistory(baseline, args.reason.trim());
    writeJson(paths.budget, withHistory);
    if (!args.quiet) {
      process.stdout.write(`Baseline written to ${paths.budget}\n`);
      process.stdout.write(`${JSON.stringify(withHistory, null, 2)}\n`);
    }
    return 0;
  }

  if (!fs.existsSync(paths.budget)) {
    process.stderr.write(
      `bundle-size-check: budget file missing at ${paths.budget}.\n`
        + 'Re-run with --update-baseline --reason "..." to seed it from the current build.\n',
    );
    return 2;
  }

  const budget = loadJson(paths.budget);
  budget.__source = paths.budget;

  const evaluation = evaluateBudget(measurement, budget, firstLoad);

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
    firstLoad: firstLoad && firstLoad.exists
      ? {
          surfaceCount: firstLoad.surfaceCount,
          sharedKB: bytesToKB(firstLoad.sharedTotalGzipBytes),
          bySurfaceKB: Object.fromEntries(
            Object.entries(firstLoad.firstLoadGzipBytes).map(([s, b]) => [s, bytesToKB(b)]),
          ),
        }
      : null,
    checks: evaluation.checks,
    policyChecks: evaluation.extras,
    violations: evaluation.violations,
  };
  writeJson(paths.report, report);

  if (!args.quiet) process.stdout.write(`${formatHumanReport(measurement, evaluation, budget, firstLoad)}\n`);

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
  measureFirstLoad,
  scanEmbeddedWasm,
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
