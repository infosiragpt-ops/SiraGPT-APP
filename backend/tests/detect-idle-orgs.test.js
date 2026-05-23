'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const { run, DEFAULT_IDLE_DAYS, KEY_PREFIX } = require('../src/jobs/detect-idle-orgs');

const silentLogger = { info() {}, warn() {}, error() {} };

function makePrisma({ orgs = [], lastByOrg = {}, membersByOrg = null, existingFlagKeys = [], capture = {} } = {}) {
  capture.upserts = [];
  capture.deletes = [];
  capture.findMany = [];
  const settings = new Set(existingFlagKeys);
  const memberRowsFor = (orgId) => {
    if (membersByOrg) return membersByOrg[orgId] || [];
    const last = lastByOrg[orgId];
    if (last === undefined || last === null) return [];
    return [{ lastActiveAt: last, deletedAt: null }];
  };
  return {
    organization: {
      async findMany() {
        return orgs;
      },
    },
    orgMembership: {
      async findFirst({ where }) {
        const requireActiveUser = where?.user?.deletedAt === null;
        const rows = memberRowsFor(where.orgId)
          .filter((row) => row && row.lastActiveAt)
          .filter((row) => !requireActiveUser || row.deletedAt == null)
          .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
        if (!rows.length) return null;
        return { user: { lastActiveAt: rows[0].lastActiveAt } };
      },
    },
    systemSettings: {
      async findMany(args) {
        capture.findMany.push(args);
        return [...settings].map((key) => ({ key, value: '{}' }));
      },
      async upsert(args) {
        capture.upserts.push(args);
        settings.add(args.where.key);
        return { id: 'fake', key: args.where.key, value: args.create.value };
      },
      async deleteMany(args) {
        capture.deletes.push(args);
        const existed = settings.delete(args.where.key);
        return { count: existed ? 1 : 0 };
      },
    },
  };
}

