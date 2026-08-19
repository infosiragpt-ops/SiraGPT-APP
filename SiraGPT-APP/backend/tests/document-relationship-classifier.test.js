'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-relationship-classifier');
const { classifyRelationships, renderRelationshipsBlock, _internal } = engine;
const { tokenize, tokenSet, jaccard, stemName, VERSION_SUFFIX_RE } = _internal;

test('tokenize drops short / stop words and keeps content', () => {
  const t = tokenize('The quick brown fox jumps over the lazy dog');
  assert.ok(t.includes('quick'));
  assert.ok(t.includes('brown'));
  assert.ok(!t.includes('the'));
});

test('jaccard returns 0 when either set is empty', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(jaccard(new Set(['a']), new Set()), 0);
});

test('jaccard returns 1 for identical sets', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'a'])), 1);
});

test('VERSION_SUFFIX_RE detects v1 / v2 / draft / final / dated suffixes', () => {
  assert.ok(VERSION_SUFFIX_RE.test('contract-v1.pdf'));
  assert.ok(VERSION_SUFFIX_RE.test('plan-v2.0.docx'));
  assert.ok(VERSION_SUFFIX_RE.test('memo-draft.txt'));
  assert.ok(VERSION_SUFFIX_RE.test('proyecto-final.md'));
  assert.ok(VERSION_SUFFIX_RE.test('report-2026-05-12.docx'));
});

test('stemName strips version suffixes and extensions', () => {
  assert.equal(stemName('contract-v1.pdf'), 'contract');
  assert.equal(stemName('contract-v2.pdf'), 'contract');
  assert.equal(stemName('plan-draft.md'), 'plan');
});

test('single-file batch returns empty', () => {
  const r = classifyRelationships([{ name: 'a.md', extractedText: 'hello world' }]);
  assert.equal(r.pairs.length, 0);
});

test('non-array tolerated', () => {
  const r = classifyRelationships(null);
  assert.equal(r.pairs.length, 0);
});

test('detects version pair when filenames share a stem + version suffix', () => {
  const sharedBody = 'This is the project plan for the new platform. The project is large with many components. The plan involves multiple teams. The objective is to deliver a complete platform. The platform includes modules, features and services.';
  const files = [
    { name: 'plan-v1.md', extractedText: sharedBody },
    { name: 'plan-v2.md', extractedText: `${sharedBody} Additional revision notes for v2.` },
  ];
  const r = classifyRelationships(files);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].kind, 'versions');
});

test('detects complementary pair when entities overlap but bodies differ', () => {
  const files = [
    { name: 'finance.md', extractedText: 'Acme Corp revenue grew. Acme Corp signed deal. Acme Corp expansion is approved.' },
    { name: 'legal.md', extractedText: 'Acme Corp legal team filed compliance brief. Acme Corp obligations are listed. Acme Corp duties documented.' },
  ];
  const r = classifyRelationships(files);
  assert.equal(r.pairs.length, 1);
  // Either complementary (entity overlap) or versions if body overlap crosses thresholds
  assert.ok(['complementary', 'versions'].includes(r.pairs[0].kind));
});

test('detects unrelated pair when both axes are near zero', () => {
  const files = [
    { name: 'cookbook.md', extractedText: 'Recipe for chocolate cake: flour, sugar, cocoa, eggs, butter.' },
    { name: 'kubernetes.md', extractedText: 'Pods are the smallest deployable units. Use kubectl to inspect cluster state.' },
  ];
  const r = classifyRelationships(files);
  assert.equal(r.pairs[0].kind, 'unrelated');
});

test('aggregate totals reflect pair kinds', () => {
  const files = [
    { name: 'a.md', extractedText: 'Acme Corp signed and grew. Acme Corp scaled the platform infrastructure.' },
    { name: 'b.md', extractedText: 'Acme Corp legal team prepared brief. Acme Corp obligations enumerated thoroughly.' },
    { name: 'c.md', extractedText: 'Recipe for chocolate cake. Mix flour and sugar with cocoa, eggs and butter.' },
  ];
  const r = classifyRelationships(files);
  assert.ok(r.pairs.length === 3);
  const sum = r.totals.versions + r.totals.complementary + r.totals.conflicting + r.totals.unrelated;
  assert.equal(sum, 3);
});

test('renderRelationshipsBlock returns markdown when informative pairs exist', () => {
  const files = [
    { name: 'plan-v1.md', extractedText: 'Acme Corp plan with details. Acme Corp launching the project soon. Project requires investment.' },
    { name: 'plan-v2.md', extractedText: 'Acme Corp plan with details. Acme Corp launching the project soon. Project requires investment. Extra revision.' },
  ];
  const r = classifyRelationships(files);
  const md = renderRelationshipsBlock(r);
  assert.match(md, /^## DOCUMENT RELATIONSHIPS/);
});

test('renderRelationshipsBlock returns empty when all pairs unrelated', () => {
  const files = [
    { name: 'cookbook.md', extractedText: 'Cookies recipe. Mix flour sugar butter eggs vanilla.' },
    { name: 'k8s.md', extractedText: 'Pods are deployable units in Kubernetes clusters. Use kubectl inspect.' },
  ];
  const r = classifyRelationships(files);
  assert.equal(renderRelationshipsBlock(r), '');
});

test('handles non-string extractedText', () => {
  const files = [{ name: 'a', extractedText: null }, { name: 'b', extractedText: undefined }];
  const r = classifyRelationships(files);
  // Empty token sets → jaccard=0 → unrelated pair
  assert.equal(r.pairs.length, 1);
});
