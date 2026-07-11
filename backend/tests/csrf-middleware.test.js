/**
 * csrf-middleware — double-submit-cookie protection for cookie-auth
 * endpoints. Pins the request shapes the rest of the codebase will
 * rely on: token issuance via /api/csrf-token, header echo via
 * X-CSRF-Token, body fallback via _csrf, bearer-auth bypass for
 * mobile/API clients, and a fail-closed default on missing data.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  csrfTokenRoute,
  requireCsrf,
  hashToken,
  generateToken,
  makeStatelessToken,
  hasBearerAuth,
  readHeader,
} = require('../src/middleware/csrf');

// Self-signed token shape: 32-byte-hex nonce, base36 timestamp, HMAC-hex sig.
const STATELESS_TOKEN_RE = /^[0-9a-f]{64}\.[0-9a-z]+\.[0-9a-f]{64}$/;

function mockRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    body: undefined,
    cookies: {},
    headers,
  };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.cookie = (name, value, opts) => {
    res.cookies[name] = { value, opts };
    return res;
  };
  return res;
}

function mockReq(over = {}) {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    body: {},
    ...over,
  };
}

describe('csrfTokenRoute', () => {
  test('issues both public + secret cookies and returns token in body', () => {
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    csrfTokenRoute(req, res);
    assert.ok(res.body && typeof res.body.csrfToken === 'string');
    assert.match(res.body.csrfToken, STATELESS_TOKEN_RE); // self-signed token
    assert.ok(res.cookies.csrf_token);
    assert.ok(res.cookies._csrf_secret);
    // The secret cookie MUST be httpOnly so JS / XSS cannot read it.
    assert.equal(res.cookies._csrf_secret.opts.httpOnly, true);
    // The token cookie must be readable by client JS to attach as header.
    assert.equal(res.cookies.csrf_token.opts.httpOnly, false);
    // Secret cookie must encode hash(token) so server can verify.
    assert.equal(res.cookies._csrf_secret.value, hashToken(res.body.csrfToken));
    assert.equal(res.getHeader('Cache-Control'), 'no-store');
    assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  });
});

describe('requireCsrf — safe methods', () => {
  test('GET passes through without a token', () => {
    let called = false;
    requireCsrf(mockReq({ method: 'GET' }), mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  test('HEAD passes through', () => {
    let called = false;
    requireCsrf(mockReq({ method: 'HEAD' }), mockRes(), () => { called = true; });
    assert.equal(called, true);
  });
});

describe('requireCsrf — bearer auth bypass', () => {
  test('Authorization: Bearer skips CSRF (mobile API)', () => {
    const req = mockReq({
      method: 'POST',
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    let called = false;
    requireCsrf(req, mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  test('hasBearerAuth recognises common forms', () => {
    assert.equal(hasBearerAuth({ headers: { authorization: 'Bearer x' } }), true);
    assert.equal(hasBearerAuth({ headers: { Authorization: 'Bearer x' } }), true);
    assert.equal(hasBearerAuth({ headers: { authorization: ['Bearer x'] } }), true);
    assert.equal(hasBearerAuth({ headers: { authorization: 'bearer x' } }), true);
    assert.equal(hasBearerAuth({ headers: { authorization: 'Basic x' } }), false);
    assert.equal(hasBearerAuth({ headers: {} }), false);
  });

  test('readHeader handles lowercase, uppercase and array values', () => {
    assert.equal(readHeader({ headers: { 'x-csrf-token': 'a' } }, 'x-csrf-token'), 'a');
    assert.equal(readHeader({ headers: { 'X-CSRF-Token': 'b' } }, 'x-csrf-token'), 'b');
    assert.equal(readHeader({ headers: { 'x-csrf-token': ['c', 'd'] } }, 'x-csrf-token'), 'c');
    assert.equal(readHeader({ headers: {} }, 'x-csrf-token'), undefined);
  });
});

describe('requireCsrf — validation', () => {
  function withCsrfEnv(overrides, fn) {
    const keys = ['NODE_ENV', 'CORS_ORIGINS', 'CSRF_DISABLED'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    for (const key of keys) {
      if (overrides[key] === undefined) delete process.env[key];
    }
    try {
      return fn();
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }

  function validCookieRequest(token, overrides = {}) {
    return mockReq({
      headers: {
        origin: 'https://app.example.com',
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': token,
      },
      cookies: {
        token: 'session-jwt',
        _csrf_secret: hashToken(token),
      },
      ...overrides,
    });
  }

  test('rejects missing token + secret with 403 csrf_invalid/missing_token', () => {
    const req = mockReq({ headers: { 'x-request-id': 'req-csrf-missing' } });
    const res = mockRes();
    requireCsrf(req, res, () => assert.fail('next should not be called'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'csrf_invalid');
    assert.equal(res.body.code, 'csrf_invalid');
    assert.equal(res.body.message, 'CSRF token invalid or missing');
    assert.equal(res.body.reason, 'missing_token');
    assert.equal(res.body.requestId, 'req-csrf-missing');
    assert.equal(res.getHeader('Cache-Control'), 'no-store');
    assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  });

  test('rejects mismatched header token', () => {
    const token = generateToken();
    const res = mockRes();
    const req = mockReq({
      headers: { 'x-csrf-token': 'wrong-token' },
      cookies: { _csrf_secret: hashToken(token) },
    });
    requireCsrf(req, res, () => assert.fail('next should not be called'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'csrf_invalid');
    assert.equal(res.body.reason, 'mismatch');
  });

  test('accepts matching header token', () => {
    const token = generateToken();
    const req = mockReq({
      headers: { 'X-CSRF-Token': token },
      cookies: { _csrf_secret: hashToken(token) },
    });
    let called = false;
    requireCsrf(req, mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  test('cookie-auth mutations require a trusted Origin in addition to a valid token', () => {
    withCsrfEnv({
      NODE_ENV: 'test',
      CORS_ORIGINS: 'https://app.example.com',
      CSRF_DISABLED: undefined,
    }, () => {
      const token = generateToken();
      for (const origin of [undefined, 'https://evil.example.com', 'null']) {
        const req = validCookieRequest(token);
        if (origin === undefined) delete req.headers.origin;
        else req.headers.origin = origin;
        const res = mockRes();
        requireCsrf(req, res, () => assert.fail('untrusted cookie-auth Origin must not pass'));
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.reason, 'untrusted_origin');
      }
    });
  });

  test('cookie-auth mutations require same-origin or same-site fetch metadata', () => {
    withCsrfEnv({
      NODE_ENV: 'test',
      CORS_ORIGINS: 'https://app.example.com',
      CSRF_DISABLED: undefined,
    }, () => {
      const token = generateToken();
      for (const fetchSite of [undefined, 'cross-site', 'none']) {
        const req = validCookieRequest(token);
        if (fetchSite === undefined) delete req.headers['sec-fetch-site'];
        else req.headers['sec-fetch-site'] = fetchSite;
        const res = mockRes();
        requireCsrf(req, res, () => assert.fail('unsafe fetch-site must not pass'));
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.reason, 'invalid_fetch_site');
      }
    });
  });

  test('cookie-auth mutations accept trusted same-origin and same-site contexts', () => {
    withCsrfEnv({
      NODE_ENV: 'test',
      CORS_ORIGINS: 'https://app.example.com',
      CSRF_DISABLED: undefined,
    }, () => {
      for (const fetchSite of ['same-origin', 'same-site']) {
        const token = generateToken();
        const req = validCookieRequest(token);
        req.headers['sec-fetch-site'] = fetchSite;
        let called = false;
        requireCsrf(req, mockRes(), () => { called = true; });
        assert.equal(called, true);
      }
    });
  });

  test('accepts body _csrf field as fallback', () => {
    const token = generateToken();
    const req = mockReq({
      body: { _csrf: token },
      cookies: { _csrf_secret: hashToken(token) },
    });
    let called = false;
    requireCsrf(req, mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  test('accepts a valid self-signed token when the secret cookie is absent (iframe/Safari ITP)', () => {
    // Simulates the cross-site iframe: GET /csrf-token issued the token but the
    // browser dropped the _csrf_secret cookie, so only the header arrives.
    const token = makeStatelessToken();
    const req = mockReq({
      headers: { 'X-CSRF-Token': token },
      cookies: {}, // no _csrf_secret — blocked third-party cookie
    });
    let called = false;
    requireCsrf(req, mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  test('stateless fallback tokens are bound to the issuing session when available', () => {
    withCsrfEnv({
      NODE_ENV: 'test',
      CORS_ORIGINS: 'https://app.example.com',
      CSRF_DISABLED: undefined,
    }, () => {
      const token = makeStatelessToken('session-1');
      const matching = validCookieRequest(token, {
        sessionID: 'session-1',
        cookies: { token: 'session-jwt' },
      });
      let called = false;
      requireCsrf(matching, mockRes(), () => { called = true; });
      assert.equal(called, true);

      const wrongSession = validCookieRequest(token, {
        sessionID: 'session-2',
        cookies: { token: 'session-jwt' },
      });
      const res = mockRes();
      requireCsrf(wrongSession, res, () => assert.fail('cross-session token replay must fail'));
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.reason, 'missing_token');
    });
  });

  test('rejects a forged token when the secret cookie is absent', () => {
    const res = mockRes();
    const req = mockReq({
      headers: { 'x-csrf-token': 'deadbeef.zzz.deadbeef' },
      cookies: {},
    });
    requireCsrf(req, res, () => assert.fail('next should not be called'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.reason, 'missing_token');
  });

  test('falls back to stateless check when secret cookie is stale (mismatch)', () => {
    // Browser kept an old _csrf_secret but echoes a fresh self-signed token.
    const token = makeStatelessToken();
    const req = mockReq({
      headers: { 'x-csrf-token': token },
      cookies: { _csrf_secret: 'stale-unrelated-secret' },
    });
    let called = false;
    requireCsrf(req, mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  // --- CSRF attack regression tests ---------------------------------------
  // A stateless token is GLOBAL (not session-bound), so it must NEVER be
  // accepted from a body/form field — only from the X-CSRF-Token header (which
  // requires a CORS preflight a cross-site attacker cannot pass). Otherwise an
  // attacker could mint a valid token and replay it via a plain <form> POST.

  test('REJECTS a valid stateless token submitted via body when no cookie (cross-site form attack)', () => {
    const res = mockRes();
    const token = makeStatelessToken(); // attacker mints their own valid token
    const req = mockReq({
      body: { _csrf: token }, // delivered through a cross-site <form> POST
      cookies: {}, // victim's secret cookie not present / not forgeable
    });
    requireCsrf(req, res, () => assert.fail('next must not be called — body stateless token is a CSRF bypass'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.reason, 'missing_token');
  });

  test('REJECTS a valid stateless token via body even with a stale secret cookie', () => {
    const res = mockRes();
    const token = makeStatelessToken();
    const req = mockReq({
      body: { csrfToken: token },
      cookies: { _csrf_secret: 'stale-unrelated-secret' },
    });
    requireCsrf(req, res, () => assert.fail('next must not be called — body stateless token is a CSRF bypass'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.reason, 'mismatch');
  });

  test('CSRF_DISABLED=1 bypasses for tests/dev', () => {
    withCsrfEnv({ NODE_ENV: 'test', CSRF_DISABLED: '1' }, () => {
      let called = false;
      requireCsrf(mockReq(), mockRes(), () => { called = true; });
      assert.equal(called, true);
    });
  });

  test('CSRF_DISABLED cannot bypass protection in literal production', () => {
    withCsrfEnv({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com',
      CSRF_DISABLED: '1',
    }, () => {
      const req = mockReq({
        headers: {
          origin: 'https://app.example.com',
          'sec-fetch-site': 'same-origin',
        },
        cookies: { token: 'session-jwt' },
      });
      const res = mockRes();
      requireCsrf(req, res, () => assert.fail('production CSRF bypass must be ignored'));
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.reason, 'missing_token');
    });
  });
});
