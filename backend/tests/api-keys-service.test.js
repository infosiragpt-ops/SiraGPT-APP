'use strict';

/**
 * Unit tests for api-keys-service (ratchet 45).
 * Pure helpers; no DB, no Express.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const svc = require('../src/services/api-keys-service');

describe('api-keys-service · generateToken', () => {
  test('emits sk_-prefixed token with correct shape', () => {
    const minted = svc.generateToken();
    assert.ok(minted.token.startsWith('sk_'));
    assert.equal(minted.prefix.length, svc.PREFIX_LEN);
    assert.equal(minted.secret.length, svc.SECRET_LEN);
    // body = prefix + secret
    assert.equal(minted.token, `sk_${minted.prefix}${minted.secret}`);
  });

  test('tokenHash matches sha256(prefix+secret)', () => {
    const minted = svc.generateToken();
    const expected = crypto
      .createHash('sha256')
      .update(`${minted.prefix}${minted.secret}`)
      .digest('hex');
    assert.equal(minted.tokenHash, expected);
  });

  test('successive mints produce distinct tokens', () => {
    const a = svc.generateToken();
    const b = svc.generateToken();
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.prefix, b.prefix);
    assert.notEqual(a.tokenHash, b.tokenHash);
  });

  test('alphabet is restricted to url-safe base62', () => {
    for (let i = 0; i < 5; i++) {
      const { prefix, secret } = svc.generateToken();
      assert.match(prefix, /^[A-Za-z0-9]+$/);
      assert.match(secret, /^[A-Za-z0-9]+$/);
    }
  });
});

describe('api-keys-service · parseToken', () => {
  test('parses a valid sk_ token', () => {
    const minted = svc.generateToken();
    const parsed = svc.parseToken(minted.token);
    assert.ok(parsed);
    assert.equal(parsed.prefix, minted.prefix);
    assert.equal(parsed.body, `${minted.prefix}${minted.secret}`);
  });

  test('returns null for non-sk_ tokens (JWT-style fall-through)', () => {
    assert.equal(svc.parseToken('eyJhbGciOiJIUzI1NiJ9.foo.bar'), null);
    assert.equal(svc.parseToken('bearer-something'), null);
    assert.equal(svc.parseToken(''), null);
    assert.equal(svc.parseToken(null), null);
    assert.equal(svc.parseToken(undefined), null);
  });

  test('returns null for sk_ tokens with dots or whitespace (JWT-shaped)', () => {
    assert.equal(svc.parseToken('sk_abc.def.ghi'), null);
    assert.equal(svc.parseToken('sk_ab cdEf'), null);
  });

  test('returns null when body is too short for prefix + 1', () => {
    assert.equal(svc.parseToken('sk_short'), null);
  });
});

describe('api-keys-service · hashToken', () => {
  test('deterministic sha256 hex', () => {
    assert.equal(svc.hashToken('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  });

  test('throws on empty input', () => {
    assert.throws(() => svc.hashToken(''));
    assert.throws(() => svc.hashToken(null));
  });
});

describe('api-keys-service · isExpired', () => {
  test('returns false when expiresAt is null/undefined', () => {
    assert.equal(svc.isExpired({}), false);
    assert.equal(svc.isExpired({ expiresAt: null }), false);
  });

  test('returns true for past dates', () => {
    assert.equal(svc.isExpired({ expiresAt: new Date(Date.now() - 1000) }), true);
  });

  test('returns false for future dates', () => {
    assert.equal(svc.isExpired({ expiresAt: new Date(Date.now() + 60_000) }), false);
  });

  test('accepts ISO strings', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    assert.equal(svc.isExpired({ expiresAt: past }), true);
  });
});

describe('api-keys-service · redactKey', () => {
  test('omits tokenHash, exposes prefix + redacted hint', () => {
    const row = {
      id: 'k1',
      name: 'CI',
      prefix: 'AbCdEfGh',
      tokenHash: 'never-leak',
      organizationId: 'org-1',
      userId: 'u-1',
      scopes: ['read'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-05-19T00:00:00Z'),
    };
    const out = svc.redactKey(row);
    assert.equal(out.id, 'k1');
    assert.equal(out.prefix, 'AbCdEfGh');
    assert.ok(out.redacted.startsWith('sk_AbCdEfGh'));
    assert.equal(out.tokenHash, undefined);
    assert.deepEqual(out.scopes, ['read']);
    assert.equal(out.createdAt, '2026-05-19T00:00:00.000Z');
  });

  test('returns null for nullish input', () => {
    assert.equal(svc.redactKey(null), null);
    assert.equal(svc.redactKey(undefined), null);
  });
});

describe('api-keys-service · presentNewKey', () => {
  test('includes the full token plus a warning, only once', () => {
    const minted = svc.generateToken();
    const row = {
      id: 'k1', name: 'CI', prefix: minted.prefix, scopes: [],
      organizationId: 'org-1', userId: 'u-1', tokenHash: minted.tokenHash,
      createdAt: new Date(),
    };
    const out = svc.presentNewKey(row, minted.token);
    assert.equal(out.token, minted.token);
    assert.match(out.warning, /Store this token/i);
    assert.equal(out.tokenHash, undefined);
  });
});
