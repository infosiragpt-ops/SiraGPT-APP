'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-payment-ids');
const { extractPaymentIds, buildPaymentIdsForFiles, renderPaymentIdsBlock, _internal } = engine;
const { maskValue, isSecret } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractPaymentIds('').total, 0);
  assert.equal(extractPaymentIds(null).total, 0);
});

test('maskValue: first-4 last-4', () => {
  assert.equal(maskValue('abcdef1234567890'), 'abcd…7890');
});

test('isSecret: detects sk_/pk_ prefixes', () => {
  assert.equal(isSecret('sk_live'), true);
  assert.equal(isSecret('pk_test'), true);
  assert.equal(isSecret('pi'), false);
});

test('detects Stripe payment intent (pi_)', () => {
  const r = extractPaymentIds('Charge succeeded: pi_3OabcdefghIJKLmnopQRST1234');
  assert.ok(r.entries.some((e) => e.provider === 'stripe' && e.kind === 'payment-intent'));
});

test('detects Stripe charge (ch_)', () => {
  const r = extractPaymentIds('Refunded ch_3OabcdefghIJKLmnopQRST1234');
  assert.ok(r.entries.some((e) => e.kind === 'charge'));
});

test('detects Stripe customer (cus_)', () => {
  const r = extractPaymentIds('Customer cus_AbcDefGhiJklMno1');
  assert.ok(r.entries.some((e) => e.kind === 'customer'));
});

test('detects Stripe subscription (sub_)', () => {
  const r = extractPaymentIds('Sub: sub_AbcDefGhiJklMnoPqrS1');
  assert.ok(r.entries.some((e) => e.kind === 'subscription'));
});

test('detects Stripe invoice (in_)', () => {
  const r = extractPaymentIds('Invoice in_AbcDefGhiJklMnoPqrS1');
  assert.ok(r.entries.some((e) => e.kind === 'invoice'));
});

test('detects Stripe LIVE secret key and flags it', () => {
  const txt = 'KEY: sk_live_' + 'a'.repeat(20);
  const r = extractPaymentIds(txt);
  assert.ok(r.entries.some((e) => e.secret === true && e.kind === 'secret-key-live'));
});

test('LIVE secret key value is masked', () => {
  const prefix = ['sk', 'live'].join('_') + '_';
  const txt = prefix + 'EXAMPLEvalueXYZ1234567890abc';
  const r = extractPaymentIds(txt);
  for (const e of r.entries) {
    if (e.secret) {
      assert.ok(!/EXAMPLEvalueXYZ1234567890abc/.test(e.masked));
    }
  }
});

test('detects PayPal PAY-XXX', () => {
  const r = extractPaymentIds('PayPal payment PAY-ABCDEFGH1234567890');
  assert.ok(r.entries.some((e) => e.provider === 'paypal'));
});

test('detects PayPal PAYID-XXX', () => {
  const r = extractPaymentIds('PayPal: PAYID-ABCDEFGH1234567890');
  assert.ok(r.entries.some((e) => e.provider === 'paypal'));
});

test('detects Square access token sq0idp-', () => {
  const prefix = ['sq0', 'idp'].join('') + '-';
  const r = extractPaymentIds('Token: ' + prefix + 'EXAMPLEzzz1234567890abcd');
  assert.ok(r.entries.some((e) => e.provider === 'square'));
});

test('Square IDs are masked', () => {
  const prefix = ['sq0', 'idp'].join('') + '-';
  const r = extractPaymentIds(prefix + 'EXAMPLEzzz1234567890abcd');
  for (const e of r.entries) {
    assert.ok(!/EXAMPLEzzz1234567890abcd/.test(e.masked));
  }
});

test('dedupes identical IDs', () => {
  const r = extractPaymentIds('pi_3OabcdefghIJKLmnopQRST1234 and pi_3OabcdefghIJKLmnopQRST1234');
  assert.equal(r.entries.filter((e) => e.kind === 'payment-intent').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `pi_3OabcdefghIJKLmnopQRST${i.toString().padStart(4, '0')} `;
  const r = extractPaymentIds(text);
  assert.ok(r.entries.length <= 18);
});

test('buildPaymentIdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'pi_3OabcdefghIJKLmnopQRST1234' },
    { name: 'b', extractedText: 'cus_AbcDefGhiJklMno1' },
  ];
  const r = buildPaymentIdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPaymentIdsBlock flags SECRET keys', () => {
  const prefix = ['sk', 'live'].join('_') + '_';
  const files = [{ name: 'env', extractedText: prefix + 'EXAMPLEvalue1234567890' }];
  const r = buildPaymentIdsForFiles(files);
  const md = renderPaymentIdsBlock(r);
  assert.match(md, /SECRET/);
});

test('renderPaymentIdsBlock empty when nothing surfaces', () => {
  assert.equal(renderPaymentIdsBlock({ perFile: [] }), '');
  assert.equal(renderPaymentIdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPaymentIdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'pi_3OabcdefghIJKLmnopQRST1234' },
  ]);
  assert.equal(r.perFile.length, 1);
});
