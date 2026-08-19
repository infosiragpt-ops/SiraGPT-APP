'use strict';

/**
 * Ratchet 45 — SAML response handler tests.
 *
 * Exercises backend/src/services/saml-handler.js with a fake
 * `@node-saml/node-saml` SDK injected via the `loadSaml` deps seam, so
 * the tests run without the heavy optional dependency installed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const saml = require('../src/services/saml-handler');

const validConfig = {
  provider: 'saml',
  entryPoint: 'https://idp.example.com/sso',
  issuer: 'https://sira.example.com/sp',
  callbackUrl: 'https://sira.example.com/api/auth/sso/acme/callback',
  cert: '-----BEGIN CERTIFICATE-----\nMIIDdjCCAl6gAwIBAgIE...redacted...==\n-----END CERTIFICATE-----',
};

function makeFakeSdk({ profile, throwOnValidate } = {}) {
  class FakeSAML {
    constructor(opts) { this.opts = opts; }
    async validatePostResponseAsync(_input) {
      if (throwOnValidate) throw new Error('bad signature');
      return { profile };
    }
  }
  return { SAML: FakeSAML };
}

test('returns 501 lib_missing when SDK not available', async () => {
  const out = await saml.verifySamlResponse('xxx', validConfig, {
    loadSaml: () => null,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 501);
  assert.equal(out.error, 'saml_lib_missing');
});

test('rejects when ssoConfig is not a saml provider', async () => {
  const out = await saml.verifySamlResponse('xxx', { ...validConfig, provider: 'oidc' }, {
    loadSaml: () => makeFakeSdk({ profile: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(out.error, 'saml_not_configured');
});

test('rejects when SAML cert missing', async () => {
  const { cert: _c, ...noCert } = validConfig;
  const out = await saml.verifySamlResponse('xxx', noCert, {
    loadSaml: () => makeFakeSdk({ profile: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'saml_not_configured');
});

test('rejects when SAMLResponse body field is empty', async () => {
  const out = await saml.verifySamlResponse('', validConfig, {
    loadSaml: () => makeFakeSdk({ profile: { email: 'a@b.com' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(out.error, 'saml_response_missing');
});

test('rejects when SDK validation throws', async () => {
  const out = await saml.verifySamlResponse('xxx', validConfig, {
    loadSaml: () => makeFakeSdk({ throwOnValidate: true }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'saml_response_invalid');
});

test('rejects when profile has no email claim', async () => {
  const out = await saml.verifySamlResponse('xxx', validConfig, {
    loadSaml: () => makeFakeSdk({ profile: { nameID: 'no-at-sign' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'saml_email_missing');
});

test('returns ok with email + profile on success', async () => {
  const out = await saml.verifySamlResponse('xxx', validConfig, {
    loadSaml: () => makeFakeSdk({
      profile: { email: 'Alice@Example.com', displayName: 'Alice Liddell', nameID: 'alice' },
    }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.email, 'alice@example.com');
  assert.equal(out.displayName, 'Alice Liddell');
  assert.equal(out.nameId, 'alice');
});

test('extractEmailFromProfile prefers email claim over nameID', () => {
  assert.equal(
    saml.extractEmailFromProfile({ email: 'a@b.com', nameID: 'x' }),
    'a@b.com',
  );
  assert.equal(
    saml.extractEmailFromProfile({ nameID: 'user@host.com' }),
    'user@host.com',
  );
  assert.equal(saml.extractEmailFromProfile({ nameID: 'no-email' }), null);
  assert.equal(saml.extractEmailFromProfile(null), null);
});

test('extractNameFromProfile assembles given+surname fallback', () => {
  assert.equal(
    saml.extractNameFromProfile({ firstName: 'Bob', lastName: 'Builder' }),
    'Bob Builder',
  );
  assert.equal(saml.extractNameFromProfile({ displayName: 'Z' }), 'Z');
  assert.equal(saml.extractNameFromProfile({}), null);
});

test('lib_missing path is hit when module cache is null', async () => {
  saml.__setSdkForTest(null);
  try {
    const out = await saml.verifySamlResponse('xxx', validConfig);
    assert.equal(out.error, 'saml_lib_missing');
  } finally {
    saml.__resetSdkForTest();
  }
});
