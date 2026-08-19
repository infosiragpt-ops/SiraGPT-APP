'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sem = require('../src/services/memory-semantic');

// Deterministic toy embedder: maps known phrases to 2-D vectors so cosine is
// predictable. "programar/typescript/react" cluster on one axis; "lima/ciudad"
// on the other.
function toyEmbed(texts) {
  return texts.map((t) => {
    const s = String(t).toLowerCase();
    const code = /program|typescript|react|frontend|c[oó]digo|lenguaje/.test(s) ? 1 : 0;
    const place = /lima|ciudad|vive|ubicaci/.test(s) ? 1 : 0;
    // small epsilon avoids zero-vector cosine NaN
    return Float32Array.from([code + 0.01, place + 0.01]);
  });
}
function cos(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

test('semanticRerank: surfaces meaning-related fact with NO shared keywords', async () => {
  const items = [
    { fact: 'El usuario vive en Lima', score: 0.5 },
    { fact: 'El usuario prefiere TypeScript', score: 0.5 },
  ];
  // Query shares NO words with either fact, but is about programming.
  const ranked = await sem.semanticRerank('¿qué uso para programar?', items, { embed: toyEmbed, cosineFn: cos });
  assert.equal(ranked[0].fact, 'El usuario prefiere TypeScript');
  assert.ok(typeof ranked[0].semantic === 'number');
  assert.ok(ranked[0].semantic > ranked[1].semantic);
});

test('semanticRerank: fail-open when embedder throws (keeps lexical order)', async () => {
  const items = [
    { fact: 'A', score: 0.9 },
    { fact: 'B', score: 0.4 },
  ];
  const throwing = async () => { throw new Error('no key'); };
  const ranked = await sem.semanticRerank('x', items, { embed: throwing });
  assert.deepEqual(ranked.map((m) => m.fact), ['A', 'B']); // unchanged
});

test('semanticRerank: blends lexical score with semantic, respects weight', async () => {
  const items = [{ fact: 'El usuario prefiere React', score: 0.2 }];
  const ranked = await sem.semanticRerank('frontend con react', items, { embed: toyEmbed, cosineFn: cos, weight: 1 });
  // weight=1 → score becomes purely semantic ([0,1]); React fact is on the code axis → high.
  assert.ok(ranked[0].score > 0.4);
});

test('semanticRerank: empty / garbage inputs are safe', async () => {
  assert.deepEqual(await sem.semanticRerank('q', []), []);
  assert.deepEqual(await sem.semanticRerank('', [{ fact: 'A' }], { embed: toyEmbed }), [{ fact: 'A' }]);
  const bad = await sem.semanticRerank('q', [{ fact: 'A', score: 1 }], { embed: async () => [Float32Array.from([1])] }); // wrong length
  assert.equal(bad[0].fact, 'A'); // returns unchanged when vec count mismatches
});

test('semanticRerank: respects limit', async () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ fact: `fact ${i}`, score: 0.5 }));
  const ranked = await sem.semanticRerank('q', items, { embed: toyEmbed, cosineFn: cos, limit: 3 });
  assert.equal(ranked.length, 3);
});

test('isSemanticAvailable: reflects OPENAI_API_KEY presence', () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(sem.isSemanticAvailable(), false);
  process.env.OPENAI_API_KEY = 'sk-test';
  assert.equal(sem.isSemanticAvailable(), true);
  if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
});
