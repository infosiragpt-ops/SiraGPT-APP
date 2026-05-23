'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  OPERATORS,
  buildSkipMask,
  generateMutants,
  applyMutant,
} = require('../scripts/mutation-operators');

test('OPERATORS covers core conditional, logical, boolean and arithmetic mutations', () => {
  const ids = OPERATORS.map(o => o.id);
  for (const expected of [
    'EQ_TO_NEQ', 'NEQ_TO_EQ', 'GT_TO_LTE', 'LT_TO_GTE',
    'GTE_TO_LT', 'LTE_TO_GT', 'AND_TO_OR', 'OR_TO_AND',
    'TRUE_TO_FALSE', 'FALSE_TO_TRUE', 'PLUS_TO_MINUS', 'MINUS_TO_PLUS',
  ]) {
    assert.ok(ids.includes(expected), `missing operator ${expected}`);
  }
});

test('buildSkipMask masks string, template, and comment regions', () => {
  const src = 'const a = "x===y"; // === here\nconst b = `t===u`;\n/* ===c=== */ const d = e === f;';
  const mask = buildSkipMask(src);
  // The === inside the double-quoted string should be masked.
  const stringIdx = src.indexOf('"x===y"');
  for (let i = stringIdx; i < stringIdx + '"x===y"'.length; i++) {
    assert.strictEqual(mask[i], 1, `expected mask at ${i}`);
  }
  // The === in the line comment should be masked.
  const commentIdx = src.indexOf('// ===');
  assert.strictEqual(mask[commentIdx + 3], 1);
  // The === in `/* ===c=== */` should be masked.
  const blockIdx = src.indexOf('/* ===c');
  assert.strictEqual(mask[blockIdx + 3], 1);
  // The final `e === f` is real code and must not be masked.
  const realIdx = src.lastIndexOf('===');
  assert.strictEqual(mask[realIdx], 0);
});

test('generateMutants produces a === → !== mutant for real code only', () => {
  const src = 'function eq(a, b) { return a === b; }\n// nothing === to mutate here\nconst s = "x === y";';
  const mutants = generateMutants(src);
  const eqToNeq = mutants.filter(m => m.operator === 'EQ_TO_NEQ');
  assert.strictEqual(eqToNeq.length, 1, 'should mutate exactly one === outside strings/comments');
  assert.strictEqual(eqToNeq[0].original, '===');
  assert.strictEqual(eqToNeq[0].replacement, '!==');
});

test('generateMutants flips boolean literals as standalone words only', () => {
  const src = 'const ok = true;\nconst label = "trueblue";\nconst flag = false;\n';
  const mutants = generateMutants(src);
  const flips = mutants.filter(m => m.operator === 'TRUE_TO_FALSE' || m.operator === 'FALSE_TO_TRUE');
  // One `true` and one `false` keyword; the substring inside the string must be skipped.
  assert.strictEqual(flips.length, 2);
});

test('generateMutants does not flag ++ / -- / += / -= as +/- mutations', () => {
  const src = 'let i = 0; i++; i--; i += 2; i -= 3; const sum = i + 1; const diff = i - 1;';
  const mutants = generateMutants(src);
  const plus = mutants.filter(m => m.operator === 'PLUS_TO_MINUS');
  const minus = mutants.filter(m => m.operator === 'MINUS_TO_PLUS');
  assert.strictEqual(plus.length, 1, 'only the bare + should mutate');
  assert.strictEqual(minus.length, 1, 'only the bare - should mutate');
});

test('generateMutants respects max cap', () => {
  const src = 'a === b; c === d; e === f; g === h;';
  const mutants = generateMutants(src, { max: 2 });
  assert.strictEqual(mutants.length, 2);
});

test('applyMutant replaces only the mutant span', () => {
  const src = 'return a === b;';
  const [mutant] = generateMutants(src).filter(m => m.operator === 'EQ_TO_NEQ');
  const mutated = applyMutant(src, mutant);
  assert.strictEqual(mutated, 'return a !== b;');
});

test('applyMutant is idempotent over reapplication via offsets', () => {
  // Two mutants at different offsets — applying them in reverse offset order is safe.
  const src = 'if (a === b && c === d) {}';
  const eqMutants = generateMutants(src).filter(m => m.operator === 'EQ_TO_NEQ');
  assert.strictEqual(eqMutants.length, 2);
  const sorted = eqMutants.slice().sort((x, y) => y.start - x.start);
  let mutated = src;
  for (const m of sorted) mutated = applyMutant(mutated, m);
  assert.strictEqual(mutated, 'if (a !== b && c !== d) {}');
});

test('summarize / renderReport contract from mutation-baseline.js is exposed', () => {
  const mod = require('../scripts/mutation-baseline');
  assert.strictEqual(typeof mod.listTargets, 'function');
  assert.strictEqual(typeof mod.summarize, 'function');
  assert.strictEqual(typeof mod.renderReport, 'function');
  const summary = mod.summarize([
    {
      target: { name: 'demo' },
      skipped: false,
      mutants: [
        { status: 'KILLED' }, { status: 'KILLED' },
        { status: 'SURVIVED' }, { status: 'TIMEOUT' },
      ],
    },
  ]);
  assert.strictEqual(summary.totals.killed, 2);
  assert.strictEqual(summary.totals.survived, 1);
  assert.strictEqual(summary.totals.timeout, 1);
  assert.ok(summary.totals.score > 0.74 && summary.totals.score < 0.76);
  const md = mod.renderReport(summary, { limit: 25, timeoutMs: 30000 });
  assert.match(md, /Mutation Testing Baseline/);
  assert.match(md, /\| demo \| 4 \| 2 \| 1 \| 1 \|/);
});
