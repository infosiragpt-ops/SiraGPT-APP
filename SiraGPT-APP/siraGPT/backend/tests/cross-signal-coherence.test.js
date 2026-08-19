'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreCoherence, renderCoherenceBlock } = require('../src/services/sira/cross-signal-coherence');

test('scoreCoherence: empty signals → coherent', () => {
  const r = scoreCoherence({});
  assert.equal(r.verdict, 'coherent');
  assert.equal(r.score, 100);
  assert.equal(r.flags.length, 0);
});

test('scoreCoherence: answer passes but hallucination=high → blocking flag', () => {
  const r = scoreCoherence({
    answer: { score: 0.92 },
    hallucination: { overallRisk: 'high', totalFlags: 5 },
  });
  assert.ok(r.flags.some(f => f.code === 'answer_passes_but_hallucination_high'));
  assert.equal(r.summary.blocking, 1);
  assert.equal(r.verdict, 'incoherent');
});

test('scoreCoherence: intent academic_paper + classification invoice → warning', () => {
  const r = scoreCoherence({
    intent: { id: 'research_with_citations' },
    classification: { type: 'invoice' },
  });
  assert.ok(r.flags.some(f => f.code === 'intent_vs_classification_mismatch'));
});

test('scoreCoherence: general_document classification does NOT trigger mismatch', () => {
  const r = scoreCoherence({
    intent: { id: 'research_with_citations' },
    classification: { type: 'general_document' },
  });
  assert.ok(!r.flags.some(f => f.code === 'intent_vs_classification_mismatch'));
});

test('scoreCoherence: quality vs answer drift triggers warning', () => {
  const r = scoreCoherence({
    quality: { overall: 95 },
    answer: { score: 0.35 },
  });
  assert.ok(r.flags.some(f => f.code === 'quality_vs_answer_drift'));
});

test('scoreCoherence: insights lack evidence for declared classification', () => {
  const r = scoreCoherence({
    classification: { type: 'academic_paper' },
    insights: {
      bibliographic: { dois: [], isbns: [], arxivIds: [] },
    },
  });
  assert.ok(r.flags.some(f => f.code === 'classification_lacks_evidence'));
});

test('scoreCoherence: bank_statement with no money entries flags', () => {
  const r = scoreCoherence({
    classification: { type: 'bank_statement' },
    insights: { numbers: { money: [] } },
  });
  assert.ok(r.flags.some(f => f.code === 'classification_lacks_evidence'));
});

test('scoreCoherence: legal_contract without orgs flags', () => {
  const r = scoreCoherence({
    classification: { type: 'legal_contract' },
    insights: { entities: { organizations: [] } },
  });
  assert.ok(r.flags.some(f => f.code === 'classification_lacks_evidence'));
});

test('scoreCoherence: retrieval has no evidence but hallucination flags > 0', () => {
  const r = scoreCoherence({
    retrieval: { has_evidence: false },
    hallucination: { totalFlags: 3 },
  });
  assert.ok(r.flags.some(f => f.code === 'no_evidence_but_flagged_claims'));
});

test('scoreCoherence: clarification needed but answer passes', () => {
  const r = scoreCoherence({
    intent: { needs_clarification: true },
    answer: { score: 0.85 },
  });
  assert.ok(r.flags.some(f => f.code === 'clarification_needed_but_answer_passes'));
});

test('scoreCoherence: low intent confidence + high answer = suspect (info)', () => {
  const r = scoreCoherence({
    intent: { confidence: 0.2 },
    answer: { score: 0.95 },
  });
  assert.ok(r.flags.some(f => f.code === 'low_intent_high_answer'));
});

test('scoreCoherence: multiple flags accumulate score deduction', () => {
  const r = scoreCoherence({
    answer: { score: 0.9 },
    hallucination: { overallRisk: 'high', totalFlags: 4 },        // blocking
    quality: { overall: 95 },                                      // drift warning
    intent: { id: 'research_with_citations' },
    classification: { type: 'invoice' },                          // mismatch warning
  });
  assert.ok(r.score < 60);
  assert.equal(r.verdict, 'incoherent');
});

test('scoreCoherence: returns grade A for clean coherent state', () => {
  const r = scoreCoherence({
    intent: { id: 'analyze_document', confidence: 0.9 },
    classification: { type: 'legal_contract' },
    insights: {
      entities: { organizations: ['Acme Corp.'] },
    },
    answer: { score: 0.92 },
    hallucination: { overallRisk: 'low', totalFlags: 0 },
    quality: { overall: 88 },
  });
  assert.equal(r.grade, 'A');
});

test('scoreCoherence: tolerates malformed signal objects', () => {
  const r = scoreCoherence({
    intent: 'not_an_object',
    answer: null,
    hallucination: 42,
  });
  assert.ok(['coherent', 'partially_coherent', 'incoherent'].includes(r.verdict));
});

test('renderCoherenceBlock: emits coherent verdict when no flags', () => {
  const r = scoreCoherence({});
  const block = renderCoherenceBlock(r);
  assert.match(block, /coherent/);
});

test('renderCoherenceBlock: lists each flag with severity icon', () => {
  const r = scoreCoherence({
    answer: { score: 0.95 },
    hallucination: { overallRisk: 'high' },
  });
  const block = renderCoherenceBlock(r);
  assert.match(block, /CROSS-SIGNAL COHERENCE/);
  assert.match(block, /Verdict:/);
  assert.match(block, /answer_passes_but_hallucination_high/);
});

test('renderCoherenceBlock: returns empty string when report is null', () => {
  assert.equal(renderCoherenceBlock(null), '');
});
