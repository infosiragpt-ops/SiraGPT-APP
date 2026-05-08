'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const {
  measureBundle,
  evaluateBudget,
  buildBaselineFromMeasurement,
  parseArgs,
  bytesToKB,
  run,
} = require('../../scripts/bundle-size-check.js');

function makeStaticTree({ jsFiles = [], cssFiles = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-'));
  const chunksDir = path.join(root, 'chunks');
  const cssDir = path.join(root, 'css');
  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(cssDir, { recursive: true });
  for (const f of jsFiles) fs.writeFileSync(path.join(chunksDir, f.name), f.content);
  for (const f of cssFiles) fs.writeFileSync(path.join(cssDir, f.name), f.content);
  return root;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

test('measureBundle returns exists:false when path is missing', () => {
  const m = measureBundle(path.join(os.tmpdir(), 'does-not-exist-bundle-xyz'));
  assert.equal(m.exists, false);
});

test('measureBundle aggregates JS and CSS gzipped sizes', () => {
  // Highly repetitive content compresses well — we can verify gzipBytes < bytes.
  const big = 'a'.repeat(50_000);
  const small = 'b'.repeat(1_000);
  const root = makeStaticTree({
    jsFiles: [
      { name: 'a.js', content: big },
      { name: 'b.js', content: small },
    ],
    cssFiles: [{ name: 'styles.css', content: big }],
  });
  try {
    const m = measureBundle(root);
    assert.equal(m.exists, true);
    assert.equal(m.totals.jsFileCount, 2);
    assert.equal(m.totals.cssFileCount, 1);
    assert.ok(m.totals.jsGzipBytes < m.totals.jsBytes, 'js compresses');
    assert.ok(m.totals.cssGzipBytes < m.totals.cssBytes, 'css compresses');
    assert.equal(
      m.totals.totalGzipBytes,
      m.totals.jsGzipBytes + m.totals.cssGzipBytes,
    );
    // largestChunk corresponds to a.js (the bigger of the two).
    const aGz = zlib.gzipSync(Buffer.from(big), { level: 9 }).length;
    assert.equal(m.totals.largestChunkGzipBytes, aGz);
    assert.ok(Array.isArray(m.top10Chunks));
    assert.equal(m.top10Chunks[0].path, 'chunks/a.js');
  } finally {
    rmrf(root);
  }
});

test('measureBundle ignores non-JS files in chunks/ and walks subdirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-'));
  const sub = path.join(root, 'chunks', 'pages');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'index.js'), 'console.log(1)');
  fs.writeFileSync(path.join(sub, 'README.md'), 'should be ignored');
  fs.mkdirSync(path.join(root, 'css'), { recursive: true });
  try {
    const m = measureBundle(root);
    assert.equal(m.totals.jsFileCount, 1);
    assert.equal(m.top10Chunks[0].path, 'chunks/pages/index.js');
  } finally {
    rmrf(root);
  }
});

test('evaluateBudget passes when totals fit under caps', () => {
  const measurement = {
    totals: {
      jsBytes: 0,
      jsGzipBytes: 100 * 1024,
      cssBytes: 0,
      cssGzipBytes: 20 * 1024,
      totalGzipBytes: 120 * 1024,
      largestChunkGzipBytes: 80 * 1024,
      jsFileCount: 0,
      cssFileCount: 0,
    },
  };
  const out = evaluateBudget(measurement, {
    totalJsKB: 200,
    totalCssKB: 100,
    totalKB: 300,
    largestChunkKB: 150,
  });
  assert.equal(out.violations.length, 0);
  assert.ok(out.checks.every((c) => c.status === 'pass'));
});

test('evaluateBudget reports violations and respects tolerancePct', () => {
  const measurement = {
    totals: {
      jsBytes: 0,
      jsGzipBytes: 105 * 1024,
      cssBytes: 0,
      cssGzipBytes: 50 * 1024,
      totalGzipBytes: 155 * 1024,
      largestChunkGzipBytes: 90 * 1024,
      jsFileCount: 0,
      cssFileCount: 0,
    },
  };
  // Without tolerance we exceed totalJsKB (105 > 100) and totalKB.
  const strict = evaluateBudget(measurement, {
    totalJsKB: 100,
    totalCssKB: 100,
    totalKB: 150,
    largestChunkKB: 200,
  });
  const strictMetrics = strict.violations.map((v) => v.metric).sort();
  assert.deepEqual(strictMetrics, ['totalJsKB', 'totalKB']);

  // 10% tolerance brings 105 KB under 100*1.10 = 110 KB ⇒ no violation.
  const loose = evaluateBudget(measurement, {
    totalJsKB: 100,
    totalCssKB: 100,
    totalKB: 150,
    largestChunkKB: 200,
    tolerancePct: 10,
  });
  // totalKB still exceeds (155 > 150*1.10=165? no: 165 ⇒ 155 < 165 passes).
  assert.equal(loose.violations.length, 0);
});

test('evaluateBudget skips checks when cap is missing or zero', () => {
  const out = evaluateBudget(
    {
      totals: {
        jsGzipBytes: 1024,
        cssGzipBytes: 1024,
        totalGzipBytes: 2048,
        largestChunkGzipBytes: 1024,
        jsBytes: 0,
        cssBytes: 0,
        jsFileCount: 0,
        cssFileCount: 0,
      },
    },
    { totalJsKB: 0, totalCssKB: null, totalKB: undefined, largestChunkKB: 5 },
  );
  const skipped = out.checks.filter((c) => c.status === 'skipped').map((c) => c.name).sort();
  assert.deepEqual(skipped, ['totalCssKB', 'totalJsKB', 'totalKB']);
  assert.equal(out.violations.length, 0);
});

