'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-crypto-wallets');
const { extractCryptoWallets, buildCryptoWalletsForFiles, renderCryptoWalletsBlock, _internal } = engine;
const { maskAddress } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCryptoWallets('').total, 0);
  assert.equal(extractCryptoWallets(null).total, 0);
});

test('maskAddress: first-6 last-4', () => {
  assert.equal(maskAddress('0xabcdef1234567890abcdef1234567890abcdef12'), '0xabcd…ef12');
});

test('detects ETH address', () => {
  const r = extractCryptoWallets('Send to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  assert.ok(r.entries.some((e) => e.chain === 'eth'));
});

test('ETH address is masked', () => {
  const r = extractCryptoWallets('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  for (const e of r.entries) {
    if (e.chain === 'eth') {
      assert.ok(!/d8dA6BF26964aF9D7eEd9e03E53415D37aA96045/.test(e.masked));
    }
  }
});

test('detects BTC P2PKH address', () => {
  const r = extractCryptoWallets('Tip jar: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.ok(r.entries.some((e) => e.chain === 'btc'));
});

test('detects BTC Bech32 address', () => {
  const r = extractCryptoWallets('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  assert.ok(r.entries.some((e) => e.chain === 'btc'));
});

test('detects ENS domain', () => {
  const r = extractCryptoWallets('vitalik.eth holds large positions');
  assert.ok(r.entries.some((e) => e.chain === 'ens'));
});

test('detects TRON address', () => {
  const r = extractCryptoWallets('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7');
  assert.ok(r.entries.some((e) => e.chain === 'tron'));
});

test('dedupes identical addresses', () => {
  const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  const r = extractCryptoWallets(`${addr} and again ${addr}`);
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `0x${i.toString().padStart(40, '0').slice(0, 40)} `;
  }
  const r = extractCryptoWallets(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by chain', () => {
  const r = extractCryptoWallets(
    '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 and vitalik.eth'
  );
  assert.ok(r.totals.eth >= 1);
  assert.ok(r.totals.ens >= 1);
});

test('buildCryptoWalletsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
    { name: 'b', extractedText: 'vitalik.eth' },
  ];
  const r = buildCryptoWalletsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCryptoWalletsBlock NEVER contains full ETH address', () => {
  const files = [{ name: 'tx', extractedText: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' }];
  const r = buildCryptoWalletsForFiles(files);
  const md = renderCryptoWalletsBlock(r);
  assert.ok(!/d8dA6BF26964aF9D7eEd9e03E53415D37aA96045/.test(md));
});

test('renderCryptoWalletsBlock empty when nothing surfaces', () => {
  assert.equal(renderCryptoWalletsBlock({ perFile: [] }), '');
  assert.equal(renderCryptoWalletsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCryptoWalletsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  ]);
  assert.equal(r.perFile.length, 1);
});
