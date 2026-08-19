'use strict';

/**
 * Ratchet 44 — tests for the org-scoped audit-logs free-text search.
 *
 *   GET /api/orgs/:id/audit-logs/search  (ADMIN+)
 *
 * Mirrors the super-admin /api/admin/audit-logs/search endpoint but
 * pins the byOrg filter to the path parameter. The route reuses the
 * shared `search()` helper from `services/audit-query`, passing
 * `{ orgId: req.params.id }` so the ILIKE predicate is intersected
 * with `metadata->>'orgId' = $N` in the parameterised SQL.
 *
 * Exercises the handler directly via the __handlers export so we don't
 * need to bind an Express app + HTTP server.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');
const {
  search,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
} = require('../src/services/audit-query');

const { searchOrgAuditLogs } = orgsRouter.__handlers;

function makeRes() {
  let status = 200;
  let body;
  let ended = false;
  return {
    status(code) { status = code; return this; },
    json(payload) { body = payload; ended = true; return this; },
    get _status() { return status; },
    get _body() { return body; },
    get _ended() { return ended; },
  };
}

function makeFakePrisma({ members = {}, orgs = {}, items = [], total = null } = {}) {
  const rawCalls = [];

  const orgMembership = {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const m = members[`${orgId}:${userId}`];
      if (!m) return null;
      const org = orgs[orgId] || { id: orgId, slug: orgId };
      return { id: 'mem', orgId, userId, role: m.role, organization: org };
    },
  };

  return {
    prisma: {
      orgMembership,
      async $queryRawUnsafe(sql, ...params) {
        rawCalls.push({ sql, params });
        if (/COUNT\(\*\)/i.test(sql)) {
          return [{ count: total === null ? items.length : total }];
        }
        return items;
      },
      _rawCalls: rawCalls,
    },
  };
}

// ── Handler ────────────────────────────────────────────────────────

describe('GET /api/orgs/:id/audit-logs/search handler', () => {
  test('ADMIN search returns items + paginated shape', async () => {
    const rows = [
      { id: 'a1', action: 'login', metadata: { orgId: 'o1', email: 'a@x' } },
      { id: 'a2', action: 'logout', metadata: { orgId: 'o1', email: 'a@x' } },
    ];
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'acme' } },
      items: rows,
      total: 7,
    });
    const req = {
      user: { id: 'admin1' },
      params: { id: 'o1' },
      query: { q: 'a@x' },
    };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });

    assert.equal(res._status, 200);
    assert.equal(res._body.items.length, 2);
    assert.equal(res._body.total, 7);
    assert.equal(res._body.page, 1);
    assert.equal(res._body.limit, SEARCH_LIMIT_DEFAULT);
    assert.equal(res._body.pages, Math.ceil(7 / SEARCH_LIMIT_DEFAULT));
  });

  test('orgId is pinned to path param — ?orgId= in query is ignored', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'o-one' } },
      items: [],
    });
    const req = {
      user: { id: 'admin1' },
      params: { id: 'o1' },
      // Attacker tries to widen scope to o2 — must be ignored.
      query: { q: 'alice', orgId: 'o2' },
    };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 200);

    // Both the items query and the count query should carry the path
    // orgId, never the query-string orgId.
    const itemsCall = prisma._rawCalls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    const countCall = prisma._rawCalls.find((c) => /COUNT\(\*\)/i.test(c.sql));
    assert.ok(itemsCall, 'items query executed');
    assert.ok(countCall, 'count query executed');
    // itemsParams: [pattern, limit, offset, orgId]
    assert.equal(itemsCall.params[3], 'o1');
    // countParams: [pattern, orgId]
    assert.equal(countCall.params[1], 'o1');
    // SQL must include the metadata->>'orgId' predicate.
    assert.match(itemsCall.sql, /"metadata"->>'orgId' = \$4/);
    assert.match(countCall.sql, /"metadata"->>'orgId' = \$2/);
  });

  test('q < 2 chars returns 400', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'o' } },
    });
    const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: { q: 'a' } };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 400);
    assert.match(res._body.error, /at least 2 characters/);
  });

  test('whitespace-only q returns 400', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'o' } },
    });
    const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: { q: '   ' } };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 400);
  });

  test('missing q returns 400', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'o' } },
    });
    const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: {} };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 400);
  });

  test('MEMBER role is rejected (403)', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:m1': { role: 'MEMBER' } },
      orgs: { o1: { id: 'o1', slug: 'o' } },
    });
    const req = { user: { id: 'm1' }, params: { id: 'o1' }, query: { q: 'hello' } };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 403);
  });

  test('VIEWER role is rejected (403)', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:v1': { role: 'VIEWER' } },
      orgs: { o1: { id: 'o1', slug: 'o' } },
    });
    const req = { user: { id: 'v1' }, params: { id: 'o1' }, query: { q: 'hello' } };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 403);
  });

  test('non-member returns 404 (assertMembership)', async () => {
    const { prisma } = makeFakePrisma({ members: {} });
    const req = { user: { id: 'ghost' }, params: { id: 'o1' }, query: { q: 'hello' } };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 404);
  });

  test('OWNER role is allowed', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:owner1': { role: 'OWNER' } },
      orgs: { o1: { id: 'o1', slug: 'sira' } },
      items: [{ id: 'a1', action: 'login', metadata: { orgId: 'o1' } }],
    });
    const req = {
      user: { id: 'owner1' },
      params: { id: 'o1' },
      query: { q: 'login' },
    };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 200);
    assert.equal(res._body.items.length, 1);
  });

  test('honours ?limit= and ?page= and caps at SEARCH_LIMIT_MAX', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'o' } },
      items: [],
      total: 0,
    });
    const req = {
      user: { id: 'admin1' },
      params: { id: 'o1' },
      query: { q: 'login', limit: '9999', page: '3' },
    };
    const res = makeRes();
    await searchOrgAuditLogs(req, res, { prisma });
    assert.equal(res._status, 200);
    assert.equal(res._body.limit, SEARCH_LIMIT_MAX);
    assert.equal(res._body.page, 3);
    const itemsCall = prisma._rawCalls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    // limit at $2, offset at $3.
    assert.equal(itemsCall.params[1], SEARCH_LIMIT_MAX);
    assert.equal(itemsCall.params[2], (3 - 1) * SEARCH_LIMIT_MAX);
  });
});

// ── search() helper: orgId behaviour ────────────────────────────────

describe('audit-query.search — orgId option (ratchet 44)', () => {
  function makeRawPrisma({ items = [], total = null } = {}) {
    const calls = [];
    return {
      calls,
      prisma: {
        async $queryRawUnsafe(sql, ...params) {
          calls.push({ sql, params });
          if (/COUNT\(\*\)/i.test(sql)) {
            return [{ count: total === null ? items.length : total }];
          }
          return items;
        },
      },
    };
  }

  test('appends metadata->>orgId predicate and passes orgId as positional param', async () => {
    const { prisma, calls } = makeRawPrisma();
    await search(prisma, 'alice', { orgId: 'o1' });

    const itemsCall = calls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    const countCall = calls.find((c) => /COUNT\(\*\)/i.test(c.sql));
    assert.ok(itemsCall);
    assert.ok(countCall);
    assert.match(itemsCall.sql, /"metadata"->>'orgId' = \$4/);
    assert.match(countCall.sql, /"metadata"->>'orgId' = \$2/);
    assert.equal(itemsCall.params[0], '%alice%');
    assert.equal(itemsCall.params[3], 'o1');
    assert.equal(countCall.params[0], '%alice%');
    assert.equal(countCall.params[1], 'o1');
  });

  test('orgId omitted ⇒ SQL does NOT include the org predicate', async () => {
    const { prisma, calls } = makeRawPrisma();
    await search(prisma, 'alice');
    const itemsCall = calls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    assert.doesNotMatch(itemsCall.sql, /metadata"->>'orgId'/);
    // No 4th param.
    assert.equal(itemsCall.params.length, 3);
  });

  test('empty-string orgId is ignored (treated as no scoping)', async () => {
    const { prisma, calls } = makeRawPrisma();
    await search(prisma, 'alice', { orgId: '' });
    const itemsCall = calls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    assert.doesNotMatch(itemsCall.sql, /metadata"->>'orgId'/);
    assert.equal(itemsCall.params.length, 3);
  });

  test('non-string orgId is ignored', async () => {
    const { prisma, calls } = makeRawPrisma();
    await search(prisma, 'alice', { orgId: 123 });
    const itemsCall = calls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    assert.doesNotMatch(itemsCall.sql, /metadata"->>'orgId'/);
    assert.equal(itemsCall.params.length, 3);
  });

  test('result shape (items/total/pages/page/limit) still honoured with orgId', async () => {
    const { prisma } = makeRawPrisma({
      items: [{ id: 'a1', metadata: { orgId: 'o1' } }],
      total: 137,
    });
    const r = await search(prisma, 'a', { orgId: 'o1', limit: 25, page: 2 });
    assert.equal(r.items.length, 1);
    assert.equal(r.total, 137);
    assert.equal(r.limit, 25);
    assert.equal(r.page, 2);
    assert.equal(r.pages, Math.ceil(137 / 25));
  });

  test('graceful degradation on query failure still returns search_failed shape', async () => {
    const prisma = {
      async $queryRawUnsafe() { throw new Error('boom'); },
    };
    const r = await search(prisma, 'a', { orgId: 'o1' });
    assert.deepEqual(r.items, []);
    assert.equal(r.total, 0);
    assert.equal(r.error, 'search_failed');
  });
});
