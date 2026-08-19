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
  hasBearerAuth,
  readHeader,
} = require('../src/middleware/csrf');

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
    assert.equal(res.body.csrfToken.length, 64); // 32 bytes hex
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

  test('CSRF_DISABLED=1 bypasses for tests/dev', () => {
    const prev = process.env.CSRF_DISABLED;
    process.env.CSRF_DISABLED = '1';
    try {
      let called = false;
      requireCsrf(mockReq(), mockRes(), () => { called = true; });
      assert.equal(called, true);
    } finally {
      if (prev === undefined) delete process.env.CSRF_DISABLED;
      else process.env.CSRF_DISABLED = prev;
    }
  });
});
