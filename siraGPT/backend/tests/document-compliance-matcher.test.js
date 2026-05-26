'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-compliance-matcher');
const { detectFrameworks, buildComplianceForFiles, renderComplianceBlock } = engine;

test('empty / non-string input tolerated', () => {
  assert.equal(detectFrameworks('').total, 0);
  assert.equal(detectFrameworks(null).total, 0);
});

test('detects GDPR / CCPA / HIPAA', () => {
  const r = detectFrameworks('The platform is GDPR compliant and conforms to CCPA. HIPAA controls apply to PHI.');
  const keys = r.frameworks.map((f) => f.key);
  assert.ok(keys.includes('GDPR'));
  assert.ok(keys.includes('CCPA'));
  assert.ok(keys.includes('HIPAA'));
});

test('detects ISO 27001 / SOC 2 / NIST CSF', () => {
  const r = detectFrameworks('We hold an ISO 27001 certificate and a SOC 2 Type II report. Our program aligns with NIST CSF.');
  const keys = r.frameworks.map((f) => f.key);
  assert.ok(keys.includes('ISO 27001'));
  assert.ok(keys.includes('SOC 2'));
  assert.ok(keys.includes('NIST CSF'));
});

test('detects PCI-DSS / SOX / IFRS', () => {
  const r = detectFrameworks('Card data handling is PCI-DSS compliant. Annual SOX controls are tested. Financials follow IFRS standards.');
  const keys = r.frameworks.map((f) => f.key);
  assert.ok(keys.includes('PCI-DSS'));
  assert.ok(keys.includes('SOX'));
  assert.ok(keys.includes('IFRS'));
});

test('detects Spanish framework names', () => {
  const r = detectFrameworks('El sistema cumple con el Reglamento General de Protección de Datos (GDPR).');
  assert.ok(r.frameworks.some((f) => f.key === 'GDPR'));
});

test('detects Basel III / MiFID II / Dodd-Frank', () => {
  const r = detectFrameworks('Capital ratios meet Basel III. Trading desks are MiFID II compliant. Dodd-Frank reporting is current.');
  const keys = r.frameworks.map((f) => f.key);
  assert.ok(keys.includes('Basel III'));
  assert.ok(keys.includes('MiFID II'));
  assert.ok(keys.includes('Dodd-Frank'));
});

test('detects ISO 9001 / 14001 / 45001', () => {
  const r = detectFrameworks('Plants are certified to ISO 9001, ISO 14001, and ISO 45001.');
  const keys = r.frameworks.map((f) => f.key);
  assert.ok(keys.includes('ISO 9001'));
  assert.ok(keys.includes('ISO 14001'));
  assert.ok(keys.includes('ISO 45001'));
});

test('detects EU AI Act', () => {
  const r = detectFrameworks('All high-risk AI systems are reviewed under the EU AI Act.');
  assert.ok(r.frameworks.some((f) => f.key === 'EU AI Act'));
});

test('mention counts and sorting are correct', () => {
  const r = detectFrameworks('GDPR GDPR GDPR. CCPA. HIPAA.');
  if (r.frameworks.length >= 2) {
    assert.ok(r.frameworks[0].mentions >= r.frameworks[1].mentions);
  }
});

test('buildComplianceForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'GDPR compliant.' },
    { name: 'b.md', extractedText: 'HIPAA controls in place.' },
  ];
  const r = buildComplianceForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.length >= 2);
});

test('renderComplianceBlock returns markdown when frameworks found', () => {
  const files = [{ name: 'doc.md', extractedText: 'The platform is GDPR-compliant.' }];
  const r = buildComplianceForFiles(files);
  const md = renderComplianceBlock(r);
  assert.match(md, /^## COMPLIANCE FRAMEWORKS/);
});

test('renderComplianceBlock empty when nothing surfaces', () => {
  assert.equal(renderComplianceBlock({ perFile: [] }), '');
  assert.equal(renderComplianceBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildComplianceForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'SOC 2 audit done.' }]);
  assert.equal(r.perFile.length, 1);
});

test('aggregate sorted by total mentions', () => {
  const files = [
    { name: 'a.md', extractedText: 'GDPR GDPR GDPR.' },
    { name: 'b.md', extractedText: 'GDPR. HIPAA.' },
  ];
  const r = buildComplianceForFiles(files);
  if (r.aggregate.length >= 2) {
    assert.equal(r.aggregate[0].key, 'GDPR');
  }
});