test('buildBaselineFromMeasurement rounds bytes up to next KB', () => {
  const m = {
    totals: {
      jsGzipBytes: 1024 * 10 + 1,
      cssGzipBytes: 1024 * 2,
      totalGzipBytes: 1024 * 12 + 1,
      largestChunkGzipBytes: 1024 * 5,
    },
  };
  const baseline = buildBaselineFromMeasurement(m, 7);
  assert.equal(baseline.totalJsKB, 11);
  assert.equal(baseline.totalCssKB, 2);
  assert.equal(baseline.totalKB, 13);
  assert.equal(baseline.largestChunkKB, 5);
  assert.equal(baseline.tolerancePct, 7);
});

test('parseArgs honors --root, --budget, --report, --update-baseline, --quiet', () => {
  const args = parseArgs([
    'node',
    'bundle-size-check.js',
    '--root',
    '/tmp/x',
    '--budget',
    '/tmp/b.json',
    '--report',
    '/tmp/r.json',
    '--update-baseline',
    '--quiet',
  ]);
  assert.equal(args.root, '/tmp/x');
  assert.equal(args.budget, '/tmp/b.json');
  assert.equal(args.report, '/tmp/r.json');
  assert.equal(args.updateBaseline, true);
  assert.equal(args.quiet, true);
});

test('parseArgs throws on unknown flags', () => {
  assert.throws(() => parseArgs(['node', 's.js', '--bogus']), /Unknown argument/);
});

test('bytesToKB rounds to two decimals', () => {
  assert.equal(bytesToKB(0), 0);
  assert.equal(bytesToKB(1024), 1);
  assert.equal(bytesToKB(1536), 1.5);
});

test('run exits 2 when build dir missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-run-'));
  const missing = path.join(tmp, 'static-not-here');
  const code = await run([
    'node',
    'bundle-size-check.js',
    '--root',
    missing,
    '--budget',
    path.join(tmp, 'budget.json'),
    '--report',
    path.join(tmp, 'report.json'),
    '--quiet',
  ]);
  assert.equal(code, 2);
  rmrf(tmp);
});

test('run with --update-baseline writes a fresh budget file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-run-'));
  const root = makeStaticTree({
    jsFiles: [{ name: 'app.js', content: 'x'.repeat(2048) }],
    cssFiles: [{ name: 'main.css', content: 'y'.repeat(512) }],
  });
  const budget = path.join(tmp, 'budget.json');
  try {
    const code = await run([
      'node',
      'bundle-size-check.js',
      '--root',
      root,
      '--budget',
      budget,
      '--report',
      path.join(tmp, 'report.json'),
      '--update-baseline',
      '--quiet',
    ]);
    assert.equal(code, 0);
    const written = JSON.parse(fs.readFileSync(budget, 'utf8'));
    assert.ok(written.totalJsKB >= 1);
    assert.ok(written.totalKB >= written.totalJsKB);
    assert.equal(typeof written.tolerancePct, 'number');
  } finally {
    rmrf(root);
    rmrf(tmp);
  }
});

test('run exits 0 when measurement is under budget and writes a report', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-run-'));
  const root = makeStaticTree({
    jsFiles: [{ name: 'app.js', content: 'x'.repeat(4096) }],
    cssFiles: [{ name: 'main.css', content: 'y'.repeat(2048) }],
  });
  const budget = path.join(tmp, 'budget.json');
  const report = path.join(tmp, 'report.json');
  fs.writeFileSync(
    budget,
    JSON.stringify({
      totalJsKB: 500,
      totalCssKB: 500,
      totalKB: 500,
      largestChunkKB: 500,
      tolerancePct: 0,
    }),
  );
  try {
    const code = await run([
      'node',
      'bundle-size-check.js',
      '--root',
      root,
      '--budget',
      budget,
      '--report',
      report,
      '--quiet',
    ]);
    assert.equal(code, 0);
    const r = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.ok(r.measurement.totals.totalKB > 0);
    assert.equal(r.violations.length, 0);
    assert.ok(Array.isArray(r.checks));
  } finally {
    rmrf(root);
    rmrf(tmp);
  }
});

test('run exits 1 and records violations when caps are exceeded', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-run-'));
  // Random bytes don't compress, ensuring we blow past tiny caps.
  const buf = require('node:crypto').randomBytes(40_000);
  const root = makeStaticTree({
    jsFiles: [{ name: 'huge.js', content: buf }],
    cssFiles: [],
  });
  const budget = path.join(tmp, 'budget.json');
  const report = path.join(tmp, 'report.json');
  fs.writeFileSync(
    budget,
    JSON.stringify({
      totalJsKB: 1,
      totalCssKB: 1,
      totalKB: 1,
      largestChunkKB: 1,
      tolerancePct: 0,
    }),
  );
  try {
    const code = await run([
      'node',
      'bundle-size-check.js',
      '--root',
      root,
      '--budget',
      budget,
      '--report',
      report,
      '--quiet',
    ]);
    assert.equal(code, 1);
    const r = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.ok(r.violations.length >= 1);
    const metrics = r.violations.map((v) => v.metric);
    assert.ok(metrics.includes('totalJsKB'));
  } finally {
    rmrf(root);
    rmrf(tmp);
  }
});

test('run exits 2 when budget file is missing without --update-baseline', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-run-'));
  const root = makeStaticTree({ jsFiles: [{ name: 'a.js', content: 'a' }] });
  try {
    const code = await run([
      'node',
      'bundle-size-check.js',
      '--root',
      root,
      '--budget',
      path.join(tmp, 'no-such-budget.json'),
      '--report',
      path.join(tmp, 'r.json'),
      '--quiet',
    ]);
    assert.equal(code, 2);
  } finally {
    rmrf(root);
    rmrf(tmp);
  }
});
