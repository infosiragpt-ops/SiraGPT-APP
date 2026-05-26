'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-composer-pkgs');
const { extractComposerPkgs, buildComposerPkgsForFiles, renderComposerPkgsBlock, _internal } = engine;
const { classifyConstraint } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractComposerPkgs('').total, 0);
  assert.equal(extractComposerPkgs(null).total, 0);
});

test('classifyConstraint: caret/tilde/exact/range', () => {
  assert.equal(classifyConstraint('^1.0'), 'caret');
  assert.equal(classifyConstraint('~1.0'), 'tilde');
  assert.equal(classifyConstraint('1.0.0'), 'exact');
  assert.equal(classifyConstraint('>=1.0'), 'range');
});

test('detects "vendor/package": "^1.0"', () => {
  const r = extractComposerPkgs('"symfony/console": "^6.0"');
  assert.ok(r.entries.some((e) => e.name === 'symfony/console'));
});

test('detects laravel/framework with tilde constraint', () => {
  const r = extractComposerPkgs('"laravel/framework": "~10.0"');
  assert.ok(r.entries.some((e) => e.name === 'laravel/framework' && e.kind === 'tilde'));
});

test('detects exact version', () => {
  const r = extractComposerPkgs('"phpunit/phpunit": "10.5.0"');
  assert.ok(r.entries.some((e) => e.kind === 'exact'));
});

test('detects composer require command', () => {
  const r = extractComposerPkgs('composer require monolog/monolog:^3.0');
  assert.ok(r.entries.some((e) => e.kind === 'command'));
});

test('detects lock file "name" field', () => {
  const r = extractComposerPkgs('"name": "doctrine/orm"');
  assert.ok(r.entries.some((e) => e.kind === 'lock' && e.name === 'doctrine/orm'));
});

test('dedupes identical packages', () => {
  const r = extractComposerPkgs('"symfony/console": "^6.0"\n"symfony/console": "^6.0"');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `"vendor/pkg${i}": "^1.${i}"\n`;
  const r = extractComposerPkgs(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractComposerPkgs('"a/b": "^1.0"\n"c/d": "~2.0"\n"e/f": "3.0.0"');
  assert.ok(r.totals.caret >= 1);
  assert.ok(r.totals.tilde >= 1);
  assert.ok(r.totals.exact >= 1);
});

test('buildComposerPkgsForFiles aggregates across batch', () => {
  const files = [
    { name: 'composer.json', extractedText: '"symfony/console": "^6.0"' },
    { name: 'composer.lock', extractedText: '"name": "doctrine/orm"' },
  ];
  const r = buildComposerPkgsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderComposerPkgsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'composer.json', extractedText: '"symfony/console": "^6.0"' }];
  const r = buildComposerPkgsForFiles(files);
  const md = renderComposerPkgsBlock(r);
  assert.match(md, /^## PHP/);
});

test('renderComposerPkgsBlock empty when nothing surfaces', () => {
  assert.equal(renderComposerPkgsBlock({ perFile: [] }), '');
  assert.equal(renderComposerPkgsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildComposerPkgsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '"symfony/console": "^6.0"' },
  ]);
  assert.equal(r.perFile.length, 1);
});
