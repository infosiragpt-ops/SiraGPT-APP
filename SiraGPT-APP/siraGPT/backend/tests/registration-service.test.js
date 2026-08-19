'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RegistrationService } = require('../src/services/RegistrationService');

const silentLogger = { error: () => {}, warn: () => {}, log: () => {} };

function makeSvc(over = {}) {
  const createCalls = [];
  const sessionCalls = [];
  const users = {
    findByEmail: over.findByEmail || (async () => null),
    createPasswordUser: over.createPasswordUser || (async ({ name, email, passwordHash }) => {
      const u = { id: 'u-1', name, email, password: passwordHash, plan: 'FREE', isAdmin: false, isSuperAdmin: false };
      createCalls.push(u);
      return u;
    }),
    _createCalls: createCalls,
  };
  const sessions = {
    create: async (row) => { sessionCalls.push(row); return row; },
    _calls: sessionCalls,
  };
  return new RegistrationService({
    users,
    sessions,
    resolveOrgBySsoDomain: over.resolveOrgBySsoDomain || (async () => null),
    signSessionToken: over.signSessionToken || (({ userId }) => `TOKEN(${userId})`),
    hashPassword: over.hashPassword || (async (p) => `H(${p})`),
    now: over.now || (() => new Date('2026-01-01T00:00:00Z')),
    logger: silentLogger,
  });
}

test('RegistrationService: constructor enforces dep contract', () => {
  assert.throws(() => new RegistrationService({}), /users repository .* is required/);
  assert.throws(
    () => new RegistrationService({
      users: { findByEmail: () => {}, createPasswordUser: () => {} },
      sessions: {}, resolveOrgBySsoDomain: () => {}, signSessionToken: () => {},
    }),
    /sessions repository is required/
  );
  assert.throws(
    () => new RegistrationService({
      users: { findByEmail: () => {}, createPasswordUser: () => {} },
      sessions: { create: () => {} },
      resolveOrgBySsoDomain: 'not-fn', signSessionToken: () => {},
    }),
    /resolveOrgBySsoDomain is required/
  );
});

test('register: SSO domain claim short-circuits before any user lookup or write', async () => {
  let findCalled = false;
  const svc = makeSvc({
    findByEmail: async () => { findCalled = true; return null; },
    resolveOrgBySsoDomain: async () => ({ id: 'org-1', slug: 'acme' }),
  });
  const r = await svc.register({ name: 'X', email: 'x@acme.com', password: 'pw12345678' });
  assert.deepEqual(r, { ok: false, kind: 'sso_required', org: { id: 'org-1', slug: 'acme' } });
  assert.equal(findCalled, false);
});

test('register: duplicate email returns kind:duplicate without hashing or writing', async () => {
  let hashCalled = false;
  const svc = makeSvc({
    findByEmail: async () => ({ id: 'u-existing' }),
    hashPassword: async (p) => { hashCalled = true; return `H(${p})`; },
  });
  const r = await svc.register({ name: 'X', email: 'x@x.com', password: 'pw12345678' });
  assert.deepEqual(r, { ok: false, kind: 'duplicate' });
  assert.equal(hashCalled, false);
});

test('register: happy path hashes, creates user, mints session with 7d expiry from injected clock', async () => {
  const NOW = new Date('2026-05-22T12:00:00Z');
  const svc = makeSvc({ now: () => NOW });
  const r = await svc.register({ name: 'New', email: 'n@x.com', password: 'pw12345678' });
  assert.equal(r.ok, true);
  assert.equal(r.user.email, 'n@x.com');
  assert.equal(r.user.password, 'H(pw12345678)');
  assert.equal(r.token, 'TOKEN(u-1)');
  assert.equal(r.expiresAt.getTime(), NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  // session row was persisted with matching token + expiresAt
  assert.equal(svc.sessions._calls.length, 1);
  assert.equal(svc.sessions._calls[0].userId, 'u-1');
  assert.equal(svc.sessions._calls[0].token, 'TOKEN(u-1)');
});

test('register: signSessionToken claims include isAdmin/isSuperAdmin flags from created user', async () => {
  const signCalls = [];
  const svc = makeSvc({
    createPasswordUser: async () => ({ id: 'u-9', isAdmin: true, isSuperAdmin: true, name: 'A', email: 'a@x.com' }),
    signSessionToken: (payload) => { signCalls.push(payload); return 'T'; },
  });
  await svc.register({ name: 'A', email: 'a@x.com', password: 'pw12345678' });
  assert.deepEqual(signCalls[0], { userId: 'u-9', isAdmin: true, isSuperAdmin: true });
});

test('register: respects custom sessionTtlMs', async () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  const svc = new RegistrationService({
    users: { findByEmail: async () => null, createPasswordUser: async () => ({ id: 'u', isAdmin: false }) },
    sessions: { create: async () => ({}) },
    resolveOrgBySsoDomain: async () => null,
    signSessionToken: () => 'T',
    hashPassword: async () => 'H',
    sessionTtlMs: 60 * 1000,
    now: () => NOW,
  });
  const r = await svc.register({ name: 'X', email: 'x@x.com', password: 'pw12345678' });
  assert.equal(r.expiresAt.getTime(), NOW.getTime() + 60 * 1000);
});
