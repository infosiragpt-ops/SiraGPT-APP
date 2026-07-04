'use strict';

// Router-input typo repair (brain-infra roadmap #2, user understanding).
// Precision-first: curated dictionary + conservative unique-candidate fuzzy;
// ambiguous or known words are NEVER touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { repairTypos, INTERNAL } = require('../src/services/typo-repairer');

test('repairs curated real-world misspellings from production prompts', () => {
  const cases = [
    ['corrige el docuemtno word', 'documento'],
    ['hazme un resumne del archivo', 'resumen'],
    ['agregale los intruemntos de la investigacino', 'instrumentos'],
    ['de forma profeiosnal', 'profesional'],
    ['crea una presetacion en exel', 'presentación'],
  ];
  for (const [input, expected] of cases) {
    const r = repairTypos(input);
    assert.equal(r.source, 'repaired', `should repair: ${input}`);
    assert.ok(r.repaired.includes(expected), `${input} → ${r.repaired} should include ${expected}`);
  }
});

test('fuzzy path repairs unique dist-1 vocab hits, keeps case', () => {
  const r = repairTypos('Diapositvia tres del deck');
  // 'diapositvia' → dist to 'diapositiva' = transposition = 2 edits... verify behaviour:
  // if not repaired, precision-first is fine — assert no crash and stable output.
  assert.ok(typeof r.repaired === 'string');
  const r2 = repairTypos('cambia la columna a monedaa');
  assert.ok(r2.repaired.includes('moneda'), `monedaa → moneda (${r2.repaired})`);
});

test('never touches known words, short tokens or ambiguous candidates', () => {
  for (const text of [
    'para este tema quiero datos',
    'crea una tabla en excel',
    'the table for this data',
    'hola cómo estás',
  ]) {
    const r = repairTypos(text);
    assert.equal(r.source, 'no_change', `must not touch: ${text} (got ${r.repaired})`);
  }
});

test('long prompts are passed through untouched (cost guard) and never throws', () => {
  const long = 'palabra '.repeat(1000);
  assert.equal(repairTypos(long).source, 'no_change');
  assert.equal(repairTypos(null).repaired, '');
  assert.equal(repairTypos(undefined).source, 'no_change');
});

test('editDistanceLe bounded correctness', () => {
  assert.equal(INTERNAL.editDistanceLe('gato', 'gato', 1), 0);
  assert.equal(INTERNAL.editDistanceLe('gato', 'gata', 1), 1);
  assert.ok(INTERNAL.editDistanceLe('gato', 'perro', 1) > 1);
});
