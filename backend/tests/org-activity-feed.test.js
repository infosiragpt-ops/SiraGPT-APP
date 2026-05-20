'use strict';

/**
 * Ratchet 44 — tests for the unified org activity feed
 * (`/api/orgs/:id/activity` + `services/org-activity-feed`). Exercises
 * the service module directly and the route handler with a fake prisma.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildActivityFeed,
  __internals,
} = require('../src/services/org-activity-feed');

const orgsRouter = require('../src/routes/orgs');
const { listOrgActivity } = orgsRouter.__handlers;

function makeRes() {
  let status = 200;
  let body;
  return {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    get _status() { return status; },
    get _body() { return body; },
  };
}

function makePrisma({ audits = [], announcements = [], members = {} } = {}) {
  return {
    orgMembership: {
      findUnique: async ({ where }) => {
        const { orgId, userId } = where.orgId_userId;
        const m = members[`${orgId}:${userId}`];
        if (!m) return null;
        return { id: 'mem', orgId, userId, role: m.role, organization: { id: orgId } };
      },
    },
    auditLog: {
      findMany: async ({ where, take }) => {
        const orgId = where?.metadata?.equals;
        const allowed = where?.action?.in;
        const lt = where?.createdAt?.lt;
        const out = audits.filter((r) => {
          if (!r.metadata || r.metadata.orgId !== orgId) return false;
          if (allowed && !allowed.includes(r.action)) return false;
          if (lt && !(new Date(r.createdAt) < lt)) return false;
          return true;
        });
        out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return out.slice(0, take || 100);
      },
    },
    orgAnnouncement: {
      findMany: async ({ where, take }) => {
        const lt = where?.createdAt?.lt;
        const out = announcements.filter((r) => {
          if (r.orgId !== where.orgId) return false;
          if (lt && !(new Date(r.createdAt) < lt)) return false;
          return true;
        });
        out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return out.slice(0, take || 100);
      },
    },
  };
}

test('clampLimit clamps to 1..100 with default 25', () => {
  const { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } = __internals;
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT);
  assert.equal(clampLimit('0'), DEFAULT_LIMIT);
  assert.equal(clampLimit('abc'), DEFAULT_LIMIT);
  assert.equal(clampLimit('5'), 5);
  assert.equal(clampLimit(99999), MAX_LIMIT);
});

test('encodeCursor/decodeCursor roundtrip', () => {
  const { encodeCursor, decodeCursor } = __internals;
  const d = new Date('2026-05-01T10:00:00Z');
  const c = encodeCursor(d, 'evt_1');
  const decoded = decodeCursor(c);
  assert.equal(decoded.ts.getTime(), d.getTime());
  assert.equal(decoded.id, 'evt_1');
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('not-base64-json'), null);
});

test('normalizeAudit produces unified shape with no secrets', () => {
  const { normalizeAudit } = __internals;
  const row = {
    id: 'a1',
    actorId: 'u1',
    actorName: 'Alice',
    actorType: 'user',
    action: 'org_invite_create',
    resourceType: 'organization',
    resourceId: 'org_1',
    before: { secret: 'leak' },
    after: { token: 'leak' },
    metadata: { orgId: 'org_1' },
    createdAt: new Date('2026-05-01T10:00:00Z'),
  };
  const it = normalizeAudit(row);
  assert.equal(it.type, 'audit');
  assert.equal(it.action, 'org_invite_create');
  assert.equal(it.refId, 'org_1');
  assert.equal(it.actor.id, 'u1');
  assert.equal(it.actor.name, 'Alice');
  assert.equal(it.source, 'audit_log');
  assert.equal(it.summary, 'Invited a new member');
  // Critically — no before/after/diff leak.
  assert.ok(!('before' in it));
  assert.ok(!('after' in it));
  assert.ok(!('diff' in it));
});

test('buildActivityFeed merges audit + announcements DESC and paginates', async () => {
  const prisma = makePrisma({
    audits: [
      {
        id: 'a1', actorId: 'u1', actorType: 'user', action: 'org_invite_accept',
        resourceType: 'organization', resourceId: 'org_1',
        metadata: { orgId: 'org_1' }, createdAt: '2026-05-10T10:00:00Z',
      },
      {
        id: 'a2', actorId: 'u2', actorType: 'user', action: 'org_member_role_change',
        resourceType: 'user', resourceId: 'u2',
        metadata: { orgId: 'org_1' }, createdAt: '2026-05-09T10:00:00Z',
      },
      {
        // Should be filtered out — not in safe list (api keys).
        id: 'a3', actorId: 'u3', actorType: 'user', action: 'org_api_key_create',
        resourceType: 'api_key', resourceId: 'k1',
        metadata: { orgId: 'org_1' }, createdAt: '2026-05-12T10:00:00Z',
      },
      {
        // Different org — must not leak.
        id: 'a4', actorId: 'u4', actorType: 'user', action: 'org_invite_accept',
        resourceType: 'organization', resourceId: 'other',
        metadata: { orgId: 'other' }, createdAt: '2026-05-11T10:00:00Z',
      },
    ],
    announcements: [
      { id: 'an1', orgId: 'org_1', title: 'Maintenance', severity: 'warn', createdById: 'u1', createdAt: '2026-05-11T09:00:00Z' },
      { id: 'an2', orgId: 'org_1', title: 'Welcome', severity: 'info', createdById: 'u1', createdAt: '2026-05-08T09:00:00Z' },
    ],
  });

  const page1 = await buildActivityFeed(prisma, 'org_1', { limit: 2 });
  assert.equal(page1.items.length, 2);
  // Newest first: announcement an1 (05-11) then audit a1 (05-10).
  assert.equal(page1.items[0].refId, 'an1');
  assert.equal(page1.items[0].type, 'announcement');
  assert.equal(page1.items[1].action, 'org_invite_accept');
  assert.ok(page1.nextCursor, 'expected a cursor when more rows remain');

  const page2 = await buildActivityFeed(prisma, 'org_1', { limit: 2, cursor: page1.nextCursor });
  assert.ok(page2.items.length >= 1);
  // No duplication across pages — key by (type, refId, ts).
  const keyOf = (it) => `${it.type}:${it.refId}:${it.ts}`;
  const ids1 = new Set(page1.items.map(keyOf));
  for (const it of page2.items) assert.ok(!ids1.has(keyOf(it)), `dup: ${keyOf(it)}`);
  // Filtered-out actions / other-org rows never appear.
  const allActions = [...page1.items, ...page2.items].map((it) => it.action).filter(Boolean);
  assert.ok(!allActions.includes('org_api_key_create'));
});

test('buildActivityFeed degrades to empty result when prisma is missing models', async () => {
  const empty = await buildActivityFeed({}, 'org_1', { limit: 10 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
});

test('GET /:id/activity requires MEMBER+ (403 for VIEWER, 404 for non-member)', async () => {
  const prisma = makePrisma({
    members: {
      'org_1:viewer': { role: 'VIEWER' },
      'org_1:member': { role: 'MEMBER' },
    },
  });

  // Non-member → 404
  const res404 = makeRes();
  await listOrgActivity(
    { user: { id: 'ghost' }, params: { id: 'org_1' }, query: {} },
    res404,
    { prisma },
  );
  assert.equal(res404._status, 404);

  // VIEWER → 403
  const res403 = makeRes();
  await listOrgActivity(
    { user: { id: 'viewer' }, params: { id: 'org_1' }, query: {} },
    res403,
    { prisma },
  );
  assert.equal(res403._status, 403);

  // MEMBER → 200
  const res200 = makeRes();
  await listOrgActivity(
    { user: { id: 'member' }, params: { id: 'org_1' }, query: {} },
    res200,
    { prisma },
  );
  assert.equal(res200._status, 200);
  assert.ok(Array.isArray(res200._body.items));
  assert.equal(typeof res200._body.limit, 'number');
});

test('GET /:id/activity returns merged feed for MEMBER and never leaks other orgs', async () => {
  const prisma = makePrisma({
    members: { 'org_1:member': { role: 'MEMBER' } },
    audits: [
      { id: 'a1', actorId: 'u1', actorType: 'user', action: 'org_billing_upgrade', resourceType: 'organization', resourceId: 'org_1', metadata: { orgId: 'org_1' }, createdAt: '2026-05-10T10:00:00Z' },
      { id: 'leak', actorId: 'u9', actorType: 'user', action: 'org_billing_upgrade', resourceType: 'organization', resourceId: 'other', metadata: { orgId: 'other' }, createdAt: '2026-05-15T10:00:00Z' },
    ],
    announcements: [
      { id: 'an1', orgId: 'org_1', title: 'Hi', severity: 'info', createdById: 'u1', createdAt: '2026-05-09T09:00:00Z' },
    ],
  });

  const res = makeRes();
  await listOrgActivity(
    { user: { id: 'member' }, params: { id: 'org_1' }, query: { limit: '10' } },
    res,
    { prisma },
  );
  assert.equal(res._status, 200);
  const refs = res._body.items.map((it) => it.refId);
  assert.ok(refs.includes('org_1'));
  assert.ok(refs.includes('an1'));
  assert.ok(!refs.includes('leak'));
});
