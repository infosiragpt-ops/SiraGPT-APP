'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-currency');
const { extractCurrency, buildCurrencyForFiles, renderCurrencyBlock, _internal } = engine;
const { isIsoCurrency, normaliseSymbol } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCurrency('').total, 0);
  assert.equal(extractCurrency(null).total, 0);
});

test('isIsoCurrency: validates ISO codes', () => {
  assert.equal(isIsoCurrency('USD'), true);
  assert.equal(isIsoCurrency('EUR'), true);
  assert.equal(isIsoCurrency('XYZ'), false);
});

test('normaliseSymbol: $ → USD', () => {
  assert.equal(normaliseSymbol('$'), 'USD');
  assert.equal(normaliseSymbol('€'), 'EUR');
  assert.equal(normaliseSymbol('£'), 'GBP');
});

test('detects $1,234.56', () => {
  const r = extractCurrency('Total: $1,234.56');
  assert.ok(r.amounts.some((a) => a.currency === 'USD'));
});

test('detects €100', () => {
  const r = extractCurrency('Price: €100');
  assert.ok(r.amounts.some((a) => a.currency === 'EUR'));
});

test('detects £50', () => {
  const r = extractCurrency('Cost is £50');
  assert.ok(r.amounts.some((a) => a.currency === 'GBP'));
});

test('detects ISO suffix "100 USD"', () => {
  const r = extractCurrency('Charged 100 USD per month.');
  assert.ok(r.amounts.some((a) => a.currency === 'USD' && a.amount === '100'));
});

test('detects ISO prefix "EUR 250"', () => {
  const r = extractCurrency('Paid EUR 250 for license.');
  assert.ok(r.amounts.some((a) => a.currency === 'EUR'));
});

test('detects BTC ₿0.01', () => {
  const r = extractCurrency('Sent ₿0.01 today.');
  assert.ok(r.amounts.some((a) => a.currency === 'BTC'));
});

test('detects R$ Brazilian Real', () => {
  const r = extractCurrency('R$ 500 in fees');
  assert.ok(r.amounts.some((a) => a.currency === 'BRL'));
});

test('dedupes identical amounts', () => {
  const r = extractCurrency('Charged $100 once and $100 again.');
  assert.equal(r.amounts.filter((a) => a.currency === 'USD' && a.amount === '100').length, 1);
});

test('counts byCurrency', () => {
  const r = extractCurrency('$100 first, then €50, then $200');
  assert.equal(r.byCurrency.USD, 2);
  assert.equal(r.byCurrency.EUR, 1);
});

test('handles negative amounts $-100 or -$100', () => {
  const r = extractCurrency('Net: $-100 charge');
  assert.ok(r.amounts.some((a) => a.amount.includes('-100')));
});

test('caps amounts per file', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += `$${i + 1} `;
  const r = extractCurrency(text);
  assert.ok(r.amounts.length <= 24);
});

test('rejects bare 3-letter words that are not currencies', () => {
  const r = extractCurrency('Send to API 200 XYZ');
  assert.equal(r.amounts.filter((a) => a.currency === 'XYZ').length, 0);
});

test('handles thousands separators', () => {
  const r = extractCurrency('Total: $1,000,000.00');
  assert.ok(r.amounts.some((a) => /1,000,000/.test(a.amount)));
});

test('buildCurrencyForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '$100 first' },
    { name: 'b.md', extractedText: '€200 second' },
  ];
  const r = buildCurrencyForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCurrencyBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '$100 charged' }];
  const r = buildCurrencyForFiles(files);
  const md = renderCurrencyBlock(r);
  assert.match(md, /^## CURRENCY AMOUNTS/);
});

test('renderCurrencyBlock empty when nothing surfaces', () => {
  assert.equal(renderCurrencyBlock({ perFile: [] }), '');
  assert.equal(renderCurrencyBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCurrencyForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '$100' },
  ]);
  assert.equal(r.perFile.length, 1);
});
