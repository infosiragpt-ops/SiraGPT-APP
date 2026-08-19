'use strict';

const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-saml-browser-flow-32-bytes';

const authRouter = require('../src/routes/auth');
const saml = require('../src/services/saml-handler');
const { createSamlRequestStore } = require('../src/services/saml-request-store');

const {
  ssoLoginHandler,
  ssoSamlCallbackHandler,
} = authRouter.__ssoHelpers;

const PREAUTH_COOKIE = 'sira_saml_preauth';
const PREAUTH_NONCE = Buffer.alloc(32, 7).toString('base64url');
const CALLBACK_URL = 'https://api.example.com/api/auth/sso/acme/callback';
const VALID_CONFIG = {
  provider: 'saml',
  entryPoint: 'https://idp.example.com/sso',
  issuer: 'https://api.example.com/saml',
  callbackUrl: CALLBACK_URL,
  audience: 'https://api.example.com/saml',
  cert: 'CERT',
};

function makeRes() {
  let status = 200;
  let body;
  let location;
  const cookies = [];
  const clearedCookies = [];
  const headers = {};
  return {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    redirect(code, url) { status = code; location = url; return this; },
    cookie(name, value, options) {
      cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      clearedCookies.push({ name, options });
      return this;
    },
    set(name, value) { headers[String(name).toLowerCase()] = String(value); return this; },
    setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); },
    get _status() { return status; },
    get _body() { return body; },
    get _location() { return location; },
    get _cookies() { return cookies; },
    get _clearedCookies() { return clearedCookies; },
    get _headers() { return headers; },
  };
}

function requestFor({
  accept = 'text/html',
  responseMode,
  preAuthNonce = PREAUTH_NONCE,
} = {}) {
  const headers = {
    accept,
    ...(responseMode ? { 'x-sira-response-mode': responseMode } : {}),
  };
  return {
    params: { orgSlug: 'acme' },
    body: {
      SAMLResponse: 'signed-response',
      RelayState: 'signed-state',
    },
    cookies: { [PREAUTH_COOKIE]: preAuthNonce },
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

function makePrisma() {
  const db = {
    user: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: 'user-1', ...data }),
    },
    session: {
      create: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
    organization: {
      findUnique: async () => ({
        id: 'org-1',
        slug: 'acme',
        ssoEnabled: true,
        ssoConfig: VALID_CONFIG,
      }),
    },
    orgMembership: {
      findUnique: async () => null,
      upsert: async ({ create }) => create,
    },
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) return [{ lock_timeout: params[0] }];
      return [{ locked: true }];
    },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

function callbackDeps({ verify, env } = {}) {
  const prisma = makePrisma();
  return {
    env: env || {
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://app.example.com/nested?ignored=1',
    },
    prisma,
    writeAuditLog: () => {},
    resolveOrgForSso: async (slug) => prisma.organization.findUnique({ where: { slug } }),
    samlHandler: {
      verifySamlResponse: verify || (async () => ({
        ok: true,
        email: 'alice@example.com',
        displayName: 'Alice',
        nameId: 'alice-id',
        profile: {},
      })),
    },
    rbacAssignments: {
      syncLegacyAdminAssignment: async () => ({ denied: false }),
      syncOrgRoleAssignment: async () => ({ denied: false }),
      invalidateUser: async () => {},
    },
  };
}

function responseFor(requestId) {
  const xml = [
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"',
    ` ID="_response" Version="2.0" Destination="${CALLBACK_URL}" InResponseTo="${requestId}">`,
    '</samlp:Response>',
  ].join('');
  return Buffer.from(xml, 'utf8').toString('base64');
}

function verificationSdk(expectedRequestId) {
  return {
    SAML: class FakeSaml {
      constructor(options) {
        this.options = options;
      }

      async validatePostResponseAsync() {
        const request = await this.options.cacheProvider.getAsync(expectedRequestId);
        if (!request) throw new Error('request missing');
        await this.options.cacheProvider.removeAsync(expectedRequestId);
        return {
          profile: {
            email: 'alice@example.com',
            nameID: 'alice-id',
          },
        };
      }
    },
  };
}

