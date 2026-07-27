'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SsoCallbackService } = require('../src/services/SsoCallbackService');

const silentLogger = { error: () => {}, warn: () => {}, log: () => {} };

function makeRes() {
  let _status = 200;
  let _body;
  return {
    status(c) { _status = c; return this; },
    json(p) { _body = p; return this; },
    get _status() { return _status },
    get _body() { return _body },
  };
}

function makePrisma(extra = {}) {
  const sessionCreates = [];
  const sessionDeletes = [];
  const db = {
    user: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: 'u-new', ...data }),
      ...(extra.user || {}),
    },
    session: {
      create: async ({ data }) => {
        sessionCreates.push(data);
        return { id: `session-${sessionCreates.length}`, ...data };
      },
      deleteMany: async ({ where }) => {
        sessionDeletes.push(where);
        return { count: 1 };
      },
      ...(extra.session || {}),
    },
    orgMembership: {
      findUnique: async () => null,
      upsert: async () => ({}),
      ...(extra.orgMembership || {}),
    },
    orgInvitation: extra.orgInvitation,
    sSOIdentity: extra.sSOIdentity,
    organization: { findUnique: async () => null },
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) return [{ lock_timeout: params[0] || '0' }];
      if (/pg_advisory_xact_lock/i.test(sql)) return [{ locked: true }];
      return [];
    },
  };
  db.$transaction = extra.$transaction || (async (fn) => fn(db));
  db._sessionCreates = sessionCreates;
  db._sessionDeletes = sessionDeletes;
  return db;
}

const fixedOrg = {
  id: 'org1', slug: 'acme', ssoEnabled: true,
  ssoConfig: { provider: 'saml', cert: 'X' },
};

function makeSvc(over = {}) {
  return new SsoCallbackService({
    prisma: over.prisma || makePrisma(),
    audit: over.audit || (() => {}),
    samlHandler: over.samlHandler || { verifySamlResponse: async () => ({ ok: true, email: 'a@x.com', displayName: 'A', nameId: 'sub-1' }) },
    oidcHandler: over.oidcHandler || { verifyOidcCode: async () => ({ ok: true, email: 'a@x.com', displayName: 'A', nameId: 'sub-1' }) },
    resolveOrg: over.resolveOrg || (async () => fixedOrg),
    signSessionToken: over.signSessionToken || (() => 'TOKEN'),
    rbacAssignments: over.rbacAssignments || {
      syncLegacyAdminAssignment: async () => ({ denied: false }),
      syncOrgRoleAssignment: async () => ({ denied: false }),
      invalidateUser: async () => {},
    },
    hashPassword: over.hashPassword || (async () => 'HASH'),
    now: over.now || (() => new Date('2026-01-01T00:00:00Z')),
    logger: silentLogger,
  });
}

test('SsoCallbackService: constructor enforces all dependencies', () => {
  assert.throws(() => new SsoCallbackService({}), /prisma is required/);
  assert.throws(
    () => new SsoCallbackService({ prisma: {}, audit: () => {}, samlHandler: {}, oidcHandler: { verifyOidcCode: () => {} }, resolveOrg: () => {}, signSessionToken: () => {} }),
    /samlHandler.verifySamlResponse is required/
  );
});

test('handle: 404 when resolveOrg returns null', async () => {
  const svc = makeSvc({ resolveOrg: async () => null });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'nope' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 404);
});

test('handle: 400 when SSO disabled', async () => {
  const svc = makeSvc({ resolveOrg: async () => ({ ...fixedOrg, ssoEnabled: false }) });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 400);
});

