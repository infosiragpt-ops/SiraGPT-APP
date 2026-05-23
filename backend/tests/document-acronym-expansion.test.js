'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-acronym-expansion');
const { extractAcronymPairs, buildAcronymsForFiles, renderAcronymsBlock, _internal } = engine;
const { validPair } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractAcronymPairs('').total, 0);
  assert.equal(extractAcronymPairs(null).total, 0);
});

test('validPair: rejects bad expansions', () => {
  assert.equal(validPair('ABC', 'short'), false);
  assert.equal(validPair('XYZ', 'something with X Y Z chars'), true);
});

test('validPair: rejects when acronym letters do not appear in expansion', () => {
  assert.equal(validPair('XYZ', 'Some Random Phrase'), false);
});

test('detects "Expanded Form (ACR)" pattern', () => {
  const r = extractAcronymPairs('Acme Business Corporation (ABC) was founded in 1999.');
  assert.ok(r.pairs.some((p) => p.acronym === 'ABC' && /Acme Business Corporation/i.test(p.expansion)));
});

test('detects "ACR (Expanded Form)" pattern', () => {
  const r = extractAcronymPairs('ABC (Acme Business Corporation) reported strong growth.');
  assert.ok(r.pairs.some((p) => p.acronym === 'ABC'));
});

test('detects "hereinafter" English form', () => {
  const r = extractAcronymPairs('Acme Business Corporation, hereinafter ABC, will deliver.');
  assert.ok(r.pairs.some((p) => p.acronym === 'ABC'));
});

test('detects "en adelante" Spanish form', () => {
  const r = extractAcronymPairs('Acme Business Corporation, en adelante ABC, será responsable.');
  assert.ok(r.pairs.some((p) => p.acronym === 'ABC'));
});

test('dedupes same acronym across pattern types', () => {
  const r = extractAcronymPairs('Acme Business Corporation (ABC). ABC (Acme Business Corporation).');
  const acronyms = r.pairs.map((p) => p.acronym);
  const unique = new Set(acronyms);
  assert.equal(acronyms.length, unique.size);
});

test('caps pairs per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Foo Bar Corporation (FB${i}). `;
  const r = extractAcronymPairs(text);
  assert.ok(r.pairs.length <= 22);
});

test('rejects random proper-noun-paren collisions', () => {
  const r = extractAcronymPairs('John Smith (Director).');
  // "Director" doesn't share enough letters with "John Smith" to be valid
  assert.equal(r.pairs.length, 0);
});

test('buildAcronymsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Acme Business Corporation (ABC) leads the market.' },
    { name: 'b.md', extractedText: 'Customer Relationship Management (CRM) tools matter.' },
  ];
  const r = buildAcronymsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAcronymsBlock returns markdown when pairs exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Acme Business Corporation (ABC).' }];
  const r = buildAcronymsForFiles(files);
  const md = renderAcronymsBlock(r);
  assert.match(md, /^## ACRONYM EXPANSIONS/);
  assert.match(md, /ABC/);
});

test('renderAcronymsBlock empty when no pairs', () => {
  assert.equal(renderAcronymsBlock({ perFile: [] }), '');
  assert.equal(renderAcronymsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAcronymsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Acme Business Corp (ABC).' }]);
  assert.equal(r.perFile.length, 1);
});

test('aggregate contains source filenames', () => {
  const files = [{ name: 'doc.md', extractedText: 'Customer Relationship Management (CRM).' }];
  const r = buildAcronymsForFiles(files);
  assert.equal(r.aggregate[0].file, 'doc.md');
});
