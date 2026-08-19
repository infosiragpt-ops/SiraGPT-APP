'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-hashes');
const { extractHashes, buildHashesForFiles, renderHashesBlock, _internal } = engine;
const { classifyHash } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractHashes('').total, 0);
  assert.equal(extractHashes(null).total, 0);
});

test('classifyHash by length', () => {
  assert.equal(classifyHash('a'.repeat(32)), 'MD5');
  assert.equal(classifyHash('a'.repeat(40)), 'SHA-1');
  assert.equal(classifyHash('a'.repeat(64)), 'SHA-256');
  assert.equal(classifyHash('a'.repeat(128)), 'SHA-512');
});

test('detects MD5 (32 hex)', () => {
  const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
  const r = extractHashes(`MD5: ${md5}`);
  assert.ok(r.hashes.some((h) => h.kind === 'MD5'));
});

test('detects SHA-1 (40 hex)', () => {
  const sha1 = 'a'.repeat(40);
  const r = extractHashes(`SHA1: ${sha1}`);
  assert.ok(r.hashes.some((h) => h.kind === 'SHA-1'));
});

test('detects SHA-256 (64 hex)', () => {
  const sha256 = 'b'.repeat(64);
  const r = extractHashes(`SHA-256: ${sha256}`);
  assert.ok(r.hashes.some((h) => h.kind === 'SHA-256'));
});

test('detects SHA-512 (128 hex)', () => {
  const sha512 = 'c'.repeat(128);
  const r = extractHashes(`SHA-512: ${sha512}`);
  assert.ok(r.hashes.some((h) => h.kind === 'SHA-512'));
});

test('detects bare hex with no label', () => {
  const sha256 = 'b'.repeat(64);
  const r = extractHashes(`Verify: ${sha256}`);
  assert.ok(r.hashes.some((h) => h.kind === 'SHA-256'));
});

test('dedupes identical hashes', () => {
  const sha256 = 'd'.repeat(64);
  const r = extractHashes(`${sha256} and ${sha256}`);
  assert.equal(r.hashes.length, 1);
});

test('normalises hex to lowercase', () => {
  const upper = 'A'.repeat(64);
  const r = extractHashes(`SHA-256: ${upper}`);
  assert.ok(r.hashes[0].hex === 'a'.repeat(64));
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 12; i++) text += `MD5: ${(i.toString(16) + 'a').padStart(32, '0')} `;
  const r = extractHashes(text);
  assert.ok((r.byKind.MD5 || 0) <= 8);
});

test('buildHashesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'MD5: ' + 'a'.repeat(32) },
    { name: 'b.md', extractedText: 'SHA-256: ' + 'b'.repeat(64) },
  ];
  const r = buildHashesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHashesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'SHA-256: ' + 'c'.repeat(64) }];
  const r = buildHashesForFiles(files);
  const md = renderHashesBlock(r);
  assert.match(md, /^## CRYPTOGRAPHIC HASHES/);
});

test('renderHashesBlock abbreviates long hex', () => {
  const files = [{ name: 'doc.md', extractedText: 'SHA-256: ' + 'e'.repeat(64) }];
  const r = buildHashesForFiles(files);
  const md = renderHashesBlock(r);
  assert.match(md, /…/);
});

test('renderHashesBlock empty when nothing surfaces', () => {
  assert.equal(renderHashesBlock({ perFile: [] }), '');
  assert.equal(renderHashesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHashesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'MD5: ' + 'a'.repeat(32) },
  ]);
  assert.equal(r.perFile.length, 1);
});
