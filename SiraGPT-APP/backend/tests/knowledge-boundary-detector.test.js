'use strict';

// Tests for the knowledge-boundary detector — focused on the grounding match
// (a claim must only count as grounded on a real token match, not a substring),
// plus light smoke coverage of the previously-untested exports.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractClaims,
  detectBoundaries,
  classifyClaim,
  buildKnowledgeBoundaryPrompt,
} = require('../src/services/knowledge-boundary-detector');

test('classifyClaim grounds a value only on a whole-token match (not a substring)', () => {
  const claim = { value: '2023', kind: 'date_claim', contextSnippet: 'released in 2023' };
  // Standalone token → grounded.
  assert.equal(classifyClaim(claim, 'The product was released in 2023 officially.').status, 'grounded');
  // The same digits buried inside other numbers must NOT count as grounded.
  const buried = classifyClaim(claim, 'Build number 20231 and 12023 were tagged.');
  assert.notEqual(buried.status, 'grounded', 'a substring match must not ground the claim');
});

test('classifyClaim still grounds non-word-edge values (currency/percent) by substring', () => {
  // "$1,500" starts with a non-word char, so word-boundary anchoring is skipped
  // and it still grounds on a normal occurrence.
  const claim = { value: '$1,500', kind: 'number_claim', contextSnippet: 'cost $1,500' };
  assert.equal(classifyClaim(claim, 'The total cost was $1,500 last quarter.').status, 'grounded');
});

test('extractClaims pulls numbers/dates/named-entities/quotes', () => {
  const claims = extractClaims('Revenue reached 1500 USD in 2023 per "the official filing" by ACME Corp.');
  const kinds = new Set(claims.map((c) => c.kind));
  assert.ok(kinds.has('number_claim'), 'a "<n> USD" number claim is extracted');
  assert.ok(kinds.has('date_claim'));
  assert.ok(kinds.has('quotation'));
  assert.ok(kinds.has('named_entity_claim'));
});

test('detectBoundaries marks an ungrounded number as not-grounded and returns a risk score', () => {
  const report = detectBoundaries('The market will reach 87% adoption.', { documents: ['Unrelated context here.'] });
  assert.ok(Array.isArray(report.claims));
  assert.ok(typeof report.riskScore === 'number');
  const pct = report.claims.find((c) => /87/.test(String(c.value)));
  if (pct) assert.notEqual(pct.status, 'grounded');
});

test('buildKnowledgeBoundaryPrompt returns a string block (or empty) without throwing', () => {
  const report = detectBoundaries('Sales were $2,000 in 2024.', { documents: ['Sales were $2,000 in 2024.'] });
  const block = buildKnowledgeBoundaryPrompt(report);
  assert.equal(typeof block, 'string');
});
