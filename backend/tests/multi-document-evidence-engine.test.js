'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEvidenceChain,
  detectContradictions,
  detectComplementary,
  computeAlignment,
  buildCrossAnalysisReport,
  jaccard,
} = require('../src/services/multi-document-evidence-engine');

test('exports the documented surface', () => {
  for (const fn of [buildEvidenceChain, detectContradictions, detectComplementary, computeAlignment, buildCrossAnalysisReport, jaccard]) {
    assert.equal(typeof fn, 'function');
  }
});

test('jaccard returns 0 for two empty sets', () => {
  assert.equal(jaccard([], []), 0);
});

test('jaccard returns 1 for identical sets', () => {
  assert.equal(jaccard(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
});

test('jaccard returns 0 for disjoint sets', () => {
  assert.equal(jaccard(['a', 'b'], ['c', 'd']), 0);
});

test('jaccard handles partial overlap', () => {
  // {a,b,c} ∩ {b,c,d} = {b,c} (2); union = {a,b,c,d} (4); j = 2/4 = 0.5
  assert.equal(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
});

test('buildEvidenceChain returns empty result for fewer than 2 documents', () => {
  assert.deepEqual(buildEvidenceChain([], []), { chains: [], crossReferences: [] });
  assert.deepEqual(buildEvidenceChain([{ id: 'a' }], [{}]), { chains: [], crossReferences: [] });
  assert.deepEqual(buildEvidenceChain(null, []), { chains: [], crossReferences: [] });
});

test('buildEvidenceChain computes pair-wise similarity for every pair of documents', () => {
  const docs = [
    { id: 'd1', text: 'this is a financial report about quarterly revenue and growth' },
    { id: 'd2', text: 'this is a financial report about quarterly revenue and decline' },
    { id: 'd3', text: 'pizza recipes for cooking' },
  ];
  const out = buildEvidenceChain(docs, [{}, {}, {}]);
  // 3 docs → 3 pairs (1-2, 1-3, 2-3)
  assert.equal(out.chains.length, 3);
  // d1↔d2 should be much more similar than d1↔d3
  const d12 = out.chains.find(c => c.docA.id === 'd1' && c.docB.id === 'd2');
  const d13 = out.chains.find(c => c.docA.id === 'd1' && c.docB.id === 'd3');
  assert.ok(d12.similarity > d13.similarity);
});

test('buildEvidenceChain surfaces shared entities and capped at 15', () => {
  const docs = [{ id: 'd1', text: 'x' }, { id: 'd2', text: 'y' }];
  const big = Array.from({ length: 30 }, (_, i) => ({ type: 'org', value: `Company${i}` }));
  const out = buildEvidenceChain(docs, [{ entities: big }, { entities: big }]);
  assert.ok(out.chains[0].sharedEntities.length <= 15);
});

test('detectContradictions returns [] when one of the inputs is missing', () => {
  assert.deepEqual(detectContradictions(null, {}), []);
  assert.deepEqual(detectContradictions({}, null), []);
});

test('detectContradictions flags numeric conflicts (same label, different value)', () => {
  const a = { entities: [{ type: 'money', value: '100' }] };
  const b = { entities: [{ type: 'money', value: '500' }] };
  const out = detectContradictions(a, b);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'numeric_conflict');
  assert.equal(out[0].label, 'money');
  assert.equal(out[0].docAValue, '100');
  assert.equal(out[0].docBValue, '500');
  // |100 - 500| = 400 > 100 → severity 'high'
  assert.equal(out[0].severity, 'high');
});

test('detectContradictions marks small numeric deltas as medium severity', () => {
  const a = { entities: [{ type: 'percentage', value: '50' }] };
  const b = { entities: [{ type: 'percentage', value: '70' }] };
  const out = detectContradictions(a, b);
  // |50 - 70| = 20 ≤ 100 → severity 'medium'
  assert.equal(out[0].severity, 'medium');
});

test('detectContradictions flags domain conflicts at low severity', () => {
  const a = { domain: { primary: 'legal' }, entities: [] };
  const b = { domain: { primary: 'medical' }, entities: [] };
  const out = detectContradictions(a, b);
  const domainConflict = out.find(c => c.type === 'domain_conflict');
  assert.ok(domainConflict);
  assert.equal(domainConflict.docAValue, 'legal');
  assert.equal(domainConflict.docBValue, 'medical');
  assert.equal(domainConflict.severity, 'low');
});

test('detectContradictions caps the result at 10 entries', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ type: 'money', value: String(i * 100) }));
  const a = { entities: big };
  // Same labels but different values across all 30 → many numeric_conflicts
  const b = { entities: big.map(e => ({ type: 'money', value: String(parseInt(e.value, 10) + 100) })) };
  const out = detectContradictions(a, b);
  assert.ok(out.length <= 10);
});

