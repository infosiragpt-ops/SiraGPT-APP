'use strict';

/**
 * Integration smoke tests for:
 *   GET /api/auth/gmail/callback
 *   GET /api/auth/google-services/callback
 *
 * Strategy: spin up a minimal Express app that wires
 * ProviderOAuthService (real class, injected/mocked collaborators) to
 * thin callback routes—the same pattern the full auth router uses.
 * supertest drives HTTP requests so we exercise the actual route
 * middleware stack, popup-HTML rendering, and error-shape contract
 * without requiring a database, Redis, or real Google credentials.
 *
 * Test coverage:
 *   - Missing code param → HTML error with "auth_failed"
 *   - Missing state param → HTML error with "auth_failed"
 *   - Tampered / invalid state JWT → HTML error with "invalid_state"
 *   - Token exchange throws redirect_uri_mismatch → HTML error with
 *     a meaningful error code (not a silent empty response)
 *   - Happy-path exchange → HTML success with correct service name
 *   - Google Services callback → success message variant
 *   - Content-Type header is text/html for every callback response
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const request = require('supertest');

const { ProviderOAuthService } = require('../src/services/ProviderOAuthService');
const {
  signOAuthState,
  verifyOAuthState,
  popupResponseHtml,
  _testOnly_clearUsedJtis,
} = require('../src/services/oauth-state');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gmail-cb-smoke-test-secret-32chars!!';

function makeVault() {
  return {
    sealProviderTokens: (b) => `SEALED(${JSON.stringify(b)})`,
    openProviderTokens: () => null,
  };
}

function makeOAuth2Client({ throwOnGetToken, scopeInResponse } = {}) {
  return {
    generateAuthUrl: (opts) =>
      `https://accounts.google.com/o/oauth2/auth?state=${opts.state}`,
    getToken: async () => {
      if (throwOnGetToken) throw throwOnGetToken;
      return {
        tokens: {
          access_token: 'AT',
          refresh_token: 'RT',
          token_type: 'Bearer',
          scope: scopeInResponse || 'gmail.readonly gmail.send',
          expiry_date: Date.now() + 3600_000,
        },
      };
    },
  };
}

const persistCalls = [];
const clearCalls = [];

function makeGmailService(opts = {}) {
  return new ProviderOAuthService({
    provider: {
      service: 'gmail',
      oauth2Client: opts.oauth2Client || makeOAuth2Client(),
      scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
      scopeFallback: 'gmail',
      requiredScopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
      scopeMatch: 'every',
      persistTokens: async (uid, sealed) => persistCalls.push({ uid, sealed }),
      clearTokens: async (uid) => clearCalls.push(uid),
      readSealedTokens: async () => null,
    },
    tokenVault: opts.vault || makeVault(),
    signState: ({ userId, service }) => {
      const jwt = require('jsonwebtoken');
      return jwt.sign({ typ: 'oauth_state', userId: String(userId), service },
        process.env.JWT_SECRET, { expiresIn: '10m' });
    },
    verifyState: (rawState, { service }) => {
      const jwt = require('jsonwebtoken');
      const d = jwt.verify(rawState, process.env.JWT_SECRET);
      if (!d || d.typ !== 'oauth_state' || d.service !== service) {
        throw new Error('Invalid OAuth state');
      }
      return { userId: String(d.userId) };
    },
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
}

function makeGoogleServicesService(opts = {}) {
  return new ProviderOAuthService({
    provider: {
      service: 'google_services',
      oauth2Client: opts.oauth2Client || makeOAuth2Client({ scopeInResponse: 'calendar drive' }),
      scopes: ['calendar', 'drive'],
      scopeFallback: 'calendar,drive',
      requiredScopes: ['calendar', 'drive'],
      scopeMatch: 'some',
      persistTokens: async (uid, sealed) => persistCalls.push({ uid, sealed }),
      clearTokens: async (uid) => clearCalls.push(uid),
      readSealedTokens: async () => null,
    },
    tokenVault: opts.vault || makeVault(),
    signState: ({ userId, service }) => {
      const jwt = require('jsonwebtoken');
      return jwt.sign({ typ: 'oauth_state', userId: String(userId), service },
        process.env.JWT_SECRET, { expiresIn: '10m' });
    },
    verifyState: (rawState, { service }) => {
      const jwt = require('jsonwebtoken');
      const d = jwt.verify(rawState, process.env.JWT_SECRET);
      if (!d || d.typ !== 'oauth_state' || d.service !== service) {
        throw new Error('Invalid OAuth state');
      }
      return { userId: String(d.userId) };
    },
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
}

function _renderCallbackResult(res, result, { successMessage } = {}) {
  res.set('Content-Type', 'text/html');
  if (result.ok) {
    return res.send(popupResponseHtml({
      status: 'success',
      service: result.service,
      ...(successMessage ? { message: successMessage } : {}),
    }));
  }
  return res.send(popupResponseHtml({
    status: 'error',
    service: result.service,
    error: result.error || 'auth_failed',
  }));
}

function buildApp(gmailSvc, googleServicesSvc) {
  const app = express();

  app.get('/api/auth/gmail/callback', async (req, res) => {
    const result = await gmailSvc.handleCallback({
      code: req.query.code,
      state: req.query.state,
    });
    _renderCallbackResult(res, result);
  });

  app.get('/api/auth/google-services/callback', async (req, res) => {
    const result = await googleServicesSvc.handleCallback({
      code: req.query.code,
      state: req.query.state,
    });
    _renderCallbackResult(res, result, {
      successMessage:
        'Google Calendar & Drive connected successfully! This window will now close.',
    });
  });

  return app;
}

function validGmailState(userId = 'user-smoke-1') {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { typ: 'oauth_state', userId: String(userId), service: 'gmail' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );
}

function validGoogleServicesState(userId = 'user-smoke-2') {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { typ: 'oauth_state', userId: String(userId), service: 'google_services' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );
}

describe('Gmail OAuth callback route — integration smoke', () => {
  let app;

  before(() => {
    persistCalls.length = 0;
    clearCalls.length = 0;
    app = buildApp(makeGmailService(), makeGoogleServicesService());
  });

  it('GET /api/auth/gmail/callback — missing code → HTML error (auth_failed)', async () => {
    const state = validGmailState();
    const res = await request(app)
      .get(`/api/auth/gmail/callback?state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /auth_failed/);
    assert.doesNotMatch(res.text, /success/);
  });

  it('GET /api/auth/gmail/callback — missing state → HTML error (auth_failed)', async () => {
    const res = await request(app)
      .get('/api/auth/gmail/callback?code=SOMECODE')
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /auth_failed/);
  });

  it('GET /api/auth/gmail/callback — tampered state → HTML error (invalid_state)', async () => {
    const res = await request(app)
      .get('/api/auth/gmail/callback?code=SOMECODE&state=not.a.valid.jwt')
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /invalid_state/);
    assert.doesNotMatch(res.text, /success/);
  });

  it('GET /api/auth/gmail/callback — state signed for wrong service → HTML error (invalid_state)', async () => {
    const wrongServiceState = validGoogleServicesState();
    const res = await request(app)
      .get(`/api/auth/gmail/callback?code=SOMECODE&state=${encodeURIComponent(wrongServiceState)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /invalid_state/);
  });

  it('GET /api/auth/gmail/callback — token exchange throws redirect_uri_mismatch → meaningful HTML error', async () => {
    const redirectErr = Object.assign(new Error('redirect_uri_mismatch'), {
      code: 400,
      response: { data: { error: 'redirect_uri_mismatch' } },
    });
    const appMisconfigured = buildApp(
      makeGmailService({ oauth2Client: makeOAuth2Client({ throwOnGetToken: redirectErr }) }),
      makeGoogleServicesService(),
    );

    const state = validGmailState('user-mismatch');
    const res = await request(appMisconfigured)
      .get(`/api/auth/gmail/callback?code=ANYCODE&state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /auth_failed/,
      'A redirect_uri_mismatch must surface as a meaningful error, not a silent empty page');
    assert.doesNotMatch(res.text, /success/);
  });

  it('GET /api/auth/gmail/callback — happy path → HTML success with service=gmail', async () => {
    const state = validGmailState('user-happy-1');
    const res = await request(app)
      .get(`/api/auth/gmail/callback?code=GOODCODE&state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /success/);
    assert.match(res.text, /gmail/);
    assert.doesNotMatch(res.text, /auth_failed/);
    assert.doesNotMatch(res.text, /invalid_state/);

    const persisted = persistCalls.find((c) => c.uid === 'user-happy-1');
    assert.ok(persisted, 'tokens must be persisted for the authenticated user');
  });

  it('GET /api/auth/gmail/callback — response is always text/html (never bare JSON or empty)', async () => {
    const scenarios = [
      `/api/auth/gmail/callback`,
      `/api/auth/gmail/callback?code=X`,
      `/api/auth/gmail/callback?state=X`,
    ];
    for (const path of scenarios) {
      const res = await request(app).get(path).expect(200);
      assert.match(res.headers['content-type'], /text\/html/,
        `Expected text/html for ${path}`);
      assert.ok(res.text.length > 0, `Expected non-empty response for ${path}`);
    }
  });
});

describe('Google Services OAuth callback route — integration smoke', () => {
  let app;

  before(() => {
    persistCalls.length = 0;
    clearCalls.length = 0;
    app = buildApp(makeGmailService(), makeGoogleServicesService());
  });

  it('GET /api/auth/google-services/callback — missing code → HTML error', async () => {
    const state = validGoogleServicesState();
    const res = await request(app)
      .get(`/api/auth/google-services/callback?state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /auth_failed/);
  });

  it('GET /api/auth/google-services/callback — missing state → HTML error', async () => {
    const res = await request(app)
      .get('/api/auth/google-services/callback?code=SOMECODE')
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /auth_failed/);
  });

  it('GET /api/auth/google-services/callback — invalid state → HTML error (invalid_state)', async () => {
    const res = await request(app)
      .get('/api/auth/google-services/callback?code=SOMECODE&state=garbage.jwt.blob')
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /invalid_state/);
  });

  it('GET /api/auth/google-services/callback — state signed for wrong service → HTML error (invalid_state)', async () => {
    const wrongServiceState = validGmailState();
    const res = await request(app)
      .get(`/api/auth/google-services/callback?code=X&state=${encodeURIComponent(wrongServiceState)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /invalid_state/);
  });

  it('GET /api/auth/google-services/callback — token exchange throws redirect_uri_mismatch → meaningful HTML error', async () => {
    const redirectErr = Object.assign(new Error('redirect_uri_mismatch'), {
      code: 400,
    });
    const appMisconfigured = buildApp(
      makeGmailService(),
      makeGoogleServicesService({
        oauth2Client: makeOAuth2Client({ throwOnGetToken: redirectErr }),
      }),
    );

    const state = validGoogleServicesState('user-gs-mismatch');
    const res = await request(appMisconfigured)
      .get(`/api/auth/google-services/callback?code=ANYCODE&state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /auth_failed/,
      'A redirect_uri_mismatch must surface as a meaningful error, not a silent empty page');
    assert.doesNotMatch(res.text, /success/);
  });

  it('GET /api/auth/google-services/callback — happy path → HTML success with custom message', async () => {
    const state = validGoogleServicesState('user-gs-happy');
    const res = await request(app)
      .get(`/api/auth/google-services/callback?code=GOODCODE&state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /success/);
    assert.match(res.text, /google_services/);
    assert.match(res.text, /Google Calendar/,
      'success response should include the custom Calendar & Drive success message');
    assert.doesNotMatch(res.text, /auth_failed/);

    const persisted = persistCalls.find((c) => c.uid === 'user-gs-happy');
    assert.ok(persisted, 'tokens must be persisted for the authenticated user');
  });

  it('GET /api/auth/google-services/callback — response is always text/html', async () => {
    const paths = [
      '/api/auth/google-services/callback',
      '/api/auth/google-services/callback?code=X',
    ];
    for (const path of paths) {
      const res = await request(app).get(path).expect(200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.ok(res.text.length > 0);
    }
  });
});

/**
 * Security tests for OAuth state token expiry, replay protection, and
 * cross-user flow isolation. These use the real signOAuthState /
 * verifyOAuthState from oauth-state.js (including jti tracking) so
 * they exercise the production one-time-use enforcement path.
 */