test('handle: defaults provisioning policy to jit_create on typo, audits attempt with normalised policy', async () => {
  const audits = [];
  const svc = makeSvc({
    audit: (_db, p) => audits.push(p),
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { ...fixedOrg.ssoConfig, provisioning: 'BoGuS' } }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  const attempt = audits.find((a) => a.action === 'sso_login_attempt');
  assert.equal(attempt.metadata.policy, 'jit_create');
});

test('handle: maps verifier failure to its status + error shape', async () => {
  const svc = makeSvc({
    samlHandler: { verifySamlResponse: async () => ({ ok: false, status: 403, error: 'bad_sig', hint: 'h' }) },
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 403);
  assert.deepEqual(res._body, { ok: false, error: 'bad_sig', hint: 'h', orgSlug: 'acme' });
});

test('handle: manual policy denies non-member with audit + 403', async () => {
  const audits = [];
  const existing = { id: 'u1', email: 'a@x.com', name: 'A', isAdmin: false };
  const svc = makeSvc({
    audit: (_db, p) => audits.push(p),
    prisma: makePrisma({ user: { findUnique: async () => existing } }),
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { ...fixedOrg.ssoConfig, provisioning: 'manual' } }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'sso_provisioning_denied');
  const denied = audits.find((a) => a.action === 'sso_login_denied');
  assert.equal(denied.metadata.reason, 'not_a_member');
});

test('handle: jit_require_invite accepts pending invite, marks acceptedAt with injected clock', async () => {
  const NOW = new Date('2026-05-22T00:00:00Z');
  const audits = [];
  const inv = { id: 'inv-1', orgId: 'org1', email: 'a@x.com', acceptedAt: null, expiresAt: new Date('2026-12-31T00:00:00Z') };
  const updateCalls = [];
  const svc = makeSvc({
    audit: (_db, p) => audits.push(p),
    now: () => NOW,
    prisma: makePrisma({
      orgInvitation: {
        findFirst: async ({ where }) => (where.expiresAt.gt.getTime() === NOW.getTime() ? inv : null),
        update: async ({ where, data }) => { updateCalls.push({ where, data }); return inv; },
      },
    }),
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { ...fixedOrg.ssoConfig, provisioning: 'jit_require_invite' } }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 200);
  assert.equal(updateCalls[0].where.id, 'inv-1');
  assert.equal(updateCalls[0].data.acceptedAt.getTime(), NOW.getTime());
  const success = audits.find((a) => a.action === 'sso_login_success');
  assert.equal(success.metadata.invitationAccepted, 'inv-1');
});

test('handle: links SSOIdentity by (provider, externalId) — create when missing, update lastUsedAt when existing', async () => {
  const NOW = new Date('2026-05-22T00:00:00Z');
  const createCalls = [];
  const updateCalls = [];

  // First call: no existing identity → create
  let svc = makeSvc({
    now: () => NOW,
    prisma: makePrisma({
      sSOIdentity: {
        findUnique: async () => null,
        create: async ({ data }) => { createCalls.push(data); return { id: 'idn-1' }; },
      },
    }),
  });
  let res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 200);
  assert.equal(createCalls[0].provider, 'saml');
  assert.equal(createCalls[0].externalId, 'sub-1');

  // Second call: existing → update lastUsedAt with injected clock
  svc = makeSvc({
    now: () => NOW,
    prisma: makePrisma({
      sSOIdentity: {
        findUnique: async () => ({ id: 'idn-1' }),
        update: async ({ where, data }) => { updateCalls.push({ where, data }); return {}; },
      },
    }),
  });
  res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(updateCalls[0].where.id, 'idn-1');
  assert.equal(updateCalls[0].data.lastUsedAt.getTime(), NOW.getTime());
});

test('handle: catches downstream errors and returns 500 sso_login_failed (audit failure never bubbles)', async () => {
  const svc = makeSvc({
    prisma: makePrisma({
      user: { findUnique: async () => { throw new Error('db dead'); } },
    }),
  });
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 500);
  assert.deepEqual(res._body, { ok: false, error: 'sso_login_failed' });
});

test('handle: OIDC branch dispatches to oidcHandler, reads code from query and from body', async () => {
  const oidcCalls = [];
  const oidc = { verifyOidcCode: async (code) => { oidcCalls.push(code); return { ok: true, email: 'a@x.com', displayName: 'A', nameId: 's' }; } };
  const svc = makeSvc({
    oidcHandler: oidc,
    resolveOrg: async () => ({ ...fixedOrg, ssoConfig: { provider: 'oidc' } }),
  });

  let res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, query: { code: 'Q-CODE' }, body: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(oidcCalls[0], 'Q-CODE');

  res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, query: {}, body: { code: 'B-CODE' } }, res);
  assert.equal(oidcCalls[1], 'B-CODE');
});

test('handle: success body shape matches legacy contract (ok, token, user{id,email,name}, orgSlug, createdUser, policy)', async () => {
  const svc = makeSvc();
  const res = makeRes();
  await svc.handle({ params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } }, res);
  assert.equal(res._status, 200);
  assert.deepEqual(Object.keys(res._body).sort(), ['createdUser', 'ok', 'orgSlug', 'policy', 'token', 'user'].sort());
  assert.deepEqual(Object.keys(res._body.user).sort(), ['email', 'id', 'name'].sort());
  assert.equal(res._body.ok, true);
  assert.equal(res._body.policy, 'jit_create');
});

test('handle: soft-deleted SSO user is denied and all existing sessions are revoked', async () => {
  const existing = {
    id: 'deleted-sso-user',
    email: 'a@x.com',
    name: 'Deleted',
    isAdmin: false,
    isSuperAdmin: false,
    deletedAt: new Date('2026-06-01T00:00:00Z'),
  };
  const prisma = makePrisma({
    user: { findUnique: async () => existing },
    orgMembership: {
      findUnique: async () => ({
        orgId: fixedOrg.id,
        userId: existing.id,
        role: 'MEMBER',
      }),
    },
  });
  const svc = makeSvc({ prisma });
  const res = makeRes();

  await svc.handle(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
  );

  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'sso_user_inactive');
  assert.deepEqual(prisma._sessionDeletes, [{ userId: existing.id }]);
  assert.equal(prisma._sessionCreates.length, 0);
});

