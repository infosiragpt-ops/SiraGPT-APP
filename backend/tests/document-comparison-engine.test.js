'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-comparison-engine');
const { compareDocuments, renderComparisonBlock } = engine;

test('compareDocuments: returns null for fewer than 2 valid files', () => {
  assert.equal(compareDocuments([]), null);
  assert.equal(compareDocuments([{ extractedText: 'solo uno con suficiente contenido para análisis.' }]), null);
});

test('compareDocuments: tolerates non-array and malformed entries', () => {
  assert.equal(compareDocuments(null), null);
  assert.equal(compareDocuments([null, undefined, {}, { extractedText: '' }]), null);
});

test('compareDocuments: produces pairwise similarity for shared content', () => {
  const a = { originalName: 'a.txt', extractedText: 'Acme Corp firmó el contrato con Globex Inc el 2026-05-10. Presupuesto: $50,000 USD.' };
  const b = { originalName: 'b.txt', extractedText: 'Acme Corp y Globex Inc colaboran desde 2026-05-10. Presupuesto inicial: $50,000 USD.' };
  const r = compareDocuments([a, b]);
  assert.ok(r);
  assert.equal(r.fileCount, 2);
  assert.equal(r.pairs.length, 1);
  assert.ok(r.pairs[0].similarity > 0.2, `pair similarity ${r.pairs[0].similarity} should be > 0.2`);
});

test('compareDocuments: identifies shared entities across files', () => {
  const a = { originalName: 'a.txt', extractedText: 'Dr. Carlos Pérez de Acme Corp visitó Lima.' };
  const b = { originalName: 'b.txt', extractedText: 'Dr. Carlos Pérez también es asesor de Globex Inc.' };
  const r = compareDocuments([a, b]);
  assert.ok(r.entities.shared.persons.some((p) => /Carlos Pérez/.test(p.name)));
});

test('compareDocuments: identifies entities unique to each file', () => {
  const a = { originalName: 'a.txt', extractedText: 'Dr. Carlos Pérez trabaja con Acme Corp en Lima.' };
  const b = { originalName: 'b.txt', extractedText: 'Dra. Ana López colabora con Globex Inc en Madrid.' };
  const r = compareDocuments([a, b]);
  const aFile = r.entities.uniqueByFile.find((u) => u.file === 'a.txt');
  const bFile = r.entities.uniqueByFile.find((u) => u.file === 'b.txt');
  assert.ok(aFile.uniquePersons.some((p) => /Carlos/.test(p)));
  assert.ok(bFile.uniquePersons.some((p) => /Ana/.test(p)));
});

test('compareDocuments: builds chronological merged timeline', () => {
  const a = { originalName: 'a.txt', extractedText: 'La reunión inicial fue el 2026-01-15.' };
  const b = { originalName: 'b.txt', extractedText: 'El cierre es el 2026-12-20.' };
  const c = { originalName: 'c.txt', extractedText: 'El hito intermedio fue el 2026-06-10.' };
  const r = compareDocuments([a, b, c]);
  assert.ok(r.timeline.length >= 3);
  // First entry should be the earliest date (2026-01-15)
  assert.equal(r.timeline[0].date, '2026-01-15');
  // Last entry of those three should be 2026-12-20
  const dates = r.timeline.map((t) => t.date);
  assert.ok(dates.indexOf('2026-12-20') > dates.indexOf('2026-01-15'));
});

test('compareDocuments: detects numeric divergences for same labels', () => {
  const a = { originalName: 'a.txt', extractedText: 'Presupuesto total: $50,000 USD para el proyecto principal.' };
  const b = { originalName: 'b.txt', extractedText: 'Presupuesto total: $75,000 USD. Cambios aprobados.' };
  const r = compareDocuments([a, b]);
  assert.ok(r.numericConflicts.length >= 1, 'should detect at least one conflict');
  assert.ok(r.numericConflicts.some((c) => /presupuesto/i.test(c.label)));
});

test('compareDocuments: surfaces dominance ratio for skewed sets', () => {
  const big = { originalName: 'big.txt', extractedText: 'Lorem ipsum dolor sit amet. '.repeat(500) };
  const small = { originalName: 'small.txt', extractedText: 'Pequeño texto.' };
  const r = compareDocuments([big, small]);
  assert.ok(r.dominanceRatio > 0.9, `dominance should reflect skew, got ${r.dominanceRatio}`);
});

test('compareDocuments: caps file count at MAX_FILES_COMPARED', () => {
  const files = Array.from({ length: 30 }, (_, i) => ({
    originalName: `f${i}.txt`,
    extractedText: `Documento número ${i} con un poco de texto para tokenizar adecuadamente.`,
  }));
  const r = compareDocuments(files);
  assert.ok(r.fileCount <= 20, `expected ≤ 20 files compared, got ${r.fileCount}`);
});

test('renderComparisonBlock: returns empty string for null/single-file', () => {
  assert.equal(renderComparisonBlock(null), '');
  assert.equal(renderComparisonBlock({ fileCount: 1, pairs: [], entities: { shared: { persons: [], organizations: [] }, uniqueByFile: [] }, timeline: [], numericConflicts: [], kindCoverage: [], dominanceRatio: 0 }), '');
});

test('renderComparisonBlock: includes title and sections when populated', () => {
  const a = { originalName: 'memo-q1.md', extractedText: 'Acme Corp reportó ingresos de $1,200,000 USD en Q1 2026. Carlos Pérez lideró.' };
  const b = { originalName: 'memo-q2.md', extractedText: 'Acme Corp reportó ingresos de $1,500,000 USD en Q2 2026. Carlos Pérez sigue al mando.' };
  const r = compareDocuments([a, b]);
  const block = renderComparisonBlock(r);
  assert.match(block, /## CROSS-DOCUMENT SYNTHESIS/);
  assert.match(block, /memo-q1\.md/);
  assert.match(block, /Pairwise similarity/);
});

test('jaccard similarity: identical strings → 1, disjoint → 0', () => {
  const { jaccardSimilarity } = engine._internal;
  const text = 'Lorem ipsum dolor sit amet consectetur adipiscing';
  assert.equal(jaccardSimilarity(text, text), 1);
  assert.equal(jaccardSimilarity('alpha bravo charlie delta', 'whiskey tango foxtrot zulu'), 0);
});
