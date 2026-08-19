'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-glossary-extractor');
const { extractGlossary, buildGlossaryForFiles, renderGlossaryBlock } = engine;

test('extractGlossary: returns empty report for empty input', () => {
  const r = extractGlossary('');
  assert.deepEqual(r.acronyms, []);
  assert.deepEqual(r.properTerms, []);
  assert.deepEqual(r.jargon, []);
});

test('extractGlossary: detects "Full Name (ACRO)" expansions', () => {
  const text = 'The Chief Financial Officer (CFO) reviewed the Earnings Before Interest and Taxes (EBIT) figures.';
  const r = extractGlossary(text);
  assert.ok(r.acronyms.some((a) => a.acronym === 'CFO' && /Chief Financial Officer/.test(a.expansion)));
  assert.ok(r.acronyms.some((a) => a.acronym === 'EBIT'));
});

test('extractGlossary: detects "ACRO (Full Name)" expansions', () => {
  const text = 'Use ACL (Access Control List) for permissions and ABAC (Attribute-Based Access Control) for fine-grained policies.';
  const r = extractGlossary(text);
  assert.ok(r.acronyms.some((a) => a.acronym === 'ACL' && /Access Control List/.test(a.expansion)));
  assert.ok(r.acronyms.some((a) => a.acronym === 'ABAC'));
});

test('extractGlossary: detects dictionary-style "ACRO: Full Name" entries', () => {
  const text = `Glossary:
SLA: Service Level Agreement
RPO: Recovery Point Objective
RTO: Recovery Time Objective`;
  const r = extractGlossary(text);
  const acros = r.acronyms.map((a) => a.acronym);
  assert.ok(acros.includes('SLA'));
  assert.ok(acros.includes('RPO'));
  assert.ok(acros.includes('RTO'));
});

test('extractGlossary: detects recurring proper terms', () => {
  const text = 'The Service Level Agreement defines the Service Level Agreement targets. The Service Level Agreement covers downtime. Beyond the Service Level Agreement, partners must comply.';
  const r = extractGlossary(text);
  assert.ok(r.properTerms.some((p) => /Service Level Agreement/.test(p.phrase) && p.count >= 2));
});

test('extractGlossary: surfaces high-frequency domain jargon', () => {
  const text = 'Kubernetes deploys microservices. Each microservice runs in a Kubernetes pod. Kubernetes scales microservices using horizontal autoscaling. Microservices communicate via Kubernetes services. Autoscaling watches CPU and memory. Pods are scheduled by Kubernetes.';
  const r = extractGlossary(text);
  const jargonTerms = r.jargon.map((j) => j.term);
  assert.ok(jargonTerms.includes('kubernetes'), `expected 'kubernetes' in ${jargonTerms.join(',')}`);
  assert.ok(jargonTerms.some((t) => /microservice/.test(t)));
});

test('extractGlossary: ignores stopwords from jargon list', () => {
  const text = 'The system uses the database. The database stores the data. The data is processed by the system.';
  const r = extractGlossary(text);
  const terms = r.jargon.map((j) => j.term);
  assert.ok(!terms.includes('the'));
  assert.ok(!terms.includes('and'));
});

test('buildGlossaryForFiles: aggregates across files', () => {
  const files = [
    { originalName: 'a.md', extractedText: 'API (Application Programming Interface) calls the backend. The API responds quickly.' },
    { originalName: 'b.md', extractedText: 'The API exposes REST endpoints. ABAC (Attribute-Based Access Control) gates access.' },
  ];
  const r = buildGlossaryForFiles(files);
  const acros = r.acronyms.map((a) => a.acronym);
  assert.ok(acros.includes('API'));
  assert.ok(acros.includes('ABAC'));
});

test('buildGlossaryForFiles: empty for no files with text', () => {
  const r = buildGlossaryForFiles([{ originalName: 'a.md', extractedText: '' }, { originalName: 'b.md' }]);
  assert.deepEqual(r.acronyms, []);
  assert.deepEqual(r.properTerms, []);
});

test('buildGlossaryForFiles: returns empty result for non-array input', () => {
  const r = buildGlossaryForFiles(null);
  assert.deepEqual(r.acronyms, []);
});

test('renderGlossaryBlock: returns empty string when nothing detected', () => {
  assert.equal(renderGlossaryBlock(null), '');
  assert.equal(renderGlossaryBlock({ acronyms: [], properTerms: [], jargon: [], frequencyTable: [] }), '');
});

test('renderGlossaryBlock: includes title and sections when populated', () => {
  const r = extractGlossary('The Chief Financial Officer (CFO) signed the Service Level Agreement. The CFO reviewed metrics. Service Level Agreement governs partners. Service Level Agreement details follow.');
  const block = renderGlossaryBlock(r);
  assert.match(block, /## DOCUMENT GLOSSARY/);
  assert.match(block, /CFO/);
});

test('extractGlossary: caps results to per-section maximums', () => {
  // 50 unique 4+ letter words to verify jargon cap (≤25)
  const words = Array.from({ length: 50 }, (_, i) => `término${i}`).join(' repetido ').repeat(4);
  const r = extractGlossary(words);
  assert.ok(r.jargon.length <= 25, `jargon should be capped, got ${r.jargon.length}`);
});
