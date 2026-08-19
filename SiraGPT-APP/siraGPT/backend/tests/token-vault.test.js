'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TokenVault } = require('../src/services/TokenVault');

const silentLogger = { warn: () => {}, log: () => {}, error: () => {} };
const identityEncrypt = (s) => `ENC(${s})`;
const identityDecrypt = (s) => s.replace(/^ENC\(/, '').replace(/\)$/, '');

test('TokenVault: constructor validates deps', () => {
  assert.throws(() => new TokenVault({ decrypt: identityDecrypt }), /encrypt is required/);
  assert.throws(() => new TokenVault({ encrypt: identityEncrypt }), /decrypt is required/);
});

test('TokenVault.sealProviderTokens: serialises envelope and encrypts', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  const sealed = vault.sealProviderTokens({
    accessToken: 'at',
    refreshToken: 'rt',
    scope: 'a b',
    expiresAt: 1234,
  });
  assert.ok(sealed.startsWith('ENC('));
  const parsed = JSON.parse(sealed.slice(4, -1));
  assert.equal(parsed.accessToken, 'at');
  assert.equal(parsed.refreshToken, 'rt');
  assert.equal(parsed.scope, 'a b');
  assert.equal(parsed.expiresAt, 1234);
  assert.equal(parsed.tokenType, 'Bearer');
});

test('TokenVault.sealProviderTokens: defaults expiresAt to ~1h ahead', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  const before = Date.now();
  const sealed = vault.sealProviderTokens({ accessToken: 'at', refreshToken: null, scope: 'x' });
  const after = Date.now();
  const parsed = JSON.parse(sealed.slice(4, -1));
  assert.ok(parsed.expiresAt >= before + 3500 * 1000);
  assert.ok(parsed.expiresAt <= after + 3700 * 1000);
});

test('TokenVault.openProviderTokens: round-trips a sealed blob', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  const sealed = vault.sealProviderTokens({ accessToken: 'at', refreshToken: 'rt', scope: 's' });
  const opened = vault.openProviderTokens(sealed);
  assert.equal(opened.accessToken, 'at');
  assert.equal(opened.refreshToken, 'rt');
});

test('TokenVault.openProviderTokens: null on missing input', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  assert.equal(vault.openProviderTokens(null), null);
  assert.equal(vault.openProviderTokens(''), null);
});

test('TokenVault.openProviderTokens: null on decrypt failure (does not throw)', () => {
  const vault = new TokenVault({
    encrypt: identityEncrypt,
    decrypt: () => { throw new Error('bad key'); },
    logger: silentLogger,
  });
  assert.equal(vault.openProviderTokens('garbage'), null);
});

test('TokenVault.openProviderTokens: null on parse failure', () => {
  const vault = new TokenVault({
    encrypt: identityEncrypt,
    decrypt: () => 'not json',
    logger: silentLogger,
  });
  assert.equal(vault.openProviderTokens('garbage'), null);
});

test('TokenVault.extractRefreshToken: returns just the refresh token', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  const sealed = vault.sealProviderTokens({ accessToken: 'at', refreshToken: 'rt', scope: 's' });
  assert.equal(vault.extractRefreshToken(sealed), 'rt');
});

test('TokenVault.extractRefreshToken: null when blob has no refresh', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  const sealed = vault.sealProviderTokens({ accessToken: 'at', refreshToken: null, scope: 's' });
  assert.equal(vault.extractRefreshToken(sealed), null);
});

test('TokenVault.inspectProviderTokens: empty on null/empty input', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  assert.deepEqual(vault.inspectProviderTokens(null), { status: 'empty', value: null });
  assert.deepEqual(vault.inspectProviderTokens(''), { status: 'empty', value: null });
});

test('TokenVault.inspectProviderTokens: corrupt on decrypt failure', () => {
  const vault = new TokenVault({
    encrypt: identityEncrypt,
    decrypt: () => { throw new Error('bad key'); },
    logger: silentLogger,
  });
  const out = vault.inspectProviderTokens('garbage');
  assert.equal(out.status, 'corrupt');
  assert.equal(out.value, null);
});

test('TokenVault.inspectProviderTokens: corrupt on JSON parse failure', () => {
  const vault = new TokenVault({
    encrypt: identityEncrypt,
    decrypt: () => 'not json',
    logger: silentLogger,
  });
  assert.equal(vault.inspectProviderTokens('garbage').status, 'corrupt');
});

test('TokenVault.inspectProviderTokens: ok with parsed value even if refreshToken is null', () => {
  const vault = new TokenVault({ encrypt: identityEncrypt, decrypt: identityDecrypt });
  const sealed = vault.sealProviderTokens({ accessToken: 'at', refreshToken: null, scope: 's' });
  const out = vault.inspectProviderTokens(sealed);
  assert.equal(out.status, 'ok');
  assert.equal(out.value.accessToken, 'at');
  assert.equal(out.value.refreshToken, null);
});
