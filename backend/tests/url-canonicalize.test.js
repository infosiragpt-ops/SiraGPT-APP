'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  canonicalizeUrl,
  areEquivalent,
  stripTrackingParams,
  DEFAULT_TRACKING,
} = require('../src/utils/url-canonicalize');

describe('canonicalizeUrl — basic', () => {
  test('lowercases scheme + host', () => {
    const r = canonicalizeUrl('HTTPS://EXAMPLE.com/Path');
    assert.match(r, /^https:\/\/example\.com/);
  });

  test('strips default port (https:443)', () => {
    assert.equal(canonicalizeUrl('https://x.com:443/y'), 'https://x.com/y');
  });

  test('keeps non-default port', () => {
    assert.equal(canonicalizeUrl('https://x.com:8443/y'), 'https://x.com:8443/y');
  });

  test('drops fragment', () => {
    assert.equal(canonicalizeUrl('https://x.com/y#section'), 'https://x.com/y');
  });

  test('collapses duplicate slashes in path', () => {
    assert.equal(canonicalizeUrl('https://x.com/a//b///c'), 'https://x.com/a/b/c');
  });

  test('strips trailing slash on non-root path', () => {
    assert.equal(canonicalizeUrl('https://x.com/a/'), 'https://x.com/a');
  });

  test('preserves root slash', () => {
    assert.equal(canonicalizeUrl('https://x.com/'), 'https://x.com/');
  });
});

describe('canonicalizeUrl — query handling', () => {
  test('sorts query parameters alphabetically', () => {
    const r = canonicalizeUrl('https://x.com/a?b=2&a=1');
    assert.equal(r, 'https://x.com/a?a=1&b=2');
  });

  test('strips utm_ + gclid + fbclid by default', () => {
    const r = canonicalizeUrl('https://x.com/a?utm_source=x&id=42&gclid=abc');
    assert.equal(r, 'https://x.com/a?id=42');
  });

  test('keeps non-tracking params verbatim', () => {
    const r = canonicalizeUrl('https://x.com/a?keep=this');
    assert.equal(r, 'https://x.com/a?keep=this');
  });
});

describe('canonicalizeUrl — opts toggles', () => {
  test('non-default port preserved regardless of stripDefaultPort', () => {
    // The URL parser normalizes default ports to '' before our code
    // sees them, so opt-out is only meaningful for non-default ports.
    const a = canonicalizeUrl('https://x.com:8443/y');
    const b = canonicalizeUrl('https://x.com:8443/y', { stripDefaultPort: false });
    assert.match(a, /:8443/);
    assert.match(b, /:8443/);
  });

  test('opt out of dropping fragment', () => {
    const r = canonicalizeUrl('https://x.com/y#frag', { dropFragment: false });
    assert.match(r, /#frag$/);
  });

  test('opt out of trailing-slash strip', () => {
    const r = canonicalizeUrl('https://x.com/y/', { stripTrailingSlash: false });
    assert.match(r, /\/y\/$/);
  });

  test('custom tracking param list', () => {
    const r = canonicalizeUrl('https://x.com/a?my_tracker=x&keep=y', { trackingParams: ['my_tracker'] });
    assert.equal(r, 'https://x.com/a?keep=y');
  });
});

describe('areEquivalent', () => {
  test('different surface, same canonical form → true', () => {
    assert.equal(areEquivalent('HTTPS://X.COM:443/a/?b=1&utm_source=z', 'https://x.com/a?b=1'), true);
  });
  test('genuinely different URLs → false', () => {
    assert.equal(areEquivalent('https://a.com/x', 'https://b.com/x'), false);
  });
  test('bad URL → false (no throw)', () => {
    assert.equal(areEquivalent('not a url', 'https://x.com'), false);
  });
});

describe('stripTrackingParams', () => {
  test('default list removes utm + gclid + fbclid', () => {
    const r = stripTrackingParams('https://x.com/a?utm_source=z&id=1&gclid=abc');
    const u = new URL(r);
    assert.equal(u.searchParams.get('id'), '1');
    assert.equal(u.searchParams.get('utm_source'), null);
    assert.equal(u.searchParams.get('gclid'), null);
  });
  test('default tracking set covers utm_*', () => {
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'gclid', 'fbclid']) {
      assert.equal(DEFAULT_TRACKING.has(k), true);
    }
  });
});
