'use strict';

/**
 * Cycle 78 — tests for the org-scoped live audit SSE feed
 * (GET /api/orgs/:id/events). Exercises the handler directly with a
 * fake prisma + fake res; no Express bind / DB required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');

const { streamOrgEvents } = orgsRouter.__handlers;

function makeFakeRes() {
  const events = [];
  const headers = {};
  let ended = false;
  let buffer = '';
  return {
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
    setHeader(k, v) { headers[k] = v; },
    flushHeaders() {},
    write(chunk) {
      if (ended) return false;
      buffer += chunk;
      // Parse SSE record: blank-line separated. Track partial records via buffer.
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.startsWith(':')) {
          events.push({ event: 'heartbeat', raw });
          continue;
        }
        const lines = raw.split('\n');
        const ev = (lines.find((l) => l.startsWith('event: ')) || '').slice(7);
        const dataLine = (lines.find((l) => l.startsWith('data: ')) || '').slice(6);
        let data = null;
        try { data = dataLine ? JSON.parse(dataLine) : null; } catch { data = dataLine; }
        events.push({ event: ev, data });
      }
      return true;
    },
    end() { ended = true; this.writableEnded = true; },
    _events: events,
    _headers: headers,
    get _ended() { return ended; },
  };
}

function makeFakeReq({ userId = 'u1', orgId = 'o1' } = {}) {
  const listeners = {};
  return {
    user: { id: userId },
    params: { id: orgId },
    query: {},
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    _fire(ev) { (listeners[ev] || []).forEach((fn) => fn()); },
  };
}

function makeFakePrisma({ memberRole, auditRows = [] } = {}) {
  const orgMembership = {
    findUnique: async ({ where }) => {
      if (!memberRole) return null;
      return {
        id: 'mem',
        orgId: where.orgId_userId.orgId,
        userId: where.orgId_userId.userId,
        role: memberRole,
      };
    },
  };
  const auditLog = {
    findMany: async ({ where, take, orderBy }) => {
      let rows = auditRows.filter((r) => {
        if (where.metadata?.path?.[0] === 'orgId') {
          if (!r.metadata || r.metadata.orgId !== where.metadata.equals) return false;
        }
        if (where.createdAt?.gte) {
          const at = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
          if (at.getTime() < where.createdAt.gte.getTime()) return false;
        }
        return true;
      });
      rows.sort((a, b) => {
        const av = (a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt)).getTime();
        const bv = (b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt)).getTime();
        return (orderBy?.createdAt === 'asc' ? 1 : -1) * (av - bv);
      });
      return rows.slice(0, take || 100);
    },
    count: async () => auditRows.length,
  };
  return { orgMembership, auditLog };
}

// ─── auth gates ──────────────────────────────────────────────────────

test('events SSE: non-member returns 404', async () => {
  const prisma = makeFakePrisma({ memberRole: null });
  const req = makeFakeReq();
  const res = makeFakeRes();
  res.status = function (c) { this.statusCode = c; return this; };
  res.json = function (b) { this._body = b; return this; };
  await streamOrgEvents(req, res, { prisma });
  assert.equal(res.statusCode, 404);
});

test('events SSE: MEMBER rejected with 403', async () => {
  const prisma = makeFakePrisma({ memberRole: 'MEMBER' });
  const req = makeFakeReq();
  const res = makeFakeRes();
  res.status = function (c) { this.statusCode = c; return this; };
  res.json = function (b) { this._body = b; return this; };
  await streamOrgEvents(req, res, { prisma });
  assert.equal(res.statusCode, 403);
});

// ─── stream behaviour ────────────────────────────────────────────────

test('events SSE: ADMIN streams backfill + closes on max_events', async () => {
  const now = Date.now();
  const auditRows = Array.from({ length: 3 }, (_, i) => ({
    id: `a${i}`,
    action: 'org_invite_create',
    actorId: 'admin1',
    actorType: 'user',
    resourceType: 'organization',
    resourceId: 'o1',
    metadata: { orgId: 'o1' },
    createdAt: new Date(now - 5_000 + i * 100),
  }));
  const prisma = makeFakePrisma({ memberRole: 'ADMIN', auditRows });
  const req = makeFakeReq();
  const res = makeFakeRes();
  await streamOrgEvents(req, res, {
    prisma,
    config: { POLL_MS: 5, MAX_DURATION_MS: 1_000, MAX_EVENTS: 3, BACKFILL_WINDOW_MS: 30_000, HEARTBEAT_MS: 10_000 },
  });
  const types = res._events.map((e) => e.event);
  assert.equal(types[0], 'ready');
  assert.equal(res._events.filter((e) => e.event === 'audit').length, 3);
  const done = res._events.find((e) => e.event === 'done');
  assert.ok(done, 'done event present');
  assert.equal(done.data.reason, 'max_events');
  assert.equal(done.data.delivered, 3);
  assert.equal(res._ended, true);
});

test('events SSE: closes on timeout when no new rows arrive', async () => {
  const prisma = makeFakePrisma({ memberRole: 'OWNER', auditRows: [] });
  const req = makeFakeReq();
  const res = makeFakeRes();
  await streamOrgEvents(req, res, {
    prisma,
    config: { POLL_MS: 5, MAX_DURATION_MS: 40, MAX_EVENTS: 100, BACKFILL_WINDOW_MS: 30_000, HEARTBEAT_MS: 10_000 },
  });
  const done = res._events.find((e) => e.event === 'done');
  assert.ok(done);
  assert.equal(done.data.reason, 'timeout');
  assert.equal(done.data.delivered, 0);
});

test('events SSE: skips rows belonging to other orgs', async () => {
  const now = Date.now();
  const auditRows = [
    { id: 'x1', action: 'org_create', actorId: 'a', createdAt: new Date(now - 2000), metadata: { orgId: 'o2' } },
    { id: 'x2', action: 'org_create', actorId: 'a', createdAt: new Date(now - 1500), metadata: { orgId: 'o1' } },
  ];
  const prisma = makeFakePrisma({ memberRole: 'ADMIN', auditRows });
  const req = makeFakeReq();
  const res = makeFakeRes();
  await streamOrgEvents(req, res, {
    prisma,
    config: { POLL_MS: 5, MAX_DURATION_MS: 60, MAX_EVENTS: 100, BACKFILL_WINDOW_MS: 30_000, HEARTBEAT_MS: 10_000 },
  });
  const audits = res._events.filter((e) => e.event === 'audit');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].data.id, 'x2');
});

test('events SSE: ready event includes config snapshot', async () => {
  const prisma = makeFakePrisma({ memberRole: 'ADMIN', auditRows: [] });
  const req = makeFakeReq();
  const res = makeFakeRes();
  await streamOrgEvents(req, res, {
    prisma,
    config: { POLL_MS: 5, MAX_DURATION_MS: 40, MAX_EVENTS: 7, BACKFILL_WINDOW_MS: 30_000, HEARTBEAT_MS: 10_000 },
  });
  const ready = res._events.find((e) => e.event === 'ready');
  assert.ok(ready);
  assert.equal(ready.data.orgId, 'o1');
  assert.equal(ready.data.maxEvents, 7);
  assert.equal(ready.data.pollMs, 5);
});

test('events SSE: SSE_EVENTS defaults match spec (60s/100 events)', () => {
  assert.equal(orgsRouter.__sseConfig.MAX_DURATION_MS, 60_000);
  assert.equal(orgsRouter.__sseConfig.MAX_EVENTS, 100);
  assert.equal(orgsRouter.__sseConfig.BACKFILL_WINDOW_MS, 30_000);
});
