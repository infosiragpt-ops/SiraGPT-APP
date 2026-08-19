'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-taxa');
const { extractTaxa, buildTaxaForFiles, renderTaxaBlock, _internal } = engine;
const { isLikelyTaxon } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTaxa('').total, 0);
  assert.equal(extractTaxa(null).total, 0);
});

test('isLikelyTaxon: valid forms', () => {
  assert.equal(isLikelyTaxon('Homo sapiens'), true);
  assert.equal(isLikelyTaxon('Escherichia coli'), true);
  assert.equal(isLikelyTaxon('New York'), false);
  assert.equal(isLikelyTaxon('Hi yes'), false);
});

test('detects italic *Homo sapiens*', () => {
  const r = extractTaxa('Homo: *Homo sapiens* genome study.');
  assert.ok(r.entries.some((e) => e.kind === 'italic' && /Homo sapiens/.test(e.name)));
});

test('detects italic _Escherichia coli_', () => {
  const r = extractTaxa('Found in _Escherichia coli_ samples.');
  assert.ok(r.entries.some((e) => e.kind === 'italic'));
});

test('detects bare binomial Canis lupus', () => {
  const r = extractTaxa('Canis lupus is the wolf.');
  assert.ok(r.entries.some((e) => e.kind === 'binomial' && /Canis lupus/.test(e.name)));
});

test('detects family Asteraceae', () => {
  const r = extractTaxa('Plant family Asteraceae is large.');
  assert.ok(r.entries.some((e) => e.kind === 'family'));
});

test('detects family Hominidae', () => {
  const r = extractTaxa('Family Hominidae includes apes.');
  assert.ok(r.entries.some((e) => e.kind === 'family'));
});

test('rejects "New York" as taxon', () => {
  const r = extractTaxa('Visiting New York next week.');
  assert.equal(r.entries.filter((e) => /New york/i.test(e.name)).length, 0);
});

test('counts byKind', () => {
  const r = extractTaxa('Studying *Homo sapiens* and Canis lupus and Asteraceae.');
  assert.ok(r.totals.italic >= 1);
  assert.ok(r.totals.binomial >= 1);
  assert.ok(r.totals.family >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Genus${i}name species${i}name. `;
  const r = extractTaxa(text);
  assert.ok(r.entries.length <= 18);
});

test('buildTaxaForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '*Homo sapiens*' },
    { name: 'b.md', extractedText: 'Canis lupus' },
  ];
  const r = buildTaxaForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTaxaBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '*Homo sapiens*' }];
  const r = buildTaxaForFiles(files);
  const md = renderTaxaBlock(r);
  assert.match(md, /^## BIOLOGICAL TAXA/);
});

test('renderTaxaBlock empty when nothing surfaces', () => {
  assert.equal(renderTaxaBlock({ perFile: [] }), '');
  assert.equal(renderTaxaBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTaxaForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '*Homo sapiens*' },
  ]);
  assert.equal(r.perFile.length, 1);
});
