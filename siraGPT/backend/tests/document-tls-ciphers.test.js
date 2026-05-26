'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tls-ciphers');
const { extractTlsCiphers, buildTlsCiphersForFiles, renderTlsCiphersBlock, _internal } = engine;
const { classifyCipher } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTlsCiphers('').total, 0);
  assert.equal(extractTlsCiphers(null).total, 0);
});

test('classifyCipher: TLS 1.3', () => {
  assert.equal(classifyCipher('TLS_AES_256_GCM_SHA384'), 'tls13');
  assert.equal(classifyCipher('TLS_CHACHA20_POLY1305_SHA256'), 'tls13');
});

test('classifyCipher: modern ECDHE', () => {
  assert.equal(classifyCipher('ECDHE-RSA-AES256-GCM-SHA384'), 'modern');
});

test('detects TLS_AES_256_GCM_SHA384', () => {
  const r = extractTlsCiphers('Use TLS_AES_256_GCM_SHA384 only.');
  assert.ok(r.entries.some((e) => /TLS_AES_256/.test(e.cipher)));
});

test('detects TLS_CHACHA20_POLY1305_SHA256', () => {
  const r = extractTlsCiphers('Use TLS_CHACHA20_POLY1305_SHA256');
  assert.ok(r.entries.some((e) => /CHACHA20/.test(e.cipher) && e.kind === 'tls13'));
});

test('detects OpenSSL-style ECDHE-RSA-AES256-GCM-SHA384', () => {
  const r = extractTlsCiphers('Allow ECDHE-RSA-AES256-GCM-SHA384');
  assert.ok(r.entries.some((e) => e.source === 'openssl'));
});

test('detects RC4 weak cipher', () => {
  const r = extractTlsCiphers('Disable RC4 immediately');
  assert.ok(r.entries.some((e) => e.kind === 'weak'));
});

test('detects 3DES weak', () => {
  const r = extractTlsCiphers('Remove 3DES from config');
  assert.ok(r.entries.some((e) => e.kind === 'weak'));
});

test('detects EXPORT weak', () => {
  const r = extractTlsCiphers('Reject EXPORT ciphers');
  assert.ok(r.entries.some((e) => e.kind === 'weak'));
});

test('dedupes identical entries', () => {
  const r = extractTlsCiphers('TLS_AES_256_GCM_SHA384 and TLS_AES_256_GCM_SHA384 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += 'TLS_AES_256_GCM_SHA384 RC4 3DES EXPORT NULL-SHA ';
  const r = extractTlsCiphers(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractTlsCiphers('TLS_AES_256_GCM_SHA384 and ECDHE-RSA-AES256-GCM-SHA384 and RC4');
  assert.ok(r.totals.tls13 >= 1);
  assert.ok(r.totals.modern >= 1);
  assert.ok(r.totals.weak >= 1);
});

test('buildTlsCiphersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'TLS_AES_256_GCM_SHA384' },
    { name: 'b', extractedText: 'RC4' },
  ];
  const r = buildTlsCiphersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTlsCiphersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'nginx.conf', extractedText: 'TLS_AES_256_GCM_SHA384' }];
  const r = buildTlsCiphersForFiles(files);
  const md = renderTlsCiphersBlock(r);
  assert.match(md, /^## TLS/);
});

test('renderTlsCiphersBlock empty when nothing surfaces', () => {
  assert.equal(renderTlsCiphersBlock({ perFile: [] }), '');
  assert.equal(renderTlsCiphersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTlsCiphersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'TLS_AES_256_GCM_SHA384' },
  ]);
  assert.equal(r.perFile.length, 1);
});
