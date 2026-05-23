'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-scope-exclusions');
const { extractScope, buildScopeForFiles, renderScopeBlock, _internal } = engine;
const { matchAny, SCOPE_PATTERNS, EXCLUSION_PATTERNS } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractScope('').total, 0);
  assert.equal(extractScope(null).total, 0);
});

test('matchAny: scope keyword detection', () => {
  assert.ok(matchAny('The scope of work covers the design phase.', SCOPE_PATTERNS));
  assert.ok(matchAny('El alcance incluye la fase de diseño.', SCOPE_PATTERNS));
});

test('matchAny: exclusion keyword detection', () => {
  assert.ok(matchAny('The contract excludes hosting fees.', EXCLUSION_PATTERNS));
  assert.ok(matchAny('Quedan fuera del alcance los gastos de viaje.', EXCLUSION_PATTERNS));
});

test('extractScope: separates included from excluded', () => {
  const text = `The scope of work covers design, development, and deployment. The contract excludes hosting fees and third-party licenses.`;
  const r = extractScope(text);
  assert.ok(r.included.length >= 1);
  assert.ok(r.excluded.length >= 1);
});

test('extractScope: Spanish text', () => {
  const text = 'El alcance incluye diseño, desarrollo y soporte. Quedan excluidos los gastos de viaje y el hosting.';
  const r = extractScope(text);
  assert.ok(r.included.length >= 1);
  assert.ok(r.excluded.length >= 1);
});

test('extractScope: exclusion phrase "does not include" goes to excluded bucket', () => {
  const text = 'The platform covers analytics. The platform does not include security audits.';
  const r = extractScope(text);
  assert.ok(r.excluded.length >= 1);
  assert.ok(r.excluded[0].sentence.toLowerCase().includes('does not'));
});

test('dedupes identical sentences', () => {
  const text = 'The scope covers analytics. The scope covers analytics. The scope covers analytics.';
  const r = extractScope(text);
  assert.equal(r.included.length, 1);
});

test('buildScopeForFiles aggregates across files', () => {
  const files = [
    { name: 'a.md', extractedText: 'The scope covers design.' },
    { name: 'b.md', extractedText: 'The contract excludes hosting fees.' },
  ];
  const r = buildScopeForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.included.length + r.aggregate.excluded.length >= 2);
});

test('renderScopeBlock returns markdown when items exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'The scope covers design. The contract excludes hosting fees.' }];
  const r = buildScopeForFiles(files);
  const md = renderScopeBlock(r);
  assert.match(md, /^## DOCUMENT SCOPE & EXCLUSIONS/);
});

test('renderScopeBlock empty when nothing found', () => {
  assert.equal(renderScopeBlock({ perFile: [] }), '');
  assert.equal(renderScopeBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildScopeForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'The scope covers analytics.' }]);
  assert.equal(r.perFile.length, 1);
});

test('caps items per kind to safe maximum', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`The scope covers area ${i} which is part of the system.`);
  const r = extractScope(lines.join(' '));
  assert.ok(r.included.length <= 8);
});

test('preserves source sentence intact', () => {
  const r = extractScope('The platform covers analytics dashboards and quarterly reports.');
  assert.match(r.included[0].sentence, /analytics dashboards/);
});

test('source label propagates through aggregate', () => {
  const files = [{ name: 'doc.md', extractedText: 'The scope covers analytics.' }];
  const r = buildScopeForFiles(files);
  assert.equal(r.aggregate.included[0].file, 'doc.md');
});
