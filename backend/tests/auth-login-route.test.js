/**
 * Route-level tests for POST /api/auth/login.
 *
 * These tests mount the real auth router with a FAKE LoginService
 * injected via the require cache. The goal is to lock in the exact
 * mapping from each LoginService result `kind` to its HTTP status,
 * headers, and JSON body — independent of prisma, bcrypt, SMS, etc.
 *
 * The mirror task for /register tracks the same coverage there; see
 * `login-service.test.js` for the LoginService unit-level contract.
 */

const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildRouteTestApp, mockResolvedModule, reloadModule } = require('./http-test-utils');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-login-route-test-secret-at-least-32-chars!!';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.RATE_LIMIT_STORE = 'memory';

const rateLimitStore = require('../src/middleware/rate-limit-store');

// ── Fake LoginService wiring ────────────────────────────────────
//
// The route handler calls `getLoginService().login({ email, password, req })`
// and switches on `result.kind`. We replace the LoginService module so
// `new LoginService(...)` returns an object whose `login()` resolves to
// whatever the current test queued via `setNextLoginResult(...)`.

let nextLoginResult = null;
let lastLoginArgs = null;

function setNextLoginResult(result) {
  nextLoginResult = result;
}

class FakeLoginService {
  async login(args) {
    lastLoginArgs = args;
    if (nextLoginResult instanceof Error) throw nextLoginResult;
    if (!nextLoginResult) {
      throw new Error('auth-login-route.test: nextLoginResult was not configured');
    }
    return nextLoginResult;
  }
}

let restoreLoginServiceModule = null;
let restoreAuditLogModule = null;
const auditCalls = [];

before(() => {
  const resolved = require.resolve('../src/services/LoginService');
  restoreLoginServiceModule = mockResolvedModule(resolved, { LoginService: FakeLoginService });
  const auditResolved = require.resolve('../src/utils/audit-log');
  restoreAuditLogModule = mockResolvedModule(auditResolved, {
    writeAuditLog: async (_db, payload) => {
      auditCalls.push(payload);
    },
  });
});

after(() => {
  if (restoreLoginServiceModule) restoreLoginServiceModule();
  if (restoreAuditLogModule) restoreAuditLogModule();
});

// ── App builder ─────────────────────────────────────────────────

function buildApp() {
  // reloadModule clears the cache for auth.js so the lazy
  // _loginService singleton is rebuilt with our FakeLoginService.
  return buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));
}

const VALID_BODY = { email: 'user@example.com', password: 'pw-not-checked-by-fake' };

// ── Tests ───────────────────────────────────────────────────────

