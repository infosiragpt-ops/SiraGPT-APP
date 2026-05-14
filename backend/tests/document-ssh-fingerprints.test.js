'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ssh-fingerprints');
const { extractSshFingerprints, buildSshFingerprintsForFiles, renderSshFingerprintsBlock, _internal } = engine;
const { maskFingerprint, maskBlob } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractSshFingerprints('').total, 0);
  assert.equal(extractSshFingerprints(null).total, 0);
});

test('maskFingerprint: first-6 last-4', () => {
  assert.equal(maskFingerprint('abcdef1234567890abcdefgh'), 'abcdef…efgh');
});

test('maskBlob: first-6 last-6 + length', () => {
  const b = 'A'.repeat(80);
  const out = maskBlob(b);
  assert.match(out, /^AAAAAA…AAAAAA \(80 chars\)$/);
});

test('detects SHA256 fingerprint', () => {
  const r = extractSshFingerprints('Fingerprint: SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
  assert.ok(r.entries.some((e) => e.kind === 'sha256'));
});

test('SHA256 fingerprint is masked', () => {
  const r = extractSshFingerprints('SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
  for (const e of r.entries) {
    assert.ok(!/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/.test(e.masked));
  }
});

test('detects MD5 fingerprint (legacy)', () => {
  const r = extractSshFingerprints('Fingerprint: MD5:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f:10');
  assert.ok(r.entries.some((e) => e.kind === 'md5'));
});

test('detects ssh-ed25519 pubkey', () => {
  const r = extractSshFingerprints(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz012345 user@host'
  );
  assert.ok(r.entries.some((e) => e.kind === 'pubkey'));
});

test('detects ssh-rsa with comment', () => {
  const r = extractSshFingerprints(
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDabcdefghijklmnopqrstuvwxyzABCDEFGHIJK admin@example.com'
  );
  assert.ok(r.entries.some((e) => e.kind === 'pubkey'));
});

test('pubkey blob is masked', () => {
  const r = extractSshFingerprints(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz012345 user@host'
  );
  for (const e of r.entries) {
    assert.ok(!/AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz012345/.test(e.masked));
  }
});

test('detects known_hosts entry', () => {
  const r = extractSshFingerprints(
    'github.com,140.82.112.3 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTd0iqz'
  );
  assert.ok(r.entries.some((e) => e.kind === 'knownHost' || e.kind === 'pubkey'));
});

test('dedupes identical entries', () => {
  const r = extractSshFingerprints(
    'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG and again SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
  );
  assert.equal(r.entries.filter((e) => e.kind === 'sha256').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) {
    const b64 = 'a'.repeat(42) + (i % 36).toString(36);
    text += `SHA256:${b64}\n`;
  }
  const r = extractSshFingerprints(text);
  assert.ok(r.entries.length <= 14);
});

test('buildSshFingerprintsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' },
    { name: 'b', extractedText: 'MD5:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f:10' },
  ];
  const r = buildSshFingerprintsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSshFingerprintsBlock NEVER contains full fingerprint', () => {
  const files = [{
    name: 'config',
    extractedText: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  }];
  const r = buildSshFingerprintsForFiles(files);
  const md = renderSshFingerprintsBlock(r);
  assert.ok(!/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/.test(md));
});

test('renderSshFingerprintsBlock empty when nothing surfaces', () => {
  assert.equal(renderSshFingerprintsBlock({ perFile: [] }), '');
  assert.equal(renderSshFingerprintsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSshFingerprintsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' },
  ]);
  assert.equal(r.perFile.length, 1);
});
