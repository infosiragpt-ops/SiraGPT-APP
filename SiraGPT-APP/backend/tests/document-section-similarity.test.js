'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-section-similarity');
const { buildSimilarityForFiles, renderSimilarityBlock, _internal } = engine;
const { tokenize, tokenSet, jaccard, splitIntoSections } = _internal;

test('tokenize drops stop-words and short tokens', () => {
  const out = tokenize('The quick brown fox jumps over the lazy dog');
  assert.ok(out.includes('quick'));
  assert.ok(out.includes('brown'));
  assert.ok(!out.includes('the'));
});

test('jaccard returns 0/1 boundaries', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
});

test('splitIntoSections respects markdown headings', () => {
  const text = `# Section A
${'A'.repeat(120)}
# Section B
${'B'.repeat(120)}`;
  const sections = splitIntoSections(text);
  assert.equal(sections.length, 2);
});

test('single file → empty result', () => {
  const r = buildSimilarityForFiles([{ name: 'a.md', extractedText: '# Sec\n' + 'word '.repeat(50) }]);
  assert.equal(r.pairs.length, 0);
});

test('non-array input tolerated', () => {
  const r = buildSimilarityForFiles(null);
  assert.equal(r.fileCount, 0);
});

test('detects high-similarity sections across two files', () => {
  const sharedClause = 'The scope of work includes design, development, testing, deployment, training, and support for the platform. The contractor will deliver milestones quarterly.';
  const files = [
    { name: 'contract-a.md', extractedText: `# Scope of Work\n${sharedClause}\n# Pricing\nFees are billed monthly with net thirty terms and applicable taxes.\n` },
    { name: 'contract-b.md', extractedText: `# Scope of Work\n${sharedClause}\n# Payments\nFees billed quarterly with net forty-five and applicable taxes.\n` },
  ];
  const r = buildSimilarityForFiles(files);
  assert.ok(r.pairs.length >= 1);
  // The top pair should be the matching SCOPE sections.
  const top = r.pairs[0];
  assert.ok(top.score >= 0.18, `expected similarity ≥ 0.18, got ${top.score}`);
  assert.match(top.titleA + top.titleB, /Scope/i);
});

test('drops pairs below MIN_SIMILARITY', () => {
  const files = [
    { name: 'doc-a.md', extractedText: '# Recipes\nFlour sugar eggs butter chocolate vanilla baking soda.' },
    { name: 'doc-b.md', extractedText: '# Kubernetes\nPods clusters deployment ingress kubectl helm service mesh.' },
  ];
  const r = buildSimilarityForFiles(files);
  assert.equal(r.pairs.length, 0);
});

test('renderSimilarityBlock: produces markdown', () => {
  const shared = 'platform design development testing deployment training support contractor milestones quarterly';
  const files = [
    { name: 'a.md', extractedText: `# Scope of Work\n${shared} ${shared}` },
    { name: 'b.md', extractedText: `# Scope of Work\n${shared} ${shared}` },
  ];
  const r = buildSimilarityForFiles(files);
  const md = renderSimilarityBlock(r);
  assert.match(md, /^## CROSS-DOCUMENT SECTION SIMILARITY/);
});

test('renderSimilarityBlock: empty when no pairs', () => {
  assert.equal(renderSimilarityBlock({ pairs: [] }), '');
  assert.equal(renderSimilarityBlock(null), '');
});

test('caps total pairs across a 3-file batch', () => {
  const shared = 'platform design development testing deployment training support contractor milestones quarterly delivery installation';
  const files = [
    { name: 'a.md', extractedText: `# S1\n${shared} ${shared}\n# S2\n${shared}` },
    { name: 'b.md', extractedText: `# S1\n${shared} ${shared}\n# S2\n${shared}` },
    { name: 'c.md', extractedText: `# S1\n${shared} ${shared}\n# S2\n${shared}` },
  ];
  const r = buildSimilarityForFiles(files);
  assert.ok(r.pairs.length <= 18);
});

test('preserves source file labels on every pair', () => {
  const shared = 'platform design development testing deployment training support contractor milestones quarterly delivery installation';
  const files = [
    { name: 'a.md', extractedText: `# S\n${shared} ${shared}` },
    { name: 'b.md', extractedText: `# S\n${shared} ${shared}` },
  ];
  const r = buildSimilarityForFiles(files);
  for (const p of r.pairs) {
    assert.ok(p.fileA && p.fileB);
    assert.ok(p.titleA && p.titleB);
  }
});

test('handles non-string extractedText', () => {
  const r = buildSimilarityForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '# Sec\n' + 'word '.repeat(60) },
  ]);
  assert.equal(r.pairs.length, 0);
});

test('paragraph fallback when no headings', () => {
  const sharedBody = 'platform design development testing deployment training support contractor milestones quarterly';
  const files = [
    { name: 'a.md', extractedText: `${sharedBody} ${sharedBody}` },
    { name: 'b.md', extractedText: `${sharedBody} ${sharedBody}` },
  ];
  const r = buildSimilarityForFiles(files);
  assert.ok(r.pairs.length >= 1);
});

test('jaccard score in [0,1]', () => {
  const files = [
    { name: 'a.md', extractedText: '# S\nplatform delivery contractor milestones design.\n' },
    { name: 'b.md', extractedText: '# S\nplatform delivery contractor milestones design and support.\n' },
  ];
  const r = buildSimilarityForFiles(files);
  for (const p of r.pairs) {
    assert.ok(p.score >= 0 && p.score <= 1);
  }
});
