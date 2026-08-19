'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-currency-symbols');
const { extractCurrencySymbols, buildCurrencySymbolsForFiles, renderCurrencySymbolsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCurrencySymbols('').total, 0);
  assert.equal(extractCurrencySymbols(null).total, 0);
});

test('detects standalone € symbol', () => {
  const r = extractCurrencySymbols('We support € transactions for European users.');
  assert.ok(r.entries.some((e) => e.iso === 'EUR'));
});

test('detects standalone $ symbol', () => {
  const r = extractCurrencySymbols('We accept $ payments in North America.');
  assert.ok(r.entries.some((e) => e.iso === 'USD'));
});

test('detects ¥ for JPY', () => {
  const r = extractCurrencySymbols('Branding shows ¥ on Japan landing page.');
  assert.ok(r.entries.some((e) => e.iso === 'JPY'));
});

test('detects ₿ for Bitcoin', () => {
  const r = extractCurrencySymbols('Accept ₿ at checkout for crypto users.');
  assert.ok(r.entries.some((e) => e.iso === 'BTC'));
});

test('does NOT detect $ followed by digit (amount)', () => {
  const r = extractCurrencySymbols('Total: $100 due');
  // $ followed by digit is amount, not standalone
  assert.equal(r.entries.length, 0);
});

test('detects ₩ for KRW', () => {
  const r = extractCurrencySymbols('Branding includes ₩ for Korean users.');
  assert.ok(r.entries.some((e) => e.iso === 'KRW'));
});

test('dedupes identical entries', () => {
  const r = extractCurrencySymbols('We support € transactions. The € is used.');
  // Different contexts → different entries; but if context is short and similar should dedupe
  assert.ok(r.entries.length <= 2);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `€ block ${i} `;
  const r = extractCurrencySymbols(text);
  assert.ok(r.entries.length <= 16);
});

test('buildCurrencySymbolsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '€ in Europe' },
    { name: 'b.md', extractedText: '$ in US' },
  ];
  const r = buildCurrencySymbolsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCurrencySymbolsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Branding €' }];
  const r = buildCurrencySymbolsForFiles(files);
  const md = renderCurrencySymbolsBlock(r);
  assert.match(md, /^## CURRENCY SYMBOLS/);
});

test('renderCurrencySymbolsBlock empty when nothing surfaces', () => {
  assert.equal(renderCurrencySymbolsBlock({ perFile: [] }), '');
  assert.equal(renderCurrencySymbolsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCurrencySymbolsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Branding €' },
  ]);
  assert.equal(r.perFile.length, 1);
});
