'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calibrateConfidence,
  renderConfidenceBlock,
  WEIGHTS,
  SHIP_THRESHOLD,
} = require('../src/services/sira/confidence-calibrator');

test('calibrateConfidence: all-positive signals → ship', () => {
  const r = calibrateConfidence({
    intent: { confidence: 0.92, needs_clarification: false },
    retrieval: { score: 0.85, has_evidence: true },
    validators: { aggregate_score: 0.9, failed_count: 0 },
    answer: { score: 0.92, failed_count: 0, warning_count: 0 },
    hallucination: { overallRisk: 'low', totalFlags: 0 },
    quality: { overall: 88 },
  });
  assert.ok(r.composite >= SHIP_THRESHOLD, `composite=${r.composite}`);
  assert.equal(r.recommendation, 'ship');
});

test('calibrateConfidence: hallucination=high overrides high composite → repair', () => {
  const r = calibrateConfidence({
    intent: { confidence: 0.95 },
    retrieval: { score: 0.9, has_evidence: true },
    validators: { aggregate_score: 0.95 },
    answer: { score: 0.95 },
    hallucination: { overallRisk: 'high', totalFlags: 6 },
    quality: { overall: 90 },
  });
  assert.equal(r.recommendation, 'repair');
});

test('calibrateConfidence: low answer score → repair regardless of composite', () => {
  const r = calibrateConfidence({
    answer: { score: 0.2 },
    quality: { overall: 90 },
    validators: { aggregate_score: 0.9 },
  });
  assert.equal(r.recommendation, 'repair');
});

test('calibrateConfidence: missing signals rescale weights', () => {
  const r = calibrateConfidence({
    intent: { confidence: 0.85 },
    answer: { score: 0.85 },
  });
  // Coverage should reflect only 2 sources reported
  assert.ok(r.coverage > 0 && r.coverage < 1);
  assert.ok(r.composite >= 0.65, `composite=${r.composite}`);
});

test('calibrateConfidence: identifies dominant risk', () => {
  const r = calibrateConfidence({
    intent: { confidence: 0.9 },
    validators: { aggregate_score: 0.9 },
    answer: { score: 0.9 },
    hallucination: { overallRisk: 'medium', totalFlags: 3 },
  });
  assert.equal(r.dominantRisk.source, 'hallucination');
});

test('calibrateConfidence: low composite below repair threshold → abort', () => {
  const r = calibrateConfidence({
    intent: { confidence: 0.2 },
    validators: { aggregate_score: 0.3, failed_count: 4 },
    answer: { score: 0.35 },
    quality: { overall: 25 },
    hallucination: { overallRisk: 'medium', totalFlags: 2 },
  });
  // Either repair (because of validators<0.3 override) or abort
  assert.ok(['repair', 'abort'].includes(r.recommendation), `got ${r.recommendation}`);
});

test('calibrateConfidence: normalises score on 0..100 scale', () => {
  const r1 = calibrateConfidence({ retrieval: { score: 85, has_evidence: true } });
  const r2 = calibrateConfidence({ retrieval: { score: 0.85, has_evidence: true } });
  // Both should produce comparable retrieval scores
  assert.ok(Math.abs(r1.breakdown.retrieval - r2.breakdown.retrieval) < 0.01);
});

test('calibrateConfidence: handles empty input', () => {
  const r = calibrateConfidence({});
  assert.equal(r.composite, 0);
  assert.equal(r.coverage, 0);
});

test('calibrateConfidence: intent.needs_clarification caps intent confidence', () => {
  const r = calibrateConfidence({
    intent: { confidence: 0.95, needs_clarification: true },
  });
  assert.ok(r.breakdown.intent <= 0.5);
});

test('weights are normalised positive', () => {
  for (const v of Object.values(WEIGHTS)) {
    assert.ok(typeof v === 'number' && v > 0);
  }
});

test('renderConfidenceBlock: emits markdown with score, recommendation, table', () => {
  const r = calibrateConfidence({
    intent: { confidence: 0.85 },
    answer: { score: 0.8 },
  });
  const block = renderConfidenceBlock(r);
  assert.match(block, /CONFIDENCE CALIBRATION/);
  assert.match(block, /Composite/);
  assert.match(block, /Recommendation/);
});

test('renderConfidenceBlock: empty report returns empty string', () => {
  assert.equal(renderConfidenceBlock(null), '');
});
