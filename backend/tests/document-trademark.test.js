'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-trademark');
const { extractTrademark, buildTrademarkForFiles, renderTrademarkBlock, _internal } = engine;
const { symbolToKind } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTrademark('').total, 0);
  assert.equal(extractTrademark(null).total, 0);
});

test('symbolToKind: returns kind', () => {
  assert.equal(symbolToKind('™'), 'trademark');
  assert.equal(symbolToKind('®'), 'registered');
  assert.equal(symbolToKind('℠'), 'serviceMark');
  assert.equal(symbolToKind('©'), 'copyright');
  assert.equal(symbolToKind('x'), null);
});

test('detects Acme™', () => {
  const r = extractTrademark('We use Acme™ for all storage.');
  assert.ok(r.entries.some((e) => e.kind === 'trademark' && /Acme/.test(e.entity)));
});

test('detects Apple®', () => {
  const r = extractTrademark('Apple® is a registered mark.');
  assert.ok(r.entries.some((e) => e.kind === 'registered' && /Apple/.test(e.entity)));
});

test('detects ServiceCo℠', () => {
  const r = extractTrademark('ServiceCo℠ provides hosting.');
  assert.ok(r.entries.some((e) => e.kind === 'serviceMark'));
});

test('detects © with year + entity', () => {
  const r = extractTrademark('© 2024 Acme Inc.');
  assert.ok(r.entries.some((e) => e.kind === 'copyright' && /Acme/.test(e.entity)));
});

test('detects "Trademark of Acme"', () => {
  const r = extractTrademark('All marks are Trademark of Acme Corporation.');
  assert.ok(r.entries.some((e) => e.kind === 'attribution'));
});

test('detects Spanish "Marca registrada de Acme"', () => {
  const r = extractTrademark('Marca registrada de Acme Inc.');
  assert.ok(r.entries.some((e) => e.kind === 'attribution'));
});

test('dedupes identical entries', () => {
  const r = extractTrademark('Acme™ here and Acme™ there.');
  assert.equal(r.entries.filter((e) => /Acme/.test(e.entity) && e.kind === 'trademark').length, 1);
});

test('counts totals by kind', () => {
  const r = extractTrademark('Acme™ and Apple® and © 2024 Corp');
  assert.ok(r.totals.trademark >= 1);
  assert.ok(r.totals.registered >= 1);
  assert.ok(r.totals.copyright >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Brand${i}™ here `;
  const r = extractTrademark(text);
  assert.ok(r.entries.length <= 16);
});

test('buildTrademarkForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Acme™' },
    { name: 'b.md', extractedText: 'Apple®' },
  ];
  const r = buildTrademarkForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTrademarkBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Acme™' }];
  const r = buildTrademarkForFiles(files);
  const md = renderTrademarkBlock(r);
  assert.match(md, /^## TRADEMARKS \/ IP MARKERS/);
});

test('renderTrademarkBlock empty when nothing surfaces', () => {
  assert.equal(renderTrademarkBlock({ perFile: [] }), '');
  assert.equal(renderTrademarkBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTrademarkForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Acme™' },
  ]);
  assert.equal(r.perFile.length, 1);
});