test('detectComplementary flags cross-domain insight when domains differ', () => {
  const a = { domain: { primary: 'legal' } };
  const b = { domain: { primary: 'financial' } };
  const out = detectComplementary(a, b);
  assert.ok(out.find(c => c.type === 'cross_domain_insight'));
});

test('detectComplementary flags risk asymmetry when only A has risks', () => {
  const a = { risks: { items: [{ desc: 'risk-1' }] } };
  const b = { risks: { items: [] } };
  const out = detectComplementary(a, b);
  assert.ok(out.find(c => c.type === 'risk_asymmetry'));
});

test('computeAlignment returns a score in [0, 1] bounded by Math.min', () => {
  // All-similar inputs should max out at 1
  const a = { domain: { primary: 'x' }, quality: { grade: 'A' }, risks: { overallScore: 50 }, entities: [{ type: 'org' }, { type: 'date' }] };
  const b = { domain: { primary: 'x' }, quality: { grade: 'A' }, risks: { overallScore: 50 }, entities: [{ type: 'org' }, { type: 'date' }] };
  const s = computeAlignment(a, b, 1.0);
  assert.ok(s >= 0 && s <= 1);
});

test('computeAlignment is higher for two well-aligned documents than two opposite ones', () => {
  const aligned = { domain: { primary: 'legal' }, quality: { grade: 'A' }, risks: { overallScore: 30 }, entities: [{ type: 'org' }] };
  const opposite = { domain: { primary: 'medical' }, quality: { grade: 'D' }, risks: { overallScore: 95 }, entities: [{ type: 'date' }] };
  const highScore = computeAlignment(aligned, aligned, 0.9);
  const lowScore = computeAlignment(aligned, opposite, 0.1);
  assert.ok(highScore > lowScore);
});

test('buildCrossAnalysisReport surfaces synthesis with overall assessment', () => {
  const docs = [
    { id: 'd1', name: 'A', text: 'shared content with the other doc here' },
    { id: 'd2', name: 'B', text: 'shared content with the other doc here too' },
  ];
  const analyses = [
    { domain: { primary: 'legal' }, entities: [{ type: 'money', value: '100' }] },
    { domain: { primary: 'legal' }, entities: [{ type: 'money', value: '500' }] },
  ];
  const report = buildCrossAnalysisReport(docs, analyses);
  assert.equal(report.synthesis.documentCount, 2);
  // money 100 vs 500 → numeric_conflict (high severity)
  assert.ok(report.synthesis.highRiskPairs >= 1);
  assert.equal(report.synthesis.overallAssessment, 'conflicts_detected');
  assert.match(report.analyzedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('buildCrossAnalysisReport reports "well_aligned" when there are no contradictions and strong alignment', () => {
  const docs = [
    { id: 'd1', text: 'identical content across both documents in this scenario' },
    { id: 'd2', text: 'identical content across both documents in this scenario' },
  ];
  const aligned = { domain: { primary: 'legal' }, quality: { grade: 'A' }, risks: { overallScore: 30 }, entities: [{ type: 'org', value: 'Acme' }] };
  const report = buildCrossAnalysisReport(docs, [aligned, aligned]);
  assert.equal(report.synthesis.overallAssessment, 'well_aligned');
  assert.equal(report.synthesis.highRiskPairs, 0);
});

test('buildCrossAnalysisReport reports "neutral" when neither conflict nor strong alignment', () => {
  const docs = [
    { id: 'd1', text: 'unique content not shared with any other doc here' },
    { id: 'd2', text: 'totally different topic unrelated to first' },
  ];
  const report = buildCrossAnalysisReport(docs, [{}, {}]);
  assert.equal(report.synthesis.overallAssessment, 'neutral');
});
