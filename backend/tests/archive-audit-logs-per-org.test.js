'use strict';

/**
 * Per-org audit retention overrides — ratchet 44 / task 1.
 *
 * Exercises the cycle-73 cron's new phase 0:
 *   - orgs with `settings.audit.retentionMonths` get their members'
 *     AuditLog rows archived using a custom cutoff *before* the global
 *     pass runs.
 *   - the global pass excludes those actorIds so rows aren't
 *     double-processed.
 *   - default fallback (no override) keeps the global 365-day cutoff.
 *   - retentionMonths is clamped to [1, 60] even when stored settings
 *     drift outside that range.
 */

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run, _loadOrgOverrides } = require('../src/jobs/archive-audit-logs');

function buildPrismaStub({ now, orgs = [], memberships = [], rows = [] }) {
  const state = { rows: rows.slice(), settings: new Map(), orgs, memberships };

  return {
    auditLog: {
      async findMany({ where, take, cursor, skip }) {
        let out = state.rows.slice();
        if (where.createdAt?.lt) {
          const lt = where.createdAt.lt;
          out = out.filter((r) => r.createdAt < lt);
        }
        if (where.actorId?.in) {
          const set = new Set(where.actorId.in);
          out = out.filter((r) => set.has(r.actorId));
        }
        if (where.NOT?.actorId?.in) {
          const set = new Set(where.NOT.actorId.in);
          out = out.filter((r) => !set.has(r.actorId));
        }
        out.sort((a, b) => a.createdAt - b.createdAt);
        if (cursor) {
          const idx = out.findIndex((r) => r.id === cursor.id);
          out = out.slice(idx + (skip || 0));
        }
        return out.slice(0, take || out.length);
      },
      async deleteMany({ where }) {
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => {
          if (where.createdAt?.lt && r.createdAt >= where.createdAt.lt) return true;
          if (where.actorId?.in) {
            if (!where.actorId.in.includes(r.actorId)) return true;
          }
          if (where.NOT?.actorId?.in) {
            if (where.NOT.actorId.in.includes(r.actorId)) return true;
          }
          return false;
        });
        return { count: before - state.rows.length };
      },
    },
    systemSettings: {
      async findUnique({ where }) {
        const v = state.settings.get(where.key);
        return v ? { key: where.key, value: v } : null;
      },
      async upsert({ where, update, create }) {
        if (state.settings.has(where.key)) state.settings.set(where.key, update.value);
        else state.settings.set(where.key, create.value);
      },
    },
    organization: {
      async findMany({ select: _s } = {}) {
        return state.orgs.slice();
      },
      async findUnique({ where }) {
        return state.orgs.find((o) => o.id === where.id) || null;
      },
    },
    orgMembership: {
      async findMany({ where, select: _s } = {}) {
        return state.memberships.filter((m) => m.orgId === where.orgId);
      },
    },
    _state: state,
  };
}

function daysAgo(now, n) {
  return new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
}

