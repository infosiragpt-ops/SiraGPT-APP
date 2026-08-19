/**
 * Unit tests for services/triple-graph.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const graph = require('../src/services/triple-graph');

// Deterministic fake embedder for linkTriple tests. Same string → same
// vector, so identical triples hit cosine=1 and different triples < 1.
function fakeEmbedder(texts) {
  return Promise.resolve(texts.map(s => {
    const v = new Float32Array(8);
    for (let i = 0; i < s.length; i++) v[i % 8] += s.charCodeAt(i);
    let norm = 0;
    for (let i = 0; i < 8; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 8; i++) v[i] /= norm;
    return v;
  }));
}

test('tripleKey: lowercased s|p|o', () => {
  const k = graph.tripleKey({ subject: 'Alpha', predicate: 'IS', object: 'Beta' });
  assert.equal(k, 'alpha|is|beta');
});

test('tripleToSentence: joins with spaces', () => {
  const s = graph.tripleToSentence({ subject: 'A', predicate: 'is', object: 'B' });
  assert.equal(s, 'A is B');
});

test('addTriples: deduplicates on canonical key', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  const r1 = await graph.addTriples(uid, 'c', [
    { subject: 'Stephen Curry', predicate: 'plays for', object: 'Warriors', source: 'a.md' },
    { subject: 'stephen curry', predicate: 'PLAYS FOR', object: 'warriors', source: 'b.md' }, // same key
  ], { embedder: null });
  assert.equal(r1.added, 1);
  assert.equal(graph.stats(uid, 'c').triples, 1);
});

test('addTriples: tracks distinct entities and sources', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  await graph.addTriples(uid, 'c', [
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors', source: 'a.md' },
    { subject: 'Curry', predicate: 'born in', object: 'Akron', source: 'b.md' },
    { subject: 'LeBron', predicate: 'plays for', object: 'Lakers', source: 'c.md' },
  ], { embedder: null });
  const st = graph.stats(uid, 'c');
  assert.equal(st.triples, 3);
  assert.ok(st.entities >= 5); // Curry, Warriors, Akron, LeBron, Lakers
  assert.equal(st.sources, 3);
});

test('getNeighbours: triples sharing head or tail entity', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  await graph.addTriples(uid, 'c', [
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
    { subject: 'Curry', predicate: 'born in', object: 'Akron' },
    { subject: 'Thompson', predicate: 'plays for', object: 'Warriors' },
    { subject: 'LeBron', predicate: 'plays for', object: 'Lakers' },
  ], { embedder: null });

  const ns = graph.getNeighbours(uid, 'c', {
    subject: 'Curry', predicate: 'plays for', object: 'Warriors',
  });
  // Neighbours: shares "Curry" → "born in Akron"; shares "Warriors" → "Thompson plays for Warriors".
  // Does NOT include LeBron (no shared entity). Does NOT include self.
  const names = ns.map(n => `${n.subject}|${n.object}`);
  assert.ok(names.includes('Curry|Akron'));
  assert.ok(names.includes('Thompson|Warriors'));
  assert.ok(!names.some(s => s.includes('LeBron')));
  assert.ok(!names.includes('Curry|Warriors'));
});

test('getNeighbours: excludeKeys drops already-visited triples', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  await graph.addTriples(uid, 'c', [
    { subject: 'A', predicate: 'p', object: 'B' },
    { subject: 'A', predicate: 'p', object: 'C' },
    { subject: 'A', predicate: 'p', object: 'D' },
  ], { embedder: null });
  const exclude = new Set([graph.tripleKey({ subject: 'A', predicate: 'p', object: 'C' })]);
  const ns = graph.getNeighbours(uid, 'c', { subject: 'A', predicate: 'p', object: 'B' }, { excludeKeys: exclude });
  // Of the two other triples, only "A p D" survives — "A p C" is excluded.
  assert.equal(ns.length, 1);
  assert.equal(ns[0].object, 'D');
});

test('linkTriple: returns closest stored triple by cosine', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  await graph.addTriples(uid, 'c', [
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
    { subject: 'Einstein', predicate: 'born in', object: 'Germany' },
  ], { embedder: fakeEmbedder });

  const linked = await graph.linkTriple(
    uid, 'c',
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors' }, // exact match
    { embedder: fakeEmbedder },
  );
  assert.ok(linked, 'link returned null');
  assert.equal(linked.triple.subject, 'Curry');
  assert.ok(linked.score > 0.99);
});

test('linkTriple: empty graph returns null', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  const linked = await graph.linkTriple(uid, 'c', { subject: 'a', predicate: 'b', object: 'c' }, { embedder: fakeEmbedder });
  assert.equal(linked, null);
});

test('linkTriple: k>1 returns ranked list', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  await graph.addTriples(uid, 'c', [
    { subject: 'A', predicate: 'p', object: 'B' },
    { subject: 'A', predicate: 'p', object: 'C' },
    { subject: 'X', predicate: 'q', object: 'Y' },
  ], { embedder: fakeEmbedder });
  const list = await graph.linkTriple(uid, 'c', { subject: 'A', predicate: 'p', object: 'B' }, { embedder: fakeEmbedder, k: 2 });
  assert.equal(list.length, 2);
  assert.ok(list[0].score >= list[1].score);
});

test('getTriplesForSource: reverse lookup by source id', async () => {
  const uid = `t-${Math.random()}`;
  graph.clear(uid, 'c');
  await graph.addTriples(uid, 'c', [
    { subject: 'A', predicate: 'p', object: 'B', source: 'doc1' },
    { subject: 'C', predicate: 'p', object: 'D', source: 'doc1' },
    { subject: 'E', predicate: 'p', object: 'F', source: 'doc2' },
  ], { embedder: null });
  const d1 = graph.getTriplesForSource(uid, 'c', 'doc1');
  assert.equal(d1.length, 2);
  const d2 = graph.getTriplesForSource(uid, 'c', 'doc2');
  assert.equal(d2.length, 1);
});

test('clear: wipes the namespace', async () => {
  const uid = `t-${Math.random()}`;
  await graph.addTriples(uid, 'c', [
    { subject: 'A', predicate: 'p', object: 'B' },
  ], { embedder: null });
  assert.equal(graph.stats(uid, 'c').triples, 1);
  graph.clear(uid, 'c');
  assert.equal(graph.stats(uid, 'c').triples, 0);
});
