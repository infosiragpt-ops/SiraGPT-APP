'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-scenarios');
const { extractScenarios, buildScenariosForFiles, renderScenariosBlock, _internal } = engine;
const { detectKind } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractScenarios('').total, 0);
  assert.equal(extractScenarios(null).total, 0);
});

test('detectKind: best case', () => {
  assert.equal(detectKind('Best case projection: 30% YoY growth.'), 'best-case');
  assert.equal(detectKind('En el mejor caso, la planta opera al 100%.'), 'best-case');
  assert.equal(detectKind('Bull case assumes premium pricing holds.'), 'best-case');
});

test('detectKind: worst case', () => {
  assert.equal(detectKind('Worst case scenario: 15% revenue decline.'), 'worst-case');
  assert.equal(detectKind('Stress test indicates capital ratio drops.'), 'worst-case');
  assert.equal(detectKind('En el peor caso, perdemos al cliente principal.'), 'worst-case');
});

test('detectKind: base case', () => {
  assert.equal(detectKind('Base case assumes 10% growth and stable margins.'), 'base-case');
  assert.equal(detectKind('Most likely scenario: gradual recovery.'), 'base-case');
  assert.equal(detectKind('Escenario base: crecimiento del 10%.'), 'base-case');
});

test('detectKind: sensitivity', () => {
  assert.equal(detectKind('Sensitivity analysis shows the project is robust to a 10% cost increase.'), 'sensitivity');
  assert.equal(detectKind('A Monte Carlo simulation explores 1000 outcomes.'), 'sensitivity');
  assert.equal(detectKind('Análisis de sensibilidad indica estabilidad.'), 'sensitivity');
});

test('detectKind: non-scenario returns null', () => {
  assert.equal(detectKind('The team had lunch on Tuesday.'), null);
});

test('extracts multiple scenario kinds', () => {
  const text = `Best case: revenue grows 30%. Worst case: revenue drops 15%. Base case assumes 10% growth and stable margins.`;
  const r = extractScenarios(text);
  assert.ok(r.total >= 3);
});

test('dedupes identical sentences', () => {
  const text = 'Worst case: revenue drops 15%. Worst case: revenue drops 15%.';
  const r = extractScenarios(text);
  assert.equal(r.total, 1);
});

test('buildScenariosForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Best case: 30% growth.' },
    { name: 'b.md', extractedText: 'Worst case: 15% decline.' },
  ];
  const r = buildScenariosForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderScenariosBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Worst case scenario: 15% revenue decline.' }];
  const r = buildScenariosForFiles(files);
  const md = renderScenariosBlock(r);
  assert.match(md, /^## SCENARIO ANALYSIS/);
});

test('renderScenariosBlock empty when nothing surfaces', () => {
  assert.equal(renderScenariosBlock({ perFile: [] }), '');
  assert.equal(renderScenariosBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildScenariosForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Base case scenario assumes growth.' }]);
  assert.ok(Array.isArray(r.perFile));
});
