'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fuzzer = require('../src/services/attribution-prompt-fuzzer');

test('generateVariants: always includes original as variant[0]', () => {
  const out = fuzzer.generateVariants('Please build me a chart of revenue.');
  assert.strictEqual(out[0], 'Please build me a chart of revenue.');
});

test('generateVariants: produces ≥ 2 distinct variants', () => {
  const out = fuzzer.generateVariants('Please build me a chart of revenue.', { limit: 5 });
  assert.ok(out.length >= 2);
  assert.strictEqual(new Set(out).size, out.length);
});

test('dropStopwordVariant: removes one stopword', () => {
  const v = fuzzer.dropStopwordVariant('Please build a chart of revenue.');
  assert.ok(v !== null);
  assert.ok(!v.toLowerCase().includes('please'));
});

test('dropStopwordVariant: returns null when no stopword to drop', () => {
  const v = fuzzer.dropStopwordVariant('Build chart.');
  assert.strictEqual(v, null);
});

test('synonymVariant: swaps a known synonym', () => {
  const v = fuzzer.synonymVariant('Please build a chart.');
  assert.ok(v && v.toLowerCase().includes('create'));
});

test('synonymVariant: returns null when no known synonyms', () => {
  const v = fuzzer.synonymVariant('xyz abc lol');
  assert.strictEqual(v, null);
});

test('reorderSentencesVariant: reverses sentence order', () => {
  const v = fuzzer.reorderSentencesVariant('First. Second. Third.');
  assert.ok(v && v.startsWith('Third'));
});

test('reorderSentencesVariant: returns null for single sentence', () => {
  assert.strictEqual(fuzzer.reorderSentencesVariant('Only one'), null);
});

test('caseFlipVariant: uppercases mixed text', () => {
  const v = fuzzer.caseFlipVariant('hello WORLD');
  assert.ok(v === 'HELLO WORLD');
});

test('caseFlipVariant: returns null for already uppercase text', () => {
  assert.strictEqual(fuzzer.caseFlipVariant('HELLO'), null);
});

test('whitespaceVariant: adds padding', () => {
  const v = fuzzer.whitespaceVariant('hello world');
  assert.ok(v && v.includes('hello world'));
  assert.notStrictEqual(v, 'hello world');
});

test('pluraliseVariant: toggles plural on a noun', () => {
  const v = fuzzer.pluraliseVariant('A function in the file');
  assert.ok(v);
  assert.notStrictEqual(v, 'A function in the file');
});

test('probeStability: returns ok=false without scorerFn', () => {
  const r = fuzzer.probeStability({ prompt: 'x' });
  assert.strictEqual(r.ok, false);
});

test('probeStability: stable scorer produces high stability', () => {
  const scorer = (_t) => ({ primaryIntent: 'build', centroid: { feature: 0.5, intent: 0.5 } });
  const r = fuzzer.probeStability({ prompt: 'Please build a chart of revenue.', scorerFn: scorer });
  assert.strictEqual(r.ok, true);
  assert.ok(r.stability >= 0.85);
  assert.strictEqual(r.classification, 'robust');
});

test('probeStability: unstable scorer produces low stability', () => {
  let i = 0;
  const intents = ['build', 'fix', 'explain', 'summarize', 'translate'];
  const scorer = (_t) => ({ primaryIntent: intents[i++ % intents.length], centroid: { feature: Math.random(), intent: Math.random() } });
  const r = fuzzer.probeStability({ prompt: 'Please build a chart of revenue.', scorerFn: scorer });
  assert.ok(r.ok);
  assert.ok(r.stability < 0.6);
  assert.strictEqual(r.classification, 'fragile');
});

test('probeStability: tolerates scorer that throws', () => {
  let calls = 0;
  const scorer = (_t) => {
    calls += 1;
    if (calls % 2 === 0) throw new Error('boom');
    return { primaryIntent: 'build', centroid: { feature: 0.5, intent: 0.5 } };
  };
  const r = fuzzer.probeStability({ prompt: 'Please build a chart.', scorerFn: scorer });
  assert.ok(r.ok);
  assert.ok(r.perVariant.some((v) => v.error));
});

test('compareIntents: empty array returns zero', () => {
  const r = fuzzer.compareIntents([]);
  assert.strictEqual(r.distinctIntents, 0);
  assert.strictEqual(r.mostCommon, null);
});

test('compareIntents: most-common intent reported', () => {
  const r = fuzzer.compareIntents([
    { primaryIntent: 'build' },
    { primaryIntent: 'build' },
    { primaryIntent: 'fix' },
  ]);
  assert.strictEqual(r.mostCommon.intent, 'build');
  assert.strictEqual(r.mostCommon.count, 2);
  assert.strictEqual(r.distinctIntents, 2);
});

test('hot path: 100 variants generated under 200ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) {
    fuzzer.generateVariants('Please build me a chart of revenue by quarter.');
  }
  assert.ok(Date.now() - t0 < 200);
});

test('synonymVariant preserves punctuation attached to the swapped word', () => {
  // "build?" must become "create?", not "create" (which fused two clauses).
  assert.equal(fuzzer.synonymVariant('Can you build? Yes'), 'Can you create? Yes');
  assert.equal(fuzzer.synonymVariant('We will build, then test'), 'We will create, then test');
});

test('probeStability scores unanimous-null intent as STABLE, not 0', () => {
  // A scorer that recognises no intent for any variant is perfectly consistent.
  const r = fuzzer.probeStability({
    prompt: 'Please build a chart of revenue.',
    scorerFn: () => ({ primaryIntent: null, centroid: null }),
  });
  assert.equal(r.intentStability, 1, 'consistent null is stability 1, not 0');
});
