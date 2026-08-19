'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-go-modules');
const { extractGoModules, buildGoModulesForFiles, renderGoModulesBlock, _internal } = engine;
const { isPseudoVersion } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractGoModules('').total, 0);
  assert.equal(extractGoModules(null).total, 0);
});

test('isPseudoVersion detects vN.0.0-YYYYMMDDHHMMSS-sha', () => {
  assert.equal(isPseudoVersion('v0.0.0-20231015120000-abc123def456'), true);
  assert.equal(isPseudoVersion('v1.2.3'), false);
});

test('detects module declaration', () => {
  const r = extractGoModules('module github.com/example/proj');
  assert.ok(r.entries.some((e) => e.kind === 'module'));
});

test('detects require line', () => {
  const r = extractGoModules('require github.com/foo/bar v1.2.3');
  assert.ok(r.entries.some((e) => e.kind === 'require' && /foo\/bar/.test(e.path)));
});

test('detects bare require entry (within require block)', () => {
  const r = extractGoModules('\tgithub.com/foo/bar v1.2.3');
  assert.ok(r.entries.some((e) => e.kind === 'require'));
});

test('detects replace directive', () => {
  const r = extractGoModules('replace github.com/x/y => ../local');
  assert.ok(r.entries.some((e) => e.kind === 'replace'));
});

test('detects retract directive', () => {
  const r = extractGoModules('retract v1.2.3');
  assert.ok(r.entries.some((e) => e.kind === 'retract'));
});

test('detects pseudo-version', () => {
  const r = extractGoModules('github.com/foo/bar v0.0.0-20231015120000-abc123def456');
  assert.ok(r.entries.some((e) => e.pseudo));
});

test('detects import statement', () => {
  const r = extractGoModules('import "github.com/foo/bar"');
  assert.ok(r.entries.some((e) => e.kind === 'import'));
});

test('dedupes identical entries', () => {
  const r = extractGoModules('github.com/foo/bar v1.0.0\ngithub.com/foo/bar v1.0.0');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `github.com/foo/bar${i} v1.${i}.0\n`;
  const r = extractGoModules(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractGoModules(`
    module github.com/example/proj
    require github.com/foo/bar v1.2.3
    replace github.com/x/y => ../local
    retract v0.1.0
    import "github.com/qux/zap"
  `);
  assert.ok(r.totals.module >= 1);
  assert.ok(r.totals.require >= 1);
  assert.ok(r.totals.replace >= 1);
  assert.ok(r.totals.retract >= 1);
  assert.ok(r.totals.import >= 1);
});

test('buildGoModulesForFiles aggregates across batch', () => {
  const files = [
    { name: 'go.mod', extractedText: 'module github.com/example/a' },
    { name: 'main.go', extractedText: 'import "github.com/foo/bar"' },
  ];
  const r = buildGoModulesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGoModulesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'go.mod', extractedText: 'module github.com/example/proj' }];
  const r = buildGoModulesForFiles(files);
  const md = renderGoModulesBlock(r);
  assert.match(md, /^## GO MODULES/);
});

test('renderGoModulesBlock empty when nothing surfaces', () => {
  assert.equal(renderGoModulesBlock({ perFile: [] }), '');
  assert.equal(renderGoModulesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGoModulesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'module github.com/example/proj' },
  ]);
  assert.equal(r.perFile.length, 1);
});
