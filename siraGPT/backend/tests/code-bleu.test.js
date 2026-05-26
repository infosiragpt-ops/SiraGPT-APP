/**
 * Tests for CodeBLEU (Ren et al. 2020).
 *
 * We verify each component independently, then the composite score
 * with the canonical 0.25/0.25/0.25/0.25 weights.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cb = require('../src/services/agents/code-bleu');

// ─── tokenize / ngram primitives ─────────────────────────────────────────

test('tokenize: strips Python and JS comments', () => {
  const src = `
# top comment
def f(): return 1  # inline
// js comment too
/* block
   comment */
`;
  const toks = cb.tokenize(src);
  assert.ok(!toks.includes('#'));
  assert.ok(toks.includes('def'));
  assert.ok(toks.includes('return'));
  assert.ok(!toks.includes('inline'));  // was in a comment
});

test('tokenize: empty / non-string → []', () => {
  assert.deepEqual(cb.tokenize(''), []);
  assert.deepEqual(cb.tokenize(null), []);
  assert.deepEqual(cb.tokenize(undefined), []);
});

// ─── bleu ────────────────────────────────────────────────────────────────

test('bleu: identical code scores very high (~1)', () => {
  const src = 'def add(a, b):\n    return a + b\n';
  const score = cb.bleu(src, src);
  assert.ok(score > 0.99, `expected ~1, got ${score}`);
});

test('bleu: disjoint code scores near 0', () => {
  const a = 'def add(a, b):\n    return a + b\n';
  const b = 'class Foo(object):\n    pass\n';
  const score = cb.bleu(a, b);
  assert.ok(score < 0.1, `expected <0.1, got ${score}`);
});

test('bleu: candidate shorter than reference gets BP penalty', () => {
  const ref = 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n';
  const shortCand = 'def add(a, b):\n    return a + b\n';
  const identical = cb.bleu(ref, ref);
  const penalised = cb.bleu(ref, shortCand);
  assert.ok(penalised < identical, 'shorter candidate should score lower');
});

// ─── weightedBleu: keyword emphasis ──────────────────────────────────────

test('weightedBleu: identical source scores ~1', () => {
  const src = 'def add(a, b): return a + b';
  const score = cb.weightedBleu(src, src);
  assert.ok(score > 0.99, `expected ~1, got ${score}`);
});

test('weightedBleu: disjoint scores near 0', () => {
  const score = cb.weightedBleu('def add(a, b): return a + b', 'totally unrelated prose');
  assert.ok(score < 0.1, `expected <0.1, got ${score}`);
});

test('weightedBleu: score stays in [0,1]', () => {
  const score = cb.weightedBleu(
    'def f(x): return x * 2',
    'def g(y): return y + 3',
  );
  assert.ok(score >= 0 && score <= 1);
});

// ─── syntaxMatch ─────────────────────────────────────────────────────────

test('syntaxMatch: identical structure → 1', () => {
  const src = 'if x: return 1\nelse: return 0';
  assert.equal(cb.syntaxMatch(src, src), 1);
});

test('syntaxMatch: disjoint structural tokens → 0 or very low', () => {
  const a = 'if x: return 1';
  const b = 'while z: continue';
  assert.ok(cb.syntaxMatch(a, b) < 0.2);
});

// ─── dataflowMatch ───────────────────────────────────────────────────────

test('dataflowMatch: same identifiers with same frequencies → 1', () => {
  const src = 'total = total + item\nreturn total';
  assert.equal(cb.dataflowMatch(src, src), 1);
});

test('dataflowMatch: different identifier names → low', () => {
  const a = 'total = total + item\nreturn total';
  const b = 'foo = foo + bar\nreturn foo';
  assert.ok(cb.dataflowMatch(a, b) < 0.2);
});

// ─── codeBleu composite ──────────────────────────────────────────────────

test('codeBleu: identical → 1 across all components', () => {
  const src = 'def f(x):\n    return x + 1\n';
  const r = cb.codeBleu(src, src);
  assert.ok(r.codeBleu > 0.99);
  assert.ok(r.bleu > 0.99);
  assert.ok(r.weightedBleu > 0.99);
  assert.equal(r.syntaxMatch, 1);
  assert.equal(r.dataflowMatch, 1);
});

test('codeBleu: disjoint → very low', () => {
  const a = 'def add(a, b): return a + b';
  const b = 'class Quux(object): pass';
  const r = cb.codeBleu(a, b);
  assert.ok(r.codeBleu < 0.3, `expected <0.3, got ${r.codeBleu}`);
});

test('codeBleu: near-duplicate with renamed vars outranks disjoint', () => {
  const a = 'def add(a, b):\n    total = a + b\n    return total\n';
  const b = 'def add(x, y):\n    sum_ = x + y\n    return sum_\n';
  const disjoint = 'class Quux(object):\n    pass\n';
  const rSimilar = cb.codeBleu(a, b).codeBleu;
  const rDisjoint = cb.codeBleu(a, disjoint).codeBleu;
  // Renamed variables drop dataflow_match but syntax/keywords survive,
  // so this should score clearly above a disjoint class definition.
  assert.ok(rSimilar > rDisjoint,
    `renamed (${rSimilar}) should outrank disjoint (${rDisjoint})`);
  assert.ok(rSimilar > 0.25, `expected >0.25, got ${rSimilar}`);
});

test('codeBleu: custom weights respected', () => {
  const a = 'def add(a, b): return a + b';
  const b = 'class C: pass';
  const r = cb.codeBleu(a, b, { bleu: 1, weightedBleu: 0, syntax: 0, dataflow: 0 });
  assert.ok(Math.abs(r.codeBleu - r.bleu) < 1e-9);
  assert.deepEqual(r.weights, { bleu: 1, weightedBleu: 0, syntax: 0, dataflow: 0 });
});

test('codeBleu: handles empty candidate gracefully', () => {
  const r = cb.codeBleu('def f(): pass', '');
  assert.equal(r.bleu, 0);
  assert.ok(r.codeBleu >= 0 && r.codeBleu <= 1);
});
