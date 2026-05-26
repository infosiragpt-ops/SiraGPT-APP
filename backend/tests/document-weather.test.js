'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-weather');
const { extractWeather, buildWeatherForFiles, renderWeatherBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractWeather('').total, 0);
  assert.equal(extractWeather(null).total, 0);
});

test('detects 25°C', () => {
  const r = extractWeather('Today temperature: 25°C');
  assert.ok(r.entries.some((e) => e.kind === 'temp-c'));
});

test('detects 77°F', () => {
  const r = extractWeather('77°F reported');
  assert.ok(r.entries.some((e) => e.kind === 'temp-f'));
});

test('detects 298K', () => {
  const r = extractWeather('Lab at 298K stable');
  assert.ok(r.entries.some((e) => e.kind === 'temp-k'));
});

test('detects precipitation', () => {
  const r = extractWeather('5 mm of rain expected tonight');
  assert.ok(r.entries.some((e) => e.kind === 'precipitation'));
});

test('detects wind speed', () => {
  const r = extractWeather('20 mph winds expected');
  assert.ok(r.entries.some((e) => e.kind === 'wind'));
});

test('detects humidity', () => {
  const r = extractWeather('65% humidity in the lab');
  assert.ok(r.entries.some((e) => e.kind === 'humidity'));
});

test('detects climate change', () => {
  const r = extractWeather('Discussion on climate change impacts');
  assert.ok(r.entries.some((e) => e.kind === 'climate-term'));
});

test('detects Spanish "cambio climático"', () => {
  const r = extractWeather('El cambio climático afecta la región.');
  assert.ok(r.entries.some((e) => e.kind === 'climate-term'));
});

test('detects CO2', () => {
  const r = extractWeather('CO2 emissions are rising.');
  assert.ok(r.entries.some((e) => e.kind === 'co2'));
});

test('dedupes identical entries', () => {
  const r = extractWeather('25°C reported. 25°C confirmed.');
  assert.equal(r.entries.filter((e) => /25/.test(e.phrase)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `${i + 10}°C reading. `;
  const r = extractWeather(text);
  assert.ok(r.entries.length <= 20);
});

test('buildWeatherForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '25°C today' },
    { name: 'b.md', extractedText: '77°F yesterday' },
  ];
  const r = buildWeatherForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWeatherBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '25°C today' }];
  const r = buildWeatherForFiles(files);
  const md = renderWeatherBlock(r);
  assert.match(md, /^## WEATHER/);
});

test('renderWeatherBlock empty when nothing surfaces', () => {
  assert.equal(renderWeatherBlock({ perFile: [] }), '');
  assert.equal(renderWeatherBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWeatherForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '25°C' },
  ]);
  assert.equal(r.perFile.length, 1);
});
