/**
 * Tests for RAPTOR tree construction + retrieval.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const raptor = require('../src/services/rag/raptor-tree');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// Deterministic embedder: text -> small unit vector based on token bag.
// This gives clusters of "similar" texts strong cosine similarity.
function fakeEmbed(texts) {
  return texts.map(t => {
    const v = new Array(16).fill(0);
    const toks = String(t || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    for (const tok of toks) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) % 16;
      v[h] += 1;
    }
    let n = 0;
    for (let i = 0; i < 16; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < 16; i++) v[i] /= n;
    return v;
  });
}

// ─── cosineSim + cluster ─────────────────────────────────────────────────

test('cosineSim: identical vector → 1', () => {
  const v = [0.5, 0.5, 0.5, 0.5];
  assert.equal(raptor.cosineSim(v, v), 1);
});

test('cosineSim: orthogonal → 0', () => {
  assert.equal(raptor.cosineSim([1, 0], [0, 1]), 0);
});

test('cosineSim: mismatched dims → 0', () => {
  assert.equal(raptor.cosineSim([1, 2], [1, 2, 3]), 0);
});

test('clusterByCosine: small input returned as one cluster', () => {
  const items = [
    { id: 'a', embedding: [1, 0] },
    { id: 'b', embedding: [1, 0] },
  ];
  const clusters = raptor.clusterByCosine(items, 4);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 2);
});

test('clusterByCosine: groups semantically similar items', () => {
  // Two natural clusters (parallel vs orthogonal directions)
  const items = [
    { id: 'a1', embedding: [1, 0, 0, 0] },
    { id: 'a2', embedding: [0.95, 0.1, 0, 0] },
    { id: 'b1', embedding: [0, 0, 1, 0] },
    { id: 'b2', embedding: [0, 0.1, 0.95, 0] },
  ];
  const clusters = raptor.clusterByCosine(items, 2);
  assert.equal(clusters.length, 2);
  // Each cluster should hold a same-direction pair (a or b).
  const clusterIds = clusters.map(c => c.map(x => x.id).sort().join(','));
  assert.ok(clusterIds.some(c => c === 'a1,a2'));
  assert.ok(clusterIds.some(c => c === 'b1,b2'));
});

// ─── buildTree ───────────────────────────────────────────────────────────

test('buildTree: creates level-0 leaves only when already below cluster size', async () => {
  const leaves = [
    { text: 'leaf one' },
    { text: 'leaf two' },
  ];
  const openai = scripted([]);
  const tree = await raptor.buildTree({
    openai, embed: fakeEmbed, leaves, clusterSize: 4, maxLevels: 3,
  });
  // Two leaves, clusterSize 4 → no higher levels.
  assert.equal(tree.levels, 1);
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.roots.length, 2);
});

test('buildTree: builds level-1 summary nodes for larger inputs', async () => {
  const leaves = [
    { text: 'apples are red fruit' },
    { text: 'apples grow on apple trees' },
    { text: 'bananas are yellow fruit' },
    { text: 'bananas grow in tropical areas' },
    { text: 'cars are vehicles' },
    { text: 'cars use engines to move' },
  ];
  const openai = scripted([
    JSON.stringify({ summary: 'Apples: red fruit growing on trees.', topic: 'apples' }),
    JSON.stringify({ summary: 'Bananas: yellow tropical fruit.', topic: 'bananas' }),
    JSON.stringify({ summary: 'Cars: vehicles with engines.', topic: 'cars' }),
    JSON.stringify({ summary: 'Food + transport overview.', topic: 'mixed' }),
  ]);
  const tree = await raptor.buildTree({
    openai, embed: fakeEmbed, leaves, clusterSize: 2, maxLevels: 3,
  });
  assert.ok(tree.levels >= 2);
  const level1 = tree.nodes.filter(n => n.level === 1);
  assert.ok(level1.length >= 2, `expected at least 2 level-1 summaries, got ${level1.length}`);
  // Every level-1 node must link back to its leaves.
  for (const n of level1) {
    assert.ok(n.children.length > 0);
  }
});

test('buildTree: missing embed fn rejected', async () => {
  await assert.rejects(
    raptor.buildTree({ openai: scripted([]), leaves: [{ text: 'x' }] }),
    /embed\(fn\) required/,
  );
});

test('buildTree: missing openai rejected when summaries needed', async () => {
  await assert.rejects(
    raptor.buildTree({ openai: null, embed: fakeEmbed, leaves: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }),
    /openai required/,
  );
});

test('buildTree: empty leaves → empty tree', async () => {
  const tree = await raptor.buildTree({ openai: scripted([]), embed: fakeEmbed, leaves: [] });
  assert.equal(tree.nodes.length, 0);
  assert.equal(tree.roots.length, 0);
});

// ─── retrieveFlat ────────────────────────────────────────────────────────

test('retrieveFlat: returns top-K across all nodes by cosine similarity', async () => {
  const leaves = [
    { text: 'red apples grow in orchards' },
    { text: 'yellow bananas in tropics' },
    { text: 'cars use fuel engines' },
  ];
  const openai = scripted([
    JSON.stringify({ summary: 'Mixed fruit and vehicle topics.', topic: 'mixed' }),
  ]);
  const tree = await raptor.buildTree({
    openai, embed: fakeEmbed, leaves, clusterSize: 4, maxLevels: 2,
  });
  const [queryEmbedding] = fakeEmbed(['apples orchards red fruit']);
  const hits = raptor.retrieveFlat({ tree, queryEmbedding, k: 2 });
  assert.equal(hits.length, 2);
  // The fruit-related node should be on top.
  assert.match(hits[0].text, /apple|fruit/i);
});

// ─── retrieveTreeTraversal ───────────────────────────────────────────────

test('retrieveTreeTraversal: walks top-down, returns leaves by default', async () => {
  const leaves = [
    { text: 'red apples grow in orchards across temperate regions' },
    { text: 'yellow bananas grow in tropical areas near the equator' },
    { text: 'cars use internal combustion engines and fuel' },
    { text: 'bicycles use pedal power not engines' },
  ];
  const openai = scripted([
    JSON.stringify({ summary: 'Fruit: apples + bananas in different climates.', topic: 'fruit' }),
    JSON.stringify({ summary: 'Vehicles: cars + bicycles.', topic: 'vehicles' }),
    JSON.stringify({ summary: 'Covers fruit + vehicles.', topic: 'mixed' }),
  ]);
  const tree = await raptor.buildTree({
    openai, embed: fakeEmbed, leaves, clusterSize: 2, maxLevels: 3,
  });
  const [queryEmbedding] = fakeEmbed(['apples grow in orchards']);
  const hits = raptor.retrieveTreeTraversal({
    tree, queryEmbedding, kPerLevel: 2, returnLeaves: true,
  });
  assert.ok(hits.length >= 1);
  // With kPerLevel=2, broadened traversal must surface the apple leaf
  // somewhere — either directly or via the fruit branch summary hop.
  assert.ok(hits.some(h => /apple/i.test(h.text)));
});

test('retrieveTreeTraversal: empty tree → []', () => {
  const hits = raptor.retrieveTreeTraversal({
    tree: { nodes: [], roots: [] },
    queryEmbedding: [1, 0, 0],
  });
  assert.deepEqual(hits, []);
});
