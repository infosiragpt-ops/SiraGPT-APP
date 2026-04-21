/**
 * Tests for advanced chunking strategies.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ac = require('../src/services/rag/advanced-chunking');

// ─── splitSentences ──────────────────────────────────────────────────────

test('splitSentences: basic English punctuation', () => {
  const s = ac.splitSentences('One. Two! Three? Done.');
  assert.deepEqual(s, ['One.', 'Two!', 'Three?', 'Done.']);
});

test('splitSentences: unicode Spanish start characters', () => {
  const s = ac.splitSentences('Primera. ¿Segunda? ¡Tercera!');
  assert.equal(s.length, 3);
  assert.equal(s[1], '¿Segunda?');
});

test('splitSentences: empty → []', () => {
  assert.deepEqual(ac.splitSentences(''), []);
  assert.deepEqual(ac.splitSentences('   '), []);
  assert.deepEqual(ac.splitSentences(null), []);
});

test('splitSentences: single sentence with no terminal punctuation', () => {
  const s = ac.splitSentences('just one sentence with no period');
  assert.equal(s.length, 1);
});

// ─── sentenceWindow ──────────────────────────────────────────────────────

test('sentenceWindow: each chunk is one sentence with ±N-sentence window', () => {
  const text = 'S1. S2. S3. S4. S5.';
  const chunks = ac.sentenceWindow({ source: 'doc', text, window: 1 });
  assert.equal(chunks.length, 5);
  assert.equal(chunks[0].retrievalText, 'S1.');
  assert.equal(chunks[0].windowText, 'S1. S2.');
  assert.equal(chunks[2].windowText, 'S2. S3. S4.');
  assert.equal(chunks[4].windowText, 'S4. S5.');
});

test('sentenceWindow: metadata carries indexing info', () => {
  const chunks = ac.sentenceWindow({ source: 'doc', text: 'A. B. C.', window: 1 });
  assert.equal(chunks[1].metadata.sentenceIndex, 1);
  assert.equal(chunks[1].metadata.windowStart, 0);
  assert.equal(chunks[1].metadata.windowEnd, 3);
  assert.equal(chunks[1].metadata.totalSentences, 3);
});

test('sentenceWindow: stable id is deterministic across runs', () => {
  const a = ac.sentenceWindow({ source: 'doc', text: 'A. B.', window: 1 });
  const b = ac.sentenceWindow({ source: 'doc', text: 'A. B.', window: 1 });
  assert.equal(a[0].id, b[0].id);
  assert.equal(a[1].id, b[1].id);
});

// ─── parentChild ─────────────────────────────────────────────────────────

test('parentChild: builds parents then children with parentId pointers', () => {
  const text = 'First sentence. '.repeat(100) + 'Second. '.repeat(100);
  const { parents, children } = ac.parentChild({
    source: 'big', text, parentSize: 500, childSize: 150, childOverlap: 30,
  });
  assert.ok(parents.length >= 2);
  assert.ok(children.length >= parents.length);
  for (const c of children) {
    const p = parents.find(pp => pp.id === c.parentId);
    assert.ok(p, 'every child must reference an existing parent');
    // Each child should be a slice of the parent body.
    assert.ok(p.text.includes(c.text) || p.text.includes(c.text.slice(0, 50)));
  }
});

test('parentChild: empty text → empty parents + children', () => {
  const r = ac.parentChild({ source: 'x', text: '' });
  assert.deepEqual(r.parents, []);
  assert.deepEqual(r.children, []);
});

test('parentChild: small text → single parent, children with proper offsets', () => {
  const text = 'The quick brown fox jumps over the lazy dog. This is another sentence.';
  const { parents, children } = ac.parentChild({
    source: 's', text, parentSize: 500, childSize: 30, childOverlap: 5,
  });
  assert.equal(parents.length, 1);
  assert.ok(children.length >= 1);
  assert.equal(children[0].parentId, parents[0].id);
});

// ─── autoMerge ───────────────────────────────────────────────────────────

test('autoMerge: merges children of same parent when count ≥ threshold', () => {
  const parent = { id: 'p1', text: 'PARENT BODY' };
  const hits = [
    { id: 'c1', parentId: 'p1', score: 0.9, text: 'a' },
    { id: 'c2', parentId: 'p1', score: 0.8, text: 'b' },
    { id: 'c3', parentId: 'p2', score: 0.6, text: 'c' },  // single child, no merge
  ];
  const parentById = new Map([['p1', parent], ['p2', { id: 'p2', text: 'OTHER' }]]);
  const { merged, mergedParents } = ac.autoMerge({ hits, parentById, threshold: 2 });
  assert.equal(mergedParents, 1);
  const p1Merge = merged.find(m => m.id === 'p1');
  assert.ok(p1Merge, 'p1 should be merged');
  assert.equal(p1Merge.text, 'PARENT BODY');
  assert.deepEqual(p1Merge.mergedFrom.sort(), ['c1', 'c2']);
  assert.ok(merged.some(m => m.id === 'c3'), 'unmerged child survives');
});

test('autoMerge: below threshold passes children through unchanged', () => {
  const parent = { id: 'p1', text: 'PARENT' };
  const hits = [
    { id: 'c1', parentId: 'p1', score: 0.9 },
    { id: 'c2', parentId: 'p2', score: 0.5 },
  ];
  const { merged, mergedParents } = ac.autoMerge({
    hits,
    parentById: new Map([['p1', parent]]),
    threshold: 3,
  });
  assert.equal(mergedParents, 0);
  assert.equal(merged.length, 2);
});

test('autoMerge: empty hits → empty merged', () => {
  const r = ac.autoMerge({ hits: [], parentById: {} });
  assert.deepEqual(r.merged, []);
  assert.equal(r.mergedParents, 0);
});

test('autoMerge: respects score ordering in final output', () => {
  const parent = { id: 'p1', text: 'P' };
  const hits = [
    { id: 'c1', parentId: 'p1', score: 0.3 },
    { id: 'c2', parentId: 'p1', score: 0.4 },
    { id: 'lone', parentId: 'p2', score: 0.95 },
  ];
  const r = ac.autoMerge({
    hits,
    parentById: new Map([['p1', parent]]),
    threshold: 2,
  });
  assert.equal(r.merged[0].id, 'lone');  // higher score survives on top
});
