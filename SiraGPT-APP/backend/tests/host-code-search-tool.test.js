/**
 * host-code-search-tool — list_dir / glob_files / code_grep.
 *
 * These give the agent real, workspace-bounded code navigation over an
 * on-disk checkout. The tests pin both behavior (find the right files/lines)
 * AND the security boundary (never escape the workspace roots, never read
 * .env or other secrets, never follow symlinks, skip build dirs + binaries).
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Build an isolated workspace under a realpath'd temp dir and register it as
// the ONLY extra workspace root BEFORE loading the tool (so its sandbox sees
// our fixtures as in-bounds and everything else as out-of-bounds).
const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sira-codesearch-')));
process.env.SIRAGPT_WORKSPACE_ROOTS = TMP_ROOT;

const { listDir, globFiles, codeGrep } = require('../src/services/agents/host-code-search-tool');

function write(rel, content) {
  const full = path.join(TMP_ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ── fixture tree ──────────────────────────────────────────────────────────
write('README.md', '# Project\n\nDocs here.\n');
write('src/index.js', "function hello() { return 'world'; }\nconst FOO = 1;\n");
write('src/util.ts', 'export const FOO = 42;\nexport const BAR = 7;\n');
write('src/nested/deep.js', 'const FOO = 99; // marker line\n');
write('.env', 'SECRET_KEY=supersecret_FOO\n'); // must never be read/listed
write('node_modules/junk/index.js', 'const FOO = "should be ignored";\n'); // ignored dir
// A >2MB file containing the needle — code_grep must skip it (size cap).
write('big.js', `const FOO = 1;\n${'x'.repeat(2 * 1024 * 1024 + 10)}\n`);

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── list_dir ────────────────────────────────────────────────────────────────

test('list_dir: lists top level, skips node_modules and dotfiles by default', () => {
  const r = listDir({ path: TMP_ROOT, depth: 1 });
  assert.equal(r.ok, true);
  const names = r.entries.map((e) => e.path);
  assert.ok(names.includes('src'), 'should list the src dir');
  assert.ok(names.includes('README.md'), 'should list README.md');
  assert.ok(!names.includes('node_modules'), 'must skip node_modules');
  assert.ok(!names.includes('.env'), 'must not list dotfiles by default');
  // depth 1 → no nested children.
  assert.ok(!names.some((n) => n.includes('/')), 'depth 1 should not descend');
});

test('list_dir: depth 2 descends into subdirectories', () => {
  const r = listDir({ path: TMP_ROOT, depth: 2 });
  const names = r.entries.map((e) => e.path);
  assert.ok(names.includes('src/index.js'));
  assert.ok(names.includes('src/util.ts'));
  // 'src/nested' is depth 2 (a dir); its children are depth 3 — not included.
  assert.ok(names.includes('src/nested'));
  assert.ok(!names.includes('src/nested/deep.js'));
});

test('list_dir: rejects a path outside the workspace roots', () => {
  const r = listDir({ path: '/etc' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Ruta inválida|dentro de/i);
});

test('list_dir: errors cleanly on a non-existent directory', () => {
  const r = listDir({ path: path.join(TMP_ROOT, 'does-not-exist') });
  assert.equal(r.ok, false);
  assert.match(r.error, /no existe/i);
});

// ── glob_files ───────────────────────────────────────────────────────────────

test('glob_files: **/*.js finds nested JS but not ignored dirs or .ts', () => {
  const r = globFiles({ directory: TMP_ROOT, pattern: '**/*.js' });
  assert.equal(r.ok, true);
  assert.ok(r.files.includes('src/index.js'));
  assert.ok(r.files.includes('src/nested/deep.js'));
  assert.ok(r.files.includes('big.js'));
  assert.ok(!r.files.includes('src/util.ts'), 'ts must not match *.js');
  assert.ok(!r.files.some((f) => f.includes('node_modules')), 'must skip node_modules');
});

test('glob_files: top-level *.md matches only the root README', () => {
  const r = globFiles({ directory: TMP_ROOT, pattern: '*.md' });
  assert.deepEqual(r.files, ['README.md']);
});

test('glob_files: never returns secret files', () => {
  const r = globFiles({ directory: TMP_ROOT, pattern: '**/*', includeHidden: true });
  assert.ok(!r.files.includes('.env'), '.env must never be globbed');
});

test('glob_files: requires a pattern', () => {
  const r = globFiles({ directory: TMP_ROOT });
  assert.equal(r.ok, false);
  assert.match(r.error, /pattern/i);
});

// ── code_grep ────────────────────────────────────────────────────────────────

test('code_grep: finds the needle across files with file+line', () => {
  const r = codeGrep({ directory: TMP_ROOT, pattern: 'FOO' });
  assert.equal(r.ok, true);
  const files = new Set(r.matches.map((m) => m.file));
  assert.ok(files.has('src/util.ts'));
  assert.ok(files.has('src/index.js'));
  assert.ok(files.has('src/nested/deep.js'));
  // Skipped surfaces:
  assert.ok(!files.has('.env'), 'secret file must never be grepped');
  assert.ok(![...files].some((f) => f.includes('node_modules')), 'ignored dir');
  assert.ok(!files.has('big.js'), 'oversized file must be skipped');
  // Match shape.
  const m = r.matches.find((x) => x.file === 'src/nested/deep.js');
  assert.equal(m.line, 1);
  assert.match(m.text, /FOO/);
});

test('code_grep: include glob restricts the scan to matching files', () => {
  const r = codeGrep({ directory: TMP_ROOT, pattern: 'FOO', include: ['**/*.ts'] });
  assert.equal(r.ok, true);
  assert.ok(r.matches.length >= 1);
  assert.ok(r.matches.every((m) => m.file.endsWith('.ts')), 'only .ts files scanned');
});

test('code_grep: ignoreCase matches case-insensitively', () => {
  const lower = codeGrep({ directory: TMP_ROOT, pattern: 'foo' });
  const ci = codeGrep({ directory: TMP_ROOT, pattern: 'foo', ignoreCase: true });
  assert.equal(lower.matchCount, 0, 'case-sensitive "foo" should not match FOO');
  assert.ok(ci.matchCount >= 3, 'case-insensitive should match FOO');
});

test('code_grep: rejects an invalid regular expression', () => {
  const r = codeGrep({ directory: TMP_ROOT, pattern: '([unclosed' });
  assert.equal(r.ok, false);
  assert.match(r.error, /regular expr|inválida/i);
});

test('code_grep: rejects a directory outside the workspace roots', () => {
  const r = codeGrep({ directory: '/usr', pattern: 'root' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Ruta inválida|dentro de/i);
});
