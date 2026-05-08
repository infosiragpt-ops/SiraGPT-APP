'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  analyze,
  analyzeExports,
  analyzeUsages,
  resolveRequire,
  stripComments,
  extractNamedFromObjectLiteral,
  formatReport,
} = require('../../scripts/dead-code.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

test('stripComments removes block and line comments', () => {
  const src = `
    /* block */ const a = 1; // line
    const b = 2;
  `;
  const out = stripComments(src);
  assert.match(out, /const a = 1;/);
  assert.match(out, /const b = 2;/);
  assert.doesNotMatch(out, /\/\*/);
  assert.doesNotMatch(out, /\/\//);
});

test('extractNamedFromObjectLiteral picks shorthand and key:value names', () => {
  const names = extractNamedFromObjectLiteral(' foo, bar: baz, qux ');
  assert.ok(names.has('foo'));
  assert.ok(names.has('bar'));
  assert.ok(names.has('qux'));
  // baz is the value, should not be exported as a key
  assert.ok(!names.has('baz'));
});

test('analyzeExports detects module.exports = { ... } shorthand and pairs', () => {
  const src = `
    function foo() {}
    const bar = 1;
    module.exports = { foo, bar, alias: foo };
  `;
  const info = analyzeExports(src);
  assert.ok(info.exports.has('foo'));
  assert.ok(info.exports.has('bar'));
  assert.ok(info.exports.has('alias'));
  assert.equal(info.hasDefault, false);
});

test('analyzeExports detects exports.NAME and module.exports.NAME', () => {
  const src = `
    exports.alpha = 1;
    module.exports.beta = 2;
  `;
  const info = analyzeExports(src);
  assert.ok(info.exports.has('alpha'));
  assert.ok(info.exports.has('beta'));
});

test('analyzeExports flags default export when assigning a non-object', () => {
  const src = `
    class Foo {}
    module.exports = Foo;
  `;
  const info = analyzeExports(src);
  assert.equal(info.hasDefault, true);
  assert.equal(info.exports.size, 0);
});

test('analyzeExports detects Object.assign(module.exports, {...})', () => {
  const src = `
    function helper() {}
    Object.assign(module.exports, { helper, other: 1 });
  `;
  const info = analyzeExports(src);
  assert.ok(info.exports.has('helper'));
  assert.ok(info.exports.has('other'));
});

test('resolveRequire resolves relative file, /index.js, and rejects bare specifiers', () => {
  const root = mkTmp();
  const a = write(root, 'a.js', "module.exports = {};\n");
  const idx = write(root, 'pkg/index.js', "module.exports = {};\n");
  const from = path.join(root, 'caller.js');
  fs.writeFileSync(from, '');
  assert.equal(resolveRequire(from, './a'), a);
  assert.equal(resolveRequire(from, './a.js'), a);
  assert.equal(resolveRequire(from, './pkg'), idx);
  assert.equal(resolveRequire(from, 'express'), null);
});

test('analyzeUsages tracks destructured names, identifier-then-dot, and inline .prop', () => {
  const root = mkTmp();
  const target = write(root, 'mod.js', "module.exports = { a: 1, b: 2, c: 3 };\n");
  const caller = write(
    root,
    'caller.js',
    `
      const { a } = require('./mod');
      const m = require('./mod');
      console.log(m.b);
      const v = require('./mod').c;
    `
  );
  const src = fs.readFileSync(caller, 'utf8');
  const usages = analyzeUsages(src, caller);
  assert.ok(usages.defaultUses.has(target));
  const named = usages.named.get(target);
  assert.ok(named && named.has('a'));
  assert.ok(named.has('b'));
  assert.ok(named.has('c'));
});

test('analyze reports unreferenced exports and skips the index.js root', () => {
  const root = mkTmp();
  // Root entry — its exports do not need to be consumed.
  write(root, 'index.js', "const { used } = require('./src/lib');\nconsole.log(used);\n");
  // A library exposing two names: one used, one dead.
  write(
    root,
    'src/lib.js',
    `
      function used() {}
      function dead() {}
      module.exports = { used, dead };
    `
  );

  const { dead, summary } = analyze(root, { includeTests: false });
  const symbols = dead.map((d) => `${path.relative(root, d.file)}:${d.symbol}`);
  assert.ok(symbols.includes('src/lib.js:dead'), `expected dead symbol, got ${JSON.stringify(symbols)}`);
  assert.ok(!symbols.includes('src/lib.js:used'));
  assert.ok(!symbols.some((s) => s.startsWith('index.js:')));
  assert.ok(summary.totalExports >= 2);
  assert.ok(summary.deadExports >= 1);
});

test('analyze tags named-orphan when the file itself is never imported', () => {
  const root = mkTmp();
  write(root, 'index.js', "// no requires of orphan\nmodule.exports = {};\n");
  write(
    root,
    'src/orphan.js',
    `
      function ghost() {}
      module.exports = { ghost };
    `
  );
  const { dead } = analyze(root, { includeTests: false });
  const orphan = dead.find((d) => d.symbol === 'ghost');
  assert.ok(orphan);
  assert.equal(orphan.kind, 'named-orphan');
});

test('analyze treats backend/tests/** as roots by default', () => {
  const root = mkTmp();
  write(root, 'index.js', '');
  write(
    root,
    'tests/foo.test.js',
    `
      function helperOnlyForTest() {}
      module.exports = { helperOnlyForTest };
    `
  );
  const { dead } = analyze(root, { includeTests: false });
  assert.ok(!dead.some((d) => d.file.endsWith(path.join('tests', 'foo.test.js'))));
});

test('analyze with --include-tests-equivalent flag examines tests too', () => {
  const root = mkTmp();
  write(root, 'index.js', '');
  write(
    root,
    'tests/foo.test.js',
    `
      function helperOnlyForTest() {}
      module.exports = { helperOnlyForTest };
    `
  );
  const { dead } = analyze(root, { includeTests: true });
  assert.ok(dead.some((d) => d.symbol === 'helperOnlyForTest'));
});

test('default export is considered used when the file is required anywhere', () => {
  const root = mkTmp();
  write(root, 'index.js', "const Foo = require('./src/foo');\nnew Foo();\n");
  write(
    root,
    'src/foo.js',
    `
      class Foo {}
      module.exports = Foo;
    `
  );
  const { dead } = analyze(root, {});
  assert.ok(!dead.some((d) => d.symbol === '<default>'));
});

test('formatReport renders a "no dead exports" message when clean', () => {
  const out = formatReport({
    dead: [],
    summary: { totalFiles: 1, totalExports: 0, deadExports: 0, rootsSkipped: 0 },
    backendRoot: '/tmp/backend',
  });
  assert.match(out, /No unreferenced exports detected/);
});

test('formatReport groups dead symbols by file', () => {
  const out = formatReport({
    dead: [
      { file: '/tmp/backend/src/a.js', symbol: 'foo', kind: 'named' },
      { file: '/tmp/backend/src/a.js', symbol: 'bar', kind: 'named-orphan' },
    ],
    summary: { totalFiles: 1, totalExports: 2, deadExports: 2, rootsSkipped: 0 },
    backendRoot: '/tmp/backend',
  });
  assert.match(out, /a\.js/);
  assert.match(out, /- foo/);
  assert.match(out, /- bar \(file never imported\)/);
});
