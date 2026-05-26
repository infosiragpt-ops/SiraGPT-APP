'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-risk-register');
const { extractRiskRegister, buildRegisterForFiles, renderRegisterBlock, _internal } = engine;
const { isRiskSentence, classifyCategory, classifySeverity, hasMitigation, severityRank } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractRiskRegister('').total, 0);
  assert.equal(extractRiskRegister(null).total, 0);
});

test('isRiskSentence: detects risk language in EN + ES', () => {
  assert.ok(isRiskSentence('There is a significant risk of downtime.'));
  assert.ok(isRiskSentence('Existe un riesgo de incumplimiento del contrato.'));
  assert.ok(!isRiskSentence('The team had lunch on Tuesday.'));
});

test('classifyCategory: routes legal / financial / technical / operational / reputational', () => {
  assert.equal(classifyCategory('GDPR compliance breach risk under jurisdiction X.'), 'legal');
  assert.equal(classifyCategory('Cash flow risk from currency hedge default.'), 'financial');
  assert.equal(classifyCategory('CVE vulnerability and outage risk in production.'), 'technical');
  assert.equal(classifyCategory('Supply chain bottleneck risk from vendor capacity issues.'), 'operational');
  assert.equal(classifyCategory('Brand reputation risk from social media backlash.'), 'reputational');
});

test('classifySeverity: critical / high / medium / low keywords', () => {
  assert.equal(classifySeverity('This is a CRITICAL risk to the platform.'), 'critical');
  assert.equal(classifySeverity('Significant risk of breach.'), 'high');
  assert.equal(classifySeverity('Moderate risk identified.'), 'medium');
  assert.equal(classifySeverity('Minor risk noted in audit.'), 'low');
});

test('classifySeverity: amplifier "all customers" pushes to high', () => {
  assert.equal(classifySeverity('A data loss risk that would affect all customers.'), 'high');
});

test('hasMitigation: detects mitigation language in same sentence', () => {
  assert.ok(hasMitigation('A risk of downtime; a backup plan has been put in place.', ''));
  assert.ok(hasMitigation('Riesgo de fraude, mitigado por controles internos.', ''));
  assert.ok(!hasMitigation('There is a risk of downtime.', 'No further details.'));
});

test('severityRank: ordered critical < high < medium < low', () => {
  assert.ok(severityRank('critical') < severityRank('high'));
  assert.ok(severityRank('high') < severityRank('medium'));
  assert.ok(severityRank('medium') < severityRank('low'));
});

test('extractRiskRegister: extracts and classifies a multi-sentence text', () => {
  const text = `Section: Risk Assessment.
There is a critical risk of a security breach if patches are delayed; a runbook exists for incident response.
The legal team flagged a significant risk of GDPR non-compliance with the new feature.
Operationally, we are exposed to a moderate risk of vendor capacity shortfall.
A minor reputational risk exists if the PR cycle goes badly.`;
  const r = extractRiskRegister(text);
  assert.ok(r.total >= 3, `expected at least 3 risks, got ${r.total}: ${JSON.stringify(r.risks)}`);
  const sevs = r.risks.map((x) => x.severity);
  assert.ok(sevs.includes('critical'));
  assert.ok(sevs.includes('high') || sevs.includes('medium'));
  const cats = r.risks.map((x) => x.category);
  assert.ok(cats.includes('technical') || cats.includes('legal'));
});

test('mitigation flag surfaces when source proposes one', () => {
  const text = 'There is a significant risk of an outage; a backup plan is in place.';
  const r = extractRiskRegister(text);
  assert.ok(r.risks.some((x) => x.mitigation), `expected mitigation true, got ${JSON.stringify(r.risks)}`);
});

test('buildRegisterForFiles aggregates and orders by severity', () => {
  const files = [
    { name: 'plan-a.md', extractedText: 'Critical risk of platform outage. There is a backup plan.' },
    { name: 'plan-b.md', extractedText: 'Minor risk of attrition in Q3.' },
  ];
  const batch = buildRegisterForFiles(files);
  assert.ok(batch.aggregate.length >= 2);
  // Aggregate sorted: critical first.
  assert.equal(batch.aggregate[0].severity, 'critical');
});

test('renderRegisterBlock: returns markdown with category + severity tags', () => {
  const files = [{ name: 'doc.md', extractedText: 'Critical risk of data loss in the customer database. There is a mitigation plan.' }];
  const batch = buildRegisterForFiles(files);
  const md = renderRegisterBlock(batch);
  assert.match(md, /^## RISK REGISTER/);
  assert.match(md, /CRITICAL/);
});

test('renderRegisterBlock: empty when nothing surfaces', () => {
  assert.equal(renderRegisterBlock({ perFile: [] }), '');
  assert.equal(renderRegisterBlock(null), '');
});

test('Spanish text: detects and classifies', () => {
  const text = 'Existe un riesgo crítico de pérdida de datos en producción. La mitigación consiste en respaldos diarios.';
  const r = extractRiskRegister(text);
  assert.ok(r.total >= 1);
  assert.equal(r.risks[0].category, 'technical');
  assert.equal(r.risks[0].severity, 'critical');
});

test('non-string extractedText tolerated', () => {
  const batch = buildRegisterForFiles([{ name: 'noisy', extractedText: null }, { name: 'good', extractedText: 'Critical risk of breach.' }]);
  assert.ok(Array.isArray(batch.perFile));
});

test('dedupe: same risk sentence twice → one entry', () => {
  const text = 'There is a high risk of fraud. There is a high risk of fraud.';
  const r = extractRiskRegister(text);
  assert.equal(r.total, 1);
});
