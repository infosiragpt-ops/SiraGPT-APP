'use strict';

const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-saml-sp-initiated-32-bytes';

const authRouter = require('../src/routes/auth');
const saml = require('../src/services/saml-handler');
const { createSamlRequestStore } = require('../src/services/saml-request-store');

const { ssoLoginHandler } = authRouter.__ssoHelpers;

const CALLBACK_URL = 'https://sira.example.com/api/auth/sso/acme/callback';
const validConfig = {
  provider: 'saml',
  entryPoint: 'https://idp.example.com/sso',
  issuer: 'https://sira.example.com/sp',
  callbackUrl: CALLBACK_URL,
  audience: 'https://sira.example.com/audience',
  cert: '-----BEGIN CERTIFICATE-----\nMIID...test...==\n-----END CERTIFICATE-----',
};
const PREAUTH_NONCE = Buffer.alloc(32, 5).toString('base64url');
const PREAUTH_NONCE_HASH = crypto
  .createHash('sha256')
  .update(PREAUTH_NONCE)
  .digest('base64url');

function createStore({ clock, env = {} } = {}) {
  return createSamlRequestStore({
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-saml-relay-state-secret-32-bytes',
      ...env,
    },
    clock,
  });
}

function makeSdk({
  capture = {},
  profile = { email: 'alice@example.com', nameID: 'alice' },
  expectedRequestId,
} = {}) {
  class FakeSAML {
    constructor(options) {
      this.options = options;
      capture.options = options;
    }

    async getAuthorizeUrlAsync(relayState, host, options) {
      const requestId = this.options.generateUniqueId();
      await this.options.cacheProvider.saveAsync(
        requestId,
        '2026-07-11T00:00:00.000Z',
      );
      capture.requestId = requestId;
      capture.relayState = relayState;
      capture.host = host;
      capture.authorizeOptions = options;
      const url = new URL(this.options.entryPoint);
      url.searchParams.set('SAMLRequest', Buffer.from(`<AuthnRequest ID="${requestId}"/>`).toString('base64'));
      url.searchParams.set('RelayState', relayState);
      return url.toString();
    }

    async validatePostResponseAsync(input) {
      capture.input = input;
      const first = await this.options.cacheProvider.getAsync(expectedRequestId);
      if (!first) throw new Error('InResponseTo is not valid');
      const second = await this.options.cacheProvider.getAsync(expectedRequestId);
      if (!second) throw new Error('SubjectInResponseTo is not valid');
      await this.options.cacheProvider.removeAsync(expectedRequestId);
      return { profile };
    }
  }
  return { SAML: FakeSAML };
}

function responseFor({
  requestId = '_request-1',
  destination = CALLBACK_URL,
} = {}) {
  const inResponseTo = requestId == null ? '' : ` InResponseTo="${requestId}"`;
  const xml = [
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"',
    ` ID="_response" Version="2.0" Destination="${destination}"${inResponseTo}>`,
    '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">',
    '<saml:Conditions><saml:AudienceRestriction>',
    `<saml:Audience>${validConfig.audience}</saml:Audience>`,
    '</saml:AudienceRestriction></saml:Conditions>',
    '</saml:Assertion>',
    '</samlp:Response>',
  ].join('');
  return Buffer.from(xml, 'utf8').toString('base64');
}

async function prepareCallback({
  requestId = '_request-1',
  orgSlug = 'acme',
  clock,
  env,
} = {}) {
  const requestStore = createStore({ clock, env });
  await requestStore.createCacheProvider(orgSlug).saveAsync(
    requestId,
    new Date((clock || Date.now)()).toISOString(),
  );
  const relayState = await requestStore.issueRelayState({
    orgSlug,
    requestId,
    preAuthNonceHash: PREAUTH_NONCE_HASH,
  });
  return { requestStore, relayState, preAuthNonce: PREAUTH_NONCE };
}

function makeRes() {
  let status = 200;
  let body;
  let location;
  const headers = {};
  return {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    redirect(code, url) { status = code; location = url; return this; },
    cookie() { return this; },
    set(name, value) { headers[String(name).toLowerCase()] = String(value); return this; },
    setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); },
    get _status() { return status; },
    get _body() { return body; },
    get _location() { return location; },
    get _headers() { return headers; },
  };
}

