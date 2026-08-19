'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-hex-pkgs');
const { extractHexPkgs, buildHexPkgsForFiles, renderHexPkgsBlock, _internal } = engine;
const { classifySource } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractHexPkgs('').total, 0);
  assert.equal(extractHexPkgs(null).total, 0);
});

test('classifySource: detects git/path/github', () => {
  assert.equal(classifySource(' git: "https://..."'), 'git');
  assert.equal(classifySource(' path: "../foo"'), 'path');
  assert.equal(classifySource(' github: "user/repo"'), 'github');
});

test('detects inline hex package', () => {
  const r = extractHexPkgs('{:phoenix, "~> 1.7"}');
  assert.ok(r.entries.some((e) => e.name === 'phoenix'));
});

test('detects ecto package', () => {
  const r = extractHexPkgs('{:ecto, "~> 3.10"}');
  assert.ok(r.entries.some((e) => e.name === 'ecto'));
});

test('detects with only: :dev option', () => {
  const r = extractHexPkgs('{:credo, "~> 1.7", only: :dev}');
  assert.ok(r.entries.some((e) => e.name === 'credo'));
});

test('detects git source', () => {
  const r = extractHexPkgs('{:mypkg, git: "https://github.com/foo/bar"}');
  assert.ok(r.entries.some((e) => e.source === 'git'));
});

test('detects path source', () => {
  const r = extractHexPkgs('{:local, path: "../local"}');
  assert.ok(r.entries.some((e) => e.source === 'path'));
});

test('detects github shorthand', () => {
  const r = extractHexPkgs('{:plug, github: "elixir-plug/plug"}');
  assert.ok(r.entries.some((e) => e.source === 'github'));
});

test('captures version', () => {
  const r = extractHexPkgs('{:phoenix, "~> 1.7.0"}');
  const entry = r.entries.find((e) => e.name === 'phoenix');
  assert.equal(entry.version, '~> 1.7.0');
});

test('dedupes identical entries', () => {
  const r = extractHexPkgs('{:phoenix, "~> 1.7"}\n{:phoenix, "~> 1.7"}');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `{:pkg_${i}, "~> 1.${i}"}\n`;
  const r = extractHexPkgs(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by source', () => {
  const r = extractHexPkgs(
    '{:a, "~> 1.0"} {:b, git: "https://..."} {:c, path: "../c"}'
  );
  assert.ok(r.totals.hex >= 1);
  assert.ok(r.totals.git >= 1);
  assert.ok(r.totals.path >= 1);
});

test('buildHexPkgsForFiles aggregates across batch', () => {
  const files = [
    { name: 'mix.exs', extractedText: '{:phoenix, "~> 1.7"}' },
    { name: 'other.exs', extractedText: '{:ecto, "~> 3.0"}' },
  ];
  const r = buildHexPkgsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHexPkgsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'mix.exs', extractedText: '{:phoenix, "~> 1.7"}' }];
  const r = buildHexPkgsForFiles(files);
  const md = renderHexPkgsBlock(r);
  assert.match(md, /^## ELIXIR/);
});

test('renderHexPkgsBlock empty when nothing surfaces', () => {
  assert.equal(renderHexPkgsBlock({ perFile: [] }), '');
  assert.equal(renderHexPkgsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHexPkgsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '{:phoenix, "~> 1.7"}' },
  ]);
  assert.equal(r.perFile.length, 1);
});
