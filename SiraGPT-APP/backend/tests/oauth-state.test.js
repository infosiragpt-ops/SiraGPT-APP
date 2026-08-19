/**
 * Tests for oauth-state.js — JWT-signed OAuth state for popup flow.
 *
 * Surface:
 *   - signOAuthState({ userId, service }, env)
 *   - verifyOAuthState(state, { service }, env)
 *   - frontendOrigin(env)
 *   - popupResponseHtml({ service, status, error, message }, env)
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const jwt = require('jsonwebtoken');

const {
  signOAuthState,
  verifyOAuthState,
  frontendOrigin,
  popupResponseHtml,
} = require('../src/services/oauth-state');

const ENV = (overrides = {}) => ({
  JWT_SECRET: 'unit-test-jwt-secret',
  ...overrides,
});
const REDIRECT_URI = 'https://api.example.test/oauth/callback';

describe('signOAuthState', () => {
  it('returns a JWT carrying the expected claims', async () => {
    const token = await signOAuthState({
      userId: 'u-1',
      service: 'google_drive',
      redirectUri: REDIRECT_URI,
    }, ENV());
    assert.equal(typeof token, 'string');
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    assert.equal(decoded.typ, 'oauth_state');
    assert.equal(decoded.userId, 'u-1');
    assert.equal(decoded.service, 'google_drive');
    assert.equal(decoded.redirectUri, REDIRECT_URI);
    assert.ok(decoded.exp > decoded.iat, 'must have an expiry');
  });

  it('coerces numeric userId to string', async () => {
    const token = await signOAuthState({
      userId: 42,
      service: 'gmail',
      redirectUri: REDIRECT_URI,
    }, ENV());
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    assert.equal(decoded.userId, '42');
  });

  it('throws when userId is missing', async () => {
    await assert.rejects(
      signOAuthState({ service: 'gmail', redirectUri: REDIRECT_URI }, ENV()),
      /OAUTH_STATE_INPUT_INVALID/,
    );
  });

  it('throws when service is missing', async () => {
    await assert.rejects(
      signOAuthState({ userId: 'u-1', redirectUri: REDIRECT_URI }, ENV()),
      /OAUTH_STATE_INPUT_INVALID/,
    );
  });

  it('throws when JWT_SECRET is not configured', async () => {
    await assert.rejects(
      signOAuthState({
        userId: 'u-1',
        service: 'gmail',
        redirectUri: REDIRECT_URI,
      }, {}),
      /JWT_SECRET is required/,
    );
  });

  it('honours OAUTH_STATE_TTL up to the 15-minute security ceiling', async () => {
    const token = await signOAuthState(
      { userId: 'u-1', service: 'gmail', redirectUri: REDIRECT_URI },
      ENV({ OAUTH_STATE_TTL: '1h' }),
    );
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    const delta = decoded.exp - decoded.iat;
    assert.ok(delta >= 899 && delta <= 901, `expected bounded ~900s ttl, got ${delta}`);
  });

  it('default TTL is roughly 10 minutes', async () => {
    const token = await signOAuthState({
      userId: 'u-1',
      service: 'gmail',
      redirectUri: REDIRECT_URI,
    }, ENV());
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    const delta = decoded.exp - decoded.iat;
    assert.ok(delta >= 598 && delta <= 602, `expected ~600s ttl, got ${delta}`);
  });
});

describe('verifyOAuthState', () => {
  it('returns bound claims for a valid state', async () => {
    const token = await signOAuthState({
      userId: 'u-1',
      service: 'gmail',
      redirectUri: REDIRECT_URI,
    }, ENV());
    const out = await verifyOAuthState(
      token,
      { service: 'gmail', redirectUri: REDIRECT_URI },
      ENV(),
    );
    assert.deepEqual(out, {
      userId: 'u-1',
      service: 'gmail',
      redirectUri: REDIRECT_URI,
    });
  });

  it('throws when rawState is missing', async () => {
    await assert.rejects(
      verifyOAuthState(null, { service: 'gmail', redirectUri: REDIRECT_URI }, ENV()),
      /OAUTH_STATE_REQUIRED/,
    );
    await assert.rejects(
      verifyOAuthState('', { service: 'gmail', redirectUri: REDIRECT_URI }, ENV()),
      /OAUTH_STATE_REQUIRED/,
    );
  });

  it('throws when service is missing', async () => {
    const token = await signOAuthState({
      userId: 'u-1',
      service: 'gmail',
      redirectUri: REDIRECT_URI,
    }, ENV());
    await assert.rejects(
      verifyOAuthState(token, { redirectUri: REDIRECT_URI }, ENV()),
      /OAUTH_STATE_INPUT_INVALID/,
    );
  });

  it('throws on a tampered JWT (sig mismatch)', async () => {
    const token = await signOAuthState({
      userId: 'u-1',
      service: 'gmail',
      redirectUri: REDIRECT_URI,
    }, ENV());
    await assert.rejects(
      verifyOAuthState(
        token,
        { service: 'gmail', redirectUri: REDIRECT_URI },
        ENV({ JWT_SECRET: 'WRONG-SECRET' }),
      ),
      /invalid signature/,
    );
  });

  it('throws when service in JWT does not match service argument', async () => {
    const token = await signOAuthState({
      userId: 'u-1',
      service: 'gmail',
      redirectUri: REDIRECT_URI,
    }, ENV());
    await assert.rejects(
      verifyOAuthState(
        token,
        { service: 'google_drive', redirectUri: REDIRECT_URI },
        ENV(),
      ),
      /OAUTH_STATE_BINDING_INVALID/,
    );
  });

  it('throws on a JWT with the wrong typ claim', async () => {
    const evil = jwt.sign(
      {
        typ: 'auth',
        userId: 'u-1',
        service: 'gmail',
        redirectUri: REDIRECT_URI,
        jti: 'wrong-type',
      },
      'unit-test-jwt-secret',
    );
    await assert.rejects(
      verifyOAuthState(evil, { service: 'gmail', redirectUri: REDIRECT_URI }, ENV()),
      /OAUTH_STATE_INVALID/,
    );
  });

  it('throws on an expired state JWT', async () => {
    const expired = jwt.sign(
      {
        typ: 'oauth_state',
        userId: 'u-1',
        service: 'gmail',
        redirectUri: REDIRECT_URI,
        jti: 'expired',
      },
      'unit-test-jwt-secret',
      { expiresIn: '-1s' },
    );
    await assert.rejects(
      verifyOAuthState(expired, { service: 'gmail', redirectUri: REDIRECT_URI }, ENV()),
      /jwt expired/,
    );
  });

  it('throws when userId missing in the JWT payload', async () => {
    const malformed = jwt.sign(
      {
        typ: 'oauth_state',
        service: 'gmail',
        redirectUri: REDIRECT_URI,
        jti: 'missing-user',
      },
      'unit-test-jwt-secret',
    );
    await assert.rejects(
      verifyOAuthState(malformed, { service: 'gmail', redirectUri: REDIRECT_URI }, ENV()),
      /OAUTH_STATE_INVALID/,
    );
  });
});

it('OAuth private context is one-time server-side state and is returned only after verification', async () => {
  const env = { NODE_ENV: 'test', JWT_SECRET: 'context-secret', OAUTH_STATE_TTL: '10m' };
  const state = await signOAuthState({
    userId: 'u-context',
    service: 'social_x',
    redirectUri: REDIRECT_URI,
    context: { codeVerifier: 'private-pkce-verifier' },
  }, env);
  const decoded = jwt.decode(state);
  assert.equal(decoded.codeVerifier, undefined, 'private context must not be embedded in the URL-visible JWT');

  const verified = await verifyOAuthState(state, {
    service: 'social_x',
    redirectUri: REDIRECT_URI,
  }, env);
  assert.deepEqual(verified.context, { codeVerifier: 'private-pkce-verifier' });
  await assert.rejects(
    () => verifyOAuthState(state, { service: 'social_x', redirectUri: REDIRECT_URI }, env),
    /OAUTH_STATE_REPLAYED_OR_EXPIRED/,
  );
});

describe('frontendOrigin', () => {
  it('reads FRONTEND_URL when set', () => {
    assert.equal(
      frontendOrigin({ FRONTEND_URL: 'https://app.example.com' }),
      'https://app.example.com',
    );
  });

  it('falls back to PUBLIC_FRONTEND_URL when FRONTEND_URL is missing', () => {
    assert.equal(
      frontendOrigin({ PUBLIC_FRONTEND_URL: 'https://other.example.com' }),
      'https://other.example.com',
    );
  });

  it('defaults to http://localhost:3000 when neither var is set', () => {
    assert.equal(frontendOrigin({}), 'http://localhost:3000');
  });

  it('extracts the origin even when the URL has a path / query / hash', () => {
    assert.equal(
      frontendOrigin({ FRONTEND_URL: 'https://app.example.com/oauth?code=x#fragment' }),
      'https://app.example.com',
    );
  });

  it('falls back to localhost on a malformed URL', () => {
    assert.equal(
      frontendOrigin({ FRONTEND_URL: 'not-a-valid-url' }),
      'http://localhost:3000',
    );
  });
});

describe('popupResponseHtml', () => {
  it('emits success HTML with the expected title', () => {
    const html = popupResponseHtml({ service: 'gmail', status: 'success' }, ENV());
    assert.match(html, /<title>Authentication Success<\/title>/);
    assert.match(html, /window\.opener\.postMessage/);
    assert.match(html, /window\.close\(\)/);
  });

  it('emits failure HTML with the expected title', () => {
    const html = popupResponseHtml({ service: 'gmail', status: 'error' }, ENV());
    assert.match(html, /<title>Authentication Failed<\/title>/);
  });

  it('includes the service in the postMessage payload', () => {
    const html = popupResponseHtml(
      { service: 'gmail', status: 'success' },
      { FRONTEND_URL: 'https://app.example.com' },
    );
    assert.match(html, /"service":"gmail"/);
    assert.match(html, /"status":"success"/);
    assert.match(html, /,\s*"https:\/\/app\.example\.com"\)/);
  });

  it('includes error key only when error is provided', () => {
    const without = popupResponseHtml({ service: 'gmail', status: 'success' }, ENV());
    assert.equal(without.includes('"error"'), false);
    const withErr = popupResponseHtml(
      { service: 'gmail', status: 'error', error: 'access_denied' },
      ENV(),
    );
    assert.match(withErr, /"error":"access_denied"/);
  });

  it('HTML-escapes the message body', () => {
    const html = popupResponseHtml(
      { service: 'gmail', status: 'error', message: '<script>alert(1)</script>' },
      ENV(),
    );
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(html.includes('<script>alert(1)</script>'), false);
  });

  it('falls back to default success message when not provided', () => {
    const html = popupResponseHtml({ service: 'gmail', status: 'success' }, ENV());
    assert.match(html, /Authentication successful/);
  });

  it('falls back to default failure message when status !== success', () => {
    const html = popupResponseHtml({ service: 'gmail', status: 'error' }, ENV());
    assert.match(html, /Authentication failed/);
  });

  it('encodes target origin as the second postMessage arg (XSS hardening)', () => {
    const html = popupResponseHtml(
      { service: 'gmail', status: 'success' },
      { FRONTEND_URL: 'https://target.example.com/some/path' },
    );
    // Origin (2nd arg of postMessage) is JSON-encoded as the origin
    // only — no path. Match on the closing `, "origin")`.
    assert.match(html, /,\s*"https:\/\/target\.example\.com"\);/);
  });
});
