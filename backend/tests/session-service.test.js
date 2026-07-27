'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionService } = require('../src/services/SessionService');

const silentLogger = { error: () => {}, warn: () => {}, log: () => {} };

function makeSvc(over = {}) {
  const updateCalls = [];
  const deleteCalls = [];
  const auditCalls = [];
  const revocationCalls = [];

  const sessions = over.sessions || {
    updateByToken: async (oldToken, data) => {
      updateCalls.push({ oldToken, data });
      return { id: 's-1', token: data.newToken };
    },
    deleteByToken: async (token) => {
      deleteCalls.push(token);
      return { count: 1 };
    },
  };
  const audit = over.audit || ((_prisma, payload) => { auditCalls.push(payload); });

  const svc = new SessionService({
    sessions,
    audit,
    prisma: over.prisma || {},
    signSessionToken: over.signSessionToken || (({ userId, isAdmin, isSuperAdmin }) =>
      `TOKEN(${userId}|${isAdmin ? 'A' : '-'}|${isSuperAdmin ? 'S' : '-'})`),
    computeFingerprint: over.computeFingerprint || (() => 'fp-1'),
    sessionTtlMs: over.sessionTtlMs,
    now: over.now || (() => new Date('2026-05-22T12:00:00Z')),
    logger: silentLogger,
    publishSessionsRevoked: over.publishSessionsRevoked || (async (event) => {
      revocationCalls.push(event);
    }),
  });
  svc._updateCalls = updateCalls;
  svc._deleteCalls = deleteCalls;
  svc._auditCalls = auditCalls;
  svc._revocationCalls = revocationCalls;
  return svc;
}

test('SessionService: constructor enforces dep contract', () => {
  assert.throws(() => new SessionService({}), /sessions repository/);
  const baseDeps = {
    sessions: { updateByToken: () => {}, deleteByToken: () => {} },
    audit: () => {},
    signSessionToken: () => 'tok',
  };
  assert.throws(
    () => new SessionService({ ...baseDeps, sessions: { updateByToken: () => {} } }),
    /sessions repository/,
  );
  assert.throws(
    () => new SessionService({ ...baseDeps, audit: 'nope' }),
    /audit fn is required/,
  );
  assert.throws(
    () => new SessionService({ ...baseDeps, signSessionToken: null }),
    /signSessionToken/,
  );
  // Happy path: optional deps default safely.
  const svc = new SessionService(baseDeps);
  assert.equal(typeof svc.computeFingerprint, 'function');
  assert.equal(svc.computeFingerprint(), null);
});

test('SessionService.refresh re-signs token, rotates row, re-binds fingerprint, audits', async () => {
  const svc = makeSvc();
  const user = { id: 'u-7', email: 'u@x.com', isAdmin: true, isSuperAdmin: false };
  const req = { ip: '1.2.3.4' };

  const out = await svc.refresh({ user, oldToken: 'OLD', req });

  assert.equal(out.ok, true);
  assert.equal(out.token, 'TOKEN(u-7|A|-)');
  assert.ok(out.expiresAt instanceof Date);
  // 7-day default TTL relative to injected `now`.
  assert.equal(
    out.expiresAt.toISOString(),
    new Date('2026-05-29T12:00:00Z').toISOString(),
  );

  assert.equal(svc._updateCalls.length, 1);
  assert.deepEqual(svc._updateCalls[0], {
    oldToken: 'OLD',
    data: {
      newToken: 'TOKEN(u-7|A|-)',
      expiresAt: out.expiresAt,
      fingerprint: 'fp-1',
    },
  });

  assert.equal(svc._auditCalls.length, 1);
  assert.deepEqual(svc._auditCalls[0], {
    req,
    action: 'token_refresh',
    resource: 'session',
    userId: 'u-7',
    actorName: 'u@x.com',
  });
});

test('SessionService.refresh re-embeds super-admin claim across refreshes', async () => {
  const svc = makeSvc();
  const out = await svc.refresh({
    user: { id: 'sa', email: 'sa@x.com', isAdmin: true, isSuperAdmin: true },
    oldToken: 'OLD',
    req: {},
  });
  assert.equal(out.token, 'TOKEN(sa|A|S)');
});

