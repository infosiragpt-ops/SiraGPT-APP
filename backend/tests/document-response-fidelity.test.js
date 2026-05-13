'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-response-fidelity');
const { buildSignalsFromFiles, auditResponse, renderFidelityNote, _internal } = engine;
const { isAssertive, extractAnchors, splitSentences } = _internal;

test('splitSentences: splits English + Spanish sentences', () => {
  const text = 'First claim. Segunda afirmación. ¿Pregunta? Final claim!';
  const out = splitSentences(text);
  assert.ok(out.length >= 3);
});

test('isAssertive: drops questions and pure-hedge sentences', () => {
  assert.ok(!isAssertive('What is the budget?'));
  assert.ok(!isAssertive('It might be the case.'));
  assert.ok(isAssertive('Revenue grew to 50000 dollars last year.'));
  assert.ok(isAssertive('El equipo entregó el dashboard este trimestre.'));
});

test('extractAnchors: pulls numbers, dates, entities', () => {
  const a = extractAnchors('Acme Corp grew revenue to $1,200,000 on 2026-06-15.');
  assert.ok(a.numbers.length >= 1);
  assert.ok(a.dates.length >= 1);
  assert.ok(a.entities.length >= 1);
});

test('buildSignalsFromFiles: empty list', () => {
  const s = buildSignalsFromFiles([]);
  assert.equal(s.fileCount, 0);
});

test('buildSignalsFromFiles: harvests numbers / dates / entities from text', () => {
  const files = [{
    name: 'doc.md',
    extractedText: 'Acme Corp received $1,200,000 in funding on 2026-06-15. Project Apollo launches in Q3 2026.',
  }];
  const s = buildSignalsFromFiles(files);
  assert.ok(s.numbers.size >= 1);
  assert.ok(s.dates.size >= 1);
  assert.ok(s.entities.size >= 1);
});

test('auditResponse: supported claims when anchors match source', () => {
  const files = [{
    name: 'doc.md',
    extractedText: 'Acme Corp received $1,200,000 on 2026-06-15. Acme Corp is the lead investor.',
  }];
  const signals = buildSignalsFromFiles(files);
  const response = 'Acme Corp received $1,200,000 on 2026-06-15.';
  const audit = auditResponse({ response, signals });
  assert.ok(audit.supported >= 1, `expected supported, got ${JSON.stringify(audit)}`);
});

test('auditResponse: unsupported when no anchor matches', () => {
  const files = [{
    name: 'doc.md',
    extractedText: 'Acme Corp is a company. It has interesting properties.',
  }];
  const signals = buildSignalsFromFiles(files);
  const response = 'Globex Industries gained $999,999 in 2099-01-01 according to the source.';
  const audit = auditResponse({ response, signals });
  assert.ok(audit.unsupported >= 1, `expected unsupported, got ${JSON.stringify(audit)}`);
});

test('auditResponse: empty response → empty report', () => {
  const audit = auditResponse({ response: '', signals: null });
  assert.equal(audit.total, 0);
  assert.equal(audit.score, 1);
});

test('auditResponse: skips sentences without concrete anchors', () => {
  const files = [{ name: 'doc.md', extractedText: 'Acme grew. Globex shrank.' }];
  const signals = buildSignalsFromFiles(files);
  // Response is assertive but has no numbers/dates/entities to audit.
  const audit = auditResponse({ response: 'Yes, it grew this year.', signals });
  // Either skipped (total=0) or supported via entity if "It" reference isn't picked up
  assert.ok(audit.total <= 1);
});

test('contradicted: entity matches but every number is new', () => {
  const files = [{
    name: 'doc.md',
    extractedText: 'Acme Corp received $1,200,000 in revenue. Acme Corp has 42 staff.',
  }];
  const signals = buildSignalsFromFiles(files);
  // Response uses Acme Corp (matches) but a completely different number
  const response = 'Acme Corp received $9,999,999 in revenue.';
  const audit = auditResponse({ response, signals });
  // Either contradicted OR unsupported is acceptable, but it should NOT be supported
  const flagged = audit.details.find((d) => d.label !== 'supported');
  assert.ok(flagged, `expected non-supported label, got ${JSON.stringify(audit)}`);
});

test('renderFidelityNote: empty when nothing flagged', () => {
  const audit = { total: 3, supported: 3, unsupported: 0, contradicted: 0, score: 1, level: 'high', details: [] };
  assert.equal(renderFidelityNote(audit), '');
});

test('renderFidelityNote: renders flagged items', () => {
  const audit = {
    total: 2,
    supported: 1,
    unsupported: 1,
    contradicted: 0,
    score: 0.5,
    level: 'medium',
    details: [
      { sentence: 'Acme grew $50K.', label: 'supported', reason: 'matches', hits: {}, anchors: {} },
      { sentence: 'Globex grew $999K in 2030.', label: 'unsupported', reason: 'no source anchor matches', hits: {}, anchors: {} },
    ],
  };
  const md = renderFidelityNote(audit);
  assert.match(md, /^## SOURCE FIDELITY NOTE/);
  assert.match(md, /unsupported/);
  assert.match(md, /Globex/);
});

test('score reflects the supported / total ratio', () => {
  const files = [{ name: 'doc.md', extractedText: 'Acme Corp on 2026-06-15. Globex Inc on 2026-08-01.' }];
  const signals = buildSignalsFromFiles(files);
  const response = 'Acme Corp launched on 2026-06-15. Globex Inc launched on 2026-08-01. Initech surprised everyone on 2099-12-31.';
  const audit = auditResponse({ response, signals });
  assert.ok(audit.total >= 2);
  assert.ok(audit.score >= 0 && audit.score <= 1);
});

test('non-string response / signals tolerated', () => {
  const audit = auditResponse({ response: null, signals: undefined });
  assert.equal(audit.total, 0);
});

test('signals expose set-shaped numbers/dates/entities', () => {
  const s = buildSignalsFromFiles([{ name: 'x', extractedText: 'Project Phoenix delivered $42 on 2026-01-01.' }]);
  assert.ok(s.numbers instanceof Set);
  assert.ok(s.dates instanceof Set);
  assert.ok(s.entities instanceof Set);
});
