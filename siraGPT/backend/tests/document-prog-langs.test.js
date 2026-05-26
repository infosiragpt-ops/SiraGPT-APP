'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-prog-langs');
const { extractProgLangs, buildProgLangsForFiles, renderProgLangsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractProgLangs('').total, 0);
  assert.equal(extractProgLangs(null).total, 0);
});

test('detects Python 3.12', () => {
  const r = extractProgLangs('Targets Python 3.12 and later.');
  assert.ok(r.entries.some((e) => e.name === 'Python' && e.version === '3.12'));
});

test('detects Node.js 20', () => {
  const r = extractProgLangs('Use Node.js 20 LTS');
  assert.ok(r.entries.some((e) => e.name === 'Node.js'));
});

test('detects Go 1.21', () => {
  const r = extractProgLangs('Built with Go 1.21');
  assert.ok(r.entries.some((e) => e.name === 'Go' && e.version === '1.21'));
});

test('detects Rust 1.75', () => {
  const r = extractProgLangs('MSRV Rust 1.75');
  assert.ok(r.entries.some((e) => e.name === 'Rust'));
});

test('detects Java 17', () => {
  const r = extractProgLangs('Java 17 LTS deployed');
  assert.ok(r.entries.some((e) => e.name === 'Java'));
});

test('detects TypeScript 5.3', () => {
  const r = extractProgLangs('Upgrade TypeScript 5.3 today');
  assert.ok(r.entries.some((e) => e.name === 'TypeScript'));
});

test('detects Kotlin (JVM family)', () => {
  const r = extractProgLangs('Kotlin 1.9 release');
  assert.ok(r.entries.some((e) => e.family === 'jvm'));
});

test('detects Swift', () => {
  const r = extractProgLangs('Swift 5.9 features');
  assert.ok(r.entries.some((e) => e.name === 'Swift'));
});

test('detects Elixir', () => {
  const r = extractProgLangs('Elixir 1.16 release');
  assert.ok(r.entries.some((e) => e.name === 'Elixir' && e.family === 'erlang-vm'));
});

test('detects Bash', () => {
  const r = extractProgLangs('Bash 5.2 is widely available');
  assert.ok(r.entries.some((e) => e.family === 'shell'));
});

test('dedupes identical entries', () => {
  const r = extractProgLangs('Python 3.12 and Python 3.12');
  assert.equal(r.entries.filter((e) => e.name === 'Python' && e.version === '3.12').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `Python 3.${i + 1} `;
  const r = extractProgLangs(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by family', () => {
  const r = extractProgLangs('Python 3.12, Java 17, Node.js 20, Rust 1.75');
  assert.ok(r.totals.scripting >= 1);
  assert.ok(r.totals.jvm >= 1);
  assert.ok(r.totals['js-runtime'] >= 1);
  assert.ok(r.totals.compiled >= 1);
});

test('buildProgLangsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'Python 3.12' },
    { name: 'b', extractedText: 'Go 1.21' },
  ];
  const r = buildProgLangsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderProgLangsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'spec.md', extractedText: 'Python 3.12' }];
  const r = buildProgLangsForFiles(files);
  const md = renderProgLangsBlock(r);
  assert.match(md, /^## PROGRAMMING/);
});

test('renderProgLangsBlock empty when nothing surfaces', () => {
  assert.equal(renderProgLangsBlock({ perFile: [] }), '');
  assert.equal(renderProgLangsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildProgLangsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Python 3.12' },
  ]);
  assert.equal(r.perFile.length, 1);
});