describe('detect-idle-orgs', () => {
  afterEach(() => {
    delete process.env.SIRAGPT_ORG_IDLE_DAYS;
    delete process.env.SIRAGPT_ORG_IDLE_DRY_RUN;
  });

  test('flags org with no member activity in last 60d', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 90 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', billingPlan: 'PRO' }],
      lastByOrg: { o1: stale },
      capture,
    });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.scanned, 1);
    assert.equal(res.flagged, 1);
    assert.equal(res.cleared, 0);
    assert.equal(res.idleDays, DEFAULT_IDLE_DAYS);

    assert.equal(capture.upserts.length, 1);
    const up = capture.upserts[0];
    assert.equal(up.where.key, `${KEY_PREFIX}o1`);
    const payload = JSON.parse(up.create.value);
    assert.equal(payload.orgId, 'o1');
    assert.equal(payload.slug, 'acme');
    assert.equal(payload.name, 'Acme');
    assert.equal(payload.plan, 'PRO');
    assert.equal(payload.daysIdle, 90);
    assert.equal(payload.lastMemberActiveAt, stale.toISOString());
    assert.equal(payload.detectedAt, now.toISOString());
  });

  test('flags org with no active members at all (null lastActiveAt)', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const capture = {};
    const prisma = makePrisma({
      orgs: [{ id: 'o2', slug: 'ghost', name: 'Ghost', billingPlan: 'FREE' }],
      lastByOrg: { o2: null },
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.flagged, 1);
    const payload = JSON.parse(capture.upserts[0].create.value);
    assert.equal(payload.daysIdle, null);
    assert.equal(payload.lastMemberActiveAt, null);
  });

  test('does NOT flag org with recent member activity', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const recent = new Date(now.getTime() - 10 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [{ id: 'o3', slug: 'live', name: 'Live', billingPlan: 'PRO' }],
      lastByOrg: { o3: recent },
      existingFlagKeys: [`${KEY_PREFIX}o3`],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.flagged, 0);
    assert.equal(capture.upserts.length, 0);
    // Should issue a clear (deleteMany) to drop any prior flag.
    assert.equal(capture.deletes.length, 1);
    assert.equal(capture.deletes[0].where.key, `${KEY_PREFIX}o3`);
  });

  test('ignores soft-deleted users when choosing last member activity', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const recentDeleted = new Date(now.getTime() - 3 * 86400 * 1000);
    const staleActive = new Date(now.getTime() - 90 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [{ id: 'o5', slug: 'soft', name: 'Soft Deleted', billingPlan: 'PLUS' }],
      membersByOrg: {
        o5: [
          { lastActiveAt: recentDeleted, deletedAt: new Date(now.getTime() - 1 * 86400 * 1000) },
          { lastActiveAt: staleActive, deletedAt: null },
        ],
      },
      capture,
    });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.flagged, 1);
    const payload = JSON.parse(capture.upserts[0].create.value);
    assert.equal(payload.daysIdle, 90);
    assert.equal(payload.lastMemberActiveAt, staleActive.toISOString());
  });

  test('honours SIRAGPT_ORG_IDLE_DAYS env override', async () => {
    process.env.SIRAGPT_ORG_IDLE_DAYS = '30';
    const now = new Date('2026-05-19T12:00:00Z');
    // 40d old — idle under 30d threshold but NOT under default 60d.
    const stale = new Date(now.getTime() - 40 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [{ id: 'o4', slug: 's', name: 'S', billingPlan: 'PRO' }],
      lastByOrg: { o4: stale },
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.idleDays, 30);
    assert.equal(res.flagged, 1);
  });

  test('opts.idleDays overrides env and default', async () => {
    process.env.SIRAGPT_ORG_IDLE_DAYS = '30';
    const prisma = makePrisma({ orgs: [] });
    const res = await run({ prisma, idleDays: 7, logger: silentLogger });
    assert.equal(res.idleDays, 7);
  });

  test('invalid env override falls back to default', async () => {
    process.env.SIRAGPT_ORG_IDLE_DAYS = 'not-a-number';
    const prisma = makePrisma({ orgs: [] });
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.idleDays, DEFAULT_IDLE_DAYS);
  });

  test('dry-run does not upsert or delete', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 90 * 86400 * 1000);
    const recent = new Date(now.getTime() - 1 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [
        { id: 'o1', slug: 'a', name: 'A', billingPlan: 'PRO' },
        { id: 'o2', slug: 'b', name: 'B', billingPlan: 'FREE' },
      ],
      lastByOrg: { o1: stale, o2: recent },
      capture,
    });
    const res = await run({ prisma, now, dryRun: true, logger: silentLogger });
    assert.equal(res.dryRun, true);
    assert.equal(res.flagged, 1);
    assert.equal(capture.upserts.length, 0);
    assert.equal(capture.deletes.length, 0);
    // dry-run also surfaces the would-flag list.
    assert.ok(Array.isArray(res.orgs));
    assert.equal(res.orgs.length, 1);
    assert.equal(res.orgs[0].orgId, 'o1');
  });

  test('SIRAGPT_ORG_IDLE_DRY_RUN=true env enables dry-run', async () => {
    process.env.SIRAGPT_ORG_IDLE_DRY_RUN = 'true';
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 90 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [{ id: 'o1', slug: 'a', name: 'A', billingPlan: 'PRO' }],
      lastByOrg: { o1: stale },
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.dryRun, true);
    assert.equal(capture.upserts.length, 0);
  });

  test('handles empty org table cleanly', async () => {
    const prisma = makePrisma({ orgs: [] });
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.scanned, 0);
    assert.equal(res.flagged, 0);
    assert.equal(res.cleared, 0);
  });

  test('mixed batch: flags stale, clears active', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 200 * 86400 * 1000);
    const recent = new Date(now.getTime() - 5 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [
        { id: 'o1', slug: 'stale', name: 'S', billingPlan: 'PRO' },
        { id: 'o2', slug: 'live', name: 'L', billingPlan: 'FREE' },
        { id: 'o3', slug: 'ghost', name: 'G', billingPlan: 'FREE' },
      ],
      lastByOrg: { o1: stale, o2: recent, o3: null },
      existingFlagKeys: [`${KEY_PREFIX}o2`],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.scanned, 3);
    assert.equal(res.flagged, 2); // o1 + o3
    assert.equal(capture.upserts.length, 2);
    // Active org should be cleared.
    assert.equal(capture.deletes.length, 1);
    assert.equal(capture.deletes[0].where.key, `${KEY_PREFIX}o2`);
  });

  test('does not count already-flagged idle org as newly detected', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 90 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      orgs: [{ id: 'o1', slug: 'a', name: 'A', billingPlan: 'PRO' }],
      lastByOrg: { o1: stale },
      existingFlagKeys: [`${KEY_PREFIX}o1`],
      capture,
    });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.flagged, 1);
    assert.equal(res.detected, 0);
    assert.equal(capture.upserts.length, 1);
  });

  test('cleans idle flags whose organization no longer exists', async () => {
    const capture = {};
    const prisma = makePrisma({
      orgs: [],
      existingFlagKeys: [`${KEY_PREFIX}deleted-org`],
      capture,
    });

    const res = await run({ prisma, logger: silentLogger });

    assert.equal(res.scanned, 0);
    assert.equal(res.flagged, 0);
    assert.equal(res.orphaned, 1);
    assert.equal(res.cleared, 1);
    assert.equal(capture.deletes.length, 1);
    assert.equal(capture.deletes[0].where.key, `${KEY_PREFIX}deleted-org`);
  });
});
