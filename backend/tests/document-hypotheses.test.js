'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-hypotheses');
const { extractHypotheses, buildHypothesesForFiles, renderHypothesesBlock, _internal } = engine;
const { detectKind } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractHypotheses('').total, 0);
  assert.equal(extractHypotheses(null).total, 0);
});

test('detectKind: hypothesis variants', () => {
  assert.equal(detectKind('We hypothesise that X causes Y.'), 'hypothesis');
  assert.equal(detectKind('Hypothesis H1: X causes Y.'), 'hypothesis');
});

test('detectKind: null hypothesis', () => {
  assert.equal(detectKind('The null hypothesis H0 states no effect.'), 'null-hypothesis');
});

test('detectKind: research question', () => {
  assert.equal(detectKind('Research question RQ1: how does X affect Y?'), 'research-question');
});

test('detects Spanish hypothesis', () => {
  const r = extractHypotheses('Hipótesis H1: el tratamiento mejora la respuesta. Postulamos que el grupo A supera al B.');
  assert.ok(r.items.length >= 1);
});

test('detects English hypothesis', () => {
  const r = extractHypotheses('We hypothesise that the new model outperforms the baseline.');
  assert.ok(r.items.some((i) => i.kind === 'hypothesis'));
});

test('detects Spanish null hypothesis', () => {
  const r = extractHypotheses('La hipótesis nula H0 indica que no hay diferencia significativa.');
  assert.ok(r.items.some((i) => i.kind === 'null-hypothesis'));
});

test('detects Spanish research question', () => {
  const r = extractHypotheses('Pregunta de investigación: ¿cómo afecta X a Y?');
  assert.ok(r.items.some((i) => i.kind === 'research-question'));
});

test('dedupes identical sentences across kinds', () => {
  const text = 'We hypothesise that A is true. We hypothesise that A is true.';
  const r = extractHypotheses(text);
  assert.equal(r.total, 1);
});

test('caps items per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Hypothesis H${i}: claim ${i} is significant. `;
  const r = extractHypotheses(text);
  assert.ok(r.items.length <= 12);
});

test('buildHypothesesForFiles aggregates across batch', () => {
  const files = [
    { name: 'paper-a.md', extractedText: 'We hypothesise that A outperforms B.' },
    { name: 'paper-b.md', extractedText: 'Pregunta de investigación: ¿cuál es el efecto?' },
  ];
  const r = buildHypothesesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHypothesesBlock returns markdown when items exist', () => {
  const files = [{ name: 'paper.md', extractedText: 'We hypothesise that X is true.' }];
  const r = buildHypothesesForFiles(files);
  const md = renderHypothesesBlock(r);
  assert.match(md, /^## RESEARCH HYPOTHESES/);
});

test('renderHypothesesBlock empty when nothing surfaces', () => {
  assert.equal(renderHypothesesBlock({ perFile: [] }), '');
  assert.equal(renderHypothesesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHypothesesForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'H1: claim.' }]);
  assert.ok(Array.isArray(r.perFile));
});
