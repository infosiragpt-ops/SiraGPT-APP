'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-doi-ids');
const { extractDoiIds, buildDoiIdsForFiles, renderDoiIdsBlock, _internal } = engine;
const { registrantOf } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDoiIds('').total, 0);
  assert.equal(extractDoiIds(null).total, 0);
});

test('registrantOf parses 10.NNNN prefix', () => {
  assert.equal(registrantOf('10.1038/nature12345'), '1038');
  assert.equal(registrantOf('10.5281/zenodo.123456'), '5281');
});

test('detects bare DOI', () => {
  const r = extractDoiIds('Cite: 10.1038/nature12345');
  assert.ok(r.entries.some((e) => /nature12345/.test(e.doi)));
});

test('detects labeled "doi: 10..."', () => {
  const r = extractDoiIds('doi: 10.1145/3568813.3568822');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('detects doi.org URL', () => {
  const r = extractDoiIds('https://doi.org/10.1038/nature12345');
  assert.ok(r.entries.some((e) => e.kind === 'url'));
});

test('detects dx.doi.org legacy URL', () => {
  const r = extractDoiIds('https://dx.doi.org/10.1145/3568813.3568822');
  assert.ok(r.entries.some((e) => e.kind === 'url'));
});

test('detects Zenodo DOI', () => {
  const r = extractDoiIds('Dataset: 10.5281/zenodo.7549981');
  assert.ok(r.entries.some((e) => e.registrant === '5281'));
});

test('captures registrant', () => {
  const r = extractDoiIds('10.1038/nature12345');
  const entry = r.entries[0];
  assert.equal(entry.registrant, '1038');
});

test('dedupes identical DOIs', () => {
  const r = extractDoiIds('10.1038/nature12345 here and again 10.1038/nature12345');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `10.1038/nature${10000 + i} `;
  const r = extractDoiIds(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractDoiIds('doi: 10.1038/aaaa and https://doi.org/10.1145/bbbb and 10.5281/cccc');
  assert.ok(r.totals.labeled >= 1);
  assert.ok(r.totals.url >= 1);
});

test('buildDoiIdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '10.1038/nature12345' },
    { name: 'b', extractedText: '10.1145/3568813.3568822' },
  ];
  const r = buildDoiIdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDoiIdsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'bib', extractedText: '10.1038/nature12345' }];
  const r = buildDoiIdsForFiles(files);
  const md = renderDoiIdsBlock(r);
  assert.match(md, /^## DOI/);
});

test('renderDoiIdsBlock empty when nothing surfaces', () => {
  assert.equal(renderDoiIdsBlock({ perFile: [] }), '');
  assert.equal(renderDoiIdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDoiIdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '10.1038/nature12345' },
  ]);
  assert.equal(r.perFile.length, 1);
});
