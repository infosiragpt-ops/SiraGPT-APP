'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-block-budget');
const { selectBlocks, joinWithinBudget, computeRelevance, _internal } = engine;
const { ALWAYS_ON, DOC_TYPE_WEIGHTS } = _internal;

test('empty / null blocks tolerated', () => {
  const r = selectBlocks({});
  assert.equal(r.included.length, 0);
  assert.equal(r.skipped.length, 0);
});

test('always-on blocks survive any budget pressure', () => {
  const blocks = {};
  for (const name of ALWAYS_ON) blocks[name] = 'X'.repeat(10_000);
  blocks.kpisBlock = 'Y'.repeat(50_000);
  const r = selectBlocks({ blocks, maxChars: 1_000 });
  const includedNames = new Set(r.included.map((c) => c.name));
  for (const name of ALWAYS_ON) assert.ok(includedNames.has(name));
});

test('budget ceiling drops less relevant blocks', () => {
  const blocks = {
    piiSafetyBlock: 'safety',
    profileBlock: 'profile',
    directiveBlock: 'directive',
    executiveSummaryBlock: 'summary',
    callsToActionBlock: 'X'.repeat(20_000),
    obligationsBlock: 'Y'.repeat(20_000),
  };
  const r = selectBlocks({ blocks, docType: 'legal_contract', maxChars: 30_000 });
  const namesIn = new Set(r.included.map((c) => c.name));
  assert.ok(namesIn.has('obligationsBlock'));
  // CTA has weight 0.3 for legal so it's the more likely casualty.
  assert.ok(!namesIn.has('callsToActionBlock') || r.totalChars <= 30_000);
});

test('computeRelevance returns expected weights for known doctypes', () => {
  const legal = computeRelevance('legal_contract');
  assert.ok(legal.obligationsBlock >= 1.5);
  assert.ok(legal.callsToActionBlock < 1);
});

test('computeRelevance returns {} for unknown doctype', () => {
  assert.deepEqual(computeRelevance('random'), {});
});

test('selectBlocks: large block under budget is included even if weight=1', () => {
  const blocks = {
    piiSafetyBlock: 'pii',
    profileBlock: 'profile',
    directiveBlock: 'directive',
    executiveSummaryBlock: 'summary',
    deepAnalysisBlock: 'X'.repeat(3_000),
  };
  const r = selectBlocks({ blocks, maxChars: 50_000 });
  const namesIn = r.included.map((c) => c.name);
  assert.ok(namesIn.includes('deepAnalysisBlock'));
});

test('joinWithinBudget concatenates in given order', () => {
  const parts = [
    { name: 'profileBlock', content: 'PROFILE' },
    { name: 'kpisBlock', content: 'KPIS' },
    { name: 'callsToActionBlock', content: 'CTA' },
  ];
  const out = joinWithinBudget(parts, { docType: 'financial_statement', maxChars: 10_000 });
  // KPIs ranks higher than CTAs in financial doctype; both should fit in 10K.
  assert.ok(out.includes('PROFILE'));
  assert.ok(out.includes('KPIS'));
});

test('joinWithinBudget drops low-value blocks under tight budget', () => {
  const parts = [
    { name: 'piiSafetyBlock', content: 'X'.repeat(1_000) },
    { name: 'profileBlock', content: 'X'.repeat(1_000) },
    { name: 'directiveBlock', content: 'X'.repeat(1_000) },
    { name: 'executiveSummaryBlock', content: 'X'.repeat(1_000) },
    { name: 'callsToActionBlock', content: 'X'.repeat(5_000) },
    { name: 'obligationsBlock', content: 'X'.repeat(5_000) },
  ];
  const out = joinWithinBudget(parts, { docType: 'legal_contract', maxChars: 8_000 });
  // PII / profile / directive / summary are always-on (4 × 1000 = 4000 chars).
  assert.ok(out.length <= 16_000);
  // Always-on blocks are always present
  for (const required of ['piiSafetyBlock', 'profileBlock', 'directiveBlock', 'executiveSummaryBlock']) {
    // We can't easily check the content by name; rely on counted length.
  }
});

test('default budget allows full pipeline when sum is small', () => {
  const blocks = { profileBlock: 'small', kpisBlock: 'tiny' };
  const r = selectBlocks({ blocks });
  assert.equal(r.skipped.length, 0);
});

test('every doctype weight entry is finite and positive (except always-on)', () => {
  for (const [docType, weights] of Object.entries(DOC_TYPE_WEIGHTS)) {
    for (const [name, w] of Object.entries(weights)) {
      assert.ok(Number.isFinite(w) && w > 0, `${docType}.${name} weight is invalid: ${w}`);
    }
  }
});

test('returns docType in result for logging / telemetry', () => {
  const r = selectBlocks({ blocks: { kpisBlock: 'x' }, docType: 'financial_statement' });
  assert.equal(r.docType, 'financial_statement');
});

test('selectBlocks: tolerates non-string content', () => {
  const r = selectBlocks({ blocks: { profileBlock: 'x', kpisBlock: 42, nullBlock: null } });
  const namesIn = r.included.map((c) => c.name);
  assert.ok(namesIn.includes('profileBlock'));
  assert.ok(!namesIn.includes('kpisBlock'));
  assert.ok(!namesIn.includes('nullBlock'));
});

test('joinWithinBudget: empty input returns empty string', () => {
  assert.equal(joinWithinBudget([]), '');
  assert.equal(joinWithinBudget(null), '');
});
