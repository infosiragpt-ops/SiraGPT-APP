'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-iso-langs');
const { extractIsoLangs, buildIsoLangsForFiles, renderIsoLangsBlock, _internal } = engine;
const { looksLikeLang } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractIsoLangs('').total, 0);
  assert.equal(extractIsoLangs(null).total, 0);
});

test('looksLikeLang: valid codes', () => {
  assert.equal(looksLikeLang('en'), true);
  assert.equal(looksLikeLang('en-US'), true);
  assert.equal(looksLikeLang('xx'), false);
});

test('detects labeled "language: en"', () => {
  const r = extractIsoLangs('language: en in metadata');
  assert.ok(r.entries.some((e) => e.lang === 'en' && e.source === 'labeled'));
});

test('detects "lang=es" attribute', () => {
  const r = extractIsoLangs('<html lang="es">');
  assert.ok(r.entries.some((e) => e.lang === 'es'));
});

test('detects "locale: en-US"', () => {
  const r = extractIsoLangs('locale: en-US');
  assert.ok(r.entries.some((e) => e.lang === 'en-US' && e.kind === 'region'));
});

test('detects pt-BR Brazilian Portuguese', () => {
  const r = extractIsoLangs('locale: pt-BR');
  assert.ok(r.entries.some((e) => e.lang === 'pt-BR'));
});

test('detects zh-CN Simplified Chinese', () => {
  const r = extractIsoLangs('language: zh-CN');
  assert.ok(r.entries.some((e) => e.lang === 'zh-CN'));
});

test('detects BCP-47 with script and region (zh-Hans-CN)', () => {
  const r = extractIsoLangs('Use zh-Hans-CN for translation.');
  assert.ok(r.entries.some((e) => /zh-Hans-CN/.test(e.lang) && e.kind === 'script'));
});

test('detects "Content-Language: fr"', () => {
  const r = extractIsoLangs('Content-Language: fr');
  assert.ok(r.entries.some((e) => e.lang === 'fr'));
});

test('rejects invalid pseudo-codes', () => {
  const r = extractIsoLangs('language: zz');
  assert.equal(r.entries.length, 0);
});

test('dedupes identical langs', () => {
  const r = extractIsoLangs('language: en and lang=en');
  assert.equal(r.entries.filter((e) => e.lang === 'en').length, 1);
});

test('caps entries per file', () => {
  const codes = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'da', 'no', 'sv', 'fi', 'pl', 'cs', 'hu', 'ja', 'ko', 'zh', 'ar'];
  let text = '';
  for (const c of codes) text += `lang=${c} `;
  const r = extractIsoLangs(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractIsoLangs('lang=en, locale: en-US, language: zh-Hans-CN');
  assert.ok(r.totals.labeled >= 1);
  assert.ok(r.totals.region >= 1);
});

test('buildIsoLangsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'lang=en' },
    { name: 'b', extractedText: 'lang=es' },
  ];
  const r = buildIsoLangsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderIsoLangsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'page', extractedText: 'lang=en' }];
  const r = buildIsoLangsForFiles(files);
  const md = renderIsoLangsBlock(r);
  assert.match(md, /^## ISO LANGUAGE/);
});

test('renderIsoLangsBlock empty when nothing surfaces', () => {
  assert.equal(renderIsoLangsBlock({ perFile: [] }), '');
  assert.equal(renderIsoLangsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildIsoLangsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'lang=en' },
  ]);
  assert.equal(r.perFile.length, 1);
});