test('SP login generates an AuthnRequest URL, one-time ID, and bound RelayState', async () => {
  const capture = {};
  const requestStore = createStore();
  const result = await saml.initiateSamlLogin(validConfig, {
    orgSlug: 'acme',
    requestStore,
    loadSaml: () => makeSdk({ capture }),
    randomBytes: (size) => Buffer.alloc(size, 9),
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestId, capture.requestId);
  assert.match(result.requestId, /^_[a-f0-9]{40}$/);
  const authorizeUrl = new URL(result.url);
  assert.equal(authorizeUrl.origin, 'https://idp.example.com');
  assert.ok(authorizeUrl.searchParams.get('SAMLRequest'));
  assert.equal(authorizeUrl.searchParams.get('RelayState'), capture.relayState);
  assert.equal(capture.options.validateInResponseTo, 'always');
  assert.equal(capture.options.requestIdExpirationPeriodMs, requestStore.status().ttlMs);
  assert.equal(capture.options.audience, validConfig.audience);
  assert.equal(typeof capture.options.cacheProvider?.saveAsync, 'function');
  assert.deepEqual(capture.authorizeOptions, {});

  assert.deepEqual(
    await requestStore.consumeRelayState({
      relayState: capture.relayState,
      orgSlug: 'acme',
      preAuthNonceHash: crypto
        .createHash('sha256')
        .update(result.preAuthNonce)
        .digest('base64url'),
    }),
    { requestId: result.requestId },
  );
});

test('GET SAML login redirects to the IdP while OIDC login behavior stays unchanged', async () => {
  const samlRes = makeRes();
  await ssoLoginHandler(
    { params: { orgSlug: 'acme' } },
    samlRes,
    {
      resolveOrgForSso: async () => ({
        id: 'org-1',
        slug: 'acme',
        ssoEnabled: true,
        ssoConfig: validConfig,
      }),
      samlHandler: {
        initiateSamlLogin: async () => ({
          ok: true,
          url: 'https://idp.example.com/sso?SAMLRequest=request&RelayState=state',
          requestId: '_request-1',
          preAuthNonce: PREAUTH_NONCE,
          ttlMs: 60_000,
        }),
      },
    },
  );
  assert.equal(samlRes._status, 302);
  assert.match(samlRes._location, /^https:\/\/idp\.example\.com\/sso\?/);

  let oidcInitiated = false;
  const oidcRes = makeRes();
  await ssoLoginHandler(
    { params: { orgSlug: 'acme' } },
    oidcRes,
    {
      resolveOrgForSso: async () => ({
        id: 'org-1',
        slug: 'acme',
        ssoEnabled: true,
        ssoConfig: { ...validConfig, provider: 'oidc' },
      }),
      samlHandler: {
        async initiateSamlLogin() {
          oidcInitiated = true;
        },
      },
    },
  );
  assert.equal(oidcInitiated, false);
  assert.equal(oidcRes._status, 501);
  assert.equal(oidcRes._body.implemented, false);
  assert.equal(oidcRes._body.message, 'SSO login redirect not implemented');
});

test('SAML login fails closed with no-store 503 when distributed cache is unavailable', async () => {
  const res = makeRes();
  await ssoLoginHandler(
    { params: { orgSlug: 'acme' } },
    res,
    {
      resolveOrgForSso: async () => ({
        id: 'org-1',
        slug: 'acme',
        ssoEnabled: true,
        ssoConfig: validConfig,
      }),
      samlHandler: {
        initiateSamlLogin: async () => ({
          ok: false,
          status: 503,
          error: 'saml_request_store_unavailable',
          retryAfter: 1,
        }),
      },
    },
  );

  assert.equal(res._status, 503);
  assert.equal(res._body.error, 'saml_request_store_unavailable');
  assert.equal(res._headers['cache-control'], 'no-store');
  assert.equal(res._headers['retry-after'], '1');
});

test('unsolicited SAML assertions are rejected before SDK validation', async () => {
  let validationCalls = 0;
  const capture = {};
  const sdk = makeSdk({ capture, expectedRequestId: '_request-1' });
  const OriginalSAML = sdk.SAML;
  sdk.SAML = class extends OriginalSAML {
    async validatePostResponseAsync(input) {
      validationCalls += 1;
      return super.validatePostResponseAsync(input);
    }
  };

  const result = await saml.verifySamlResponse(
    responseFor({ requestId: null }),
    validConfig,
    {
      orgSlug: 'acme',
      relayState: null,
      requestStore: createStore(),
      loadSaml: () => sdk,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'saml_relay_state_invalid');
  assert.equal(validationCalls, 0);
});

test('callback consumes request and rejects replay', async () => {
  const requestId = '_request-1';
  const { requestStore, relayState, preAuthNonce } = await prepareCallback({ requestId });
  const capture = {};
  const context = {
    orgSlug: 'acme',
    relayState,
    preAuthNonce,
    requestStore,
    loadSaml: () => makeSdk({ capture, expectedRequestId: requestId }),
  };

  const first = await saml.verifySamlResponse(responseFor({ requestId }), validConfig, context);
  assert.equal(first.ok, true);
  assert.equal(first.email, 'alice@example.com');
  assert.equal(capture.options.validateInResponseTo, 'always');

  const replay = await saml.verifySamlResponse(responseFor({ requestId }), validConfig, context);
  assert.equal(replay.ok, false);
  assert.equal(replay.status, 401);
  assert.equal(replay.error, 'saml_relay_state_invalid');
});

test('cross-org RelayState is rejected without burning the legitimate login', async () => {
  const requestId = '_request-1';
  const {
    requestStore,
    relayState,
    preAuthNonce,
  } = await prepareCallback({ requestId, orgSlug: 'acme' });
  const loadSaml = () => makeSdk({ expectedRequestId: requestId });

  const crossOrg = await saml.verifySamlResponse(responseFor({ requestId }), validConfig, {
    orgSlug: 'other-org',
    relayState,
    preAuthNonce,
    requestStore,
    loadSaml,
  });
  assert.equal(crossOrg.ok, false);
  assert.equal(crossOrg.error, 'saml_relay_state_invalid');

  const legitimate = await saml.verifySamlResponse(responseFor({ requestId }), validConfig, {
    orgSlug: 'acme',
    relayState,
    preAuthNonce,
    requestStore,
    loadSaml,
  });
  assert.equal(legitimate.ok, true);
});

test('expired callback state is rejected before assertion validation', async () => {
  let now = Date.parse('2026-07-11T00:00:00.000Z');
  const clock = () => now;
  const requestId = '_request-1';
  const { requestStore, relayState, preAuthNonce } = await prepareCallback({
    requestId,
    clock,
    env: { SAML_REQUEST_TTL_MS: '60000' },
  });
  now += 60_001;

  const result = await saml.verifySamlResponse(responseFor({ requestId }), validConfig, {
    orgSlug: 'acme',
    relayState,
    preAuthNonce,
    requestStore,
    loadSaml: () => makeSdk({ expectedRequestId: requestId }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'saml_relay_state_expired');
});

test('callback validates exact destination and configures audience validation', async () => {
  const requestId = '_request-1';
  const { requestStore, relayState, preAuthNonce } = await prepareCallback({ requestId });
  let validationCalls = 0;
  const capture = {};
  const sdk = makeSdk({ capture, expectedRequestId: requestId });
  const OriginalSAML = sdk.SAML;
  sdk.SAML = class extends OriginalSAML {
    async validatePostResponseAsync(input) {
      validationCalls += 1;
      return super.validatePostResponseAsync(input);
    }
  };

  const result = await saml.verifySamlResponse(
    responseFor({
      requestId,
      destination: 'https://attacker.example.com/api/auth/sso/acme/callback',
    }),
    validConfig,
    {
      orgSlug: 'acme',
      relayState,
      preAuthNonce,
      requestStore,
      loadSaml: () => sdk,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'saml_destination_invalid');
  assert.equal(validationCalls, 0);
  assert.equal(capture.options, undefined);
});

test('callback returns prompt 503 rather than weakening validation on Redis outage', async () => {
  const requestStore = createSamlRequestStore({
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: 'test-only-saml-relay-state-secret-32-bytes',
      SAML_REDIS_COMMAND_TIMEOUT_MS: '20',
    },
    redis: {
      status: 'ready',
      ping: () => new Promise(() => {}),
      disconnect() {},
    },
  });

  const startedAt = Date.now();
  const result = await saml.verifySamlResponse(responseFor(), validConfig, {
    orgSlug: 'acme',
    relayState: 'invalid.invalid',
    requestStore,
    loadSaml: () => makeSdk({ expectedRequestId: '_request-1' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'saml_request_store_unavailable');
  assert.ok(Date.now() - startedAt < 250);
});
