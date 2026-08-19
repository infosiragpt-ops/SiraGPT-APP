'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-recipe-measurements');
const { extractRecipeMeasurements, buildRecipeMeasurementsForFiles, renderRecipeMeasurementsBlock, _internal } = engine;
const { normaliseAmount, classifyTemp } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractRecipeMeasurements('').total, 0);
  assert.equal(extractRecipeMeasurements(null).total, 0);
});

test('normaliseAmount: fractions', () => {
  assert.equal(normaliseAmount('1/2'), '0.5');
  assert.equal(normaliseAmount('½'), '0.5');
});

test('classifyTemp: F + C ranges', () => {
  assert.equal(classifyTemp('400', 'F'), 'hot');
  assert.equal(classifyTemp('350', 'F'), 'medium');
  assert.equal(classifyTemp('200', 'C'), 'hot');
});

test('detects "1 cup flour"', () => {
  const r = extractRecipeMeasurements('Add 1 cup flour to bowl.');
  assert.ok(r.entries.some((e) => e.kind === 'volume'));
});

test('detects "2 tbsp olive oil"', () => {
  const r = extractRecipeMeasurements('2 tbsp olive oil');
  assert.ok(r.entries.some((e) => e.kind === 'volume'));
});

test('detects "1/2 tsp salt"', () => {
  const r = extractRecipeMeasurements('1/2 tsp salt to taste');
  assert.ok(r.entries.some((e) => e.kind === 'volume'));
});

test('detects "250 g sugar"', () => {
  const r = extractRecipeMeasurements('250 g sugar dissolved');
  assert.ok(r.entries.some((e) => e.kind === 'weight'));
});

test('detects "1 lb beef"', () => {
  const r = extractRecipeMeasurements('1 lb beef stew meat');
  assert.ok(r.entries.some((e) => e.kind === 'weight'));
});

test('detects 350°F temperature', () => {
  const r = extractRecipeMeasurements('Bake at 350°F until golden');
  assert.ok(r.entries.some((e) => e.kind === 'temperature' && e.range === 'medium'));
});

test('detects 180°C temperature', () => {
  const r = extractRecipeMeasurements('Preheat oven to 180°C');
  assert.ok(r.entries.some((e) => e.kind === 'temperature'));
});

test('detects "gas mark 5"', () => {
  const r = extractRecipeMeasurements('Bake at gas mark 5');
  assert.ok(r.entries.some((e) => e.kind === 'temperature' && /gas/.test(e.normalised)));
});

test('detects cook time', () => {
  const r = extractRecipeMeasurements('bake for 30 minutes');
  assert.ok(r.entries.some((e) => e.kind === 'time'));
});

test('detects "simmer for 1 hour"', () => {
  const r = extractRecipeMeasurements('simmer for 1 hour, stirring');
  assert.ok(r.entries.some((e) => e.kind === 'time'));
});

test('dedupes identical entries', () => {
  const r = extractRecipeMeasurements('1 cup flour, 1 cup flour later');
  assert.equal(r.entries.filter((e) => e.kind === 'volume' && /1-cup/.test(e.normalised)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i < 30; i++) text += `${i} g sugar `;
  const r = extractRecipeMeasurements(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractRecipeMeasurements('1 cup flour, 250 g sugar, bake at 350°F for 30 minutes');
  assert.ok(r.totals.volume >= 1);
  assert.ok(r.totals.weight >= 1);
  assert.ok(r.totals.temperature >= 1);
  assert.ok(r.totals.time >= 1);
});

test('buildRecipeMeasurementsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '1 cup flour' },
    { name: 'b.md', extractedText: '250 g sugar' },
  ];
  const r = buildRecipeMeasurementsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRecipeMeasurementsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'recipe.md', extractedText: '1 cup flour' }];
  const r = buildRecipeMeasurementsForFiles(files);
  const md = renderRecipeMeasurementsBlock(r);
  assert.match(md, /^## RECIPE/);
});

test('renderRecipeMeasurementsBlock empty when nothing surfaces', () => {
  assert.equal(renderRecipeMeasurementsBlock({ perFile: [] }), '');
  assert.equal(renderRecipeMeasurementsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRecipeMeasurementsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '1 cup flour' },
  ]);
  assert.equal(r.perFile.length, 1);
});