describe('OAuth state token security — expiry, replay, and cross-user isolation', () => {
  let app;
  const localPersistCalls = [];

  before(() => {
    localPersistCalls.length = 0;
    _testOnly_clearUsedJtis();

    const securityGmailSvc = new ProviderOAuthService({
      provider: {
        service: 'gmail',
        oauth2Client: makeOAuth2Client(),
        scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
        scopeFallback: 'gmail',
        requiredScopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
        scopeMatch: 'every',
        persistTokens: async (uid, sealed) => localPersistCalls.push({ uid, sealed }),
        clearTokens: async () => {},
        readSealedTokens: async () => null,
      },
      tokenVault: makeVault(),
      signState: ({ userId, service }) => signOAuthState({ userId, service }),
      verifyState: (rawState, { service }) => verifyOAuthState(rawState, { service }),
      logger: { warn: () => {}, error: () => {}, log: () => {} },
    });

    app = buildApp(securityGmailSvc, makeGoogleServicesService());
  });

  it('expired state JWT is rejected with invalid_state', async () => {
    const jwt = require('jsonwebtoken');
    const crypto = require('crypto');
    const expiredState = jwt.sign(
      { typ: 'oauth_state', userId: 'user-expiry-test', service: 'gmail', jti: crypto.randomUUID() },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' },
    );

    const res = await request(app)
      .get(`/api/auth/gmail/callback?code=SOMECODE&state=${encodeURIComponent(expiredState)}`)
      .expect(200);

    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /invalid_state/,
      'An expired state JWT must be rejected with invalid_state, not silently accepted');
    assert.doesNotMatch(res.text, /success/);
  });

  it('replaying a state token after first use is rejected with invalid_state', async () => {
    const state = signOAuthState({ userId: 'user-replay', service: 'gmail' });

    const firstUse = await request(app)
      .get(`/api/auth/gmail/callback?code=GOODCODE&state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(firstUse.text, /success/,
      'First use of a valid state must succeed');

    const secondUse = await request(app)
      .get(`/api/auth/gmail/callback?code=GOODCODE2&state=${encodeURIComponent(state)}`)
      .expect(200);

    assert.match(secondUse.text, /invalid_state/,
      'Replaying an already-consumed state JWT must be rejected with invalid_state');
    assert.doesNotMatch(secondUse.text, /success/);
  });

  it('state consumed by user-A cannot be replayed in a user-B code exchange', async () => {
    const userAState = signOAuthState({ userId: 'user-xflow-a', service: 'gmail' });

    const userAFlow = await request(app)
      .get(`/api/auth/gmail/callback?code=CODE_FOR_A&state=${encodeURIComponent(userAState)}`)
      .expect(200);

    assert.match(userAFlow.text, /success/,
      "user-A's flow should complete successfully on first use");
    assert.ok(
      localPersistCalls.find((c) => c.uid === 'user-xflow-a'),
      'tokens must be persisted for user-A after their flow completes',
    );

    const userBTriesUserAState = await request(app)
      .get(`/api/auth/gmail/callback?code=CODE_FOR_B&state=${encodeURIComponent(userAState)}`)
      .expect(200);

    assert.match(userBTriesUserAState.text, /invalid_state/,
      "user-A's already-consumed state must be rejected when presented in a user-B code exchange");
    assert.doesNotMatch(userBTriesUserAState.text, /success/);
    assert.ok(
      !localPersistCalls.find((c) => c.uid === 'user-xflow-b'),
      'no tokens should be persisted for user-B via a replayed user-A state',
    );
  });
});
