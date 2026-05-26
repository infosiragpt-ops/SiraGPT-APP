'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalize,
  similarity,
  areDuplicate,
  dedupItems,
  clusterByPrefix,
} = require('../src/services/sira/semantic-deduplicator');

// ─── Normalisation ─────────────────────────────────────

test('normalize: lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalize('  Hello,  World!!  '), 'hello world');
});

test('normalize: keeps unicode letters', () => {
  assert.equal(normalize('Año Nuevo, 2026'), 'año nuevo 2026');
});

test('normalize: tolerates non-string', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(123), '');
});

// ─── Similarity ────────────────────────────────────

test('similarity: identical strings → 1', () => {
  assert.equal(similarity('hello world', 'hello world'), 1);
});

test('similarity: completely different → low', () => {
  const s = similarity('cats are mammals', 'quantum physics is hard');
  assert.ok(s < 0.2);
});

test('similarity: paraphrase with shared content → high', () => {
  const a = 'The Q3 deadline for the migration project is September 30';
  const b = 'Q3 migration project deadline is September 30';
  const s = similarity(a, b);
  assert.ok(s >= 0.5, `expected ≥ 0.5, got ${s}`);
});

test('similarity: normalisation-equivalent strings → 1', () => {
  assert.equal(similarity('Hello, World!', 'hello   world'), 1);
});

test('similarity: tolerates null inputs', () => {
  assert.equal(similarity(null, null), 1);
  assert.equal(similarity('a', null), 0);
});

// ─── areDuplicate ─────────────────────────────────

test('areDuplicate: applies default threshold', () => {
  assert.equal(areDuplicate('hello world', 'Hello, World!'), true);
  assert.equal(areDuplicate('cats are nice', 'dogs are loud'), false);
});

test('areDuplicate: respects custom threshold', () => {
  // Two paraphrases — pass with low threshold, fail with high
  const a = 'meeting moved to 4pm';
  const b = 'the meeting was moved to 4pm';
  assert.equal(areDuplicate(a, b, { threshold: 0.4 }), true);
  assert.equal(areDuplicate(a, b, { threshold: 0.99 }), false);
});

// ─── dedupItems ─────────────────────────────────

test('dedupItems: removes near-duplicates from an array of strings', () => {
  const items = [
    'The deadline is 2026-09-30',
    'the deadline is 2026-09-30',
    'Acme Corp signed the contract',
    'The deadline is 2026-09-30!',
  ];
  const { unique, duplicates } = dedupItems(items);
  assert.equal(unique.length, 2);
  assert.equal(duplicates.length, 2);
});

test('dedupItems: handles array of objects with getText', () => {
  const items = [
    { id: 1, text: 'foo bar baz' },
    { id: 2, text: 'Foo, Bar. Baz!' },
    { id: 3, text: 'qux quux quuux' },
  ];
  const { unique } = dedupItems(items);
  assert.equal(unique.length, 2);
});

test('dedupItems: uses .content / .value / .text fallbacks', () => {
  const items = [
    { content: 'alpha beta gamma' },
    { value: 'alpha beta gamma' },
    { text: 'alpha beta gamma' },
    { content: 'unrelated topic here' },
  ];
  const { unique } = dedupItems(items);
  assert.equal(unique.length, 2);
});

test('dedupItems: tracks dropped→kept mapping with similarity', () => {
  const items = ['hello world', 'Hello, World'];
  const { duplicates } = dedupItems(items);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].kept, 'hello world');
  assert.equal(duplicates[0].dropped, 'Hello, World');
  assert.ok(duplicates[0].similarity >= 0.78);
});

test('dedupItems: tolerates empty / null', () => {
  assert.deepEqual(dedupItems([]).unique, []);
  assert.deepEqual(dedupItems(null).unique, []);
});

test('dedupItems: keeps items with empty extracted text', () => {
  const items = [{ id: 1 }, { id: 2 }]; // no text extractable
  const { unique } = dedupItems(items);
  assert.equal(unique.length, 2);
});

// ─── clusterByPrefix ────────────────────────────────

test('clusterByPrefix: groups items by normalised prefix', () => {
  const items = [
    'Acme Corp contract — clause 7',
    'Acme Corp contract — clause 8',
    'Globex Inc partnership — section 2',
  ];
  const buckets = clusterByPrefix(items, 16);
  assert.equal(buckets.length, 2);
});

test('clusterByPrefix: empty buckets safe', () => {
  const buckets = clusterByPrefix([]);
  assert.equal(buckets.length, 0);
});