test('SP login creates a high-entropy browser nonce and stores only its hash', async () => {
  const issued = [];
  const requestStore = {
    async ensureAvailable() {},
    status: () => ({ ttlMs: 90_000 }),
    createCacheProvider: () => ({
      async saveAsync() {},
    }),
    async issueRelayState(input) {
      issued.push(input);
      return 'signed-state';
    },
  };
  const result = await saml.initiateSamlLogin(VALID_CONFIG, {
    orgSlug: 'acme',
    requestStore,
    randomBytes: (size) => Buffer.alloc(size, 7),
    loadSaml: () => ({
      SAML: class FakeSaml {
        constructor(options) {
          this.options = options;
        }

        async getAuthorizeUrlAsync(relayState) {
          const requestId = this.options.generateUniqueId();
          await this.options.cacheProvider.saveAsync(requestId, new Date().toISOString());
          return `${VALID_CONFIG.entryPoint}?SAMLRequest=request&RelayState=${relayState}`;
        }
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.match(result.preAuthNonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.ttlMs, 90_000);
  assert.equal(issued.length, 1);
  assert.equal(issued[0].preAuthNonceHash, crypto
    .createHash('sha256')
    .update(result.preAuthNonce)
    .digest('base64url'));
  assert.equal(JSON.stringify(issued[0]).includes(result.preAuthNonce), false);
  assert.equal(result.url.includes(result.preAuthNonce), false);
});

test('SAML login sets a narrowly scoped cross-site pre-auth cookie', async () => {
  const res = makeRes();
  await ssoLoginHandler(
    { params: { orgSlug: 'acme' } },
    res,
    {
      env: { NODE_ENV: 'production' },
      resolveOrgForSso: async () => ({
        id: 'org-1',
        slug: 'acme',
        ssoEnabled: true,
        ssoConfig: VALID_CONFIG,
      }),
      samlHandler: {
        initiateSamlLogin: async () => ({
          ok: true,
          url: 'https://idp.example.com/sso?SAMLRequest=request&RelayState=state',
          requestId: '_request-1',
          preAuthNonce: PREAUTH_NONCE,
          ttlMs: 120_000,
        }),
      },
    },
  );

  const cookie = res._cookies.find((entry) => entry.name === PREAUTH_COOKIE);
  assert.equal(res._status, 302);
  assert.ok(cookie);
  assert.equal(cookie.value, PREAUTH_NONCE);
  assert.deepEqual(cookie.options, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/api/auth/sso/acme/callback',
    maxAge: 120_000,
  });
});

test('cross-browser SAML callback fails without consuming the legitimate browser state', async () => {
  const requestId = '_request-1';
  const requestStore = createSamlRequestStore({
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-saml-browser-binding-secret',
    },
  });
  const preAuthNonceHash = crypto.createHash('sha256').update(PREAUTH_NONCE).digest('base64url');
  await requestStore.createCacheProvider('acme').saveAsync(requestId, new Date().toISOString());
  const relayState = await requestStore.issueRelayState({
    orgSlug: 'acme',
    requestId,
    preAuthNonceHash,
  });
  const base = {
    orgSlug: 'acme',
    relayState,
    requestStore,
    loadSaml: () => verificationSdk(requestId),
  };

  const wrongBrowser = await saml.verifySamlResponse(
    responseFor(requestId),
    VALID_CONFIG,
    { ...base, preAuthNonce: Buffer.alloc(32, 8).toString('base64url') },
  );
  assert.equal(wrongBrowser.ok, false);
  assert.equal(wrongBrowser.error, 'saml_browser_binding_invalid');

  const initiatingBrowser = await saml.verifySamlResponse(
    responseFor(requestId),
    VALID_CONFIG,
    { ...base, preAuthNonce: PREAUTH_NONCE },
  );
  assert.equal(initiatingBrowser.ok, true);
});

test('successful browser ACS sets cookies, clears pre-auth state, and redirects without JWT disclosure', async () => {
  let verificationContext;
  const res = makeRes();
  await ssoSamlCallbackHandler(
    requestFor(),
    res,
    callbackDeps({
      verify: async (_response, _config, context) => {
        verificationContext = context;
        return {
          ok: true,
          email: 'alice@example.com',
          displayName: 'Alice',
          nameId: 'alice-id',
          profile: {},
        };
      },
    }),
  );

  assert.equal(verificationContext.preAuthNonce, PREAUTH_NONCE);
  assert.equal(res._status, 303);
  assert.equal(res._location, 'https://app.example.com/auth/callback?sso=success');
  assert.equal(res._body, undefined);
  assert.equal(res._location.includes('token='), false);
  assert.deepEqual(
    res._cookies.find((entry) => entry.name === 'token')?.options,
    {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  );
  assert.ok(res._cookies.some((entry) => entry.name === 'csrf_token'));
  assert.ok(res._cookies.some((entry) => entry.name === '_csrf_secret'));
  assert.ok(res._clearedCookies.some((entry) => (
    entry.name === PREAUTH_COOKIE
      && entry.options.path === '/api/auth/sso/acme/callback'
  )));
});

test('trusted JSON negotiation never returns the session JWT in the response body', async () => {
  const res = makeRes();
  await ssoSamlCallbackHandler(
    requestFor({ accept: 'application/json', responseMode: 'json' }),
    res,
    callbackDeps(),
  );

  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(Object.hasOwn(res._body, 'token'), false);
  assert.equal(JSON.stringify(res._body).includes('eyJ'), false);
  assert.ok(res._cookies.some((entry) => entry.name === 'token'));
});

test('Accept JSON alone is not trusted negotiation and still receives the browser redirect', async () => {
  const res = makeRes();
  await ssoSamlCallbackHandler(
    requestFor({ accept: 'application/json' }),
    res,
    callbackDeps(),
  );

  assert.equal(res._status, 303);
  assert.equal(res._body, undefined);
  assert.equal(res._location, 'https://app.example.com/auth/callback?sso=success');
});

test('invalid FRONTEND_URL fails before issuing the session cookie', async () => {
  const res = makeRes();
  await ssoSamlCallbackHandler(
    requestFor(),
    res,
    callbackDeps({
      env: {
        NODE_ENV: 'production',
        FRONTEND_URL: 'javascript:alert(document.domain)',
      },
    }),
  );

  assert.equal(res._status, 500);
  assert.equal(res._body.error, 'saml_frontend_callback_invalid');
  assert.equal(res._cookies.some((entry) => entry.name === 'token'), false);
  assert.ok(res._clearedCookies.some((entry) => entry.name === PREAUTH_COOKIE));
});

