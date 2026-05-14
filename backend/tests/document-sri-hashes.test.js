'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-sri-hashes');
const { extractSriHashes, buildSriHashesForFiles, renderSriHashesBlock, _internal } = engine;
const { maskHash } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractSriHashes('').total, 0);
  assert.equal(extractSriHashes(null).total, 0);
});

test('maskHash truncates long hash values', () => {
  assert.equal(maskHash('short'), 'short');
  const long = 'A'.repeat(64);
  const masked = maskHash(long);
  assert.ok(masked.length < 30);
  assert.ok(masked.includes('…'));
});

test('detects sha256 integrity attribute', () => {
  const r = extractSriHashes('<script src="x.js" integrity="sha256-abcdefghijklmnopqrstuvwxyz1234567890+/=ABC"></script>');
  assert.ok(r.entries.some((e) => e.algo === 'sha256'));
});

test('detects sha384 integrity', () => {
  const r = extractSriHashes('<link rel="stylesheet" integrity="sha384-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">');
  assert.ok(r.entries.some((e) => e.algo === 'sha384'));
});

test('detects sha512 integrity', () => {
  const r = extractSriHashes('integrity="sha512-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
  assert.ok(r.entries.some((e) => e.algo === 'sha512'));
});

test('detects multiple space-separated integrity values', () => {
  const r = extractSriHashes('integrity="sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa sha384-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
  assert.equal(r.totals.sha256, 1);
  assert.equal(r.totals.sha384, 1);
});

test('detects standalone hash strings', () => {
  const r = extractSriHashes('Reference hash: sha256-DEADBEEFCAFEBABE1234567890abcdefghijklmnopqrstuv');
  assert.ok(r.entries.some((e) => e.algo === 'sha256'));
});

test('counts script vs link tags with integrity', () => {
  const r = extractSriHashes('<script integrity="sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"></script><link integrity="sha384-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">');
  assert.ok(r.totals.scriptTag >= 1);
  assert.ok(r.totals.linkTag >= 1);
});

test('detects crossorigin attribute', () => {
  const r = extractSriHashes('<script integrity="sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" crossorigin="anonymous"></script>');
  assert.ok(r.entries.some((e) => e.algo === 'crossorigin'));
  assert.ok(r.totals.crossorigin >= 1);
});

test('hashes are masked, not raw', () => {
  const longHash = 'X'.repeat(60);
  const r = extractSriHashes(`integrity="sha256-${longHash}"`);
  const entry = r.entries.find((e) => e.algo === 'sha256');
  assert.ok(entry);
  assert.ok(entry.hash.length < 30);
});

test('dedupes identical hashes', () => {
  const r = extractSriHashes('sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and again sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(r.entries.filter((e) => e.algo === 'sha256').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) {
    text += `integrity="sha256-${'X'.repeat(20)}${i}${'Y'.repeat(10)}" `;
  }
  const r = extractSriHashes(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by algo', () => {
  const r = extractSriHashes('sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa sha384-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb sha512-cccccccccccccccccccccccccccccccc');
  assert.equal(r.totals.sha256, 1);
  assert.equal(r.totals.sha384, 1);
  assert.equal(r.totals.sha512, 1);
});

test('buildSriHashesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.html', extractedText: 'integrity="sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    { name: 'b.html', extractedText: 'integrity="sha384-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' },
  ];
  const r = buildSriHashesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSriHashesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'index.html', extractedText: 'integrity="sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' }];
  const r = buildSriHashesForFiles(files);
  const md = renderSriHashesBlock(r);
  assert.match(md, /^## SRI/);
});

test('renderSriHashesBlock empty when nothing surfaces', () => {
  assert.equal(renderSriHashesBlock({ perFile: [] }), '');
  assert.equal(renderSriHashesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSriHashesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'integrity="sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
  ]);
  assert.equal(r.perFile.length, 1);
});
