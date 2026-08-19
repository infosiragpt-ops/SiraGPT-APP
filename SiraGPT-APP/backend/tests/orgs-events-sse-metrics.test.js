'use strict';

/**
 * Cycle 79+ — verifies the SSE /api/orgs/:id/events handler emits
 * Prometheus metrics for streamed events and active subscribers.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');
const metrics = require('../src/utils/metrics');

const { streamOrgEvents } = orgsRouter.__handlers;

function makeFakeRes() {
  const events = [];
  let buffer = '';
  let ended = false;
  return {
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      if (ended) return false;
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.startsWith(':')) { events.push({ event: 'heartbeat' }); continue; }
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
    get _ended() { return ended; },
  };
}

function makeFakeReq({ userId = 'u1', orgId = 'o-metrics' } = {}) {
  const listeners = {};
  return {
    user: { id: userId },
    params: { id: orgId },
    query: {},
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  };
}

function makeFakePrisma({ memberRole, auditRows = [] } = {}) {
  return {
    orgMembership: {
      findUnique: async ({ where }) => (
        memberRole
          ? { id: 'mem', orgId: where.orgId_userId.orgId, userId: where.orgId_userId.userId, role: memberRole }
          : null
      ),
    },
    auditLog: {
      findMany: async ({ where, take }) => {
        const rows = auditRows.filter((r) => {
          if (where.metadata?.path?.[0] === 'orgId') {
            if (!r.metadata || r.metadata.orgId !== where.metadata.equals) return false;
          }
          if (where.createdAt?.gte) {
            const at = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
            if (at.getTime() < where.createdAt.gte.getTime()) return false;
          }
          return true;
        });
        rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        return rows.slice(0, take || 100);
      },
      count: async () => auditRows.length,
    },
  };
}

function findCounterValue(name, labelSubstr) {
  const text = metrics.renderText();
  const lines = text.split('\n').filter((l) => l.startsWith(name) && !l.startsWith(`${name}_`));
  const target = labelSubstr
    ? lines.find((l) => l.includes(labelSubstr))
    : lines[0];
  if (!target) return null;
  const parts = target.trim().split(/\s+/);
  return Number(parts[parts.length - 1]);
}

beforeEach(() => metrics._reset());

test('SSE handler increments siragpt_org_events_streamed_total per delivered audit row', async () => {
  const now = Date.now();
  const auditRows = Array.from({ length: 2 }, (_, i) => ({
    id: `a${i}`,
    action: 'org_invite_create',
    actorId: 'admin1',
    actorType: 'user',
    resourceType: 'organization',
    resourceId: 'o-metrics',
    metadata: { orgId: 'o-metrics' },
    createdAt: new Date(now - 5_000 + i * 100),
  }));
  const prisma = makeFakePrisma({ memberRole: 'ADMIN', auditRows });
  const req = makeFakeReq();
  const res = makeFakeRes();
  await streamOrgEvents(req, res, {
    prisma,
    config: { POLL_MS: 5, MAX_DURATION_MS: 500, MAX_EVENTS: 2, BACKFILL_WINDOW_MS: 30_000, HEARTBEAT_MS: 10_000 },
  });

  const v = findCounterValue('siragpt_org_events_streamed_total', 'orgId="o-metrics"');
  assert.equal(v, 2);
  // After handler returns the subscriber gauge should be back to 0.
  const gaugeVal = findCounterValue('siragpt_org_events_active_subscribers');
  assert.equal(gaugeVal, 0);
});

test('SSE handler does not increment counters on auth failure', async () => {
  const prisma = makeFakePrisma({ memberRole: null });
  const req = makeFakeReq();
  const res = makeFakeRes();
  res.status = function (c) { this.statusCode = c; return this; };
  res.json = function (b) { this._body = b; return this; };
  await streamOrgEvents(req, res, { prisma });
  const v = findCounterValue('siragpt_org_events_streamed_total', 'orgId="o-metrics"');
  assert.equal(v, null);
});
