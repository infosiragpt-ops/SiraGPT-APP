'use strict';

/**
 * Tests for the section-level spec table and the exact-word-count
 * validator that drives strict thesis section generation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('../src/services/thesis/section-specs');
const {
  countWords,
  validateExactWordCount,
  validateAgainstSpec,
} = require('../src/services/thesis/word-count-validator');

// ── section-specs ──────────────────────────────────────────────────────

test('section-specs: every spec has a chapter, title and citation count', () => {
  const all = specs.listAllSpecs();
  assert.ok(all.length >= 20, `expected ≥20 specs, got ${all.length}`);
  for (const s of all) {
    assert.equal(typeof s.id, 'string', `${s.id}: id missing`);
    assert.equal(typeof s.chapter, 'string', `${s.id}: chapter missing`);
    assert.equal(typeof s.title, 'string', `${s.id}: title missing`);
    assert.equal(typeof s.paragraphs, 'number', `${s.id}: paragraphs missing`);
    assert.equal(typeof s.citationsRequired, 'number', `${s.id}: citationsRequired missing`);
    assert.ok(
      s.exactWords != null || (s.minWords != null && s.maxWords != null),
      `${s.id}: must declare exactWords OR minWords+maxWords`,
    );
    if (s.yearRange) {
      assert.equal(s.yearRange.length, 2, `${s.id}: yearRange must be [start,end]`);
      assert.ok(s.yearRange[0] <= s.yearRange[1], `${s.id}: yearRange ordering`);
    }
  }
});

test('section-specs: critical user-spec word counts match the prompt master', () => {
  // The prompt explicitly nails these numbers, so the tests
  // capture them as a contract — changing them needs a deliberate edit.
  const v1 = specs.getSpec('problematic_reality_variable_1');
  assert.equal(v1.exactWords, 75);
  const v2 = specs.getSpec('problematic_reality_variable_2');
  assert.equal(v2.exactWords, 75);
  const global = specs.getSpec('problematic_reality_global');
  assert.equal(global.exactWords, 100);
  const latam = specs.getSpec('problematic_reality_latam');
  assert.equal(latam.exactWords, 100);
  const peru = specs.getSpec('problematic_reality_national');
  assert.equal(peru.exactWords, 100);
  const local = specs.getSpec('problematic_reality_local');
  assert.equal(local.exactWords, 220);
  const conceptV1 = specs.getSpec('conceptualization_variable_1_definitions');
  assert.equal(conceptV1.exactWords, 100);
  assert.equal(conceptV1.paragraphs, 3);
  const baseV1 = specs.getSpec('conceptualization_variable_1_theory_bases');
  assert.equal(baseV1.exactWords, 80);
  assert.equal(baseV1.paragraphs, 3);
  assert.deepEqual(baseV1.yearRange, [2022, 2025]);
  const instrDesc = specs.getSpec('instruments_description');
  assert.equal(instrDesc.exactWords, 300);
});

test('section-specs: listSpecsForChapter filters by parent chapter', () => {
  const realidad = specs.listSpecsForChapter('problematic_reality');
  assert.ok(realidad.length >= 6, `expected ≥6 sub-sections, got ${realidad.length}`);
  for (const s of realidad) assert.equal(s.chapter, 'problematic_reality');
  assert.equal(specs.listSpecsForChapter('nonexistent').length, 0);
});

test('section-specs: latam spec mentions all 5 required regions', () => {
  const latam = specs.getSpec('problematic_reality_latam');
  for (const region of ['Colombia', 'Chile', 'Ecuador', 'México', 'Argentina']) {
    assert.ok(
      latam.mustMention.includes(region),
      `expected Latam mustMention to include ${region}`,
    );
  }
});

test('section-specs: buildSpecBlock renders all key constraints', () => {
  const v1 = specs.getSpec('problematic_reality_variable_1');
  const block = specs.buildSpecBlock(v1);
  assert.match(block, /Palabras EXACTAS: 75/);
  assert.match(block, /Párrafos esperados: 1/);
  assert.match(block, /Citas APA 7 mínimas: 3/);
  assert.match(block, /2020/);
  assert.match(block, /tercera persona/);
});

test('section-specs: buildSpecBlock falls back to range when no exact count', () => {
  const techniques = specs.getSpec('techniques');
  const block = specs.buildSpecBlock(techniques);
  assert.match(block, /Palabras: entre 70 y 100/);
});

test('section-specs: buildSpecBlock returns empty string for null spec', () => {
  assert.equal(specs.buildSpecBlock(null), '');
});

// ── validateExactWordCount ─────────────────────────────────────────────

test('validateExactWordCount: target words → ok within ±3 tolerance', () => {
  const text = Array(75).fill('palabra').join(' ');
  const result = validateExactWordCount(text, { target: 75 });
  assert.equal(result.ok, true);
  assert.equal(result.words, 75);
  assert.equal(result.delta, 0);
});

test('validateExactWordCount: 73 words → still ok against target 75 (within ±3)', () => {
  const text = Array(73).fill('palabra').join(' ');
  const result = validateExactWordCount(text, { target: 75 });
  assert.equal(result.ok, true);
  assert.equal(result.delta, 0);
});

test('validateExactWordCount: 71 words → fails against target 75 (outside ±3)', () => {
  const text = Array(71).fill('palabra').join(' ');
  const result = validateExactWordCount(text, { target: 75 });
  assert.equal(result.ok, false);
  assert.equal(result.delta, 1);
});

test('validateExactWordCount: 80 words → fails against target 75 (outside ±3)', () => {
  const text = Array(80).fill('palabra').join(' ');
  const result = validateExactWordCount(text, { target: 75 });
  assert.equal(result.ok, false);
  assert.equal(result.delta, 2);
});

test('validateExactWordCount: custom tolerance widens the window', () => {
  const text = Array(70).fill('palabra').join(' ');
  const strict = validateExactWordCount(text, { target: 75, tolerance: 2 });
  const lax = validateExactWordCount(text, { target: 75, tolerance: 10 });
  assert.equal(strict.ok, false);
  assert.equal(lax.ok, true);
});

test('validateExactWordCount: rejects missing/invalid target', () => {
  assert.throws(() => validateExactWordCount('foo', {}), /target/);
  assert.throws(() => validateExactWordCount('foo', { target: -1 }), /target/);
});

// ── validateAgainstSpec ────────────────────────────────────────────────

test('validateAgainstSpec: uses exact strategy when spec has exactWords', () => {
  const spec = specs.getSpec('problematic_reality_variable_1');
  const ok75 = Array(75).fill('palabra').join(' ');
  const tooSmall = Array(60).fill('palabra').join(' ');
  const okResult = validateAgainstSpec(ok75, spec);
  const failResult = validateAgainstSpec(tooSmall, spec);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.target, 75);
  assert.equal(failResult.ok, false);
});

test('validateAgainstSpec: falls back to range strategy when no exactWords', () => {
  const spec = specs.getSpec('techniques');
  const ok85 = Array(85).fill('palabra').join(' ');
  const tooSmall = Array(50).fill('palabra').join(' ');
  const okResult = validateAgainstSpec(ok85, spec);
  const failResult = validateAgainstSpec(tooSmall, spec);
  assert.equal(okResult.ok, true);
  assert.equal(failResult.ok, false);
});

test('validateAgainstSpec: returns error shape when spec is null', () => {
  const r = validateAgainstSpec('foo bar', null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_spec');
});

test('countWords: ignores whitespace and empty tokens', () => {
  assert.equal(countWords('hola mundo'), 2);
  assert.equal(countWords('  hola   mundo  '), 2);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});