test('SessionService.refresh tolerates fingerprint computation returning null', async () => {
  const svc = makeSvc({ computeFingerprint: () => null });
  await svc.refresh({
    user: { id: 'u-1', email: 'u@x.com' },
    oldToken: 'OLD',
    req: {},
  });
  assert.equal(svc._updateCalls[0].data.fingerprint, null);
});

test('SessionService.refresh propagates repo errors and skips audit', async () => {
  const svc = makeSvc({
    sessions: {
      updateByToken: async () => { throw new Error('db down'); },
      deleteByToken: async () => {},
    },
  });
  await assert.rejects(
    () => svc.refresh({ user: { id: 'u', email: 'u@x' }, oldToken: 'OLD', req: {} }),
    /db down/,
  );
  assert.equal(svc._auditCalls.length, 0);
});

test('SessionService.refresh swallows audit errors so the request still succeeds', async () => {
  const svc = makeSvc({
    audit: () => { throw new Error('audit blew up'); },
  });
  const out = await svc.refresh({
    user: { id: 'u', email: 'u@x' },
    oldToken: 'OLD',
    req: {},
  });
  assert.equal(out.ok, true);
  assert.equal(svc._updateCalls.length, 1);
});

test('SessionService.refresh honours a custom sessionTtlMs', async () => {
  const svc = makeSvc({ sessionTtlMs: 60 * 1000 });
  const out = await svc.refresh({
    user: { id: 'u', email: 'u@x' },
    oldToken: 'OLD',
    req: {},
  });
  assert.equal(
    out.expiresAt.toISOString(),
    new Date('2026-05-22T12:01:00Z').toISOString(),
  );
});

test('SessionService.revoke deletes by token and audits logout', async () => {
  const svc = makeSvc();
  const user = { id: 'u-9', email: 'u@x.com' };
  const req = { ip: '1.2.3.4' };

  const out = await svc.revoke({ user, token: 'OLD', req });

  assert.deepEqual(out, { ok: true });
  assert.deepEqual(svc._deleteCalls, ['OLD']);
  assert.deepEqual(svc._revocationCalls, [{
    userId: 'u-9',
    reason: 'session_revoked',
  }]);
  assert.equal(svc._auditCalls.length, 1);
  assert.deepEqual(svc._auditCalls[0], {
    req,
    action: 'logout',
    resource: 'session',
    userId: 'u-9',
    actorName: 'u@x.com',
  });
});

test('SessionService.revoke tolerates a missing user (defensive)', async () => {
  const svc = makeSvc();
  await svc.revoke({ user: null, token: 'OLD', req: {} });
  assert.deepEqual(svc._deleteCalls, ['OLD']);
  assert.equal(svc._auditCalls[0].userId, undefined);
  assert.equal(svc._auditCalls[0].actorName, undefined);
});

test('SessionService.revoke propagates repo errors', async () => {
  const svc = makeSvc({
    sessions: {
      updateByToken: async () => {},
      deleteByToken: async () => { throw new Error('boom'); },
    },
  });
  await assert.rejects(
    () => svc.revoke({ user: { id: 'u' }, token: 'OLD', req: {} }),
    /boom/,
  );
  assert.equal(svc._auditCalls.length, 0);
});

test('SessionService: zero raw prisma.session.* calls (uses repo only)', async () => {
  const repoCalls = [];
  const sessions = {
    updateByToken: async (...a) => { repoCalls.push(['update', ...a]); return {}; },
    deleteByToken: async (...a) => { repoCalls.push(['delete', ...a]); return {}; },
  };
  const svc = new SessionService({
    sessions,
    audit: () => {},
    signSessionToken: () => 'T',
  });
  await svc.refresh({ user: { id: 'u' }, oldToken: 'O', req: {} });
  await svc.revoke({ user: { id: 'u' }, token: 'O', req: {} });
  assert.equal(repoCalls.length, 2);
  assert.equal(repoCalls[0][0], 'update');
  assert.equal(repoCalls[1][0], 'delete');
});
