'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-arxiv-ids');
const { extractArxivIds, buildArxivIdsForFiles, renderArxivIdsBlock, _internal } = engine;
const { classifyYear } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractArxivIds('').total, 0);
  assert.equal(extractArxivIds(null).total, 0);
});

test('classifyYear: parses year prefix', () => {
  assert.equal(classifyYear('2401.12345'), 2024);
  assert.equal(classifyYear('0801.12345'), 2008);
});

test('detects arXiv:2401.12345', () => {
  const r = extractArxivIds('See arXiv:2401.12345 for details.');
  assert.ok(r.entries.some((e) => e.kind === 'new' && e.id === '2401.12345'));
});

test('detects arXiv URL', () => {
  const r = extractArxivIds('https://arxiv.org/abs/2401.12345');
  assert.ok(r.entries.some((e) => e.kind === 'new' && e.source === 'url'));
});

test('detects PDF URL variant', () => {
  const r = extractArxivIds('https://arxiv.org/pdf/2401.12345');
  assert.ok(r.entries.some((e) => e.source === 'url'));
});

test('detects version suffix v2', () => {
  const r = extractArxivIds('arXiv:2401.12345v2');
  assert.ok(r.entries.some((e) => e.version === '2'));
});

test('detects old-format id (cs.AI/0701001)', () => {
  const r = extractArxivIds('See cs.AI/0701001 for foundational work.');
  assert.ok(r.entries.some((e) => e.kind === 'old'));
});

test('captures year from new id', () => {
  const r = extractArxivIds('arXiv:2305.00001');
  const entry = r.entries[0];
  assert.equal(entry.year, 2023);
});

test('dedupes identical ids', () => {
  const r = extractArxivIds('arXiv:2401.12345 here and arXiv:2401.12345 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) {
    text += `arXiv:2401.${i.toString().padStart(5, '0')} `;
  }
  const r = extractArxivIds(text);
  assert.ok(r.entries.length <= 18);
});

test('counts versioned totals', () => {
  const r = extractArxivIds('arXiv:2401.12345v1 and arXiv:2401.12346v2');
  assert.ok(r.totals.versioned >= 2);
});

test('buildArxivIdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'arXiv:2401.12345' },
    { name: 'b', extractedText: 'arXiv:2402.54321' },
  ];
  const r = buildArxivIdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderArxivIdsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'bib.md', extractedText: 'arXiv:2401.12345' }];
  const r = buildArxivIdsForFiles(files);
  const md = renderArxivIdsBlock(r);
  assert.match(md, /^## arXiv/);
});

test('renderArxivIdsBlock empty when nothing surfaces', () => {
  assert.equal(renderArxivIdsBlock({ perFile: [] }), '');
  assert.equal(renderArxivIdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildArxivIdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'arXiv:2401.12345' },
  ]);
  assert.equal(r.perFile.length, 1);
});
