'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LoginService } = require('../src/services/LoginService');

const silentLogger = { error: () => {}, warn: () => {}, log: () => {} };

function makeUser(over = {}) {
  return {
    id: 'u-1',
    email: 'u@x.com',
    password: 'HASHED',
    isAdmin: false,
    isSuperAdmin: false,
    twoFactorEnabled: false,
    totpEnabled: false,
    phone: null,
    phoneVerifiedAt: null,
    ...over,
  };
}

function makeLockout(over = {}) {
  const calls = { isLocked: [], recordFailure: [], recordSuccess: [] };
  let nextLock = over.lockState || { locked: false, attempts: 0, retryAfterMs: 0 };
  let nextAfter = over.afterFailure || { locked: false, attempts: 1 };
  return {
    isLocked: (email) => { calls.isLocked.push(email); return nextLock; },
    recordFailure: (email) => { calls.recordFailure.push(email); return nextAfter; },
    recordSuccess: (email) => { calls.recordSuccess.push(email); return { attempts: 0 }; },
    _calls: calls,
    _setNextLock(v) { nextLock = v; },
    _setAfter(v) { nextAfter = v; },
  };
}

function makeSvc(over = {}) {
  const sessionCalls = [];
  const auditCalls = [];
  const users = {
    findByEmail: over.findByEmail || (async () => makeUser()),
  };
  const sessions = {
    create: async (row) => { sessionCalls.push(row); return row; },
    _calls: sessionCalls,
  };
  const audit = over.audit || ((_prisma, payload) => { auditCalls.push(payload); });
  audit._calls = auditCalls;

  const svc = new LoginService({
    users,
    sessions,
    audit,
    prisma: over.prisma || {},
    lockout: over.lockout || makeLockout(),
    resolveOrgBySsoDomain: over.resolveOrgBySsoDomain || (async () => null),
    signSessionToken: over.signSessionToken || (({ userId }) => `TOKEN(${userId})`),
    comparePassword: over.comparePassword || (async () => true),
    computeFingerprint: over.computeFingerprint || (() => 'fp-1'),
    userHasTwoFactor: over.userHasTwoFactor || (() => true),
    orgRequiresTwoFactor: over.orgRequiresTwoFactor || (() => false),
    twoFASms: over.twoFASms || null,
    mintPartialSession: over.mintPartialSession || null,
    sessionTtlMs: over.sessionTtlMs,
    now: over.now || (() => new Date('2026-05-22T12:00:00Z')),
    logger: silentLogger,
  });
  svc._audit = audit;
  svc._sessions = sessions;
  return svc;
}

test('LoginService: constructor enforces dep contract', () => {
  assert.throws(() => new LoginService({}), /users repository/);
  const baseDeps = {
    users: { findByEmail: () => {} },
    sessions: { create: () => {} },
    audit: () => {},
    lockout: { isLocked: () => {}, recordFailure: () => {}, recordSuccess: () => {} },
    resolveOrgBySsoDomain: () => {},
    signSessionToken: () => {},
    userHasTwoFactor: () => false,
    orgRequiresTwoFactor: () => false,
  };
  assert.throws(
    () => new LoginService({ ...baseDeps, sessions: {} }),
    /sessions repository/,
  );
  assert.throws(
    () => new LoginService({ ...baseDeps, audit: 'nope' }),
    /audit fn is required/,
  );
  assert.throws(
    () => new LoginService({ ...baseDeps, lockout: { isLocked: () => {} } }),
    /lockout/,
  );
  assert.throws(
    () => new LoginService({ ...baseDeps, resolveOrgBySsoDomain: 'x' }),
    /resolveOrgBySsoDomain/,
  );
});

test('login: SSO-claimed domain short-circuits before lockout/user lookup, audits sso_required', async () => {
  let findCalled = false;
  const lockout = makeLockout();
  const svc = makeSvc({
    resolveOrgBySsoDomain: async () => ({ id: 'org-9', slug: 'acme' }),
    findByEmail: async () => { findCalled = true; return makeUser(); },
    lockout,
  });
  const r = await svc.login({ email: 'a@acme.com', password: 'pw', req: {} });
  assert.deepEqual(r, { ok: false, kind: 'sso_required', org: { id: 'org-9', slug: 'acme' } });
  assert.equal(findCalled, false);
  assert.equal(lockout._calls.isLocked.length, 0);
  assert.equal(svc._audit._calls[0].action, 'login_sso_required');
  assert.equal(svc._audit._calls[0].metadata.orgSlug, 'acme');
});

test('login: locked account returns kind:locked with retryAfterMs and audits account_locked', async () => {
  const lockout = makeLockout({ lockState: { locked: true, attempts: 7, retryAfterMs: 30_000 } });
  const svc = makeSvc({ lockout });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.deepEqual(r, { ok: false, kind: 'locked', retryAfterMs: 30_000, attempts: 7 });
  assert.equal(svc._audit._calls[0].action, 'account_locked');
  assert.equal(svc._audit._calls[0].metadata.reason, 'too_many_failures');
});

