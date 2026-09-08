'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createFileStateTracker,
  compileGlob,
  matchPaths,
  fingerprint,
} = require('../src/services/codex/file-state');

// ---------------------------------------------------------------------------
// createFileStateTracker — read-before-write guard (OT-11)
// ---------------------------------------------------------------------------

test('read then write with unchanged content is ok', () => {
  const tracker = createFileStateTracker();
  tracker.recordRead('src/app.ts', 'const a = 1;\n');
  const verdict = tracker.assertWritable('src/app.ts', 'const a = 1;\n');
  assert.deepEqual(verdict, { ok: true });
});

test('write without a prior read is rejected as not_read with an instructive hint', () => {
  const tracker = createFileStateTracker();
  const verdict = tracker.assertWritable('src/app.ts', 'whatever');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_read');
  assert.match(verdict.hint, /src\/app\.ts/);
  assert.match(verdict.hint, /read_file/);
  assert.match(verdict.hint, /Léelo primero/);
});

test('content changed since the read is rejected as stale with an instructive hint', () => {
  const tracker = createFileStateTracker();
  tracker.recordRead('src/app.ts', 'version 1');
  const verdict = tracker.assertWritable('src/app.ts', 'version 2 — someone else edited');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'stale');
  assert.match(verdict.hint, /src\/app\.ts/);
  assert.match(verdict.hint, /cambió/);
  assert.match(verdict.hint, /Vuelve a leerlo/);
});

test('recordRead refreshes the hash so a re-read makes the file writable again', () => {
  const tracker = createFileStateTracker();
  tracker.recordRead('a.txt', 'v1');
  assert.equal(tracker.assertWritable('a.txt', 'v2').reason, 'stale');
  tracker.recordRead('a.txt', 'v2');
  assert.deepEqual(tracker.assertWritable('a.txt', 'v2'), { ok: true });
});

test('invalidate drops the recorded read', () => {
  const tracker = createFileStateTracker();
  tracker.recordRead('src/app.ts', 'content');
  tracker.invalidate('src/app.ts');
  const verdict = tracker.assertWritable('src/app.ts', 'content');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_read');
});

test('paths are normalized: backslashes and ./ prefixes resolve to the same file', () => {
  const tracker = createFileStateTracker();
  tracker.recordRead('./src\\lib\\util.ts', 'x');
  assert.deepEqual(tracker.assertWritable('src/lib/util.ts', 'x'), { ok: true });
});

test('unsafe paths (absolute / traversal) are rejected with a hint, never ok', () => {
  const tracker = createFileStateTracker();
  for (const bad of ['/etc/passwd', '../secrets.env', 'C:/windows/system32']) {
    const verdict = tracker.assertWritable(bad, 'x');
    assert.equal(verdict.ok, false, `expected rejection for ${bad}`);
    assert.equal(verdict.reason, 'not_read');
    assert.equal(typeof verdict.hint, 'string');
    assert.ok(verdict.hint.length > 0);
  }
});

test('snapshot returns a plain path→sha256 map', () => {
  const tracker = createFileStateTracker();
  tracker.recordRead('a.txt', 'aaa');
  tracker.recordRead('b/c.txt', 'ccc');
  const snap = tracker.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['a.txt', 'b/c.txt']);
  assert.equal(snap['a.txt'], fingerprint('aaa'));
  assert.equal(snap['b/c.txt'], fingerprint('ccc'));
  assert.match(snap['a.txt'], /^[0-9a-f]{64}$/);
});

test('trackers are independent instances', () => {
  const one = createFileStateTracker();
  const two = createFileStateTracker();
  one.recordRead('a.txt', 'x');
  assert.equal(two.assertWritable('a.txt', 'x').reason, 'not_read');
  assert.deepEqual(one.assertWritable('a.txt', 'x'), { ok: true });
});

// ---------------------------------------------------------------------------
// compileGlob / matchPaths — safe glob matrix (OT-11)
// ---------------------------------------------------------------------------

