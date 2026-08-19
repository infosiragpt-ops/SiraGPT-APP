'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createJwtSigner } = require('../src/services/auth/jwt-hs256');
const b64u = require('../src/utils/base64url');

describe('createJwtSigner — construction', () => {
  test('rejects empty secret', () => {
    assert.throws(() => createJwtSigner({}), TypeError);
  });
});

describe('sign + verify — round-trip', () => {
  test('payload survives token', () => {
    const j = createJwtSigner({ secret: 'shh' });
    const t = j.sign({ uid: 1, role: 'admin' });
    const r = j.verify(t);
    assert.equal(r.ok, true);
    assert.equal(r.payload.uid, 1);
    assert.equal(r.payload.role, 'admin');
    assert.ok(r.payload.iat);
    assert.ok(r.payload.exp > r.payload.iat);
  });

  test('issuer and audience injected and verified', () => {
    const j = createJwtSigner({ secret: 'shh', issuer: 'siragpt', audience: 'web' });
    const t = j.sign({ uid: 1 });
    assert.equal(j.verify(t).ok, true);
    assert.equal(j.verify(t).payload.iss, 'siragpt');
    assert.equal(j.verify(t).payload.aud, 'web');
  });

  test('audience override on sign', () => {
    const j = createJwtSigner({ secret: 'shh', audience: 'web' });
    const t = j.sign({ uid: 1 }, { audience: 'mobile' });
    assert.equal(j.verify(t, { audience: 'mobile' }).ok, true);
    assert.equal(j.verify(t, { audience: 'web' }).reason, 'wrong_audience');
  });
});

describe('verify — failure modes', () => {
  test('non-string / wrong dot count → malformed', () => {
    const j = createJwtSigner({ secret: 'shh' });
    assert.equal(j.verify('').reason, 'malformed');
    assert.equal(j.verify(null).reason, 'malformed');
    assert.equal(j.verify('a.b').reason, 'malformed');
    assert.equal(j.verify('a.b.c.d').reason, 'malformed');
  });

  test('malformed header JSON → malformed', () => {
    const j = createJwtSigner({ secret: 'shh' });
    const bad = `${b64u.encode('not json')}.${b64u.encode('{}')}.x`;
    assert.equal(j.verify(bad).reason, 'malformed');
  });

  test('alg=none rejected (always)', () => {
    const j = createJwtSigner({ secret: 'shh' });
    const noneToken = `${b64u.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64u.encode(JSON.stringify({ uid: 1 }))}.`;
    const r = j.verify(noneToken);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_alg');
  });

  test('different secret → signature_mismatch', () => {
    const a = createJwtSigner({ secret: 'A' });
    const b = createJwtSigner({ secret: 'B' });
    const t = a.sign({ uid: 1 });
    assert.equal(b.verify(t).reason, 'signature_mismatch');
  });

  test('expired token → expired', () => {
    const j = createJwtSigner({ secret: 'shh', leewaySec: 0 });
    const t = j.sign({}, { ttlSec: 1 });
    const future = Math.floor(Date.now() / 1000) + 100;
    assert.equal(j.verify(t, { now: future }).reason, 'expired');
  });

  test('leeway tolerates small clock skew on exp', () => {
    const j = createJwtSigner({ secret: 'shh', leewaySec: 60 });
    const t = j.sign({}, { ttlSec: 1 });
    const future = Math.floor(Date.now() / 1000) + 30;
    assert.equal(j.verify(t, { now: future }).ok, true);
  });

  test('not_before rejected', () => {
    const j = createJwtSigner({ secret: 'shh', leewaySec: 0 });
    const t = j.sign({ nbf: Math.floor(Date.now() / 1000) + 1000 });
    assert.equal(j.verify(t).reason, 'not_before');
  });

  test('wrong issuer surfaces typed reason', () => {
    const a = createJwtSigner({ secret: 'shh', issuer: 'A' });
    const b = createJwtSigner({ secret: 'shh', issuer: 'B' });
    const t = a.sign({});
    assert.equal(b.verify(t).reason, 'wrong_issuer');
  });
});

describe('newJti', () => {
  test('returns a 24-char hex string', () => {
    const j = createJwtSigner({ secret: 'shh' });
    const id = j.newJti();
    assert.match(id, /^[0-9a-f]{24}$/);
  });
});