test('login: unknown email records failure, audits login_failed, returns invalid_credentials', async () => {
  const lockout = makeLockout({ afterFailure: { locked: false, attempts: 1 } });
  const svc = makeSvc({ findByEmail: async () => null, lockout });
  const r = await svc.login({ email: 'nope@x.com', password: 'pw', req: {} });
  assert.deepEqual(r, { ok: false, kind: 'invalid_credentials' });
  assert.equal(lockout._calls.recordFailure[0], 'nope@x.com');
  const actions = svc._audit._calls.map((c) => c.action);
  assert.deepEqual(actions, ['login_failed']);
  assert.equal(svc._audit._calls[0].metadata.reason, 'unknown_email');
});

test('login: unknown email crossing the lockout threshold ALSO audits account_locked', async () => {
  const lockout = makeLockout({ afterFailure: { locked: true, attempts: 5 } });
  const svc = makeSvc({ findByEmail: async () => null, lockout });
  await svc.login({ email: 'nope@x.com', password: 'pw', req: {} });
  const actions = svc._audit._calls.map((c) => c.action);
  assert.deepEqual(actions, ['login_failed', 'account_locked']);
  assert.equal(svc._audit._calls[1].metadata.reason, 'failure_threshold');
});

test('login: bad password records failure, audits with resourceId, returns invalid_credentials', async () => {
  const lockout = makeLockout({ afterFailure: { locked: false, attempts: 2 } });
  const svc = makeSvc({
    comparePassword: async () => false,
    findByEmail: async () => makeUser({ id: 'u-77' }),
    lockout,
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.deepEqual(r, { ok: false, kind: 'invalid_credentials' });
  assert.equal(svc._audit._calls[0].action, 'login_failed');
  assert.equal(svc._audit._calls[0].resourceId, 'u-77');
  assert.equal(svc._audit._calls[0].metadata.reason, 'bad_password');
});

test('login: bad password crossing lockout threshold also fires account_locked with user id', async () => {
  const lockout = makeLockout({ afterFailure: { locked: true, attempts: 5 } });
  const svc = makeSvc({
    comparePassword: async () => false,
    findByEmail: async () => makeUser({ id: 'u-77' }),
    lockout,
  });
  await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  const actions = svc._audit._calls.map((c) => c.action);
  assert.deepEqual(actions, ['login_failed', 'account_locked']);
  assert.equal(svc._audit._calls[1].resourceId, 'u-77');
});

test('login: org requires 2FA and user has none → org_2fa_required + audit', async () => {
  const prisma = {
    orgMembership: {
      findMany: async () => [
        { organization: { id: 'org-A', slug: 'a', settings: {} } },
      ],
    },
  };
  const svc = makeSvc({
    prisma,
    userHasTwoFactor: () => false,
    orgRequiresTwoFactor: (org) => org.id === 'org-A',
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.deepEqual(r, { ok: false, kind: 'org_2fa_required', orgId: 'org-A' });
  const blockAudit = svc._audit._calls.find((c) => c.action === 'login_blocked_org_2fa');
  assert.ok(blockAudit);
  assert.equal(blockAudit.metadata.orgId, 'org-A');
});

test('login: org-2FA check failing open (DB throws) → continues to session mint', async () => {
  const prisma = {
    orgMembership: { findMany: async () => { throw new Error('boom'); } },
  };
  const svc = makeSvc({
    prisma,
    userHasTwoFactor: () => false,
    orgRequiresTwoFactor: () => true,
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'TOKEN(u-1)');
});

test('login: SMS 2FA gate mints challenge, sends OTP, audits, returns sms_2fa_required', async () => {
  const twoFASms = {
    isValidPhone: () => true,
    createSmsChallenge: async () => ({
      challengeId: 'ch-1',
      code: '123456',
      expiresAt: new Date('2026-05-22T12:05:00Z'),
    }),
    sendSms: async () => ({ sent: true }),
  };
  const svc = makeSvc({
    twoFASms,
    findByEmail: async () => makeUser({
      twoFactorEnabled: true,
      phone: '+15551234',
      phoneVerifiedAt: new Date(),
    }),
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'sms_2fa_required');
  assert.equal(r.challengeId, 'ch-1');
  assert.equal(r.smsSent, true);
  assert.equal(r.smsSkippedReason, undefined);
  const audit = svc._audit._calls.find((c) => c.action === 'login_2fa_required');
  assert.ok(audit);
  assert.equal(audit.metadata.smsSent, true);
  assert.match(audit.metadata.phoneMasked, /^\*+1234$/);
});

test('login: SMS skipped surfaces smsSkippedReason in the result', async () => {
  const twoFASms = {
    isValidPhone: () => true,
    createSmsChallenge: async () => ({
      challengeId: 'ch-2', code: '0', expiresAt: new Date('2026-05-22T12:05:00Z'),
    }),
    sendSms: async () => ({ sent: false, reason: 'sms_disabled' }),
  };
  const svc = makeSvc({
    twoFASms,
    findByEmail: async () => makeUser({
      twoFactorEnabled: true, phone: '+15559876', phoneVerifiedAt: new Date(),
    }),
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.equal(r.kind, 'sms_2fa_required');
  assert.equal(r.smsSent, false);
  assert.equal(r.smsSkippedReason, 'sms_disabled');
});

test('login: SMS challenge mint throws → kind:sms_2fa_mint_failed', async () => {
  const twoFASms = {
    isValidPhone: () => true,
    createSmsChallenge: async () => { throw new Error('twilio down'); },
    sendSms: async () => ({ sent: true }),
  };
  const svc = makeSvc({
    twoFASms,
    findByEmail: async () => makeUser({
      twoFactorEnabled: true, phone: '+15551234', phoneVerifiedAt: new Date(),
    }),
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.deepEqual(r, { ok: false, kind: 'sms_2fa_mint_failed' });
});

test('login: TOTP-only user (totpEnabled, !twoFactorEnabled) → totp_2fa_required + partial token', async () => {
  const svc = makeSvc({
    findByEmail: async () => makeUser({ totpEnabled: true, twoFactorEnabled: false }),
    mintPartialSession: async (uid) => ({
      token: `partial-${uid}`,
      expiresAt: new Date('2026-05-22T12:05:00Z'),
    }),
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.equal(r.kind, 'totp_2fa_required');
  assert.equal(r.partialToken, 'partial-u-1');
  const audit = svc._audit._calls.find((c) => c.action === 'login_totp_required');
  assert.ok(audit);
});

test('login: TOTP partial mint throws → kind:totp_partial_mint_failed', async () => {
  const svc = makeSvc({
    findByEmail: async () => makeUser({ totpEnabled: true, twoFactorEnabled: false }),
    mintPartialSession: async () => { throw new Error('db down'); },
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.deepEqual(r, { ok: false, kind: 'totp_partial_mint_failed' });
});

test('login: SMS-enabled user wins over TOTP (TOTP branch not used)', async () => {
  let totpCalled = false;
  const twoFASms = {
    isValidPhone: () => true,
    createSmsChallenge: async () => ({
      challengeId: 'ch', code: '0', expiresAt: new Date('2026-05-22T12:05:00Z'),
    }),
    sendSms: async () => ({ sent: true }),
  };
  const svc = makeSvc({
    twoFASms,
    findByEmail: async () => makeUser({
      twoFactorEnabled: true, phone: '+15551234', phoneVerifiedAt: new Date(),
      totpEnabled: true,
    }),
    mintPartialSession: async () => { totpCalled = true; return { token: 'p', expiresAt: new Date() }; },
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.equal(r.kind, 'sms_2fa_required');
  assert.equal(totpCalled, false);
});

test('login: happy path mints session, embeds admin claims, persists row with fingerprint, clears lockout', async () => {
  const NOW = new Date('2026-05-22T12:00:00Z');
  const signCalls = [];
  const lockout = makeLockout();
  const svc = makeSvc({
    findByEmail: async () => makeUser({ id: 'u-42', isAdmin: true, isSuperAdmin: true }),
    signSessionToken: (p) => { signCalls.push(p); return 'JWT'; },
    lockout,
    now: () => NOW,
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: { ip: '1.2.3.4' } });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'JWT');
  assert.equal(r.expiresAt.getTime(), NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(signCalls[0], { userId: 'u-42', isAdmin: true, isSuperAdmin: true });
  assert.equal(svc._sessions._calls.length, 1);
  assert.deepEqual(svc._sessions._calls[0], {
    userId: 'u-42', token: 'JWT', expiresAt: r.expiresAt, fingerprint: 'fp-1',
  });
  assert.deepEqual(lockout._calls.recordSuccess, ['u@x.com']);
});

test('login: respects custom sessionTtlMs', async () => {
  const NOW = new Date('2026-05-22T12:00:00Z');
  const svc = makeSvc({ sessionTtlMs: 60_000, now: () => NOW });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.equal(r.expiresAt.getTime(), NOW.getTime() + 60_000);
});

test('login: when audit fn throws synchronously, login still succeeds', async () => {
  const svc = makeSvc({
    audit: () => { throw new Error('audit boom'); },
  });
  const r = await svc.login({ email: 'u@x.com', password: 'pw', req: {} });
  assert.equal(r.ok, true);
});
