/**
 * Tests for proposition-level indexing (Dense X retrieval).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const pi = require('../src/services/rag/proposition-indexer');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── extractPropositions ─────────────────────────────────────────────────

test('extractPropositions: returns clean unique list', async () => {
  const openai = scripted([
    JSON.stringify({
      propositions: [
        'The Eiffel Tower was completed in 1889.',
        'The Eiffel Tower was inaugurated at the 1889 World\'s Fair.',
        'The Eiffel Tower was completed in 1889.', // dup
      ],
    }),
  ]);
  const out = await pi.extractPropositions({ openai, text: 'passage' });
  assert.equal(out.length, 2);
  assert.match(out[0], /completed in 1889/);
});

test('extractPropositions: empty text → []', async () => {
  const out = await pi.extractPropositions({ openai: scripted([]), text: '' });
  assert.deepEqual(out, []);
});

test('extractPropositions: null openai → []', async () => {
  const out = await pi.extractPropositions({ openai: null, text: 'anything' });
  assert.deepEqual(out, []);
});

test('extractPropositions: honours maxPropositions cap', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `Fact number ${i}.`);
  const openai = scripted([JSON.stringify({ propositions: many })]);
  const out = await pi.extractPropositions({ openai, text: 'long passage', maxPropositions: 5 });
  assert.equal(out.length, 5);
});

test('extractPropositions: LLM error → []', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('down'); } } },
  };
  const out = await pi.extractPropositions({ openai, text: 'x' });
  assert.deepEqual(out, []);
});

// ─── indexPassage ────────────────────────────────────────────────────────

test('indexPassage: emits parent + children pointing back to parentId', async () => {
  const openai = scripted([
    JSON.stringify({
      propositions: [
        'A is true.',
        'B is also true.',
      ],
    }),
  ]);
  const { parent, propositions } = await pi.indexPassage({
    openai,
    source: 'doc1',
    text: 'Some passage about A and B.',
    parentMeta: { section: 'intro' },
  });
  assert.equal(parent.metadata.section, 'intro');
  assert.equal(parent.metadata.strategy, 'proposition');
  assert.equal(propositions.length, 2);
  for (const p of propositions) {
    assert.equal(p.parentId, parent.id);
    assert.equal(p.metadata.role, 'proposition');
    assert.equal(p.metadata.section, 'intro'); // metadata propagates
  }
});

// ─── expandToParents ─────────────────────────────────────────────────────

test('expandToParents: aggregates proposition hits back to parent with summed scores', () => {
  const parent1 = { id: 'p1', text: 'Parent one body.', source: 'doc1' };
  const parent2 = { id: 'p2', text: 'Parent two body.', source: 'doc2' };
  const hits = [
    { id: 'prop1', parentId: 'p1', score: 0.8 },
    { id: 'prop2', parentId: 'p1', score: 0.5 },
    { id: 'prop3', parentId: 'p2', score: 0.6 },
  ];
  const { passages } = pi.expandToParents({
    hits,
    parentById: new Map([['p1', parent1], ['p2', parent2]]),
  });
  assert.equal(passages.length, 2);
  const p1 = passages.find(p => p.id === 'p1');
  assert.ok(Math.abs(p1.score - 1.3) < 1e-9);
  assert.equal(p1.propositionCount, 2);
  // Sorted by total score desc — p1 (1.3) > p2 (0.6).
  assert.equal(passages[0].id, 'p1');
});

test('expandToParents: hits without parentId or missing parent are skipped', () => {
  const hits = [
    { id: 'x', parentId: 'missing', score: 0.9 },
    { id: 'y', score: 0.5 },
  ];
  const { passages } = pi.expandToParents({ hits, parentById: new Map() });
  assert.equal(passages.length, 0);
});

test('expandToParents: empty input', () => {
  const { passages } = pi.expandToParents({ hits: [], parentById: {} });
  assert.deepEqual(passages, []);
});
