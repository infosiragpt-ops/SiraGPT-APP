'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-risk-levels');
const { extractRiskLevels, buildRiskLevelsForFiles, renderRiskLevelsBlock, _internal } = engine;
const { classifyPLevel, classifySevLevel } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractRiskLevels('').total, 0);
  assert.equal(extractRiskLevels(null).total, 0);
});

test('classifyPLevel maps P0..P4', () => {
  assert.equal(classifyPLevel('P0'), 'critical');
  assert.equal(classifyPLevel('P1'), 'high');
  assert.equal(classifyPLevel('P4'), 'info');
});

test('classifySevLevel maps Sev0..Sev5', () => {
  assert.equal(classifySevLevel('Sev0'), 'critical');
  assert.equal(classifySevLevel('Sev2'), 'high');
});

test('detects "severity: Critical"', () => {
  const r = extractRiskLevels('severity: Critical');
  assert.ok(r.entries.some((e) => e.level === 'critical'));
});

test('detects "severity: High"', () => {
  const r = extractRiskLevels('priority = high');
  assert.ok(r.entries.some((e) => e.level === 'high'));
});

test('detects "Medium risk"', () => {
  const r = extractRiskLevels('Medium risk vulnerability');
  assert.ok(r.entries.some((e) => e.level === 'medium'));
});

test('detects "Low severity finding"', () => {
  const r = extractRiskLevels('Low severity finding logged');
  assert.ok(r.entries.some((e) => e.level === 'low'));
});

test('detects "Info" level', () => {
  const r = extractRiskLevels('Severity: Info, nothing actionable');
  assert.ok(r.entries.some((e) => e.level === 'info'));
});

test('detects P0 priority', () => {
  const r = extractRiskLevels('Incident P0 declared');
  assert.ok(r.entries.some((e) => e.level === 'critical' && e.source === 'p-level'));
});

test('detects Sev2', () => {
  const r = extractRiskLevels('This is a Sev2 outage');
  assert.ok(r.entries.some((e) => e.level === 'high' && e.source === 'sev-level'));
});

test('detects SEV-0 (incident.io style)', () => {
  const r = extractRiskLevels('Page SEV0 oncall');
  assert.ok(r.entries.some((e) => e.level === 'critical'));
});

test('dedupes identical entries', () => {
  const r = extractRiskLevels('Severity: High and Severity: High again');
  assert.equal(r.entries.filter((e) => e.level === 'high' && e.source === 'severity').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `priority = high `;
  const r = extractRiskLevels(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by level', () => {
  const r = extractRiskLevels(
    'Severity: Critical, severity: High, Medium risk, low severity finding'
  );
  assert.ok(r.totals.critical >= 1);
  assert.ok(r.totals.high >= 1);
  assert.ok(r.totals.medium >= 1);
});

test('buildRiskLevelsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'severity: Critical' },
    { name: 'b', extractedText: 'severity: Low' },
  ];
  const r = buildRiskLevelsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRiskLevelsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'incident.md', extractedText: 'severity: High' }];
  const r = buildRiskLevelsForFiles(files);
  const md = renderRiskLevelsBlock(r);
  assert.match(md, /^## RISK/);
});

test('renderRiskLevelsBlock empty when nothing surfaces', () => {
  assert.equal(renderRiskLevelsBlock({ perFile: [] }), '');
  assert.equal(renderRiskLevelsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRiskLevelsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'severity: Critical' },
  ]);
  assert.equal(r.perFile.length, 1);
});
