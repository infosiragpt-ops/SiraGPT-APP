'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cargo-packages');
const { extractCargoPackages, buildCargoPackagesForFiles, renderCargoPackagesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCargoPackages('').total, 0);
  assert.equal(extractCargoPackages(null).total, 0);
});

test('detects inline serde = "1.0"', () => {
  const r = extractCargoPackages('serde = "1.0.0"');
  assert.ok(r.entries.some((e) => e.name === 'serde'));
});

test('detects inline tokio with version', () => {
  const r = extractCargoPackages('tokio = "1.35"');
  assert.ok(r.entries.some((e) => e.name === 'tokio'));
});

test('detects table-form workspace = true', () => {
  const r = extractCargoPackages('serde = { workspace = true }');
  assert.ok(r.entries.some((e) => e.source === 'workspace'));
});

test('detects table-form with git source', () => {
  const r = extractCargoPackages('mycrate = { git = "https://github.com/x/y", branch = "main" }');
  assert.ok(r.entries.some((e) => e.source === 'git'));
});

test('detects table-form with path source', () => {
  const r = extractCargoPackages('local-crate = { path = "../local-crate" }');
  assert.ok(r.entries.some((e) => e.source === 'path'));
});

test('detects Cargo.lock package entries', () => {
  const r = extractCargoPackages('[[package]]\nname = "anyhow"\nversion = "1.0.75"');
  assert.ok(r.entries.some((e) => e.source === 'lock' && e.name === 'anyhow'));
});

test('extracts version from table form', () => {
  const r = extractCargoPackages('tokio = { version = "1.35", features = ["full"] }');
  const entry = r.entries.find((e) => e.name === 'tokio');
  assert.equal(entry.version, '1.35');
});

test('dedupes identical entries', () => {
  const r = extractCargoPackages('serde = "1.0"\nserde = "1.0"');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `crate_${i} = "1.${i}"\n`;
  const r = extractCargoPackages(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by source', () => {
  const r = extractCargoPackages(
    'serde = "1.0"\ntokio = { workspace = true }\nfoo = { git = "https://example.com" }\nbar = { path = "../bar" }'
  );
  assert.ok(r.totals.registry >= 1);
  assert.ok(r.totals.workspace >= 1);
  assert.ok(r.totals.git >= 1);
  assert.ok(r.totals.path >= 1);
});

test('buildCargoPackagesForFiles aggregates across batch', () => {
  const files = [
    { name: 'Cargo.toml', extractedText: 'serde = "1.0"' },
    { name: 'Cargo.lock', extractedText: '[[package]]\nname = "anyhow"\nversion = "1.0.75"' },
  ];
  const r = buildCargoPackagesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCargoPackagesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'Cargo.toml', extractedText: 'serde = "1.0"' }];
  const r = buildCargoPackagesForFiles(files);
  const md = renderCargoPackagesBlock(r);
  assert.match(md, /^## RUST/);
});

test('renderCargoPackagesBlock empty when nothing surfaces', () => {
  assert.equal(renderCargoPackagesBlock({ perFile: [] }), '');
  assert.equal(renderCargoPackagesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCargoPackagesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'serde = "1.0"' },
  ]);
  assert.equal(r.perFile.length, 1);
});
