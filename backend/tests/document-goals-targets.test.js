'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-goals-targets');
const { extractGoals, buildGoalsForFiles, renderGoalsBlock, _internal } = engine;
const { isGoal } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractGoals('').total, 0);
  assert.equal(extractGoals(null).total, 0);
});

test('isGoal: English variants', () => {
  assert.ok(isGoal('Our goal is to scale to 1M users by 2027.'));
  assert.ok(isGoal('The objective is to achieve 90% gross margin.'));
  assert.ok(isGoal('Target: 25% YoY growth this fiscal year.'));
  assert.ok(isGoal('OKR 1: launch the new platform in Q3.'));
});

test('isGoal: Spanish variants', () => {
  assert.ok(isGoal('Nuestro objetivo es escalar a 1 millón de usuarios.'));
  assert.ok(isGoal('La meta es alcanzar 90% de margen bruto.'));
  assert.ok(isGoal('Buscamos crecimiento del 25% anual.'));
});

test('isGoal: non-goal rejected', () => {
  assert.ok(!isGoal('The team had lunch on Tuesday.'));
});

test('extractGoals returns goal sentences', () => {
  const text = `Our goal is to scale to 1M users.
The objective is 90% margin.
Target: 25% YoY growth.`;
  const r = extractGoals(text);
  assert.ok(r.total >= 3);
});

test('Spanish: extracts goals', () => {
  const text = 'Nuestro objetivo es 1M de usuarios. La meta es 90% de margen.';
  const r = extractGoals(text);
  assert.ok(r.total >= 2);
});

test('dedupes identical sentences', () => {
  const text = 'Our goal is 1M users by 2027. Our goal is 1M users by 2027.';
  const r = extractGoals(text);
  assert.equal(r.total, 1);
});

test('buildGoalsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Our goal is 1M users by 2027.' },
    { name: 'b.md', extractedText: 'La meta es 90% de margen.' },
  ];
  const r = buildGoalsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGoalsBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Our goal is to scale to 1M users.' }];
  const r = buildGoalsForFiles(files);
  const md = renderGoalsBlock(r);
  assert.match(md, /^## GOALS & TARGETS/);
});

test('renderGoalsBlock empty when nothing surfaces', () => {
  assert.equal(renderGoalsBlock({ perFile: [] }), '');
  assert.equal(renderGoalsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGoalsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Our goal is to ship.' }]);
  assert.ok(Array.isArray(r.perFile));
});
