'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-gem-pkgs');
const { extractGemPkgs, buildGemPkgsForFiles, renderGemPkgsBlock, _internal } = engine;
const { classifyConstraint } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractGemPkgs('').total, 0);
  assert.equal(extractGemPkgs(null).total, 0);
});

test('classifyConstraint: ~> = pessimistic', () => {
  assert.equal(classifyConstraint('~> 1.0'), 'pessimistic');
  assert.equal(classifyConstraint('>= 2.0'), 'comparison');
});

test('detects gem "name", "~> 1.0"', () => {
  const r = extractGemPkgs("gem 'rails', '~> 7.1'");
  assert.ok(r.entries.some((e) => e.name === 'rails'));
});

test('detects gem with pessimistic constraint', () => {
  const r = extractGemPkgs("gem 'puma', '~> 6.0'");
  const entry = r.entries.find((e) => e.name === 'puma');
  assert.equal(entry.constraintKind, 'pessimistic');
});

test('detects gem without version', () => {
  const r = extractGemPkgs("gem 'sidekiq'");
  assert.ok(r.entries.some((e) => e.name === 'sidekiq'));
});

test('detects gemspec add_dependency', () => {
  const r = extractGemPkgs("s.add_dependency 'rake', '~> 13.0'");
  assert.ok(r.entries.some((e) => e.kind === 'gemspec'));
});

test('detects add_development_dependency', () => {
  const r = extractGemPkgs("s.add_development_dependency 'rspec', '~> 3.12'");
  assert.ok(r.entries.some((e) => e.kind === 'gemspec'));
});

test('detects Gemfile.lock entry', () => {
  const r = extractGemPkgs('    activesupport (7.1.0)');
  assert.ok(r.entries.some((e) => e.kind === 'lock'));
});

test('detects bundle add command', () => {
  const r = extractGemPkgs('bundle add devise');
  assert.ok(r.entries.some((e) => e.kind === 'command'));
});

test('dedupes identical entries', () => {
  const r = extractGemPkgs("gem 'rails'\ngem 'rails'");
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `gem 'pkg-${i}'\n`;
  const r = extractGemPkgs(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractGemPkgs("gem 'a'\ns.add_dependency 'b'\n    c (1.0)");
  assert.ok(r.totals.gem >= 1);
  assert.ok(r.totals.gemspec >= 1);
  assert.ok(r.totals.lock >= 1);
});

test('buildGemPkgsForFiles aggregates across batch', () => {
  const files = [
    { name: 'Gemfile', extractedText: "gem 'rails'" },
    { name: 'Gemfile.lock', extractedText: '    activesupport (7.1.0)' },
  ];
  const r = buildGemPkgsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGemPkgsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'Gemfile', extractedText: "gem 'rails'" }];
  const r = buildGemPkgsForFiles(files);
  const md = renderGemPkgsBlock(r);
  assert.match(md, /^## RUBY/);
});

test('renderGemPkgsBlock empty when nothing surfaces', () => {
  assert.equal(renderGemPkgsBlock({ perFile: [] }), '');
  assert.equal(renderGemPkgsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGemPkgsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: "gem 'rails'" },
  ]);
  assert.equal(r.perFile.length, 1);
});
