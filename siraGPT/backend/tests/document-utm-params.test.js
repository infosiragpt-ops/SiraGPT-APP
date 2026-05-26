'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-utm-params');
const { extractUtmParams, buildUtmParamsForFiles, renderUtmParamsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractUtmParams('').total, 0);
  assert.equal(extractUtmParams(null).total, 0);
});

test('detects utm_source', () => {
  const r = extractUtmParams('Visit https://example.com?utm_source=newsletter');
  assert.ok(r.entries.some((e) => e.key === 'source'));
});

test('detects utm_medium', () => {
  const r = extractUtmParams('?utm_medium=email&id=1');
  assert.ok(r.entries.some((e) => e.key === 'medium'));
});

test('detects utm_campaign', () => {
  const r = extractUtmParams('?utm_campaign=launch_q4');
  assert.ok(r.entries.some((e) => e.key === 'campaign'));
});

test('detects multiple UTM params', () => {
  const r = extractUtmParams('https://example.com?utm_source=fb&utm_medium=cpc&utm_campaign=fall_2024');
  assert.equal(r.entries.length, 3);
});

test('URL-decodes values', () => {
  const r = extractUtmParams('?utm_term=ai%20platform');
  assert.ok(r.entries.some((e) => /ai platform/.test(e.value)));
});

test('handles + as space', () => {
  const r = extractUtmParams('?utm_term=ai+platform');
  assert.ok(r.entries.some((e) => /ai platform/.test(e.value)));
});

test('dedupes identical entries', () => {
  const r = extractUtmParams('?utm_source=x&utm_source=x');
  assert.equal(r.entries.filter((e) => e.key === 'source').length, 1);
});

test('counts totals by key', () => {
  const r = extractUtmParams('?utm_source=a&utm_medium=b&utm_campaign=c');
  assert.ok(r.totals.source >= 1);
  assert.ok(r.totals.medium >= 1);
  assert.ok(r.totals.campaign >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `?utm_source=src${i} `;
  const r = extractUtmParams(text);
  assert.ok(r.entries.length <= 20);
});

test('buildUtmParamsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '?utm_source=fb' },
    { name: 'b.md', extractedText: '?utm_medium=email' },
  ];
  const r = buildUtmParamsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderUtmParamsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '?utm_source=fb' }];
  const r = buildUtmParamsForFiles(files);
  const md = renderUtmParamsBlock(r);
  assert.match(md, /^## UTM TRACKING/);
});

test('renderUtmParamsBlock empty when nothing surfaces', () => {
  assert.equal(renderUtmParamsBlock({ perFile: [] }), '');
  assert.equal(renderUtmParamsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildUtmParamsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '?utm_source=fb' },
  ]);
  assert.equal(r.perFile.length, 1);
});
