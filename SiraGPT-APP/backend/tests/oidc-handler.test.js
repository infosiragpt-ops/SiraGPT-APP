'use strict';

/**
 * Ratchet 45 — OIDC authorization-code handler tests.
 *
 * Exercises backend/src/services/oidc-handler.js with a fake
 * `openid-client` SDK injected via the `loadOidc` deps seam, so
 * the tests run without the optional dependency installed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const oidc = require('../src/services/oidc-handler');

const validConfig = {
  provider: 'oidc',
  issuer: 'https://idp.example.com',
  clientId: 'sira-client',
  clientSecret: 'shh',
  callbackUrl: 'https://sira.example.com/api/auth/sso/acme/callback',
};

function makeFakeSdk({ claims, throwOnCallback, throwOnDiscover } = {}) {
  class FakeClient {
    constructor(opts) { this.opts = opts; }
    async callback(_uri, _params, _checks) {
      if (throwOnCallback) throw new Error('bad code');
      return { claims: () => claims };
    }
  }
  class FakeIssuer {
    constructor(meta) { this.metadata = meta; this.Client = FakeClient; }
    static async discover(_url) {
      if (throwOnDiscover) throw new Error('discovery failed');
      return new FakeIssuer({ issuer: validConfig.issuer });
    }
  }
  // Instance shape needs `.Client` too.
  FakeIssuer.prototype.Client = FakeClient;
  return { Issuer: FakeIssuer };
}

test('returns 501 lib_missing when SDK not available', async () => {
  const out = await oidc.verifyOidcCode('abc', validConfig, {
    loadOidc: () => null,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 501);
  assert.equal(out.error, 'oidc_lib_missing');
});

test('rejects when ssoConfig is not an oidc provider', async () => {
  const out = await oidc.verifyOidcCode('abc', { ...validConfig, provider: 'saml' }, {
    loadOidc: () => makeFakeSdk({ claims: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(out.error, 'oidc_not_configured');
});

test('rejects when issuer missing', async () => {
  const { issuer: _i, ...noIss } = validConfig;
  const out = await oidc.verifyOidcCode('abc', noIss, {
    loadOidc: () => makeFakeSdk({ claims: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'oidc_not_configured');
});

test('rejects when clientId missing', async () => {
  const { clientId: _c, ...noCid } = validConfig;
  const out = await oidc.verifyOidcCode('abc', noCid, {
    loadOidc: () => makeFakeSdk({ claims: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'oidc_not_configured');
});

test('rejects when callbackUrl missing', async () => {
  const { callbackUrl: _u, ...noCb } = validConfig;
  const out = await oidc.verifyOidcCode('abc', noCb, {
    loadOidc: () => makeFakeSdk({ claims: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'oidc_not_configured');
});

test('rejects when code is empty', async () => {
  const out = await oidc.verifyOidcCode('', validConfig, {
    loadOidc: () => makeFakeSdk({ claims: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(out.error, 'oidc_code_missing');
});

test('rejects when discovery throws', async () => {
  const out = await oidc.verifyOidcCode('abc', validConfig, {
    loadOidc: () => makeFakeSdk({ throwOnDiscover: true, claims: {} }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'oidc_response_invalid');
});

test('rejects when token callback throws', async () => {
  const out = await oidc.verifyOidcCode('abc', validConfig, {
    loadOidc: () => makeFakeSdk({ throwOnCallback: true, claims: {} }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'oidc_response_invalid');
});

test('rejects when claims missing email', async () => {
  const out = await oidc.verifyOidcCode('abc', validConfig, {
    loadOidc: () => makeFakeSdk({ claims: { sub: 'no-at-sign' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'oidc_email_missing');
});

test('returns ok with email + profile on success', async () => {
  const out = await oidc.verifyOidcCode('abc', validConfig, {
    loadOidc: () => makeFakeSdk({
      claims: {
        email: 'Alice@Example.com',
        name: 'Alice Liddell',
        sub: 'alice-uid',
      },
    }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.email, 'alice@example.com');
  assert.equal(out.displayName, 'Alice Liddell');
  assert.equal(out.nameId, 'alice-uid');
});

test('PKCE codeVerifier from deps is forwarded into checks', async () => {
  let seenChecks = null;
  const fakeSdk = (() => {
    class FakeClient {
      async callback(_uri, _params, checks) {
        seenChecks = checks;
        return { claims: () => ({ email: 'a@b.com', sub: 'a' }) };
      }
    }
    class FakeIssuer {
      static async discover() { return new FakeIssuer(); }
    }
    FakeIssuer.prototype.Client = FakeClient;
    return { Issuer: FakeIssuer };
  })();
  const out = await oidc.verifyOidcCode('abc', validConfig, {
    loadOidc: () => fakeSdk,
    codeVerifier: 'verifier-xyz',
    state: 'state-123',
  });
  assert.equal(out.ok, true);
  assert.equal(seenChecks.code_verifier, 'verifier-xyz');
  assert.equal(seenChecks.state, 'state-123');
});

test('extractEmailFromProfile prefers email claim over sub', () => {
  assert.equal(
    oidc.extractEmailFromProfile({ email: 'a@b.com', sub: 'x' }),
    'a@b.com',
  );
  assert.equal(
    oidc.extractEmailFromProfile({ sub: 'user@host.com' }),
    'user@host.com',
  );
  assert.equal(oidc.extractEmailFromProfile({ sub: 'no-email' }), null);
  assert.equal(oidc.extractEmailFromProfile(null), null);
});

test('extractNameFromProfile assembles given+family fallback', () => {
  assert.equal(
    oidc.extractNameFromProfile({ given_name: 'Bob', family_name: 'Builder' }),
    'Bob Builder',
  );
  assert.equal(oidc.extractNameFromProfile({ name: 'Z' }), 'Z');
  assert.equal(oidc.extractNameFromProfile({}), null);
});

test('lib_missing path is hit when module cache is null', async () => {
  oidc.__setSdkForTest(null);
  try {
    const out = await oidc.verifyOidcCode('abc', validConfig);
    assert.equal(out.error, 'oidc_lib_missing');
  } finally {
    oidc.__resetSdkForTest();
  }
});
