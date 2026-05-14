'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-stock-tickers');
const { extractStockTickers, buildStockTickersForFiles, renderStockTickersBlock, _internal } = engine;
const { looksLikeTicker } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractStockTickers('').total, 0);
  assert.equal(extractStockTickers(null).total, 0);
});

test('looksLikeTicker: rejects reserved words', () => {
  assert.equal(looksLikeTicker('AAPL'), true);
  assert.equal(looksLikeTicker('THE'), false);
  assert.equal(looksLikeTicker('lowercase'), false);
});

test('detects $AAPL cashtag', () => {
  const r = extractStockTickers('Bought $AAPL today.');
  assert.ok(r.entries.some((e) => e.kind === 'cashtag' && e.ticker === 'AAPL'));
});

test('detects $TSLA cashtag', () => {
  const r = extractStockTickers('Watching $TSLA price');
  assert.ok(r.entries.some((e) => e.kind === 'cashtag' && e.ticker === 'TSLA'));
});

test('detects NASDAQ:GOOG', () => {
  const r = extractStockTickers('NASDAQ:GOOG hit a new high.');
  assert.ok(r.entries.some((e) => e.kind === 'exchange' && e.exchange === 'NASDAQ'));
});

test('detects NYSE:TSLA', () => {
  const r = extractStockTickers('NYSE:TSLA closed at 250.');
  assert.ok(r.entries.some((e) => e.kind === 'exchange' && e.exchange === 'NYSE'));
});

test('detects ISIN code', () => {
  const r = extractStockTickers('Apple ISIN: US0378331005');
  assert.ok(r.entries.some((e) => e.kind === 'isin' && e.ticker === 'US0378331005'));
});

test('detects "shares of X" contextual', () => {
  const r = extractStockTickers('Bought 100 shares of MSFT yesterday.');
  assert.ok(r.entries.some((e) => e.kind === 'contextual'));
});

test('rejects reserved word cashtag', () => {
  const r = extractStockTickers('Just thinking $THE');
  assert.equal(r.entries.filter((e) => e.kind === 'cashtag').length, 0);
});

test('detects BRK.B class B ticker', () => {
  const r = extractStockTickers('$BRK.B is class B Berkshire shares');
  assert.ok(r.entries.some((e) => /BRK\.B/.test(e.ticker)));
});

test('dedupes identical tickers within kind', () => {
  const r = extractStockTickers('$AAPL here and $AAPL again');
  assert.equal(r.entries.filter((e) => e.kind === 'cashtag' && e.ticker === 'AAPL').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `$${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i]} `;
  const r = extractStockTickers(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractStockTickers('$AAPL and NYSE:TSLA and ISIN US0378331005');
  assert.ok(r.totals.cashtag >= 1);
  assert.ok(r.totals.exchange >= 1);
  assert.ok(r.totals.isin >= 1);
});

test('buildStockTickersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '$AAPL' },
    { name: 'b.md', extractedText: '$MSFT' },
  ];
  const r = buildStockTickersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderStockTickersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'note.md', extractedText: '$AAPL' }];
  const r = buildStockTickersForFiles(files);
  const md = renderStockTickersBlock(r);
  assert.match(md, /^## STOCK TICKERS/);
});

test('renderStockTickersBlock empty when nothing surfaces', () => {
  assert.equal(renderStockTickersBlock({ perFile: [] }), '');
  assert.equal(renderStockTickersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildStockTickersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '$AAPL' },
  ]);
  assert.equal(r.perFile.length, 1);
});
