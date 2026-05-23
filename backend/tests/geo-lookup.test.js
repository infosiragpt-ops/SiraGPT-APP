'use strict';

/**
 * geo-lookup — Task 19 unit tests.
 *
 * The util is plain functions (no Express router, no Prisma) so we just
 * inject a fake `fetchImpl` instead of spinning up a stub HTTP server.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveGeoHint,
  formatGeoHint,
  isPrivateOrReserved,
  isSecureLookupUrl,
} = require('../src/utils/geo-lookup');

describe('isPrivateOrReserved', () => {
  it('classifies common private / loopback IPs as private', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.10', '172.16.5.4', '169.254.1.1', '::1', 'fd00::1']) {
      assert.equal(isPrivateOrReserved(ip), true, `expected ${ip} to be private`);
    }
  });
  it('classifies public IPs as not private', () => {
    for (const ip of ['8.8.8.8', '81.45.30.20', '1.1.1.1']) {
      assert.equal(isPrivateOrReserved(ip), false, `expected ${ip} to be public`);
    }
  });
  it('treats unknown / garbage strings as non-resolvable (private)', () => {
    assert.equal(isPrivateOrReserved(''), true);
    assert.equal(isPrivateOrReserved(null), true);
    assert.equal(isPrivateOrReserved('not-an-ip'), true);
  });
});

describe('isSecureLookupUrl', () => {
  it('accepts https and loopback http; rejects everything else', () => {
    assert.equal(isSecureLookupUrl('https://ipwho.is/{ip}'), true);
    assert.equal(isSecureLookupUrl('http://127.0.0.1:9000/{ip}'), true);
    assert.equal(isSecureLookupUrl('http://localhost/{ip}'), true);
    assert.equal(isSecureLookupUrl('http://ip-api.com/json/{ip}'), false);
    assert.equal(isSecureLookupUrl(''), false);
    assert.equal(isSecureLookupUrl(null), false);
  });
});

describe('formatGeoHint', () => {
  it('combines city + countryCode when both present', () => {
    assert.equal(
      formatGeoHint({ status: 'success', city: 'Madrid', countryCode: 'ES' }),
      'Madrid, ES',
    );
  });
  it('falls back to country name when no code', () => {
    assert.equal(formatGeoHint({ country: 'Spain' }), 'Spain');
  });
  it('returns null when status is non-success or payload is empty', () => {
    assert.equal(formatGeoHint({ status: 'fail' }), null);
    assert.equal(formatGeoHint({}), null);
    assert.equal(formatGeoHint(null), null);
  });
});

describe('resolveGeoHint', () => {
  it('short-circuits private IPs without calling fetch', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    const out = await resolveGeoHint('192.168.1.50', { fetchImpl });
    assert.equal(out, null);
    assert.equal(called, false);
  });

  it('returns a "City, CC" label for a successful lookup', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ status: 'success', city: 'Madrid', countryCode: 'ES' }),
    });
    const out = await resolveGeoHint('81.45.30.20', { fetchImpl });
    assert.equal(out, 'Madrid, ES');
  });

  it('refuses to leak the IP over plain HTTP (non-loopback)', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    const out = await resolveGeoHint('81.45.30.20', {
      fetchImpl,
      lookupUrl: 'http://ip-api.com/json/{ip}',
    });
    assert.equal(out, null);
    assert.equal(called, false, 'must not hit an insecure upstream');
  });

  it('accepts plain HTTP only for loopback stubs', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { ok: true, json: async () => ({ city: 'Madrid', countryCode: 'ES' }) };
    };
    const out = await resolveGeoHint('81.45.30.20', {
      fetchImpl,
      lookupUrl: 'http://127.0.0.1:9000/lookup/{ip}',
    });
    assert.equal(called, true);
    assert.equal(out, 'Madrid, ES');
  });

  it('returns null on non-200 responses', async () => {
    const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
    const out = await resolveGeoHint('81.45.30.20', { fetchImpl });
    assert.equal(out, null);
  });

  it('returns null when fetch throws (timeout/network)', async () => {
    const fetchImpl = async () => { throw new Error('boom'); };
    const out = await resolveGeoHint('81.45.30.20', { fetchImpl });
    assert.equal(out, null);
  });
});
