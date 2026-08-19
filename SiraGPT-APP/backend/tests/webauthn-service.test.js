/**
 * webauthn-service — ratchet 45 passkey scaffold.
 *
 * Pins the contract of `src/services/webauthn.js`: the four
 * functions (generateRegistrationOptions, verifyRegistration,
 * generateAuthenticationOptions, verifyAuthentication) MUST:
 *
 *   1. Return a 501 placeholder when @simplewebauthn/server is
 *      not installed.
 *   2. Return a 501 placeholder when the RP env config is
 *      incomplete (rpID + origin missing) — same shape so the
 *      route layer's `res.status(result.status).json(result)`
 *      logic stays uniform.
 *   3. Round-trip a registration → authentication flow under a
 *      stubbed SDK, producing a credential record shaped for the
 *      User.webauthnCredentials JSON column.
 *   4. Reject a counter regression on the authentication path
 *      (cloned-key signal).
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/webauthn');

const ENABLED_ENV = {
  WEBAUTHN_RP_ID: 'example.com',
  WEBAUTHN_RP_NAME: 'siraGPT',
  WEBAUTHN_ORIGIN: 'https://app.example.com',
};

function makeStubSdk(overrides = {}) {
  return {
    generateRegistrationOptions: async () => ({
      challenge: 'reg-challenge',
      rp: { id: 'example.com', name: 'siraGPT' },
      user: { id: 'u1', name: 'u@example.com', displayName: 'u@example.com' },
      pubKeyCredParams: [],
    }),
    verifyRegistrationResponse: async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: new Uint8Array([1, 2, 3, 4]),
          publicKey: new Uint8Array([9, 9, 9, 9]),
          counter: 0,
        },
      },
    }),
    generateAuthenticationOptions: async () => ({
      challenge: 'auth-challenge',
      rpId: 'example.com',
      allowCredentials: [],
    }),
    verifyAuthenticationResponse: async () => ({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    }),
    ...overrides,
  };
}

beforeEach(() => {
  svc.__resetSdkForTest();
  svc.__clearChallengesForTest();
});

describe('resolveConfig', () => {
  test('reports configured=false when env is empty', () => {
    const cfg = svc.resolveConfig({});
    assert.equal(cfg.configured, false);
    assert.equal(cfg.rpID, '');
    assert.deepEqual(cfg.origins, []);
  });

  test('configured=true when rpID + origin are set', () => {
    const cfg = svc.resolveConfig(ENABLED_ENV);
    assert.equal(cfg.configured, true);
    assert.equal(cfg.rpID, 'example.com');
    assert.deepEqual(cfg.origins, ['https://app.example.com']);
  });
});

describe('501 placeholders', () => {
  test('generateRegistrationOptions returns 501 when SDK missing', async () => {
    svc.__setSdkForTest(null);
    const result = await svc.generateRegistrationOptions({
      user: { id: 'u1' },
      env: ENABLED_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 501);
    assert.equal(result.error, 'webauthn_lib_missing');
  });

  test('verifyRegistration returns 501 when SDK missing', async () => {
    svc.__setSdkForTest(null);
    const result = await svc.verifyRegistration({
      user: { id: 'u1' },
      response: { id: 'x' },
      env: ENABLED_ENV,
    });
    assert.equal(result.status, 501);
    assert.equal(result.error, 'webauthn_lib_missing');
  });

  test('generateAuthenticationOptions returns 501 when SDK missing', async () => {
    svc.__setSdkForTest(null);
    const result = await svc.generateAuthenticationOptions({
      user: { id: 'u1' },
      env: ENABLED_ENV,
    });
    assert.equal(result.status, 501);
    assert.equal(result.error, 'webauthn_lib_missing');
  });

  test('verifyAuthentication returns 501 when SDK missing', async () => {
    svc.__setSdkForTest(null);
    const result = await svc.verifyAuthentication({
      user: { id: 'u1' },
      response: { id: 'x' },
      env: ENABLED_ENV,
    });
    assert.equal(result.status, 501);
    assert.equal(result.error, 'webauthn_lib_missing');
  });

  test('returns 501 not_configured when SDK present but env missing', async () => {
    svc.__setSdkForTest(makeStubSdk());
    const result = await svc.generateRegistrationOptions({
      user: { id: 'u1' },
      env: {},
    });
    assert.equal(result.status, 501);
    assert.equal(result.error, 'webauthn_not_configured');
  });
});

describe('registration → authentication round-trip', () => {
  test('verifyRegistration builds the credential record + new credentials array', async () => {
    svc.__setSdkForTest(makeStubSdk());
    const user = { id: 'u1', email: 'u@example.com', webauthnCredentials: [] };

    const opts = await svc.generateRegistrationOptions({ user, env: ENABLED_ENV });
    assert.equal(opts.ok, true);
    assert.equal(opts.options.challenge, 'reg-challenge');

    const verify = await svc.verifyRegistration({
      user,
      response: { response: { transports: ['internal'] } },
      label: 'MacBook Touch ID',
      env: ENABLED_ENV,
    });
    assert.equal(verify.ok, true);
    assert.equal(verify.credential.label, 'MacBook Touch ID');
    assert.equal(verify.credential.counter, 0);
    assert.deepEqual(verify.credential.transports, ['internal']);
    assert.equal(verify.credentials.length, 1);
    // base64url of [1,2,3,4] = "AQIDBA"
    assert.equal(verify.credential.credentialId, 'AQIDBA');
  });

  test('verifyRegistration is idempotent for repeated credentialId', async () => {
    svc.__setSdkForTest(makeStubSdk());
    const existing = {
      credentialId: 'AQIDBA',
      publicKey: 'old',
      counter: 7,
      transports: ['usb'],
    };
    const user = { id: 'u1', webauthnCredentials: [existing] };

    await svc.generateRegistrationOptions({ user, env: ENABLED_ENV });
    const verify = await svc.verifyRegistration({
      user,
      response: { response: { transports: ['internal'] } },
      env: ENABLED_ENV,
    });
    assert.equal(verify.ok, true);
    assert.equal(verify.credentials.length, 1, 'duplicate credentialId should be replaced, not duplicated');
    assert.equal(verify.credentials[0].publicKey, 'CQkJCQ'); // base64url of [9,9,9,9]
  });

  test('verifyRegistration fails when no challenge was issued', async () => {
    svc.__setSdkForTest(makeStubSdk());
    const user = { id: 'u1', webauthnCredentials: [] };
    // Skip generateRegistrationOptions — no challenge in store.
    const verify = await svc.verifyRegistration({
      user,
      response: { id: 'x' },
      env: ENABLED_ENV,
    });
    assert.equal(verify.ok, false);
    assert.equal(verify.error, 'webauthn_no_pending_challenge');
  });

  test('verifyAuthentication updates the counter on success', async () => {
    svc.__setSdkForTest(makeStubSdk());
    const credential = {
      credentialId: 'cred-1',
      publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
      counter: 2,
      transports: ['internal'],
    };
    const user = { id: 'u1', webauthnCredentials: [credential] };

    const opts = await svc.generateAuthenticationOptions({ user, env: ENABLED_ENV });
    assert.equal(opts.ok, true);

    const verify = await svc.verifyAuthentication({
      user,
      response: { id: 'cred-1' },
      env: ENABLED_ENV,
    });
    assert.equal(verify.ok, true);
    assert.equal(verify.credentials[0].counter, 5);
    assert.ok(verify.credentials[0].lastUsedAt, 'lastUsedAt should be stamped');
  });

  test('verifyAuthentication rejects counter regression', async () => {
    svc.__setSdkForTest(makeStubSdk({
      verifyAuthenticationResponse: async () => ({
        verified: true,
        authenticationInfo: { newCounter: 1 }, // < stored 5
      }),
    }));
    const user = {
      id: 'u1',
      webauthnCredentials: [{
        credentialId: 'cred-1',
        publicKey: 'pk',
        counter: 5,
        transports: [],
      }],
    };

    await svc.generateAuthenticationOptions({ user, env: ENABLED_ENV });
    const verify = await svc.verifyAuthentication({
      user,
      response: { id: 'cred-1' },
      env: ENABLED_ENV,
    });
    assert.equal(verify.ok, false);
    assert.equal(verify.status, 401);
    assert.equal(verify.error, 'webauthn_counter_regression');
  });

  test('verifyAuthentication 400s for an unknown credentialId', async () => {
    svc.__setSdkForTest(makeStubSdk());
    const user = {
      id: 'u1',
      webauthnCredentials: [{ credentialId: 'other', publicKey: 'pk', counter: 0, transports: [] }],
    };
    await svc.generateAuthenticationOptions({ user, env: ENABLED_ENV });
    const verify = await svc.verifyAuthentication({
      user,
      response: { id: 'missing' },
      env: ENABLED_ENV,
    });
    assert.equal(verify.ok, false);
    assert.equal(verify.error, 'webauthn_credential_not_found');
  });
});

describe('readCredentials defensive parse', () => {
  test('returns [] when column is null / undefined / non-array', () => {
    assert.deepEqual(svc.readCredentials({ webauthnCredentials: null }), []);
    assert.deepEqual(svc.readCredentials({ webauthnCredentials: undefined }), []);
    assert.deepEqual(svc.readCredentials({ webauthnCredentials: 'oops' }), []);
    assert.deepEqual(svc.readCredentials({ webauthnCredentials: { not: 'array' } }), []);
  });

  test('filters non-object / missing-id rows', () => {
    const out = svc.readCredentials({
      webauthnCredentials: [
        { credentialId: 'a', publicKey: 'pk', counter: 0, transports: [] },
        null,
        'string',
        { publicKey: 'no-id' },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].credentialId, 'a');
  });
});
