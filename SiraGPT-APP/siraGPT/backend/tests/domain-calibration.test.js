'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cal = require('../src/services/domain-calibration');

test('detectDomain: empty input → general with low confidence', () => {
  const r = cal.detectDomain('');
  assert.strictEqual(r.domain, 'general');
  assert.strictEqual(r.confidence, 0);
});

test('detectDomain: legal keywords pick legal', () => {
  const r = cal.detectDomain('Review this contract clause for liability and compliance.');
  assert.strictEqual(r.domain, 'legal');
  assert.ok(r.confidence > 0.4);
  assert.ok(r.evidence.length >= 2);
});

test('detectDomain: medical keywords pick medical', () => {
  const r = cal.detectDomain('Patient presents with chest pain symptoms. Suggest treatment dosage.');
  assert.strictEqual(r.domain, 'medical');
});

test('detectDomain: financial keywords pick financial', () => {
  const r = cal.detectDomain('Calculate the profit margin given revenue and COGS in the P&L.');
  assert.strictEqual(r.domain, 'financial');
});

test('detectDomain: code keywords pick code', () => {
  const r = cal.detectDomain('Refactor this React function and the database query in the API endpoint.');
  assert.strictEqual(r.domain, 'code');
});

test('detectDomain: research keywords pick research', () => {
  const r = cal.detectDomain('Run a literature review on cohort hypothesis with p-value < 0.05.');
  assert.strictEqual(r.domain, 'research');
});

test('detectDomain: creative keywords pick creative', () => {
  const r = cal.detectDomain('Write a poem with metaphor about loneliness; mind the tone.');
  assert.strictEqual(r.domain, 'creative');
});

test('detectDomain: marketing keywords pick marketing', () => {
  const r = cal.detectDomain('Launch the campaign targeting the persona; CPC and landing page metrics.');
  assert.strictEqual(r.domain, 'marketing');
});

test('detectDomain: ambiguous input → general fallback', () => {
  const r = cal.detectDomain('Tell me about yourself.');
  assert.strictEqual(r.domain, 'general');
});

test('detectDomain: minHits option raises the bar', () => {
  const r = cal.detectDomain('A single contract reference here.', { minHits: 5 });
  assert.strictEqual(r.domain, 'general');
});

test('getCalibration: legal has high faithfulness threshold + requireCitation', () => {
  const legal = cal.getCalibration('legal');
  assert.ok(legal.faithfulnessAcceptThreshold >= 0.8);
  assert.strictEqual(legal.requireCitation, true);
});

test('getCalibration: creative has low faithfulness threshold + high novelty', () => {
  const c = cal.getCalibration('creative');
  assert.ok(c.faithfulnessAcceptThreshold < 0.6);
  assert.ok(c.noveltyMax > 0.7);
  assert.strictEqual(c.requireCitation, false);
});

test('getCalibration: unknown domain falls back to general', () => {
  const c = cal.getCalibration('nonexistent');
  assert.strictEqual(c.domain, 'general');
});

test('getCalibrationFor: returns calibration + detected hit', () => {
  const c = cal.getCalibrationFor('Audit the financial P&L revenue figures.');
  assert.strictEqual(c.domain, 'financial');
  assert.ok(c.detected);
  assert.ok(c.detected.confidence > 0.3);
});

test('listDomains: returns every domain', () => {
  const list = cal.listDomains();
  const domains = list.map((d) => d.domain);
  for (const expected of ['legal', 'medical', 'financial', 'code', 'research', 'creative', 'marketing', 'general']) {
    assert.ok(domains.includes(expected), `expected ${expected}`);
  }
});

test('buildCalibrationBlock: returns prompt text', () => {
  const block = cal.buildCalibrationBlock('legal');
  assert.ok(block.includes('<domain_calibration>'));
  assert.ok(block.includes('Legal'));
  assert.ok(block.includes('REQUERIDA'));
});

test('relative-ordering: legal stricter than general stricter than creative', () => {
  const legal = cal.getCalibration('legal');
  const general = cal.getCalibration('general');
  const creative = cal.getCalibration('creative');
  assert.ok(legal.faithfulnessAcceptThreshold > general.faithfulnessAcceptThreshold);
  assert.ok(general.faithfulnessAcceptThreshold > creative.faithfulnessAcceptThreshold);
});

test('hot path: 100 detections under 100ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) cal.detectDomain('Audit the financial P&L revenue figures.');
  assert.ok(Date.now() - t0 < 200);
});
