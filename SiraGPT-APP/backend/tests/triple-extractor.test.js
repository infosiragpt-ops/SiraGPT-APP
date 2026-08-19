/**
 * Unit tests for services/triple-extractor.js.
 * Focused on pure helpers + heuristic path. LLM path uses a stubbed client.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractTriples,
  extractProximalTriples,
  extractTriplesHeuristic,
  normaliseElement,
  isValidTriple,
  coerceTriple,
} = require('../src/services/triple-extractor');

test('normaliseElement: trims, collapses spaces, hard-caps length', () => {
  assert.equal(normaliseElement('  Hello   World  '), 'Hello World');
  assert.equal(normaliseElement('x'.repeat(200)).length, 60);
  assert.equal(normaliseElement(null), '');
});

test('isValidTriple: rejects empty / non-object / missing fields', () => {
  assert.equal(isValidTriple(null), false);
  assert.equal(isValidTriple({}), false);
  assert.equal(isValidTriple({ subject: 'x' }), false);
  assert.equal(isValidTriple({ subject: 'a', predicate: 'is', object: 'b' }), true);
});

test('coerceTriple: preserves source and confidence, fills defaults', () => {
  const t = coerceTriple({ subject: 'X', predicate: 'is', object: 'Y', confidence: 0.3 }, 'doc1');
  assert.equal(t.source, 'doc1');
  assert.equal(t.confidence, 0.3);

  const d = coerceTriple({ subject: 'X', predicate: 'is', object: 'Y' }, null);
  assert.equal(d.confidence, 0.8);
});

// ─── heuristic ─────────────────────────────────────────────────────────────

test('extractTriplesHeuristic: catches "X is a Y" English', () => {
  const out = extractTriplesHeuristic('Stephen Curry is a basketball player');
  assert.ok(out.length >= 1);
  assert.ok(out.some(t => t.subject.includes('Curry') && t.object.includes('basketball')));
});

test('extractTriplesHeuristic: catches "X was born in Y"', () => {
  const out = extractTriplesHeuristic('Leonardo was born in Florence');
  assert.ok(out.some(t => t.subject.includes('Leonardo') && t.predicate === 'born in'));
});

test('extractTriplesHeuristic: catches "X was founded by Y"', () => {
  const out = extractTriplesHeuristic('OpenAI was founded by Sam Altman');
  assert.ok(out.some(t => t.subject.includes('OpenAI') && t.predicate === 'founded by' && t.object.includes('Sam')));
});

test('extractTriplesHeuristic: dedupes identical matches', () => {
  const src = 'Stephen Curry is a basketball player. Stephen Curry is a basketball player.';
  const out = extractTriplesHeuristic(src);
  const uniq = new Set(out.map(t => `${t.subject}|${t.predicate}|${t.object}`));
  assert.equal(uniq.size, out.length);
});

test('extractTriplesHeuristic: empty / null input returns []', () => {
  assert.deepEqual(extractTriplesHeuristic(''), []);
  assert.deepEqual(extractTriplesHeuristic(null), []);
});

// ─── LLM path with stubbed client ──────────────────────────────────────────

function makeFakeOpenAI(responseJson) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(responseJson) } }],
        }),
      },
    },
  };
}

test('extractTriples: parses LLM response, applies validation + source', async () => {
  const fake = makeFakeOpenAI({
    triples: [
      { subject: 'Stephen Curry', predicate: 'plays for', object: 'Warriors', confidence: 0.95 },
      { subject: 'Stephen Curry', predicate: 'born in', object: 'Akron' },
      { subject: 'bad' }, // invalid, should be dropped
      null,               // invalid
    ],
  });
  const out = await extractTriples(fake, 'Stephen Curry is a basketball player.', { source: 'player.md' });
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'player.md');
  assert.equal(out[0].confidence, 0.95);
  assert.equal(out[1].confidence, 0.8); // default
});

test('extractTriples: returns [] on parse error without throwing', async () => {
  const broken = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json' } }] }) } },
  };
  const out = await extractTriples(broken, 'Stephen Curry plays basketball.');
  assert.deepEqual(out, []);
});

test('extractTriples: null openai returns [] immediately', async () => {
  const out = await extractTriples(null, 'some text');
  assert.deepEqual(out, []);
});

test('extractTriples: too-short text returns []', async () => {
  const fake = makeFakeOpenAI({ triples: [] });
  const out = await extractTriples(fake, 'hi');
  assert.deepEqual(out, []);
});

test('extractProximalTriples: validates + trims to maxTriples', async () => {
  const fake = makeFakeOpenAI({
    triples: Array.from({ length: 30 }, (_, i) => ({
      subject: `s${i}`, predicate: 'p', object: `o${i}`,
    })),
  });
  const out = await extractProximalTriples(
    fake,
    'what is X?',
    [{ text: 'X is a thing.' }, { text: 'More about X.' }],
    { maxTriples: 5 },
  );
  assert.equal(out.length, 5);
});

test('extractProximalTriples: includes gist memory in prompt when provided', async () => {
  let seenUser = '';
  const fake = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          seenUser = messages.find(m => m.role === 'user').content;
          return { choices: [{ message: { content: JSON.stringify({ triples: [] }) } }] };
        },
      },
    },
  };
  await extractProximalTriples(
    fake, 'query', [{ text: 'passage' }],
    { gistMemory: [{ subject: 'Prior', predicate: 'knows', object: 'Fact' }] },
  );
  assert.ok(seenUser.includes('KNOWN TRIPLES'));
  assert.ok(seenUser.includes('Prior'));
});

test('extractProximalTriples: empty passages → []', async () => {
  const fake = makeFakeOpenAI({ triples: [] });
  assert.deepEqual(await extractProximalTriples(fake, 'q', []), []);
});
