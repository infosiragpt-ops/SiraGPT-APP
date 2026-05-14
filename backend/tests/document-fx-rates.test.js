'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-fx-rates');
const { extractFxRates, buildFxRatesForFiles, renderFxRatesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractFxRates('').total, 0);
  assert.equal(extractFxRates(null).total, 0);
});

test('detects USD/EUR 1.10', () => {
  const r = extractFxRates('Rate: USD/EUR 1.10 today.');
  assert.ok(r.entries.some((e) => e.kind === 'pair-rate'));
});

test('detects EUR/USD = 0.91', () => {
  const r = extractFxRates('Quote: EUR/USD = 0.91');
  assert.ok(r.entries.some((e) => e.kind === 'pair-rate'));
});

test('detects "1 USD = 0.91 EUR"', () => {
  const r = extractFxRates('Conversion: 1 USD = 0.91 EUR today.');
  assert.ok(r.entries.some((e) => e.kind === 'equation'));
});

test('detects "exchange rate: 1.10"', () => {
  const r = extractFxRates('exchange rate: 1.10');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('detects Spanish "tipo de cambio"', () => {
  const r = extractFxRates('Tipo de cambio: 20.50');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('rejects invalid ISO codes', () => {
  const r = extractFxRates('Pair XYZ/ABC 1.10 invalid.');
  assert.equal(r.entries.filter((e) => e.kind === 'pair-rate').length, 0);
});

test('dedupes identical pairs', () => {
  const r = extractFxRates('USD/EUR 1.10 here. USD/EUR 1.10 there.');
  assert.equal(r.entries.filter((e) => e.kind === 'pair-rate').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `USD/EUR ${i / 100} `;
  const r = extractFxRates(text);
  assert.ok(r.entries.length <= 16);
});

test('buildFxRatesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'USD/EUR 1.10' },
    { name: 'b.md', extractedText: 'EUR/JPY 165' },
  ];
  const r = buildFxRatesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFxRatesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'USD/EUR 1.10' }];
  const r = buildFxRatesForFiles(files);
  const md = renderFxRatesBlock(r);
  assert.match(md, /^## CURRENCY EXCHANGE RATES/);
});

test('renderFxRatesBlock empty when nothing surfaces', () => {
  assert.equal(renderFxRatesBlock({ perFile: [] }), '');
  assert.equal(renderFxRatesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFxRatesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'USD/EUR 1.10' },
  ]);
  assert.equal(r.perFile.length, 1);
});
