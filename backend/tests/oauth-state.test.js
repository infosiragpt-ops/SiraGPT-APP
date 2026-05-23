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

describe('signOAuthState', () => {
  it('returns a JWT carrying the expected claims', () => {
    const token = signOAuthState({ userId: 'u-1', service: 'google_drive' }, ENV());
    assert.equal(typeof token, 'string');
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    assert.equal(decoded.typ, 'oauth_state');
    assert.equal(decoded.userId, 'u-1');
    assert.equal(decoded.service, 'google_drive');
    assert.ok(decoded.exp > decoded.iat, 'must have an expiry');
  });

  it('coerces numeric userId to string', () => {
    const token = signOAuthState({ userId: 42, service: 'gmail' }, ENV());
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    assert.equal(decoded.userId, '42');
  });

  it('throws when userId is missing', () => {
    assert.throws(
      () => signOAuthState({ service: 'gmail' }, ENV()),
      /userId and service are required/,
    );
  });

  it('throws when service is missing', () => {
    assert.throws(
      () => signOAuthState({ userId: 'u-1' }, ENV()),
      /userId and service are required/,
    );
  });

  it('throws when JWT_SECRET is not configured', () => {
    assert.throws(
      () => signOAuthState({ userId: 'u-1', service: 'gmail' }, {}),
      /JWT_SECRET is required/,
    );
  });

  it('honours OAUTH_STATE_TTL when set', () => {
    const token = signOAuthState(
      { userId: 'u-1', service: 'gmail' },
      ENV({ OAUTH_STATE_TTL: '1h' }),
    );
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    const delta = decoded.exp - decoded.iat;
    assert.ok(delta >= 3599 && delta <= 3601, `expected ~3600s ttl, got ${delta}`);
  });

  it('default TTL is roughly 10 minutes', () => {
    const token = signOAuthState({ userId: 'u-1', service: 'gmail' }, ENV());
    const decoded = jwt.verify(token, 'unit-test-jwt-secret');
    const delta = decoded.exp - decoded.iat;
    assert.ok(delta >= 598 && delta <= 602, `expected ~600s ttl, got ${delta}`);
  });
});

describe('verifyOAuthState', () => {
  it('returns { userId, service } for a valid state', () => {
    const token = signOAuthState({ userId: 'u-1', service: 'gmail' }, ENV());
    const out = verifyOAuthState(token, { service: 'gmail' }, ENV());
    assert.deepEqual(out, { userId: 'u-1', service: 'gmail' });
  });

  it('throws when rawState is missing', () => {
    assert.throws(
      () => verifyOAuthState(null, { service: 'gmail' }, ENV()),
      /OAuth state is required/,
    );
    assert.throws(
      () => verifyOAuthState('', { service: 'gmail' }, ENV()),
      /OAuth state is required/,
    );
  });

  it('throws when service is missing', () => {
    const token = signOAuthState({ userId: 'u-1', service: 'gmail' }, ENV());
    assert.throws(
      () => verifyOAuthState(token, {}, ENV()),
      /OAuth state is required/,
    );
  });

  it('throws on a tampered JWT (sig mismatch)', () => {
    const token = signOAuthState({ userId: 'u-1', service: 'gmail' }, ENV());
    assert.throws(
      () => verifyOAuthState(token, { service: 'gmail' }, ENV({ JWT_SECRET: 'WRONG-SECRET' })),
      /invalid signature/,
    );
  });

  it('throws when service in JWT does not match service argument', () => {
    const token = signOAuthState({ userId: 'u-1', service: 'gmail' }, ENV());
    assert.throws(
      () => verifyOAuthState(token, { service: 'google_drive' }, ENV()),
      /Invalid OAuth state/,
    );
  });

  it('throws on a JWT with the wrong typ claim', () => {
    const evil = jwt.sign(
      { typ: 'auth', userId: 'u-1', service: 'gmail' },
      'unit-test-jwt-secret',
    );
    assert.throws(
      () => verifyOAuthState(evil, { service: 'gmail' }, ENV()),
      /Invalid OAuth state/,
    );
  });

  it('throws on an expired state JWT', () => {
    const expired = jwt.sign(
      { typ: 'oauth_state', userId: 'u-1', service: 'gmail' },
      'unit-test-jwt-secret',
      { expiresIn: '-1s' },
    );
    assert.throws(
      () => verifyOAuthState(expired, { service: 'gmail' }, ENV()),
      /jwt expired/,
    );
  });

  it('throws when userId missing in the JWT payload', () => {
    const malformed = jwt.sign(
      { typ: 'oauth_state', service: 'gmail' },
      'unit-test-jwt-secret',
    );
    assert.throws(
      () => verifyOAuthState(malformed, { service: 'gmail' }, ENV()),
      /Invalid OAuth state/,
    );
  });
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
