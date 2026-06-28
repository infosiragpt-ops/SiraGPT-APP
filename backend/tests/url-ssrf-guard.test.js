'use strict';

// Unit tests for the outbound SSRF guard used by payments invoice downloads
// (and future server-side URL fetches). Pure + offline: the DNS layer is
// exercised via an injected `lookup` so no network/real resolution happens.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SsrfBlockedError,
  parseSafeOutboundUrl,
  isSafeOutboundUrl,
  assertOutboundUrlSafe,
} = require('../src/utils/url-ssrf-guard');

function expectBlocked(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SsrfBlockedError, `expected SsrfBlockedError, got ${err && err.name}`);
    if (code) assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return err;
  }
  assert.fail('expected parseSafeOutboundUrl to throw');
}

describe('[UNIT] url-ssrf-guard parseSafeOutboundUrl', () => {
  test('accepts a valid https Stripe URL under a stripe.com allowlist', () => {
    const url = parseSafeOutboundUrl('https://files.stripe.com/invoice/abc.pdf', { allowHosts: ['stripe.com'] });
    assert.equal(url.hostname, 'files.stripe.com');
  });

  test('rejects http when https-only (default)', () => {
    const err = expectBlocked(() => parseSafeOutboundUrl('http://files.stripe.com/x.pdf'), 'bad_scheme');
    assert.equal(err.statusCode, 400);
  });

  test('accepts http when allowHttp is set', () => {
    const url = parseSafeOutboundUrl('http://example.com/x', { allowHttp: true });
    assert.equal(url.protocol, 'http:');
  });

  test('rejects non-http(s) schemes (file://, gopher://)', () => {
    expectBlocked(() => parseSafeOutboundUrl('file:///etc/passwd'), 'bad_scheme');
    expectBlocked(() => parseSafeOutboundUrl('gopher://x/1', { allowHttp: true }), 'bad_scheme');
  });

  test('rejects embedded credentials', () => {
    expectBlocked(() => parseSafeOutboundUrl('https://user:pass@stripe.com/x'), 'credentials_rejected');
  });

  test('rejects an unparseable URL', () => {
    expectBlocked(() => parseSafeOutboundUrl('not a url'), 'invalid_url');
  });

  test('rejects localhost and *.internal / *.local / *.localhost', () => {
    expectBlocked(() => parseSafeOutboundUrl('https://localhost/x'), 'blocked_host');
    expectBlocked(() => parseSafeOutboundUrl('https://db.internal/x'), 'blocked_host');
    expectBlocked(() => parseSafeOutboundUrl('https://printer.local/x'), 'blocked_host');
    expectBlocked(() => parseSafeOutboundUrl('https://api.localhost/x'), 'blocked_host');
  });

  test('rejects cloud-metadata hostnames', () => {
    expectBlocked(() => parseSafeOutboundUrl('https://metadata.google.internal/x'), 'blocked_host');
  });

  test('rejects private / reserved IPv4 literals', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0']) {
      expectBlocked(() => parseSafeOutboundUrl(`https://${ip}/x`), 'blocked_ip');
    }
  });

  test('rejects loopback + IPv4-mapped IPv6 literals', () => {
    expectBlocked(() => parseSafeOutboundUrl('https://[::1]/x'), 'blocked_ip');
    expectBlocked(() => parseSafeOutboundUrl('https://[::ffff:127.0.0.1]/x'), 'blocked_ip');
  });

  test('allows a public IP literal (no allowlist)', () => {
    const url = parseSafeOutboundUrl('https://93.184.216.34/x');
    assert.equal(url.hostname, '93.184.216.34');
  });

  test('allowlist is exact-suffix: subdomain matches, look-alikes do not', () => {
    assert.ok(parseSafeOutboundUrl('https://invoice.stripe.com/x', { allowHosts: ['stripe.com'] }));
    expectBlocked(() => parseSafeOutboundUrl('https://notstripe.com/x', { allowHosts: ['stripe.com'] }), 'host_not_allowlisted');
    expectBlocked(() => parseSafeOutboundUrl('https://stripe.com.attacker.tld/x', { allowHosts: ['stripe.com'] }), 'host_not_allowlisted');
    const err = expectBlocked(() => parseSafeOutboundUrl('https://evil.example/x', { allowHosts: ['stripe.com'] }), 'host_not_allowlisted');
    assert.equal(err.statusCode, 403);
  });
});

describe('[UNIT] url-ssrf-guard isSafeOutboundUrl', () => {
  test('returns boolean instead of throwing', () => {
    assert.equal(isSafeOutboundUrl('https://files.stripe.com/x', { allowHosts: ['stripe.com'] }), true);
    assert.equal(isSafeOutboundUrl('http://127.0.0.1/x', { allowHttp: true }), false);
    assert.equal(isSafeOutboundUrl('https://evil.example/x', { allowHosts: ['stripe.com'] }), false);
  });
});

describe('[UNIT] url-ssrf-guard assertOutboundUrlSafe (DNS anti-rebinding)', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const metadataLookup = async () => [{ address: '169.254.169.254', family: 4 }];

  test('resolves for a host whose DNS records are public', async () => {
    const url = await assertOutboundUrlSafe('https://files.stripe.com/x.pdf', {
      allowHosts: ['stripe.com'],
      lookup: publicLookup,
    });
    assert.equal(url.hostname, 'files.stripe.com');
  });

  test('rejects when DNS resolves to a private address (rebinding)', async () => {
    await assert.rejects(
      () => assertOutboundUrlSafe('https://sneaky.stripe.com/x', { allowHosts: ['stripe.com'], lookup: privateLookup }),
      (err) => err instanceof SsrfBlockedError && err.code === 'resolved_blocked',
    );
  });

  test('rejects when DNS resolves to the cloud metadata address', async () => {
    await assert.rejects(
      () => assertOutboundUrlSafe('https://rebind.stripe.com/x', { allowHosts: ['stripe.com'], lookup: metadataLookup }),
      (err) => err instanceof SsrfBlockedError && err.code === 'resolved_blocked',
    );
  });

  test('skips DNS for already-vetted public IP literals', async () => {
    let called = false;
    const url = await assertOutboundUrlSafe('https://93.184.216.34/x', {
      lookup: async () => { called = true; return [{ address: '93.184.216.34', family: 4 }]; },
    });
    assert.equal(url.hostname, '93.184.216.34');
    assert.equal(called, false, 'DNS lookup should be skipped for IP literals');
  });

  test('still applies sync checks before DNS (allowlist mismatch never resolves)', async () => {
    let called = false;
    await assert.rejects(
      () => assertOutboundUrlSafe('https://evil.example/x', {
        allowHosts: ['stripe.com'],
        lookup: async () => { called = true; return [{ address: '93.184.216.34', family: 4 }]; },
      }),
      (err) => err instanceof SsrfBlockedError && err.code === 'host_not_allowlisted',
    );
    assert.equal(called, false, 'sync allowlist check must short-circuit before DNS');
  });
});
