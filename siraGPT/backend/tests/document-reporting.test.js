'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-reporting');
const { extractReporting, buildReportingForFiles, renderReportingBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractReporting('').total, 0);
  assert.equal(extractReporting(null).total, 0);
});

test('detects "said"', () => {
  const r = extractReporting('The CEO said the company will hit Q4 targets.');
  assert.ok(r.entries.some((e) => e.verb === 'said'));
});

test('detects "claimed"', () => {
  const r = extractReporting('The author claimed their results were robust.');
  assert.ok(r.entries.some((e) => e.verb === 'claimed'));
});

test('detects "found"', () => {
  const r = extractReporting('The study found significant correlations.');
  assert.ok(r.entries.some((e) => e.verb === 'found'));
});

test('detects "reported"', () => {
  const r = extractReporting('Reuters reported the outage at 9am.');
  assert.ok(r.entries.some((e) => e.verb === 'reported'));
});

test('detects "concluded"', () => {
  const r = extractReporting('Researchers concluded that the model is biased.');
  assert.ok(r.entries.some((e) => e.verb === 'concluded'));
});

test('detects Spanish "dijo"', () => {
  const r = extractReporting('El CEO dijo que la empresa logrará los objetivos.');
  assert.ok(r.entries.some((e) => e.verb === 'dijo'));
});

test('detects Spanish "afirmó"', () => {
  const r = extractReporting('El autor afirmó que sus resultados son robustos.');
  assert.ok(r.entries.some((e) => /afirm[óo]/.test(e.verb)));
});

test('detects "reportó"', () => {
  const r = extractReporting('Reuters reportó el incidente a las 9am.');
  assert.ok(r.entries.some((e) => /report[óo]/.test(e.verb)));
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Author ${i} said hello. `;
  const r = extractReporting(text);
  assert.ok(r.entries.length <= 22);
});

test('buildReportingForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'They said yes.' },
    { name: 'b.md', extractedText: 'The study found x.' },
  ];
  const r = buildReportingForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderReportingBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'They said yes.' }];
  const r = buildReportingForFiles(files);
  const md = renderReportingBlock(r);
  assert.match(md, /^## REPORTING VERBS/);
});

test('renderReportingBlock empty when nothing surfaces', () => {
  assert.equal(renderReportingBlock({ perFile: [] }), '');
  assert.equal(renderReportingBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildReportingForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'They said yes.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
