/**
 * Tests for the GraphRAG pipeline:
 *   - community-detection (label propagation + hierarchical)
 *   - community-summaries (leaf + super LLM summarisation)
 *   - map-reduce-qa (map per summary, reduce to global answer)
 *   - index orchestration (buildIndex → query)
 *   - triple-graph._dumpEntities bridge
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeVectorFor(text) {
  const v = new Float32Array(8);
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 8;
    v[h] += 1;
  }
  let n = 0;
  for (let i = 0; i < 8; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 8; i++) v[i] /= n;
  return v;
}
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = {
        create: async ({ input }) => ({
          data: input.map(text => ({ embedding: Array.from(fakeVectorFor(text)) })),
        }),
      };
    }
  },
};
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const detection = require('../src/services/agents/graphrag/community-detection');
const summaries = require('../src/services/agents/graphrag/community-summaries');
const mapReduce = require('../src/services/agents/graphrag/map-reduce-qa');
const graphrag = require('../src/services/agents/graphrag');
const tripleGraph = require('../src/services/triple-graph');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    })}},
  };
}

// ─── community-detection ─────────────────────────────────────────────────

test('detection.detect: single disconnected node = single community', () => {
  const r = detection.detect({ nodes: ['a'], edges: [] });
  assert.equal(r.communities.length, 1);
  assert.deepEqual(r.communities[0].members, ['a']);
});

test('detection.detect: two components → two communities', () => {
  // Two clusters: {a,b,c} fully connected, {x,y,z} fully connected, no edge between.
  const r = detection.detect({
    nodes: ['a', 'b', 'c', 'x', 'y', 'z'],
    edges: [
      { a: 'a', b: 'b' }, { a: 'b', b: 'c' }, { a: 'a', b: 'c' },
      { a: 'x', b: 'y' }, { a: 'y', b: 'z' }, { a: 'x', b: 'z' },
    ],
  });
  assert.equal(r.communities.length, 2);
  // Each community should contain one of the triangles.
  const c1 = r.communities.find(c => c.members.includes('a'));
  const c2 = r.communities.find(c => c.members.includes('x'));
  assert.deepEqual(new Set(c1.members), new Set(['a', 'b', 'c']));
  assert.deepEqual(new Set(c2.members), new Set(['x', 'y', 'z']));
});

test('detection.detect: empty graph → empty result', () => {
  const r = detection.detect({ nodes: [], edges: [] });
  assert.deepEqual(r.communities, []);
});

test('detection.detect: deterministic given same seed', () => {
  const opts = {
    nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    edges: [
      { a: 'a', b: 'b' }, { a: 'b', b: 'c' },
      { a: 'd', b: 'e' }, { a: 'e', b: 'f' },
      { a: 'b', b: 'd' }, // weak inter-cluster link
      { a: 'g', b: 'a' },
    ],
    seed: 42,
  };
  const r1 = detection.detect(opts);
  const r2 = detection.detect(opts);
  assert.deepEqual(
    r1.communities.map(c => c.members.slice().sort()),
    r2.communities.map(c => c.members.slice().sort()),
  );
});

test('detection.detect: converged flag signals early stop', () => {
  const r = detection.detect({
    nodes: ['a', 'b', 'c'],
    edges: [{ a: 'a', b: 'b' }, { a: 'b', b: 'c' }, { a: 'a', b: 'c' }],
    maxIters: 5,
  });
  assert.equal(r.converged, true);
});

test('detection.detectHierarchical: produces leaf + (optional) super level', () => {
  // Three clusters loosely connected.
  const nodes = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3'];
  const edges = [
    { a: 'a1', b: 'a2' }, { a: 'a2', b: 'a3' }, { a: 'a1', b: 'a3' },
    { a: 'b1', b: 'b2' }, { a: 'b2', b: 'b3' }, { a: 'b1', b: 'b3' },
    { a: 'c1', b: 'c2' }, { a: 'c2', b: 'c3' }, { a: 'c1', b: 'c3' },
    { a: 'a1', b: 'b1' }, // a ↔ b bridge
  ];
  const r = detection.detectHierarchical({ nodes, edges });
  assert.ok(r.leaf.communities.length >= 2);
  // Every node has an assignment
  for (const n of nodes) {
    assert.ok(r.assignments[n].leaf, `no leaf for ${n}`);
  }
});

test('detection.detectHierarchical: single community → no super level', () => {
  const nodes = ['a', 'b'];
  const edges = [{ a: 'a', b: 'b' }];
  const r = detection.detectHierarchical({ nodes, edges });
  // With only one leaf community, super should be null.
  assert.equal(r.super, null);
});

test('detection.buildAdjacency: undirected from edge list', () => {
  const adj = detection.buildAdjacency(['a', 'b', 'c'], [{ a: 'a', b: 'b' }, { a: 'b', b: 'c' }]);
  assert.equal(adj.get('a').length, 1);
  assert.equal(adj.get('b').length, 2);
  assert.equal(adj.get('c').length, 1);
});

// ─── community-summaries ────────────────────────────────────────────────

test('summaries.summariseLeaf: parses topic/summary/key_entities/themes', async () => {
  const openai = scripted([JSON.stringify({
    topic: 'Machine learning',
    summary: 'These entities relate to supervised ML techniques.',
    key_entities: ['neural network', 'gradient descent', 'loss function'],
    themes: ['optimization', 'training'],
  })]);
  const r = await summaries.summariseLeaf({
    openai,
    community: { id: 'c0', members: ['neural network', 'gradient descent', 'loss function'] },
    getRelations: () => [{ subject: 'nn', predicate: 'uses', object: 'gradient' }],
  });
  assert.equal(r.community_id, 'c0');
  assert.equal(r.topic, 'Machine learning');
  assert.equal(r.key_entities.length, 3);
  assert.equal(r.themes.length, 2);
  assert.equal(r.level, 'leaf');
});

test('summaries.summariseLeaf: null LLM → neutral fallback', async () => {
  const r = await summaries.summariseLeaf({
    openai: null,
    community: { id: 'c0', members: ['a'] },
    getRelations: () => [],
  });
  assert.ok(r.summary.includes('unavailable'));
});

test('summaries.summariseSuper: synthesises from child summaries', async () => {
  const openai = scripted([JSON.stringify({
    topic: 'AI research areas',
    summary: 'Multiple distinct threads including ML, robotics, NLP.',
    cross_cutting_themes: ['representation learning'],
  })]);
  const r = await summaries.summariseSuper({
    openai,
    community: { id: 's0', members: ['c0', 'c1'] },
    childSummaries: [
      { community_id: 'c0', topic: 'ML', summary: 's1' },
      { community_id: 'c1', topic: 'Robotics', summary: 's2' },
    ],
  });
  assert.equal(r.level, 'super');
  assert.equal(r.n_children, 2);
  assert.equal(r.cross_cutting_themes.length, 1);
});

test('summaries.summariseSuper: no children → neutral fallback', async () => {
  const r = await summaries.summariseSuper({
    openai: scripted([]),
    community: { id: 's0', members: [] },
    childSummaries: [],
  });
  assert.ok(r.summary.includes('unavailable'));
});

test('summaries.summariseAll: generates leaf + super summaries end-to-end', async () => {
  // Script: 2 leaf summaries, then 1 super summary.
  const openai = scripted([
    JSON.stringify({ topic: 'Topic 1', summary: 's1', key_entities: [], themes: [] }),
    JSON.stringify({ topic: 'Topic 2', summary: 's2', key_entities: [], themes: [] }),
    JSON.stringify({ topic: 'Super', summary: 'super s', cross_cutting_themes: [] }),
  ]);
  const hierarchy = {
    leaf: {
      communities: [
        { id: 'c0', members: ['a'] },
        { id: 'c1', members: ['b'] },
      ],
    },
    super: {
      communities: [{ id: 's0', members: ['c0', 'c1'] }],
    },
  };
  const r = await summaries.summariseAll({
    openai, hierarchy, getRelations: () => [],
  });
  assert.equal(r.leaf.length, 2);
  assert.equal(r.super.length, 1);
  assert.ok(r.byId.c0);
  assert.ok(r.byId.s0);
});

// ─── map-reduce-qa ───────────────────────────────────────────────────────

test('mapReduce.mapStep: parses partial_answer + helpfulness', async () => {
  const openai = scripted([JSON.stringify({
    partial_answer: 'This community covers X and Y.',
    helpfulness: 75,
    reasoning: 'highly relevant',
  })]);
  const r = await mapReduce.mapStep({
    openai, query: 'what are the themes?',
    summary: { community_id: 'c0', topic: 'ML', summary: 's', themes: ['t'] },
  });
  assert.equal(r.community_id, 'c0');
  assert.equal(r.helpfulness, 75);
  assert.ok(r.partial_answer.length > 0);
});

test('mapReduce.mapStep: clamps helpfulness to [0, 100]', async () => {
  const openai = scripted([JSON.stringify({
    partial_answer: 'x', helpfulness: 9999,
  })]);
  const r = await mapReduce.mapStep({
    openai, query: 'q',
    summary: { community_id: 'c0', summary: 's' },
  });
  assert.equal(r.helpfulness, 100);
});

test('mapReduce.reduceStep: synthesises final answer from partials', async () => {
  const openai = scripted([JSON.stringify({
    answer: 'Comprehensive global answer synthesised from communities.',
    themes: ['t1', 't2'],
    contributing_communities: ['c0', 'c1'],
  })]);
  const r = await mapReduce.reduceStep({
    openai, query: 'q',
    partials: [
      { community_id: 'c0', partial_answer: 'pa1', helpfulness: 80 },
      { community_id: 'c1', partial_answer: 'pa2', helpfulness: 75 },
    ],
  });
  assert.ok(r.answer.length > 20);
  assert.equal(r.themes.length, 2);
  assert.deepEqual(r.contributing_communities, ['c0', 'c1']);
});

test('mapReduce.reduceStep: empty partials → placeholder answer', async () => {
  const r = await mapReduce.reduceStep({
    openai: scripted([]), query: 'q', partials: [],
  });
  assert.ok(r.answer.includes('no helpful'));
});

test('mapReduce.answer: filters by minHelpfulness and reduces', async () => {
  // 3 communities: 2 helpful (>= 40), 1 not. Reduce gets 2.
  let i = 0;
  const responses = [
    JSON.stringify({ partial_answer: 'a1', helpfulness: 80 }),
    JSON.stringify({ partial_answer: 'a2', helpfulness: 25 }),    // drops
    JSON.stringify({ partial_answer: 'a3', helpfulness: 60 }),
    JSON.stringify({
      answer: 'Synthesised.', themes: ['t'], contributing_communities: ['c0', 'c2'],
    }),
  ];
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: responses[Math.min(i++, responses.length - 1)] } }],
  })}}};
  const r = await mapReduce.answer({
    openai, query: 'q',
    summaries: [
      { community_id: 'c0', summary: 's1' },
      { community_id: 'c1', summary: 's2' },
      { community_id: 'c2', summary: 's3' },
    ],
    minHelpfulness: 40,
  });
  assert.equal(r.stats.n_communities, 3);
  assert.equal(r.stats.n_helpful, 2);
  assert.ok(r.answer.includes('Synthesised'));
});

test('mapReduce.answer: no summaries → placeholder', async () => {
  const r = await mapReduce.answer({ openai: scripted([]), query: 'q', summaries: [] });
  assert.equal(r.stats.n_communities, 0);
  assert.ok(r.answer.includes('no community'));
});

test('mapReduce.answer: missing openai throws', async () => {
  await assert.rejects(
    mapReduce.answer({ query: 'q', summaries: [{ community_id: 'c', summary: 's' }] }),
    /openai required/,
  );
});

// ─── graphrag index orchestration ───────────────────────────────────────

test('graphrag.buildIndex: end-to-end build from entities + edges', async () => {
  // Stub: 2 leaf summaries + 0 super (single super-community on small graph).
  const openai = scripted([
    JSON.stringify({ topic: 'A', summary: 'a-summary', key_entities: [], themes: [] }),
    JSON.stringify({ topic: 'B', summary: 'b-summary', key_entities: [], themes: [] }),
  ]);
  const idx = await graphrag.buildIndex({
    openai,
    userId: 'u1', collection: 'c1',
    entities: ['a', 'b', 'x', 'y'],
    edges: [
      { a: 'a', b: 'b' },
      { a: 'x', b: 'y' },
    ],
    getRelations: () => [],
  });
  assert.equal(idx.stats.n_entities, 4);
  assert.equal(idx.stats.n_edges, 2);
  assert.ok(idx.stats.n_leaf_communities >= 1);
});

test('graphrag.buildIndex: empty entities returns empty index', async () => {
  const r = await graphrag.buildIndex({
    openai: scripted([]),
    userId: 'u', collection: 'c',
    entities: [], edges: [],
  });
  assert.equal(r.stats.n_entities, 0);
});

test('graphrag.query: no index → index_missing flag', async () => {
  graphrag.clearIndex('ghost', 'nothing');
  const r = await graphrag.query({
    openai: scripted([]),
    userId: 'ghost', collection: 'nothing', query: 'anything',
  });
  assert.ok(r.stats.index_missing);
});

test('graphrag.query: uses leaf summaries by default', async () => {
  // Build: 2 leaf summaries + 1 super summary (generated automatically
  // when ≥2 leaf communities exist). Then query: 2 mapSteps + 1 reduce.
  const openai = scripted([
    JSON.stringify({ topic: 'A', summary: 'a', key_entities: [], themes: [] }),
    JSON.stringify({ topic: 'B', summary: 'b', key_entities: [], themes: [] }),
    JSON.stringify({ topic: 'Super', summary: 'super', cross_cutting_themes: [] }),
    JSON.stringify({ partial_answer: 'p1', helpfulness: 80 }),
    JSON.stringify({ partial_answer: 'p2', helpfulness: 70 }),
    JSON.stringify({ answer: 'Final answer.', themes: [], contributing_communities: ['c0', 'c1'] }),
  ]);
  await graphrag.buildIndex({
    openai, userId: 'u2', collection: 'c2',
    entities: ['a', 'b', 'x', 'y'],
    edges: [{ a: 'a', b: 'b' }, { a: 'x', b: 'y' }],
    getRelations: () => [],
  });
  const r = await graphrag.query({
    openai, userId: 'u2', collection: 'c2',
    query: 'What are the themes?',
  });
  assert.ok(r.answer.includes('Final'));
  assert.ok(r.stats.n_communities > 0);
});

test('graphrag.clearIndex: wipes stored index', async () => {
  const openai = scripted([JSON.stringify({ topic: 'X', summary: 's', key_entities: [], themes: [] })]);
  await graphrag.buildIndex({
    openai, userId: 'u3', collection: 'c3',
    entities: ['a'], edges: [],
    getRelations: () => [],
  });
  assert.ok(graphrag.getIndex('u3', 'c3'));
  graphrag.clearIndex('u3', 'c3');
  assert.equal(graphrag.getIndex('u3', 'c3'), null);
});

// ─── triple-graph bridge ────────────────────────────────────────────────

test('tripleGraph._dumpEntities: empty namespace returns empty shape', () => {
  const r = tripleGraph._dumpEntities('ghost-user', 'nothing');
  assert.deepEqual(r.entities, []);
  assert.deepEqual(r.edges, []);
  assert.equal(typeof r.getRelations, 'function');
});

test('tripleGraph._dumpEntities: builds entity graph + edges from triples', async () => {
  const uid = `gr-${Math.random()}`;
  const col = 'gr';
  tripleGraph.clear(uid, col);
  await tripleGraph.addTriples(uid, col, [
    { subject: 'Alice', predicate: 'works at', object: 'Acme' },
    { subject: 'Bob', predicate: 'works at', object: 'Acme' },
    { subject: 'Alice', predicate: 'friend of', object: 'Bob' },
  ], { embedder: null });

  const r = tripleGraph._dumpEntities(uid, col);
  // Entities: alice, bob, acme (lowercased by triple-graph)
  assert.equal(r.entities.length, 3);
  // Edges: alice-acme, bob-acme, alice-bob (3 edges).
  assert.ok(r.edges.length >= 2);
  // getRelations returns triples for a given entity.
  const rels = r.getRelations('alice');
  assert.ok(rels.length >= 2);
});
