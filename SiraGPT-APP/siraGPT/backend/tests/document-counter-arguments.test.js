'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-counter-arguments');
const { extractCounterArguments, buildCounterArgumentsForFiles, renderCounterArgumentsBlock, _internal } = engine;
const { detectTrigger } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCounterArguments('').total, 0);
  assert.equal(extractCounterArguments(null).total, 0);
});

test('detectTrigger: English contrast markers', () => {
  assert.ok(detectTrigger('However, the data suggests otherwise.'));
  assert.ok(detectTrigger('On the other hand, costs grew.'));
  assert.ok(detectTrigger('Despite the gains, latency worsened.'));
});

test('detectTrigger: Spanish contrast markers', () => {
  assert.ok(detectTrigger('Sin embargo, los datos sugieren lo contrario.'));
  assert.ok(detectTrigger('Por otro lado, los costos crecieron.'));
  assert.ok(detectTrigger('A pesar de las ganancias, la latencia empeoró.'));
});

test('detectTrigger: explicit objection phrases', () => {
  assert.ok(detectTrigger('Critics argue the methodology is flawed.'));
  assert.ok(detectTrigger('A counter-argument is that the sample is too small.'));
  assert.ok(detectTrigger('Críticos sostienen que la muestra es insuficiente.'));
});

test('detectTrigger: non-counter returns null', () => {
  assert.equal(detectTrigger('The team had lunch on Tuesday.'), null);
});

test('extracts mixed-language counter-arguments', () => {
  const text = 'However, the experiment had limitations. Sin embargo, los resultados son prometedores.';
  const r = extractCounterArguments(text);
  assert.ok(r.total >= 2);
});

test('dedupes identical sentences', () => {
  const text = 'However, X is true. However, X is true.';
  const r = extractCounterArguments(text);
  assert.equal(r.total, 1);
});

test('caps counters per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `However, objection ${i} is noted. `;
  const r = extractCounterArguments(text);
  assert.ok(r.counters.length <= 14);
});

test('buildCounterArgumentsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'However, the data tells a different story.' },
    { name: 'b.md', extractedText: 'No obstante, los costos aumentaron significativamente.' },
  ];
  const r = buildCounterArgumentsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCounterArgumentsBlock returns markdown when counters exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'However, the data suggests otherwise here.' }];
  const r = buildCounterArgumentsForFiles(files);
  const md = renderCounterArgumentsBlock(r);
  assert.match(md, /^## COUNTER-ARGUMENTS/);
});

test('renderCounterArgumentsBlock empty when nothing surfaces', () => {
  assert.equal(renderCounterArgumentsBlock({ perFile: [] }), '');
  assert.equal(renderCounterArgumentsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCounterArgumentsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'However, X is critical.' }]);
  assert.ok(Array.isArray(r.perFile));
});
