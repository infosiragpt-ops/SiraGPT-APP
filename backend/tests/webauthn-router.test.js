/**
 * webauthn-router — pins the gating contract. Live SDK calls
 * (registration / authentication ceremonies) require a real
 * authenticator response; we cover the happy path of those by
 * injecting a mocked SDK that returns a fixed verification
 * result. The tests here are deliberately about the ROUTER, not
 * about @simplewebauthn/server's correctness — that's the
 * upstream package's job.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { buildWebAuthnRouter, shouldExposeEndpoints } = require("../src/routes/webauthn");
const { createInMemoryCredentialStore } = require("../src/services/webauthn/credential-store");
const { createInMemoryStore: createInMemoryChallengeStore } = require("../src/services/webauthn/webauthn-challenge-store");

function callRouter(router, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/webauthn', router);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => { buffer += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ statusCode: res.statusCode, body: buffer });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (data) req.write(data);
      req.end();
    });
  });
}

describe("shouldExposeEndpoints", () => {
  test("default OFF — operator must explicitly opt in", () => {
    assert.equal(shouldExposeEndpoints({}), false);
  });

  test("WEBAUTHN_ENDPOINTS_ENABLED=true activates", () => {
    assert.equal(shouldExposeEndpoints({ WEBAUTHN_ENDPOINTS_ENABLED: 'true' }), true);
  });
});

describe("buildWebAuthnRouter — disabled paths", () => {
  test("returns 404 with hint when WebAuthn config disabled", async () => {
    const router = buildWebAuthnRouter({
      env: {}, // no RP_ID, no ORIGIN, no endpoints flag
    });
    const { statusCode, body } = await callRouter(router, '/api/webauthn/register/begin', 'POST', {});
    assert.equal(statusCode, 404);
    const json = JSON.parse(body);
    assert.equal(json.error, 'webauthn_endpoints_disabled');
    assert.match(json.hint, /WEBAUTHN_RP_ID/);
  });

  test("returns 404 when RP_ID set but ENDPOINTS_ENABLED is false", async () => {
    const router = buildWebAuthnRouter({
      env: {
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'https://example.com',
        // WEBAUTHN_ENDPOINTS_ENABLED missing
      },
    });
    const { statusCode } = await callRouter(router, '/api/webauthn/login/begin', 'POST', { userId: 'u-1' });
    assert.equal(statusCode, 404);
  });

  test("returns 503 when @simplewebauthn/server is missing", async () => {
    const router = buildWebAuthnRouter({
      env: {
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'https://example.com',
        WEBAUTHN_ENDPOINTS_ENABLED: 'true',
      },
      sdk: null, // explicit null — simulates a missing package
    });
    const { statusCode, body } = await callRouter(router, '/api/webauthn/login/begin', 'POST', { userId: 'u-1' });
    assert.equal(statusCode, 503);
    const json = JSON.parse(body);
    assert.equal(json.error, 'webauthn_sdk_missing');
  });
});

describe("buildWebAuthnRouter — login flow with mocked SDK", () => {
  // Build a router with stubs so we can drive every branch
  // without an actual authenticator.
  function buildLiveRouter({ generateAuth = null, verifyAuth = null } = {}) {
    const sdk = {
      generateRegistrationOptions: async () => ({ challenge: 'reg-chall', user: {} }),
      verifyRegistrationResponse: async () => ({
        verified: true,
        registrationInfo: {
          credential: {
            id: Buffer.from('new-cred-id'),
            publicKey: Buffer.from('pk'),
            counter: 0,
          },
        },
      }),
      generateAuthenticationOptions: generateAuth || (async () => ({ challenge: 'auth-chall' })),
      verifyAuthenticationResponse: verifyAuth || (async () => ({
        verified: true,
        authenticationInfo: { newCounter: 1 },
      })),
    };
    return buildWebAuthnRouter({
      env: {
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'https://example.com',
        WEBAUTHN_ENDPOINTS_ENABLED: 'true',
      },
      sdk,
      challengeStore: createInMemoryChallengeStore(),
      credentialStore: createInMemoryCredentialStore(),
    });
  }

  test("login/begin without userId → 400", async () => {
    const router = buildLiveRouter();
    const { statusCode, body } = await callRouter(router, '/api/webauthn/login/begin', 'POST', {});
    assert.equal(statusCode, 400);
    assert.equal(JSON.parse(body).error, 'webauthn_missing_user');
  });

  test("login/finish with mismatched origin → 400 webauthn_origin_not_allowed", async () => {
    const router = buildLiveRouter();
    // Note: no challenge in store yet, but the origin check fires first.
    const { statusCode, body } = await callRouter(
      router,
      '/api/webauthn/login/finish',
      'POST',
      { userId: 'u-1', response: { id: 'x' } },
      { origin: 'https://attacker.tld' },
    );
    assert.equal(statusCode, 400);
    assert.equal(JSON.parse(body).error, 'webauthn_origin_not_allowed');
  });

  test("login/finish with missing fields → 400 webauthn_missing_fields", async () => {
    const router = buildLiveRouter();
    const { statusCode, body } = await callRouter(
      router,
      '/api/webauthn/login/finish',
      'POST',
      {},
      { origin: 'https://example.com' },
    );
    assert.equal(statusCode, 400);
    assert.equal(JSON.parse(body).error, 'webauthn_missing_fields');
  });

  test("login/finish with no pending challenge → 400 webauthn_no_pending_challenge", async () => {
    const router = buildLiveRouter();
    const { statusCode, body } = await callRouter(
      router,
      '/api/webauthn/login/finish',
      'POST',
      { userId: 'u-1', response: { id: 'cred-x' } },
      { origin: 'https://example.com' },
    );
    assert.equal(statusCode, 400);
    assert.equal(JSON.parse(body).error, 'webauthn_no_pending_challenge');
  });

  test("login/finish with no registered credential → 400 webauthn_credential_not_found", async () => {
    const challengeStore = createInMemoryChallengeStore();
    await challengeStore.put('u-1', 'authentication', 'auth-chall');
    const router = buildWebAuthnRouter({
      env: {
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'https://example.com',
        WEBAUTHN_ENDPOINTS_ENABLED: 'true',
      },
      sdk: {
        generateAuthenticationOptions: async () => ({ challenge: 'auth-chall' }),
        verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
        generateRegistrationOptions: async () => ({}),
        verifyRegistrationResponse: async () => ({ verified: false }),
      },
      challengeStore,
      credentialStore: createInMemoryCredentialStore(),
    });
    const { statusCode, body } = await callRouter(
      router,
      '/api/webauthn/login/finish',
      'POST',
      { userId: 'u-1', response: { id: 'unknown-cred' } },
      { origin: 'https://example.com' },
    );
    assert.equal(statusCode, 400);
    assert.equal(JSON.parse(body).error, 'webauthn_credential_not_found');
  });
});