test('glob matrix: src/**/*.ts', () => {
  const re = compileGlob('src/**/*.ts');
  assert.ok(re instanceof RegExp);
  assert.equal(re.test('src/app.ts'), true, 'zero directories under **');
  assert.equal(re.test('src/lib/util.ts'), true);
  assert.equal(re.test('src/a/b/c/deep.ts'), true);
  assert.equal(re.test('lib/app.ts'), false);
  assert.equal(re.test('src/app.tsx'), false);
  assert.equal(re.test('src/app.js'), false);
});

test('glob matrix: *.json stays segment-scoped', () => {
  const re = compileGlob('*.json');
  assert.equal(re.test('package.json'), true);
  assert.equal(re.test('tsconfig.json'), true);
  assert.equal(re.test('config/settings.json'), false, '* must not cross "/"');
  assert.equal(re.test('package.json5'), false);
});

test('glob matrix: componentes/{a,b}.tsx alternation', () => {
  const re = compileGlob('componentes/{a,b}.tsx');
  assert.equal(re.test('componentes/a.tsx'), true);
  assert.equal(re.test('componentes/b.tsx'), true);
  assert.equal(re.test('componentes/c.tsx'), false);
  assert.equal(re.test('componentes/ab.tsx'), false);
});

test('glob matrix: ? matches exactly one non-slash character', () => {
  const re = compileGlob('file?.txt');
  assert.equal(re.test('file1.txt'), true);
  assert.equal(re.test('fileA.txt'), true);
  assert.equal(re.test('file.txt'), false);
  assert.equal(re.test('file12.txt'), false);
  assert.equal(re.test('file/.txt'), false);
});

test('dangerous regex characters are escaped, not interpreted', () => {
  // "+" literal: "a+b.js" must not become one-or-more "a"
  const plus = compileGlob('a+b.js');
  assert.equal(plus.test('a+b.js'), true);
  assert.equal(plus.test('aab.js'), false);
  assert.equal(plus.test('aXb.js'), false);

  // dots are literal
  const dot = compileGlob('a.b');
  assert.equal(dot.test('a.b'), true);
  assert.equal(dot.test('aXb'), false);

  // parens, brackets, pipe, dollar, caret literal
  const funky = compileGlob('src/(main)|[x]^$.ts');
  assert.equal(funky.test('src/(main)|[x]^$.ts'), true);
  assert.equal(funky.test('src/main.ts'), false);
});

test('hostile patterns do not explode and never throw', () => {
  const hostile = [
    '(a+)+$',
    '([a-z]+)*\\1',
    '****////****',
    '{{{{,,,}}}}',
    '{unclosed',
    'closed}brace',
    '\\d+\\.\\d+',
    '.*.*.*.*.*.*',
  ];
  for (const pattern of hostile) {
    let re;
    assert.doesNotThrow(() => { re = compileGlob(pattern); }, `compileGlob(${pattern}) threw`);
    assert.ok(re instanceof RegExp);
    // A long adversarial input must resolve fast (linear-time regex)
    const started = Date.now();
    re.test(`${'a'.repeat(5000)}!`);
    assert.ok(Date.now() - started < 1000, `pattern ${pattern} is pathological`);
  }
});

test('non-string, empty and oversized patterns compile to a never-matching regex', () => {
  for (const bad of [null, undefined, 42, {}, '', '   ', 'a'.repeat(5000)]) {
    const re = compileGlob(bad);
    assert.ok(re instanceof RegExp);
    assert.equal(re.test('src/app.ts'), false);
    assert.equal(re.test(''), false);
  }
});

test('matchPaths filters and normalizes paths', () => {
  const paths = [
    'src/app.ts',
    './src/lib/util.ts',
    'src\\deep\\nested\\mod.ts',
    'src/styles.css',
    'README.md',
  ];
  assert.deepEqual(matchPaths(paths, 'src/**/*.ts'), [
    'src/app.ts',
    './src/lib/util.ts',
    'src\\deep\\nested\\mod.ts',
  ]);
  assert.deepEqual(matchPaths(paths, '*.md'), ['README.md']);
  assert.deepEqual(matchPaths(paths, '**/*.py'), []);
  assert.deepEqual(matchPaths('not-an-array', '*.md'), []);
});