describe('archive-audit-logs per-org overrides', () => {
  test('org with shorter retention archives its members rows before global pass', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    // Org "acme" → 3-month retention (~90 days). Global default = 365.
    const orgs = [
      { id: 'org-acme', ownerId: 'u-owner', settings: { audit: { retentionMonths: 3 } } },
      { id: 'org-nooverride', ownerId: 'u-x', settings: { audit: {} } },
    ];
    const memberships = [
      { orgId: 'org-acme', userId: 'u-acme-1' },
      { orgId: 'org-acme', userId: 'u-acme-2' },
    ];
    const rows = [
      // acme owner — 200 days old → expires under org rule (90d) but not global (365d).
      { id: 'r-1', actorType: 'user', actorId: 'u-owner', actorName: 'Owner',
        resourceType: 'doc', resourceId: 'd-1', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 200) },
      // acme member — 120 days old → expires under org rule.
      { id: 'r-2', actorType: 'user', actorId: 'u-acme-1', actorName: 'Alice',
        resourceType: 'doc', resourceId: 'd-2', action: 'update',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 120) },
      // acme member — 60 days old → still fresh even under 90-day rule.
      { id: 'r-3', actorType: 'user', actorId: 'u-acme-2', actorName: 'Bob',
        resourceType: 'doc', resourceId: 'd-3', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 60) },
      // unrelated user — 400 days old → expires under global 365d.
      { id: 'r-4', actorType: 'user', actorId: 'u-other', actorName: 'Other',
        resourceType: 'doc', resourceId: 'd-4', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 400) },
      // unrelated user — 200 days old → survives (no override, global rule).
      { id: 'r-5', actorType: 'user', actorId: 'u-other', actorName: 'Other',
        resourceType: 'doc', resourceId: 'd-5', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 200) },
      // system row (actorId=null), 400 days old → handled by global pass.
      { id: 'r-6', actorType: 'system', actorId: null, actorName: null,
        resourceType: 'user', resourceId: 'u-9', action: 'delete',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 400) },
    ];
    const prisma = buildPrismaStub({ now, orgs, memberships, rows });

    const res = await run({
      prisma,
      now,
      retentionDays: 365,
      batchSize: 50,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Expected:
    //   r-1, r-2 archived via per-org pass (acme).
    //   r-4, r-6 archived via global pass.
    //   r-3, r-5 survive.
    assert.equal(res.archived, 4);
    assert.equal(res.deleted, 4);
    const survivors = prisma._state.rows.map((r) => r.id).sort();
    assert.deepEqual(survivors, ['r-3', 'r-5']);

    // perOrg result captures the override that fired.
    const acme = res.perOrg.find((p) => p.orgId === 'org-acme');
    assert.ok(acme);
    assert.equal(acme.retentionMonths, 3);
    assert.equal(acme.archived, 2);
    assert.equal(acme.deleted, 2);
    assert.equal(acme.memberCount, 3); // owner + 2 members

    // Org without an `retentionMonths` value is not reported.
    assert.equal(res.perOrg.find((p) => p.orgId === 'org-nooverride'), undefined);
  });

  test('orgs without override fall through to global default', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const rows = [
      { id: 'g-1', actorType: 'user', actorId: 'u-1', actorName: 'A',
        resourceType: 'doc', resourceId: 'd-1', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 400) },
      { id: 'g-2', actorType: 'user', actorId: 'u-2', actorName: 'B',
        resourceType: 'doc', resourceId: 'd-2', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 30) },
    ];
    const prisma = buildPrismaStub({ now, orgs: [], memberships: [], rows });
    const res = await run({
      prisma,
      now,
      retentionDays: 365,
      batchSize: 10,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(res.archived, 1);
    assert.equal(res.deleted, 1);
    assert.equal(res.perOrg.length, 0);
    assert.equal(prisma._state.rows.length, 1);
    assert.equal(prisma._state.rows[0].id, 'g-2');
  });

  test('retentionMonths is clamped into [1, 60] when storage drifts', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const orgs = [
      // 9999 months would otherwise produce a cutoff before epoch.
      { id: 'org-huge', ownerId: 'u-h', settings: { audit: { retentionMonths: 9999 } } },
      // -5 months is rejected as non-positive (skipped entirely).
      { id: 'org-neg', ownerId: 'u-n', settings: { audit: { retentionMonths: -5 } } },
    ];
    const prisma = buildPrismaStub({ now, orgs, memberships: [], rows: [] });
    const overrides = await _loadOrgOverrides(prisma, { warn() {} });
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].orgId, 'org-huge');
    assert.equal(overrides[0].retentionMonths, 60);
    // 60 months * 30 days = 1800 days
    assert.equal(overrides[0].retentionDays, 1800);
  });

  test('dry-run reports per-org candidates without writing', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const orgs = [
      { id: 'org-acme', ownerId: 'u-owner', settings: { audit: { retentionMonths: 3 } } },
    ];
    const memberships = [{ orgId: 'org-acme', userId: 'u-acme-1' }];
    const rows = [
      { id: 'd-1', actorType: 'user', actorId: 'u-acme-1', actorName: 'A',
        resourceType: 'doc', resourceId: 'x', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 200) },
    ];
    const prisma = buildPrismaStub({ now, orgs, memberships, rows });
    const res = await run({
      prisma,
      now,
      retentionDays: 365,
      batchSize: 10,
      dryRun: true,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(res.archived, 1);
    assert.equal(res.deleted, 0);
    assert.equal(res.dryRun, true);
    assert.equal(prisma._state.rows.length, 1);
    assert.equal(prisma._state.settings.size, 0);
  });

  test('skipOrgOverrides keeps legacy global-only behaviour', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const orgs = [
      { id: 'org-acme', ownerId: 'u-owner', settings: { audit: { retentionMonths: 3 } } },
    ];
    const memberships = [{ orgId: 'org-acme', userId: 'u-acme-1' }];
    const rows = [
      { id: 's-1', actorType: 'user', actorId: 'u-acme-1', actorName: 'A',
        resourceType: 'doc', resourceId: 'x', action: 'create',
        before: null, after: null, diff: null, metadata: null,
        createdAt: daysAgo(now, 200) },
    ];
    const prisma = buildPrismaStub({ now, orgs, memberships, rows });
    const res = await run({
      prisma,
      now,
      retentionDays: 365,
      batchSize: 10,
      skipOrgOverrides: true,
      logger: { info() {}, warn() {}, error() {} },
    });
    // 200-day-old row stays — global default (365d) leaves it alone,
    // and the per-org pass was skipped.
    assert.equal(res.archived, 0);
    assert.equal(res.deleted, 0);
    assert.equal(res.perOrg.length, 0);
    assert.equal(prisma._state.rows.length, 1);
  });
});
