'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-credit-cards');
const { extractCreditCards, buildCreditCardsForFiles, renderCreditCardsBlock, _internal } = engine;
const { luhnValid, mask } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCreditCards('').total, 0);
  assert.equal(extractCreditCards(null).total, 0);
});

test('luhnValid: known good number', () => {
  // Standard test card numbers (publicly known, used everywhere)
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('4111111111111111'), true);
});

test('luhnValid: rejects bad checksum', () => {
  assert.equal(luhnValid('4242424242424243'), false);
});

test('mask: returns last-4 only', () => {
  const m = mask('4242 4242 4242 4242');
  assert.equal(m, '****-****-****-4242');
});

test('detects Visa test card masked', () => {
  const r = extractCreditCards('Card: 4242 4242 4242 4242');
  assert.ok(r.entries.some((e) => e.kind === 'visa' && /4242$/.test(e.masked)));
});

test('detects masked output never contains full number', () => {
  const r = extractCreditCards('Card: 4242 4242 4242 4242');
  for (const e of r.entries) {
    assert.ok(!/4242 4242 4242 4242/.test(e.masked));
    assert.ok(!/4242424242424242/.test(e.masked));
  }
});

test('detects Mastercard test card', () => {
  const r = extractCreditCards('MC: 5555 5555 5555 4444');
  assert.ok(r.entries.some((e) => e.kind === 'mastercard'));
});

test('detects Amex 15-digit', () => {
  const r = extractCreditCards('Amex: 3782 822463 10005');
  assert.ok(r.entries.some((e) => e.kind === 'amex'));
});

test('rejects invalid Luhn', () => {
  const r = extractCreditCards('Card: 4242 4242 4242 4243');
  assert.equal(r.entries.length, 0);
});

test('dedupes identical masked', () => {
  const r = extractCreditCards('Card: 4242 4242 4242 4242. Same: 4242 4242 4242 4242.');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += '4242 4242 4242 4242 ';
  const r = extractCreditCards(text);
  assert.ok(r.entries.length <= 14);
});

test('buildCreditCardsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '4242 4242 4242 4242' },
    { name: 'b.md', extractedText: '5555 5555 5555 4444' },
  ];
  const r = buildCreditCardsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCreditCardsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '4242 4242 4242 4242' }];
  const r = buildCreditCardsForFiles(files);
  const md = renderCreditCardsBlock(r);
  assert.match(md, /^## CREDIT CARDS/);
});

test('renderCreditCardsBlock empty when nothing surfaces', () => {
  assert.equal(renderCreditCardsBlock({ perFile: [] }), '');
  assert.equal(renderCreditCardsBlock(null), '');
});

test('renderCreditCardsBlock NEVER contains the full number', () => {
  const files = [{ name: 'doc.md', extractedText: '4242 4242 4242 4242' }];
  const r = buildCreditCardsForFiles(files);
  const md = renderCreditCardsBlock(r);
  assert.ok(!/4242 4242 4242 4242/.test(md));
  assert.ok(!/4242424242424242/.test(md));
});

test('handles non-string extractedText', () => {
  const r = buildCreditCardsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '4242 4242 4242 4242' },
  ]);
  assert.equal(r.perFile.length, 1);
});
