'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-coupons');
const { extractCoupons, buildCouponsForFiles, renderCouponsBlock, _internal } = engine;
const { isLikelyCode } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCoupons('').total, 0);
  assert.equal(extractCoupons(null).total, 0);
});

test('isLikelyCode: rejects stopwords', () => {
  assert.equal(isLikelyCode('SAVE20'), true);
  assert.equal(isLikelyCode('JSON'), false);
  assert.equal(isLikelyCode('AB'), false);
});

test('detects "Code: SAVE20"', () => {
  const r = extractCoupons('Use Code: SAVE20 at checkout.');
  assert.ok(r.coupons.some((c) => c.code === 'SAVE20'));
});

test('detects "Promo: BLACKFRIDAY"', () => {
  const r = extractCoupons('Promo: BLACKFRIDAY active.');
  assert.ok(r.coupons.some((c) => c.code === 'BLACKFRIDAY'));
});

test('detects Spanish "Código: AHORRO20"', () => {
  const r = extractCoupons('Código: AHORRO20 disponible.');
  assert.ok(r.coupons.some((c) => c.code === 'AHORRO20'));
});

test('detects "Use SAVE20 at checkout"', () => {
  const r = extractCoupons('Use SAVE20 at checkout for 20% off.');
  assert.ok(r.coupons.some((c) => c.code === 'SAVE20'));
});

test('detects "Apply WELCOME10"', () => {
  const r = extractCoupons('Apply WELCOME10 today.');
  assert.ok(r.coupons.some((c) => c.code === 'WELCOME10'));
});

test('dedupes identical codes (case-insensitive)', () => {
  const r = extractCoupons('Code: SAVE20 and Code: SAVE20 also.');
  assert.equal(r.coupons.filter((c) => c.code === 'SAVE20').length, 1);
});

test('rejects too-short codes', () => {
  const r = extractCoupons('Code: AB');
  assert.equal(r.coupons.length, 0);
});

test('caps codes per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `Code: CODE${i} `;
  const r = extractCoupons(text);
  assert.ok(r.coupons.length <= 12);
});

test('rejects common acronyms', () => {
  const r = extractCoupons('Code: JSON or Code: HTTP');
  assert.equal(r.coupons.length, 0);
});

test('buildCouponsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Code: SAVE20' },
    { name: 'b.md', extractedText: 'Promo: BLACKFRIDAY' },
  ];
  const r = buildCouponsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCouponsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Code: SAVE20' }];
  const r = buildCouponsForFiles(files);
  const md = renderCouponsBlock(r);
  assert.match(md, /^## PROMO \/ COUPON CODES/);
});

test('renderCouponsBlock empty when nothing surfaces', () => {
  assert.equal(renderCouponsBlock({ perFile: [] }), '');
  assert.equal(renderCouponsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCouponsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Code: SAVE20' },
  ]);
  assert.equal(r.perFile.length, 1);
});
