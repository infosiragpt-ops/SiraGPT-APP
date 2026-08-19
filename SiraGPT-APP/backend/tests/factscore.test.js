/**
 * Tests for FactScore-lite.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const fs = require('../src/services/rag/factscore');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── extractFacts ────────────────────────────────────────────────────────

test('extractFacts: returns clean unique list', async () => {
  const openai = scripted([JSON.stringify({
    facts: [
      'The Eiffel Tower was completed in 1889.',
      'The Eiffel Tower is 330m tall.',
      'The Eiffel Tower was completed in 1889.',  // dup
    ],
  })]);
  const f = await fs.extractFacts({ openai, text: 'A biography passage about the Eiffel Tower' });
  assert.equal(f.length, 2);
  assert.match(f[0], /1889/);
});

test('extractFacts: empty text → []', async () => {
  const f = await fs.extractFacts({ openai: scripted([]), text: '' });
  assert.deepEqual(f, []);
});

test('extractFacts: null openai → []', async () => {
  const f = await fs.extractFacts({ openai: null, text: 'some text' });
  assert.deepEqual(f, []);
});

test('extractFacts: caps at maxFacts', async () => {
  const openai = scripted([JSON.stringify({
    facts: Array.from({ length: 50 }, (_, i) => `Fact ${i} is a claim.`),
  })]);
  const f = await fs.extractFacts({ openai, text: 'long text', maxFacts: 5 });
  assert.equal(f.length, 5);
});

test('extractFacts: LLM error → []', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('down'); } } },
  };
  const f = await fs.extractFacts({ openai, text: 'x' });
  assert.deepEqual(f, []);
});

// ─── judgeFact ───────────────────────────────────────────────────────────

test('judgeFact: parses label + cited passage', async () => {
  const openai = scripted([JSON.stringify({
    label: 'supported', citedPassage: 1, reason: 'direct match',
  })]);
  const r = await fs.judgeFact({
    openai, fact: 'X happened in 1889.',
    passages: [{ source: 'wiki', text: 'X happened in 1889.' }],
  });
  assert.equal(r.label, 'supported');
  assert.equal(r.citedPassage, 1);
  assert.equal(r.citedSource, 'wiki');
});

test('judgeFact: invalid cited → 0', async () => {
  const openai = scripted([JSON.stringify({
    label: 'supported', citedPassage: 99, reason: '',
  })]);
  const r = await fs.judgeFact({
    openai, fact: 'x',
    passages: [{ source: 'a', text: 'b' }],
  });
  assert.equal(r.citedPassage, 0);
});

test('judgeFact: unknown label normalised to not_in_sources', async () => {
  const openai = scripted([JSON.stringify({
    label: 'weird', citedPassage: 1, reason: '',
  })]);
  const r = await fs.judgeFact({
    openai, fact: 'x',
    passages: [{ source: 'a', text: 'b' }],
  });
  assert.equal(r.label, 'not_in_sources');
});

// ─── factScore (full) ────────────────────────────────────────────────────

test('factScore: all supported → score=1', async () => {
  const openai = scripted([
    // extractFacts
    JSON.stringify({ facts: ['fact A', 'fact B'] }),
    // judgeFact × 2
    JSON.stringify({ label: 'supported', citedPassage: 1 }),
    JSON.stringify({ label: 'supported', citedPassage: 1 }),
  ]);
  const r = await fs.factScore({
    openai,
    text: 'two facts',
    referencePassages: [{ source: 'p', text: 'p' }],
  });
  assert.equal(r.factScore, 1);
  assert.equal(r.supported, 2);
  assert.equal(r.totalFacts, 2);
});

test('factScore: mixed → fraction supported (strict)', async () => {
  const openai = scripted([
    JSON.stringify({ facts: [
      'Fact one is a claim.',
      'Fact two is another claim.',
      'Fact three is another claim.',
      'Fact four is the final claim.',
    ] }),
    JSON.stringify({ label: 'supported', citedPassage: 1 }),
    JSON.stringify({ label: 'contradicted', citedPassage: 1 }),
    JSON.stringify({ label: 'not_in_sources', citedPassage: 0 }),
    JSON.stringify({ label: 'supported', citedPassage: 1 }),
  ]);
  const r = await fs.factScore({
    openai,
    text: 'four facts',
    referencePassages: [{ source: 'p', text: 'p' }],
  });
  // Strict mode (default): not_in_sources counts against.
  // Supported 2 / 4 = 0.5
  assert.equal(r.supported, 2);
  assert.equal(r.contradicted, 1);
  assert.equal(r.notInSources, 1);
  assert.equal(r.factScore, 0.5);
});

test('factScore: countNotInSourcesAs=neutral drops unknowns from denominator', async () => {
  const openai = scripted([
    JSON.stringify({ facts: [
      'Fact one is a claim.',
      'Fact two is a claim.',
      'Fact three is a claim.',
    ] }),
    JSON.stringify({ label: 'supported', citedPassage: 1 }),
    JSON.stringify({ label: 'not_in_sources', citedPassage: 0 }),
    JSON.stringify({ label: 'contradicted', citedPassage: 1 }),
  ]);
  const r = await fs.factScore({
    openai,
    text: 'three facts',
    referencePassages: [{ source: 'p', text: 'p' }],
    countNotInSourcesAs: 'neutral',
  });
  // Neutral mode: denom = supported + contradicted = 2; supported = 1 → 0.5
  assert.equal(r.factScore, 0.5);
});

test('factScore: empty facts → perfect score (no claims to judge)', async () => {
  const openai = scripted([JSON.stringify({ facts: [] })]);
  const r = await fs.factScore({
    openai,
    text: 'opinionated passage with no facts',
    referencePassages: [{ source: 'p', text: 'p' }],
  });
  assert.equal(r.factScore, 1);
  assert.equal(r.totalFacts, 0);
});

test('factScore: missing reference passages → all not_in_sources', async () => {
  const openai = scripted([
    JSON.stringify({ facts: ['A single factual claim.'] }),
  ]);
  const r = await fs.factScore({
    openai,
    text: 'one fact',
    referencePassages: [],
  });
  assert.equal(r.perFact[0].label, 'not_in_sources');
  assert.equal(r.factScore, 0);
});

test('factScore: null openai rejected', async () => {
  await assert.rejects(
    fs.factScore({ openai: null, text: 'x', referencePassages: [] }),
    /openai required/,
  );
});
