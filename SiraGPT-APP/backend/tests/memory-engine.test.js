'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/memory-engine');

test('extractTopics: keeps meaningful words, drops stopwords/short', () => {
  const t = engine.extractTopics('¿recuerdas qué framework prefiero para los tests?');
  assert.ok(t.includes('framework'));
  assert.ok(t.includes('prefiero'));
  assert.ok(t.includes('tests'));
  assert.ok(!t.includes('que'));
  assert.ok(!t.includes('los'));
  assert.ok(!t.includes('recuerdas')); // stopword
});

test('topicMatches: exact + 5-char stem (prefiero↔prefiere, react↔React)', () => {
  assert.equal(engine.topicMatches('el usuario prefiere typescript', 'prefiero'), true);
  assert.equal(engine.topicMatches('el usuario prefiere react', 'react'), true);
  assert.equal(engine.topicMatches('el usuario se llama ana', 'python'), false);
});

test('rankRecall: enriches with matchedTopics + why + rank, ordered by blend', () => {
  const items = [
    { fact: 'El usuario prefiere TypeScript', score: 0.6, tier: 'short_term' },
    { fact: 'El usuario se llama Ana', score: 0.9, tier: 'long_term' },
  ];
  const ranked = engine.rankRecall('qué lenguaje prefiero, typescript?', items);
  assert.equal(ranked.length, 2);
  // The TypeScript fact matches the "typescript"/"prefiero" topics → should rank
  // high despite a lower store score.
  const ts = ranked.find((m) => /TypeScript/.test(m.fact));
  assert.ok(ts.matchedTopics.length >= 1);
  assert.match(ts.why, /Coincide con/);
  assert.equal(typeof ts.blendedScore, 'number');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
});

test('rankRecall: caps at limit and tolerates empty/garbage', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ fact: `fact ${i}`, score: 0.5 }));
  assert.equal(engine.rankRecall('x', many, { limit: 3 }).length, 3);
  assert.deepEqual(engine.rankRecall('x', []), []);
  assert.deepEqual(engine.rankRecall('x', [null, { nope: 1 }]), []);
});

test('rankRecall: no matched topics still yields a generic why', () => {
  const ranked = engine.rankRecall('hola', [{ fact: 'El usuario vive en Lima', score: 0.5 }]);
  assert.equal(ranked[0].matchedTopics.length, 0);
  assert.match(ranked[0].why, /Relacionado/);
});

test('buildBlock: renders a markdown block or empty', () => {
  assert.equal(engine.buildBlock([]), '');
  const block = engine.buildBlock([{ fact: 'A' }, { fact: 'B' }]);
  assert.match(block, /Memoria del usuario/);
  assert.match(block, /- A/);
  assert.match(block, /- B/);
  assert.match(block, /MENCI[OÓ]NALO|recuerdo/i); // instructs citing memory as a source
});

test('dedupeCandidates: merges by id (first wins, keeps score) + fact fallback', () => {
  const a = [{ id: '1', fact: 'X', score: 0.9 }, { id: '2', fact: 'Y' }];
  const b = [{ id: '1', fact: 'X' }, { id: '3', fact: 'Z' }];
  const merged = engine.dedupeCandidates(a, b);
  assert.deepEqual(merged.map((m) => m.fact), ['X', 'Y', 'Z']);
  assert.equal(merged[0].score, 0.9); // first occurrence (with score) kept
  // id-less items dedupe by normalized fact (case-insensitive).
  assert.equal(engine.dedupeCandidates([{ fact: 'Hola' }], [{ fact: 'hola' }]).length, 1);
  assert.deepEqual(engine.dedupeCandidates(null, undefined, [{ nope: 1 }]), []);
});
