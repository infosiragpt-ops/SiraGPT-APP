'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-decision-records');
const { extractDecisionRecords, buildDecisionRecordsForFiles, renderDecisionRecordsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractDecisionRecords('').total, 0);
  assert.equal(extractDecisionRecords(null).total, 0);
});

test('detects Decision: line', () => {
  const r = extractDecisionRecords('Decision: Adopt OpenAPI for all new services.');
  assert.ok(r.records.some((rec) => rec.field === 'decision' && /OpenAPI/.test(rec.value)));
});

test('detects Context: line', () => {
  const r = extractDecisionRecords('Context: The team needs a standard spec format.');
  assert.ok(r.records.some((rec) => rec.field === 'context'));
});

test('detects Consequences: line', () => {
  const r = extractDecisionRecords('Consequences: Migration effort estimated at 3 weeks.');
  assert.ok(r.records.some((rec) => rec.field === 'consequences'));
});

test('detects Alternatives Considered: line', () => {
  const r = extractDecisionRecords('Alternatives Considered: GraphQL, gRPC, JSON-RPC.');
  assert.ok(r.records.some((rec) => rec.field === 'alternatives'));
});

test('detects Trade-offs: line', () => {
  const r = extractDecisionRecords('Trade-offs: Higher upfront cost vs. long-term maintainability.');
  assert.ok(r.records.some((rec) => rec.field === 'tradeoffs'));
});

test('detects Rationale: line', () => {
  const r = extractDecisionRecords('Rationale: Aligns with industry standards.');
  assert.ok(r.records.some((rec) => rec.field === 'rationale'));
});

test('detects Spanish Decisión', () => {
  const r = extractDecisionRecords('Decisión: Usar OpenAPI para todos los nuevos servicios.');
  assert.ok(r.records.some((rec) => rec.field === 'decision'));
});

test('detects Spanish Contexto + Consecuencias', () => {
  const r = extractDecisionRecords('Contexto: Necesitamos un estándar.\nConsecuencias: Esfuerzo de migración.');
  assert.ok(r.records.some((rec) => rec.field === 'context'));
  assert.ok(r.records.some((rec) => rec.field === 'consequences'));
});

test('detects headers like "## Decision"', () => {
  const r = extractDecisionRecords('## Decision: Adopt the new system.');
  assert.ok(r.records.some((rec) => rec.field === 'decision'));
});

test('counts byField totals', () => {
  const text = `Decision: A
Context: B
Consequences: C
Alternatives: D`;
  const r = extractDecisionRecords(text);
  assert.equal(r.byField.decision, 1);
  assert.equal(r.byField.context, 1);
  assert.equal(r.byField.consequences, 1);
  assert.equal(r.byField.alternatives, 1);
});

test('dedupes identical records', () => {
  const r = extractDecisionRecords('Decision: Foo\nDecision: Foo');
  assert.equal(r.records.filter((rec) => rec.field === 'decision').length, 1);
});

test('caps records per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Decision: option ${i}\n`;
  const r = extractDecisionRecords(text);
  assert.ok(r.records.length <= 12);
});

test('buildDecisionRecordsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Decision: Use Foo.' },
    { name: 'b.md', extractedText: 'Context: Need scale.' },
  ];
  const r = buildDecisionRecordsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDecisionRecordsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Decision: Adopt OpenAPI.' }];
  const r = buildDecisionRecordsForFiles(files);
  const md = renderDecisionRecordsBlock(r);
  assert.match(md, /^## DECISION RECORDS/);
});

test('renderDecisionRecordsBlock empty when nothing surfaces', () => {
  assert.equal(renderDecisionRecordsBlock({ perFile: [] }), '');
  assert.equal(renderDecisionRecordsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDecisionRecordsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Decision: foo' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('ignores arbitrary "Foo: bar" non-ADR lines', () => {
  const r = extractDecisionRecords('Description: Some text.\nNotes: Another.');
  assert.equal(r.total, 0);
});

test('clips very long values', () => {
  const long = 'A'.repeat(400);
  const r = extractDecisionRecords(`Decision: ${long}`);
  assert.ok(r.records[0].value.length <= 260);
});
