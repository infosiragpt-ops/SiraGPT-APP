/**
 * Tests for benchmark contamination detector.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cc = require('../src/services/agents/code-contamination');

// ─── primitives ──────────────────────────────────────────────────────────

test('jaccard: basic invariants', () => {
  const a = new Set(['a', 'b', 'c']);
  const b = new Set(['b', 'c', 'd']);
  assert.equal(cc.jaccard(new Set(), new Set()), 1);
  assert.equal(cc.jaccard(new Set(['x']), new Set()), 0);
  // |a ∩ b| = 2, |a ∪ b| = 4
  assert.equal(cc.jaccard(a, b), 0.5);
});

test('ngramSet: builds all n-grams', () => {
  const toks = ['a', 'b', 'c', 'd'];
  const s = cc.ngramSet(toks, 2);
  assert.deepEqual([...s].sort(), ['a b', 'b c', 'c d']);
});

test('longestSharedSubstring: finds a run ≥ minLen', () => {
  const a = 'def fibonacci(n): return n if n < 2 else fibonacci(n-1) + fibonacci(n-2)';
  const b = `docs note: def fibonacci(n): return n if n < 2 else fibonacci(n-1) + fibonacci(n-2) — canonical`;
  const match = cc.longestSharedSubstring(a, b, 40);
  assert.ok(match.length >= 40);
  assert.ok(b.toLowerCase().includes(match));
});

test('longestSharedSubstring: none → empty string', () => {
  const r = cc.longestSharedSubstring('def add(a, b): return a + b', 'totally unrelated text here', 60);
  assert.equal(r, '');
});

// ─── corpusTokenFrequency + rareTokens ───────────────────────────────────

test('corpusTokenFrequency: counts document frequency (not raw frequency)', () => {
  const corpus = [
    'alpha alpha alpha',   // "alpha" appears in 1 doc
    'alpha beta',
    'gamma',
  ];
  const f = cc.corpusTokenFrequency(corpus);
  assert.equal(f.get('alpha'), 2);   // two docs contain it
  assert.equal(f.get('beta'), 1);
  assert.equal(f.get('gamma'), 1);
});

test('rareTokens: picks tokens with low document frequency', () => {
  const corpus = ['common alpha', 'common beta', 'common unusual_identifier'];
  const freq = cc.corpusTokenFrequency(corpus);
  const rare = cc.rareTokens('common needs_unusual_identifier', freq, corpus.length, 1);
  assert.ok(rare.has('unusual_identifier') === false);  // not in problem text
  // Try one that IS in the problem + rare in corpus
  const rare2 = cc.rareTokens('unusual_identifier appears here', freq, corpus.length, 1);
  assert.ok(rare2.has('unusual_identifier'));
});

// ─── check: end-to-end ───────────────────────────────────────────────────

test('check: clean corpus → not flagged', () => {
  const problem = {
    task_id: 'local/0',
    prompt: 'Write a function that sums a list.',
    canonical_solution: 'def sum_list(xs):\n    return sum(xs)\n',
    test: '_check("x", sum_list([1,2,3]) == 6)\n',
  };
  const corpus = [
    'This is unrelated web content.',
    'Here is a cooking recipe.',
    'class Unrelated: pass',
  ];
  const r = cc.check({ problem, corpus });
  assert.equal(r.flagged, false);
  assert.equal(r.reasons.length, 0);
});

test('check: corpus doc containing the solution verbatim → flagged (substring)', () => {
  const solution = 'def sum_list(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n';
  const problem = {
    task_id: 'local/1',
    prompt: 'sum a list',
    canonical_solution: solution,
    test: '',
  };
  const corpus = [
    'ordinary doc',
    `blog post snippet: ${solution} — that's how it works`,
  ];
  const r = cc.check({ problem, corpus, substringLen: 40 });
  assert.equal(r.flagged, true);
  assert.ok(r.reasons.some(x => /shared substring/.test(x)));
  assert.ok(r.hits[1].substringSol.length >= 40);
});

test('check: near-duplicate solution with renamed vars → jaccard flag', () => {
  const original = 'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n';
  const renamed = 'def fibonacci(num):\n    a, b = 0, 1\n    for _ in range(num):\n        a, b = b, a + b\n    return a\n';
  const problem = {
    task_id: 'local/2',
    prompt: 'fibonacci',
    canonical_solution: original,
    test: '',
  };
  const r = cc.check({
    problem,
    corpus: [renamed],
    substringLen: 1000,  // disable substring signal
    jaccardFlag: 0.3,
  });
  assert.equal(r.flagged, true);
  assert.ok(r.hits[0].jaccardSol >= 0.3);
});

test('check: corpus doc containing the canonical test verbatim → flagged (test substring)', () => {
  const problem = {
    task_id: 'local/3',
    prompt: 'x',
    canonical_solution: '',
    test: '_check("sum", sum_list([1, 2, 3]) == 6)\n_check("zero", sum_list([]) == 0)\n',
  };
  const corpus = [
    'hello world',
    'archive: _check("sum", sum_list([1, 2, 3]) == 6)\n_check("zero", sum_list([]) == 0) seen in paper',
  ];
  const r = cc.check({ problem, corpus, substringLen: 30 });
  assert.equal(r.flagged, true);
  assert.ok(r.reasons.some(x => /test block/.test(x)));
});

test('filterContaminated: returns only flagged items', () => {
  const problems = [
    { task_id: 'a', prompt: 'x', canonical_solution: 'def x(): return 1', test: '' },
    { task_id: 'b', prompt: 'y', canonical_solution: 'def really_unusual_function_name_zzzqqq(): return 42', test: '' },
  ];
  const corpus = [
    'unrelated content one',
    'another doc',
    'exact leak: def really_unusual_function_name_zzzqqq(): return 42 end',
  ];
  const r = cc.filterContaminated({ problems, corpus, substringLen: 40 });
  assert.equal(r.length, 1);
  assert.equal(r[0].taskId, 'b');
});

test('check: empty corpus → not flagged', () => {
  const r = cc.check({ problem: { task_id: 't', prompt: 'x', canonical_solution: 'def f(): pass', test: '' }, corpus: [] });
  assert.equal(r.flagged, false);
});
