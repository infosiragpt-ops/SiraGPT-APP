'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-attributions');
const { extractAttributions, buildAttributionsForFiles, renderAttributionsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractAttributions('').total, 0);
  assert.equal(extractAttributions(null).total, 0);
});

test('detects "According to" attribution', () => {
  const r = extractAttributions('According to McKinsey, growth slowed.');
  assert.ok(r.attributions.some((a) => /McKinsey/.test(a.source)));
});

test('detects "Per the X" attribution', () => {
  const r = extractAttributions('Per the IMF report, inflation rose.');
  assert.ok(r.attributions.some((a) => /IMF/.test(a.source)));
});

test('detects "As reported by" attribution', () => {
  const r = extractAttributions('As reported by Reuters, the stock fell.');
  assert.ok(r.attributions.some((a) => /Reuters/.test(a.source)));
});

test('detects "Cited in" attribution', () => {
  const r = extractAttributions('Cited in Nature, the findings hold.');
  assert.ok(r.attributions.some((a) => /Nature/.test(a.source)));
});

test('detects Spanish "Según X"', () => {
  const r = extractAttributions('Según el Banco Mundial, hay riesgos.');
  assert.ok(r.attributions.some((a) => /Banco/.test(a.source)));
});

test('detects Spanish "De acuerdo con"', () => {
  const r = extractAttributions('De acuerdo con la OMS, los casos aumentan.');
  assert.ok(r.attributions.some((a) => /OMS/.test(a.source)));
});

test('dedupes identical sources', () => {
  const r = extractAttributions('According to McKinsey, growth slowed. According to McKinsey, costs rose.');
  assert.equal(r.attributions.filter((a) => /McKinsey/.test(a.source)).length, 1);
});

test('caps attributions per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `According to Source${i}, fact ${i}. `;
  const r = extractAttributions(text);
  assert.ok(r.attributions.length <= 16);
});

test('buildAttributionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'According to McKinsey, growth slowed.' },
    { name: 'b.md', extractedText: 'Per Reuters, the stock fell.' },
  ];
  const r = buildAttributionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAttributionsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'According to McKinsey, growth slowed.' }];
  const r = buildAttributionsForFiles(files);
  const md = renderAttributionsBlock(r);
  assert.match(md, /^## SOURCE ATTRIBUTIONS/);
});

test('renderAttributionsBlock empty when nothing surfaces', () => {
  assert.equal(renderAttributionsBlock({ perFile: [] }), '');
  assert.equal(renderAttributionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAttributionsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'According to McKinsey, growth slowed.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
