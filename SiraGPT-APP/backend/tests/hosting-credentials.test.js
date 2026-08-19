'use strict';

const test = require('node:test');
const assert = require('node:assert');

const creds = require('../src/services/hosting/credentials');

// Identity-ish enc/dec so we never touch the real ENCRYPTION_KEY.
const enc = (s) => `enc:${s}`;
const dec = (s) => s.replace(/^enc:/, '');

test('sealCreds + openCreds round-trips a password', () => {
  const blob = creds.sealCreds({ password: 'secret' }, enc);
  assert.ok(blob.startsWith('enc:'));
  const opened = creds.openCreds(blob, dec);
  assert.equal(opened.password, 'secret');
  assert.equal(opened.privateKey, undefined);
});

test('sealCreds keeps privateKey + passphrase', () => {
  const blob = creds.sealCreds({ privateKey: 'KEY', passphrase: 'pp' }, enc);
  const opened = creds.openCreds(blob, dec);
  assert.equal(opened.privateKey, 'KEY');
  assert.equal(opened.passphrase, 'pp');
});

test('openCreds returns null on garbage', () => {
  assert.equal(creds.openCreds('not-json', dec), null);
  assert.equal(creds.openCreds('', dec), null);
});

test('sealJson + openJson round-trip generic env objects', () => {
  const blob = creds.sealJson({ VITE_API: 'abc', NODE_ENV: 'production' }, enc)
  const opened = creds.openJson(blob, dec)
  assert.equal(opened.VITE_API, 'abc')
  assert.equal(opened.NODE_ENV, 'production')
  assert.deepEqual(creds.openJson('', dec), {})
  assert.deepEqual(creds.openJson('garbage', dec), {})
})

test('credsSummary never leaks the secret', () => {
  const blob = creds.sealCreds({ password: 'secret' }, enc);
  const s = creds.credsSummary(blob, dec);
  assert.equal(s.hasCreds, true);
  assert.equal(s.kind, 'password');
  assert.ok(!('password' in s));

  const keyBlob = creds.sealCreds({ privateKey: 'KEY' }, enc);
  assert.equal(creds.credsSummary(keyBlob, dec).kind, 'key');
  assert.equal(creds.credsSummary('', dec).hasCreds, false);
});