test('handle: inactive RBAC synchronization result is authoritative and prevents SSO session minting', async () => {
  const existing = {
    id: 'sso-user',
    email: 'a@x.com',
    name: 'A',
    isAdmin: false,
    isSuperAdmin: false,
    deletedAt: null,
  };
  const prisma = makePrisma({
    user: { findUnique: async () => existing },
    orgMembership: {
      findUnique: async () => ({
        orgId: fixedOrg.id,
        userId: existing.id,
        role: 'MEMBER',
      }),
      upsert: async () => ({
        orgId: fixedOrg.id,
        userId: existing.id,
        role: 'MEMBER',
      }),
    },
  });
  const svc = makeSvc({
    prisma,
    rbacAssignments: {
      syncLegacyAdminAssignment: async () => ({ denied: false }),
      syncOrgRoleAssignment: async () => ({
        denied: true,
        reason: 'inactive_user',
      }),
      invalidateUser: async () => {},
    },
  });
  const res = makeRes();

  await svc.handle(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
  );

  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'sso_user_inactive');
  assert.deepEqual(prisma._sessionDeletes, [{ userId: existing.id }]);
  assert.equal(prisma._sessionCreates.length, 0);
});

test('handle: IdP verification precedes one locked transaction containing every local SSO write', async () => {
  const events = [];
  let lockHeld = false;
  const assertLockedWrite = (name) => {
    assert.equal(lockHeld, true, `${name} must not write before the global RBAC lock`);
    events.push(name);
  };
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      if (/pg_advisory_xact_lock/i.test(sql)) {
        events.push('lock');
        lockHeld = true;
        return [{ locked: true }];
      }
      if (/set_config/i.test(sql)) {
        const resetting = params.length === 0 || String(params[0]) === '0';
        events.push(resetting ? 'lock-timeout-reset' : 'lock-timeout');
        return [{ lock_timeout: resetting ? '0' : params[0] }];
      }
      return [];
    },
    user: {
      async findUnique() {
        assert.equal(lockHeld, true, 'user source of truth must be read after lock');
        events.push('tx-user-read');
        return null;
      },
      async create({ data }) {
        assertLockedWrite('user-create');
        return { id: 'u-locked', deletedAt: null, ...data };
      },
    },
    orgMembership: {
      async findUnique() {
        assert.equal(lockHeld, true);
        events.push('membership-read');
        return null;
      },
      async upsert({ create }) {
        assertLockedWrite('membership-upsert');
        return create;
      },
    },
    sSOIdentity: {
      async findUnique() {
        assert.equal(lockHeld, true);
        return null;
      },
      async create({ data }) {
        assertLockedWrite('identity-create');
        return { id: 'identity-1', ...data };
      },
    },
    session: {
      async create({ data }) {
        assertLockedWrite('session-create');
        return { id: 'session-1', ...data };
      },
      async deleteMany() {
        assertLockedWrite('session-delete');
        return { count: 0 };
      },
    },
  };
  const prisma = {
    user: {
      async findUnique() {
        events.push('root-user-read');
        return null;
      },
      async create() {
        assert.fail('root user writer must not run outside the transaction');
      },
    },
    orgMembership: {
      async upsert() {
        assert.fail('root membership writer must not run outside the transaction');
      },
    },
    sSOIdentity: {
      async findUnique() {
        assert.fail('identity lookup must use the locked transaction');
      },
      async create() {
        assert.fail('identity writer must use the locked transaction');
      },
    },
    session: {
      async create() {
        assert.fail('session writer must use the locked transaction');
      },
    },
    async $transaction(fn) {
      events.push('transaction');
      return fn(tx);
    },
  };
  const rbacAssignments = {
    async syncLegacyAdminAssignment(args) {
      assert.equal(args.prismaClient, tx);
      assert.equal(args.lockAlreadyHeld, true);
      assertLockedWrite('rbac-global-sync');
      return { denied: false };
    },
    async syncOrgRoleAssignment(args) {
      assert.equal(args.prismaClient, tx);
      assert.equal(args.lockAlreadyHeld, true);
      assertLockedWrite('rbac-org-sync');
      return { denied: false };
    },
    async invalidateUser() {
      events.push('cache-invalidate');
    },
  };
  const svc = makeSvc({
    prisma,
    rbacAssignments,
    samlHandler: {
      async verifySamlResponse() {
        events.push('idp-verify');
        return {
          ok: true,
          email: 'a@x.com',
          displayName: 'A',
          nameId: 'sub-1',
        };
      },
    },
  });
  const res = makeRes();

  await svc.handle(
    { params: { orgSlug: 'acme' }, body: { SAMLResponse: 'x' } },
    res,
  );

  assert.equal(res._status, 200);
  assert.ok(events.indexOf('idp-verify') < events.indexOf('transaction'));
  assert.deepEqual(
    events.filter((event) => [
      'lock',
      'user-create',
      'membership-upsert',
      'rbac-global-sync',
      'rbac-org-sync',
      'identity-create',
      'session-create',
    ].includes(event)),
    [
      'lock',
      'user-create',
      'rbac-global-sync',
      'membership-upsert',
      'rbac-org-sync',
      'identity-create',
      'session-create',
    ],
  );
});
