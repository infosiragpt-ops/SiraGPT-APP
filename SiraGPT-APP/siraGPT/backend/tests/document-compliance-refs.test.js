'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-compliance-refs');
const { extractComplianceRefs, buildComplianceRefsForFiles, renderComplianceRefsBlock, _internal } = engine;
const { frameworkCategory } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractComplianceRefs('').total, 0);
  assert.equal(extractComplianceRefs(null).total, 0);
});

test('frameworkCategory maps GDPR to privacy', () => {
  const r = frameworkCategory('GDPR');
  assert.equal(r.category, 'privacy');
});

test('detects GDPR', () => {
  const r = extractComplianceRefs('We comply with GDPR.');
  assert.ok(r.entries.some((e) => e.framework === 'GDPR'));
});

test('detects HIPAA', () => {
  const r = extractComplianceRefs('Subject to HIPAA');
  assert.ok(r.entries.some((e) => e.category === 'healthcare'));
});

test('detects PCI DSS', () => {
  const r = extractComplianceRefs('PCI DSS Level 1 certified');
  assert.ok(r.entries.some((e) => e.category === 'finance'));
});

test('detects SOC 2', () => {
  const r = extractComplianceRefs('SOC 2 Type II report');
  assert.ok(r.entries.some((e) => e.category === 'audit'));
});

test('detects FedRAMP', () => {
  const r = extractComplianceRefs('FedRAMP authorized');
  assert.ok(r.entries.some((e) => e.framework === 'FedRAMP'));
});

test('detects ISO 27001', () => {
  const r = extractComplianceRefs('Certified ISO 27001 compliant');
  assert.ok(r.entries.some((e) => e.category === 'audit'));
});

test('detects NIST CSF', () => {
  const r = extractComplianceRefs('Aligned with NIST CSF');
  assert.ok(r.entries.some((e) => e.category === 'cyber'));
});

test('detects CCPA', () => {
  const r = extractComplianceRefs('CCPA rights honored');
  assert.ok(r.entries.some((e) => e.category === 'privacy'));
});

test('detects EU AI Act', () => {
  const r = extractComplianceRefs('Subject to the EU AI Act');
  assert.ok(r.entries.some((e) => e.category === 'ai-regulation'));
});

test('dedupes identical frameworks', () => {
  const r = extractComplianceRefs('GDPR here, GDPR there');
  assert.equal(r.entries.filter((e) => e.framework === 'GDPR').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const frameworks = ['GDPR', 'HIPAA', 'PCI DSS', 'SOC 2', 'FedRAMP', 'ISO 27001', 'NIST CSF', 'CCPA',
    'LGPD', 'PIPL', 'PDPA', 'POPIA', 'DPDPA', 'SOX', 'GLBA', 'COPPA', 'FERPA', 'FISMA', 'CMMC', 'DORA'];
  for (const f of frameworks) text += `${f} `;
  const r = extractComplianceRefs(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by category', () => {
  const r = extractComplianceRefs('GDPR, HIPAA, PCI DSS, SOC 2, NIST CSF');
  assert.ok(r.totals.privacy >= 1);
  assert.ok(r.totals.healthcare >= 1);
  assert.ok(r.totals.finance >= 1);
  assert.ok(r.totals.audit >= 1);
  assert.ok(r.totals.cyber >= 1);
});

test('buildComplianceRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'GDPR' },
    { name: 'b', extractedText: 'HIPAA' },
  ];
  const r = buildComplianceRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderComplianceRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'policy', extractedText: 'GDPR' }];
  const r = buildComplianceRefsForFiles(files);
  const md = renderComplianceRefsBlock(r);
  assert.match(md, /^## COMPLIANCE/);
});

test('renderComplianceRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderComplianceRefsBlock({ perFile: [] }), '');
  assert.equal(renderComplianceRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildComplianceRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'GDPR' },
  ]);
  assert.equal(r.perFile.length, 1);
});
