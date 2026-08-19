'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-definition-lists');
const { extractDefinitionLists, buildDefinitionListsForFiles, renderDefinitionListsBlock, _internal } = engine;
const { isLikelyTerm } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDefinitionLists('').total, 0);
  assert.equal(extractDefinitionLists(null).total, 0);
});

test('isLikelyTerm: rejects sentences', () => {
  assert.equal(isLikelyTerm('Foo'), true);
  assert.equal(isLikelyTerm('Foo Bar'), true);
  assert.equal(isLikelyTerm('The system is fast.'), false);
});

test('detects markdown definition list', () => {
  const text = `Latency
:   The time between request and response.

Throughput
:   The number of requests per second.`;
  const r = extractDefinitionLists(text);
  assert.equal(r.entries.length, 2);
  assert.ok(r.entries.some((e) => e.term === 'Latency'));
});

test('detects HTML dt/dd', () => {
  const text = '<dt>Latency</dt><dd>Time between request and response.</dd>';
  const r = extractDefinitionLists(text);
  assert.ok(r.entries.some((e) => e.term === 'Latency'));
});

test('dedupes identical terms', () => {
  const text = `Latency
:   Time delay.

Latency
:   Another definition.`;
  const r = extractDefinitionLists(text);
  // Same term + kind = dedupe
  assert.equal(r.entries.filter((e) => e.term === 'Latency').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `Term${i}\n:   Definition for term ${i}.\n\n`;
  const r = extractDefinitionLists(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractDefinitionLists('Latency\n:   Foo.\n<dt>Throughput</dt><dd>Bar throughput here.</dd>');
  assert.ok(r.totals.md >= 1);
  assert.ok(r.totals.html >= 1);
});

test('clips long definitions', () => {
  const long = 'A'.repeat(400);
  const r = extractDefinitionLists(`Term\n:   ${long}`);
  assert.ok(r.entries[0].definition.length <= 200);
});

test('rejects sentence-like terms', () => {
  const r = extractDefinitionLists(`The quick brown fox jumps over the lazy dog.\n:   Some definition follows.`);
  assert.equal(r.entries.length, 0);
});

test('buildDefinitionListsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Term1\n:   Def 1 of some length.' },
    { name: 'b.md', extractedText: '<dt>Term2</dt><dd>Def 2 of some length here.</dd>' },
  ];
  const r = buildDefinitionListsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDefinitionListsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Term\n:   Definition of some length.' }];
  const r = buildDefinitionListsForFiles(files);
  const md = renderDefinitionListsBlock(r);
  assert.match(md, /^## DEFINITION LISTS/);
});

test('renderDefinitionListsBlock empty when nothing surfaces', () => {
  assert.equal(renderDefinitionListsBlock({ perFile: [] }), '');
  assert.equal(renderDefinitionListsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDefinitionListsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Term\n:   Definition.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
