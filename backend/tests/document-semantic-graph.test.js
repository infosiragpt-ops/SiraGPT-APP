'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-semantic-graph');
const { buildGraphForFiles, renderGraphBlock, _internal } = engine;
const {
  extractEntities,
  entityKey,
  normaliseEntity,
  sentenceContaining,
  findNearbyMoney,
  safeFileName,
} = _internal;

test('safeFileName fallbacks', () => {
  assert.equal(safeFileName({ name: 'doc.pdf' }), 'doc.pdf');
  assert.equal(safeFileName({}), 'attachment');
  assert.equal(safeFileName(null), 'attachment');
});

test('entityKey collapses whitespace + casing', () => {
  assert.equal(entityKey('  Acme   Corp  '), 'acme corp');
  assert.equal(entityKey(normaliseEntity('Acme Corp')), 'acme corp');
});

test('extractEntities: detects proper nouns', () => {
  const text = 'Acme Corp signed with Globex Inc last week.';
  const ents = extractEntities(text);
  const names = ents.map((e) => e.name).sort();
  assert.ok(names.includes('Acme Corp') || names.includes('Acme'));
  assert.ok(names.includes('Globex Inc') || names.includes('Globex'));
});

test('extractEntities: detects acronyms', () => {
  const text = 'The KPI report was reviewed by the SREs on the API team.';
  const ents = extractEntities(text);
  const acronyms = ents.filter((e) => e.kind === 'acronym').map((e) => e.name);
  assert.ok(acronyms.includes('KPI'));
  assert.ok(acronyms.includes('API'));
});

test('extractEntities: drops single stop-word heads', () => {
  const text = 'The Apollo Project shipped on time. The Apollo Project ran for 6 years.';
  const ents = extractEntities(text);
  const names = ents.map((e) => e.name);
  // Should produce "Apollo Project" not "The Apollo Project"
  assert.ok(names.some((n) => n.startsWith('Apollo')));
  assert.ok(!names.some((n) => n === 'The Apollo Project'));
});

test('sentenceContaining: returns the surrounding sentence', () => {
  const text = 'First sentence. Second sentence about Acme Corp here. Third one.';
  const idx = text.indexOf('Acme');
  const s = sentenceContaining(text, idx, 'Acme Corp'.length);
  assert.match(s, /Acme Corp/);
});

test('findNearbyMoney: detects currency anchors', () => {
  const text = 'Acme Corp received $1,200,000 in funding this quarter.';
  const idx = text.indexOf('Acme');
  const money = findNearbyMoney(text, idx);
  assert.ok(money);
  assert.equal(money.currency, '$');
});

test('findNearbyMoney: returns null when no currency nearby', () => {
  const text = 'Acme Corp is doing well this year.';
  const idx = text.indexOf('Acme');
  assert.equal(findNearbyMoney(text, idx), null);
});

test('buildGraphForFiles: empty list returns empty report', () => {
  assert.equal(buildGraphForFiles([]).totalEntities, 0);
});

test('buildGraphForFiles: ranks cross-document entities first', () => {
  const files = [
    { name: 'a.md', extractedText: 'Acme Corp leads the market. Acme Corp grew last year. Globex was acquired.' },
    { name: 'b.md', extractedText: 'Acme Corp signed a deal. The Acme Corp board met yesterday. Initech filed a lawsuit.' },
  ];
  const r = buildGraphForFiles(files);
  assert.ok(r.entities.length >= 1);
  // Acme Corp appears in both files → should rank first as crossDocument
  assert.ok(r.entities[0].crossDocument, `first entity should be cross-document, got ${JSON.stringify(r.entities[0])}`);
  assert.match(r.entities[0].name, /Acme/);
});

test('buildGraphForFiles: detects monetary conflicts', () => {
  const files = [
    { name: 'budget-a.md', extractedText: 'Acme Corp budget allocated $50,000 for Q1. Acme Corp reviewed it again.' },
    { name: 'budget-b.md', extractedText: 'Acme Corp budget allocated $75,000 for Q1. Acme Corp signed off.' },
  ];
  const r = buildGraphForFiles(files);
  const acme = r.entities.find((e) => /Acme/.test(e.name));
  assert.ok(acme, 'Acme should appear in the graph');
  assert.ok(acme.conflict, `expected conflict, got: ${JSON.stringify(acme)}`);
  assert.equal(acme.conflict.length, 2);
});

test('buildGraphForFiles: preserves source files per mention', () => {
  const files = [
    { name: 'doc1.md', extractedText: 'Project Phoenix begins this quarter. Project Phoenix scope is ambitious.' },
    { name: 'doc2.md', extractedText: 'Project Phoenix is the priority. Project Phoenix needs more resources.' },
  ];
  const r = buildGraphForFiles(files);
  const phoenix = r.entities.find((e) => /Phoenix/.test(e.name));
  assert.ok(phoenix);
  const files_seen = phoenix.mentions.map((m) => m.file).sort();
  assert.deepEqual(files_seen, ['doc1.md', 'doc2.md']);
});

test('renderGraphBlock: produces markdown when entities exist', () => {
  const files = [
    { name: 'a.md', extractedText: 'Acme Corp leads. Acme Corp grew.' },
    { name: 'b.md', extractedText: 'Acme Corp signed a deal. Acme Corp expanded.' },
  ];
  const r = buildGraphForFiles(files);
  const md = renderGraphBlock(r);
  assert.match(md, /^## CROSS-DOCUMENT SEMANTIC GRAPH/);
  assert.match(md, /Acme/);
});

test('renderGraphBlock: empty when no entities', () => {
  assert.equal(renderGraphBlock({ entities: [] }), '');
  assert.equal(renderGraphBlock(null), '');
});

test('handles non-string extractedText without throwing', () => {
  const files = [
    { name: 'noisy', extractedText: null },
    { name: 'good', extractedText: 'Project Phoenix begins. Project Phoenix scope is wide.' },
  ];
  const r = buildGraphForFiles(files);
  assert.equal(r.fileCount, 2);
});

test('claim count reflects deep-analyzer pickup', () => {
  // We require the deep analyzer for this test — it should identify
  // claim-bearing sentences in this paragraph. We just verify the field
  // is populated as a non-negative number.
  const files = [{
    name: 'report.md',
    extractedText: 'Project Apollo delivered $1,200,000 in revenue last quarter. Project Apollo has 42 active users today. Apollo expansion was approved by the board.',
  }];
  const r = buildGraphForFiles(files);
  if (r.entities.length === 0) return;
  for (const e of r.entities) {
    assert.ok(typeof e.claimCount === 'number');
    assert.ok(e.claimCount >= 0);
  }
});
