'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-web-crypto');
const { extractWebCrypto, buildWebCryptoForFiles, renderWebCryptoBlock, _internal } = engine;
const { isWebCryptoLike } = _internal;

const CRYPTO_FIXTURE = `import { webcrypto } from 'node:crypto';

async function generateAesKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
}

async function decryptData(key, iv, ciphertext) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

async function signData(privateKey, data) {
  return crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    data
  );
}

async function verifySig(publicKey, signature, data) {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    data
  );
}

async function digestSha256(message) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
}

async function generateEcdsaKey() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
}

async function deriveKeyFromPassword(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

const id = crypto.randomUUID();
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractWebCrypto('').total, 0);
  assert.equal(extractWebCrypto(null).total, 0);
});

test('non-crypto text returns empty', () => {
  const r = extractWebCrypto('Just regular text without crypto');
  assert.equal(r.total, 0);
});

test('isWebCryptoLike heuristic', () => {
  assert.ok(isWebCryptoLike('crypto.subtle.encrypt(...)'));
  assert.ok(isWebCryptoLike('AES-GCM'));
  assert.ok(!isWebCryptoLike('plain text'));
});

test('detects subtle ops (encrypt/decrypt/sign/verify/digest)', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.encrypt'));
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.decrypt'));
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.sign'));
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.verify'));
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.digest'));
});

test('detects generateKey / importKey / deriveKey', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.generateKey'));
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.importKey'));
  assert.ok(r.entries.some((e) => e.kind === 'op' && e.name === 'crypto.subtle.deriveKey'));
});

test('detects algorithm names (AES-GCM / ECDSA / PBKDF2)', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'algo' && e.name === 'AES-GCM'));
  assert.ok(r.entries.some((e) => e.kind === 'algo' && e.name === 'ECDSA'));
  assert.ok(r.entries.some((e) => e.kind === 'algo' && e.name === 'PBKDF2'));
});

test('detects hash (SHA-256)', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'hash' && e.name === 'SHA-256'));
});

test('detects curve (P-256)', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'curve' && e.name === 'P-256'));
});

test('detects key format (raw)', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'format' && e.name === 'raw'));
});

test('detects key usages', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'usage' && e.name === 'encrypt'));
  assert.ok(r.entries.some((e) => e.kind === 'usage' && e.name === 'decrypt'));
  assert.ok(r.entries.some((e) => e.kind === 'usage' && e.name === 'sign'));
});

test('detects random / randomUUID usage', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'random'));
});

test('detects node:crypto imports', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'nodeCrypto'));
});

test('detects RSA-OAEP / RSA-PSS / HKDF', () => {
  const r = extractWebCrypto(`crypto.subtle.encrypt({ name: 'RSA-OAEP' }); crypto.subtle.sign({ name: 'RSA-PSS' });
crypto.subtle.deriveKey({ name: 'HKDF' });`);
  assert.ok(r.entries.some((e) => e.kind === 'algo' && e.name === 'RSA-OAEP'));
  assert.ok(r.entries.some((e) => e.kind === 'algo' && e.name === 'RSA-PSS'));
  assert.ok(r.entries.some((e) => e.kind === 'algo' && e.name === 'HKDF'));
});

test('dedupes identical operations', () => {
  const r = extractWebCrypto('crypto.subtle.encrypt({}); crypto.subtle.encrypt({});');
  assert.equal(r.entries.filter((e) => e.kind === 'op' && /encrypt$/.test(e.name)).length, 1);
});

test('caps entries per file', () => {
  let text = 'crypto.subtle.encrypt(); ';
  for (let i = 0; i < 30; i++) text += `crypto.subtle.deriveKey({ name: 'AES-GCM' }, k${i}); `;
  const r = extractWebCrypto(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractWebCrypto(CRYPTO_FIXTURE);
  assert.ok(r.totals.op >= 5);
  assert.ok(r.totals.algo >= 2);
});

test('buildWebCryptoForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'crypto.subtle.encrypt({ name: "AES-GCM" })' },
    { name: 'b.ts', extractedText: 'crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" })' },
  ];
  const r = buildWebCryptoForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWebCryptoBlock returns markdown when entries exist', () => {
  const files = [{ name: 'crypto.ts', extractedText: CRYPTO_FIXTURE }];
  const r = buildWebCryptoForFiles(files);
  const md = renderWebCryptoBlock(r);
  assert.match(md, /^## WEB CRYPTO/);
});

test('renderWebCryptoBlock empty when nothing surfaces', () => {
  assert.equal(renderWebCryptoBlock({ perFile: [] }), '');
  assert.equal(renderWebCryptoBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWebCryptoForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: CRYPTO_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