describe('POST /api/auth/login — response shape per LoginService kind', () => {
  beforeEach(() => {
    rateLimitStore._resetForTests();
    nextLoginResult = null;
    lastLoginArgs = null;
    auditCalls.length = 0;
  });

  afterEach(() => {
    nextLoginResult = null;
    lastLoginArgs = null;
  });

  it('forwards email/password to LoginService.login', async () => {
    setNextLoginResult({ ok: false, kind: 'invalid_credentials' });
    const app = buildApp();
    await request(app).post('/api/auth/login').send(VALID_BODY).expect(401);
    assert.equal(lastLoginArgs.email, VALID_BODY.email);
    assert.equal(lastLoginArgs.password, VALID_BODY.password);
    assert.ok(lastLoginArgs.req, 'req is passed through to LoginService');
  });

  it('sso_required → 501 with ssoRequired, orgSlug, ssoLoginUrl', async () => {
    setNextLoginResult({
      ok: false,
      kind: 'sso_required',
      org: { slug: 'acme-corp' },
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(501);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.ssoRequired, true);
    assert.equal(res.body.implemented, false);
    assert.equal(res.body.orgSlug, 'acme-corp');
    assert.equal(res.body.ssoLoginUrl, '/api/auth/sso/acme-corp/login');
    assert.equal(typeof res.body.message, 'string');
  });

  it('locked → 423 with Retry-After header (ceil seconds) and retryAfterMs', async () => {
    setNextLoginResult({
      ok: false,
      kind: 'locked',
      retryAfterMs: 2500, // ceil(2.5) = 3 seconds
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(423);
    assert.equal(res.headers['retry-after'], '3');
    assert.equal(res.body.retryAfterMs, 2500);
    assert.equal(typeof res.body.error, 'string');
  });

  it('locked → Retry-After is at least 1 second even for sub-second waits', async () => {
    setNextLoginResult({ ok: false, kind: 'locked', retryAfterMs: 0 });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(423);
    assert.equal(res.headers['retry-after'], '1');
    assert.equal(res.body.retryAfterMs, 0);
  });

  it('invalid_credentials → 401 { error: "Invalid credentials" }', async () => {
    setNextLoginResult({ ok: false, kind: 'invalid_credentials' });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(401);
    assert.deepEqual(res.body, { error: 'Invalid credentials' });
    assert.deepEqual(auditCalls, [], 'route must not duplicate LoginService login_failed audits');
  });

  it('org_2fa_required → 403 with code: "org_requires_2fa" and orgId', async () => {
    setNextLoginResult({
      ok: false,
      kind: 'org_2fa_required',
      orgId: 'org-42',
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(403);
    assert.equal(res.body.code, 'org_requires_2fa');
    assert.equal(res.body.orgId, 'org-42');
    assert.equal(typeof res.body.error, 'string');
  });

  it('sms_2fa_required → 202 with challengeId, ISO expiresAt, smsSent', async () => {
    const expiresAt = new Date('2030-01-02T03:04:05.000Z');
    setNextLoginResult({
      ok: false,
      kind: 'sms_2fa_required',
      challengeId: 'chal-1',
      expiresAt,
      smsSent: true,
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(202);
    assert.equal(res.body.twoFactorRequired, true);
    assert.equal(res.body.challengeId, 'chal-1');
    assert.equal(res.body.expiresAt, expiresAt.toISOString());
    assert.equal(res.body.smsSent, true);
    assert.equal(res.body.smsSkippedReason, undefined);
  });

  it('sms_2fa_required → includes smsSkippedReason when present', async () => {
    setNextLoginResult({
      ok: false,
      kind: 'sms_2fa_required',
      challengeId: 'chal-2',
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      smsSent: false,
      smsSkippedReason: 'provider_unavailable',
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(202);
    assert.equal(res.body.smsSent, false);
    assert.equal(res.body.smsSkippedReason, 'provider_unavailable');
  });

  it('sms_2fa_mint_failed → 500 { error: "Failed to issue 2FA challenge" }', async () => {
    setNextLoginResult({ ok: false, kind: 'sms_2fa_mint_failed' });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(500);
    assert.deepEqual(res.body, { error: 'Failed to issue 2FA challenge' });
  });

  it('totp_2fa_required → 202 with method "totp", partialToken, ISO expiresAt', async () => {
    const expiresAt = new Date('2030-06-07T08:09:10.000Z');
    setNextLoginResult({
      ok: false,
      kind: 'totp_2fa_required',
      partialToken: 'partial-abc',
      expiresAt,
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(202);
    assert.equal(res.body.twoFactorRequired, true);
    assert.equal(res.body.method, 'totp');
    assert.equal(res.body.partialToken, 'partial-abc');
    assert.equal(res.body.expiresAt, expiresAt.toISOString());
  });

  it('totp_partial_mint_failed → 500 { error: "Failed to issue TOTP challenge" }', async () => {
    setNextLoginResult({ ok: false, kind: 'totp_partial_mint_failed' });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(500);
    assert.deepEqual(res.body, { error: 'Failed to issue TOTP challenge' });
  });

  it('ok → 200 with token cookie set, csrfToken in body, user without password', async () => {
    const user = {
      id: 'u-1',
      email: 'user@example.com',
      name: 'Login User',
      password: 'HASHED-SHOULD-NEVER-LEAK',
      isAdmin: false,
      isSuperAdmin: false,
      plan: 'FREE',
    };
    setNextLoginResult({
      ok: true,
      user,
      token: 'session-token-xyz',
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send(VALID_BODY).expect(200);

    assert.equal(res.body.token, 'session-token-xyz');
    assert.equal(typeof res.body.csrfToken, 'string');
    assert.ok(res.body.csrfToken.length > 0, 'csrfToken is non-empty');

    assert.ok(res.body.user, 'user is serialized in the response');
    assert.equal(res.body.user.email, user.email);
    assert.equal(res.body.user.id, user.id);
    assert.equal(res.body.user.password, undefined, 'password is never echoed');

    const cookies = res.headers['set-cookie'] || [];
    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    assert.ok(tokenCookie, 'token cookie is set');
    assert.ok(tokenCookie.includes('session-token-xyz'), 'token cookie carries the session token');
    assert.ok(/HttpOnly/i.test(tokenCookie), 'token cookie is HttpOnly');
    assert.ok(/SameSite=Lax/i.test(tokenCookie), 'token cookie is SameSite=Lax');
  });
});
