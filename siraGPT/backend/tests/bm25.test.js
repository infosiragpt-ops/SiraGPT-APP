/**
 * Unit tests for services/bm25.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  tokenize,
  buildIndex,
  searchIndex,
  idf,
  DEFAULT_K1,
  DEFAULT_B,
} = require('../src/services/bm25');

test('tokenize: lowercases and keeps identifier tokens whole', () => {
  const tokens = tokenize('createUser(email: string): Promise<User>');
  assert.ok(tokens.includes('createuser'));
  assert.ok(tokens.includes('email'));
  assert.ok(tokens.includes('string'));
  assert.ok(tokens.includes('promise'));
  assert.ok(tokens.includes('user'));
});

test('tokenize: drops stop words in EN and ES', () => {
  const tokens = tokenize('The quick brown fox and the lazy dog');
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('and'));
  assert.ok(tokens.includes('quick'));
  assert.ok(tokens.includes('brown'));
});

test('tokenize: handles accented unicode', () => {
  const tokens = tokenize('función ñandú café');
  assert.ok(tokens.includes('función'));
  assert.ok(tokens.includes('ñandú'));
  assert.ok(tokens.includes('café'));
});

test('buildIndex: empty input returns zeroed index', () => {
  const idx = buildIndex([]);
  assert.equal(idx.totalDocs, 0);
  assert.equal(idx.avgDocLength, 0);
});

test('buildIndex: tallies docFreq across unique doc terms', () => {
  const idx = buildIndex([
    { text: 'cat dog fish' },
    { text: 'cat dog mouse' },
    { text: 'bird fish shark' },
  ]);
  assert.equal(idx.docFreq.get('cat'), 2);
  assert.equal(idx.docFreq.get('dog'), 2);
  assert.equal(idx.docFreq.get('fish'), 2);
  assert.equal(idx.docFreq.get('mouse'), 1);
  assert.equal(idx.docFreq.get('bird'), 1);
});

test('idf: rare term scores higher than common term', () => {
  const idx = buildIndex([
    { text: 'apple orange banana' },
    { text: 'apple pear banana' },
    { text: 'apple kiwi banana' },
    { text: 'grape melon pineapple' },
  ]);
  const rareIdf = idf('grape', idx.docFreq, idx.totalDocs); // appears in 1 doc
  const commonIdf = idf('apple', idx.docFreq, idx.totalDocs); // appears in 3 of 4
  assert.ok(rareIdf > commonIdf, `rare=${rareIdf} should beat common=${commonIdf}`);
});

test('searchIndex: returns docs sorted by relevance', () => {
  const docs = [
    { text: 'The rain in Spain falls mainly on the plain', id: 'rain' },
    { text: 'The quick brown fox jumps over the lazy dog', id: 'fox' },
    { text: 'Spain is a country in Europe', id: 'spain' },
  ];
  const idx = buildIndex(docs);
  const hits = searchIndex(idx, 'Spain rain', { k: 3 });
  // 'rain' doc has both "rain" and "Spain" → should be #1
  assert.equal(hits[0].doc.id, 'rain');
  // 'spain' doc only has "Spain" → should outrank 'fox' which has neither
  assert.ok(hits.findIndex(h => h.doc.id === 'spain') < hits.findIndex(h => h.doc.id === 'fox'));
});

test('searchIndex: empty query returns empty list', () => {
  const idx = buildIndex([{ text: 'anything here' }]);
  assert.deepEqual(searchIndex(idx, ''), []);
});

test('searchIndex: query with only stop words returns empty', () => {
  const idx = buildIndex([{ text: 'alpha beta gamma' }]);
  assert.deepEqual(searchIndex(idx, 'the and of'), []);
});

test('searchIndex: identifier-style query matches code-ish docs', () => {
  const docs = [
    { text: 'function createUser(name) { return { name }; }', id: 'create' },
    { text: 'function deleteUser(id) { return null; }', id: 'delete' },
    { text: 'const config = { port: 3000 };', id: 'config' },
  ];
  const idx = buildIndex(docs);
  const hits = searchIndex(idx, 'createUser', { k: 3 });
  assert.equal(hits[0].doc.id, 'create');
});

test('searchIndex: repeated query term boosts contribution', () => {
  const docs = [{ text: 'alpha beta gamma' }, { text: 'alpha alpha' }];
  const idx = buildIndex(docs);
  const hitsOnce = searchIndex(idx, 'alpha', { k: 2 });
  const hitsTwice = searchIndex(idx, 'alpha alpha', { k: 2 });
  // Second doc has more alphas, should win both; repeated query amplifies margin.
  const marginOnce = hitsOnce[0].score - hitsOnce[1].score;
  const marginTwice = hitsTwice[0].score - hitsTwice[1].score;
  assert.ok(marginTwice > marginOnce, 'repeating query term should widen top-2 margin');
});

test('DEFAULT_K1/B are textbook values', () => {
  assert.equal(DEFAULT_K1, 1.5);
  assert.equal(DEFAULT_B, 0.75);
});
