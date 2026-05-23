'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const { run, DEFAULT_IDLE_DAYS, KEY_PREFIX } = require('../src/jobs/detect-idle-users');

const silentLogger = { info() {}, warn() {}, error() {} };

function makePrisma({ users = [], existingFlagKeys = [], capture = {} } = {}) {
  capture.upserts = [];
  capture.deletes = [];
  capture.findMany = [];
  capture.findWhere = null;
  const settings = new Set(existingFlagKeys);
  return {
    user: {
      async findMany({ where } = {}) {
        capture.findWhere = where;
        return users;
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

describe('detect-idle-users', () => {
  afterEach(() => {
    delete process.env.SIRAGPT_USER_IDLE_DAYS;
    delete process.env.SIRAGPT_USER_IDLE_DRY_RUN;
  });

  test('flags user with lastActiveAt older than 90d', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 120 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      users: [{ id: 'u1', email: 'a@x.io', plan: 'PRO', lastActiveAt: stale }],
      capture,
    });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.scanned, 1);
    assert.equal(res.flagged, 1);
    assert.equal(res.cleared, 0);
    assert.equal(res.idleDays, DEFAULT_IDLE_DAYS);

    assert.equal(capture.upserts.length, 1);
    const up = capture.upserts[0];
    assert.equal(up.where.key, `${KEY_PREFIX}u1`);
    const payload = JSON.parse(up.create.value);
    assert.equal(payload.userId, 'u1');
    assert.equal(payload.email, 'a@x.io');
    assert.equal(payload.plan, 'PRO');
    assert.equal(payload.daysIdle, 120);
    assert.equal(payload.lastActiveAt, stale.toISOString());
    assert.equal(payload.detectedAt, now.toISOString());
  });

  test('flags user with null lastActiveAt (never seen)', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const capture = {};
    const prisma = makePrisma({
      users: [{ id: 'u2', email: 'ghost@x.io', plan: 'FREE', lastActiveAt: null }],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.flagged, 1);
    const payload = JSON.parse(capture.upserts[0].create.value);
    assert.equal(payload.daysIdle, null);
    assert.equal(payload.lastActiveAt, null);
  });

  test('does NOT flag user with recent activity, clears prior flag', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const recent = new Date(now.getTime() - 10 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      users: [{ id: 'u3', email: 'live@x.io', plan: 'PRO', lastActiveAt: recent }],
      existingFlagKeys: [`${KEY_PREFIX}u3`],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.flagged, 0);
    assert.equal(capture.upserts.length, 0);
    assert.equal(capture.deletes.length, 1);
    assert.equal(capture.deletes[0].where.key, `${KEY_PREFIX}u3`);
  });

  test('query excludes deleted + super-admin users', async () => {
    const capture = {};
    const prisma = makePrisma({ users: [], capture });
    await run({ prisma, logger: silentLogger });
    assert.deepEqual(capture.findWhere, { deletedAt: null, isSuperAdmin: false });
  });

  test('honours SIRAGPT_USER_IDLE_DAYS env override', async () => {
    process.env.SIRAGPT_USER_IDLE_DAYS = '30';
    const now = new Date('2026-05-19T12:00:00Z');
    // 40d old — idle under 30d threshold but NOT under default 90d.
    const stale = new Date(now.getTime() - 40 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      users: [{ id: 'u4', email: 's@x.io', plan: 'PRO', lastActiveAt: stale }],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.idleDays, 30);
    assert.equal(res.flagged, 1);
  });

  test('opts.idleDays overrides env and default', async () => {
    process.env.SIRAGPT_USER_IDLE_DAYS = '30';
    const prisma = makePrisma({ users: [] });
    const res = await run({ prisma, idleDays: 7, logger: silentLogger });
    assert.equal(res.idleDays, 7);
  });

  test('invalid env override falls back to default', async () => {
    process.env.SIRAGPT_USER_IDLE_DAYS = 'not-a-number';
    const prisma = makePrisma({ users: [] });
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.idleDays, DEFAULT_IDLE_DAYS);
  });

  test('dry-run does not upsert or delete and surfaces users list', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 200 * 86400 * 1000);
    const recent = new Date(now.getTime() - 1 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      users: [
        { id: 'u1', email: 'a@x.io', plan: 'PRO', lastActiveAt: stale },
        { id: 'u2', email: 'b@x.io', plan: 'FREE', lastActiveAt: recent },
      ],
      capture,
    });
    const res = await run({ prisma, now, dryRun: true, logger: silentLogger });
    assert.equal(res.dryRun, true);
    assert.equal(res.flagged, 1);
    assert.equal(capture.upserts.length, 0);
    assert.equal(capture.deletes.length, 0);
    assert.ok(Array.isArray(res.users));
    assert.equal(res.users.length, 1);
    assert.equal(res.users[0].userId, 'u1');
  });

  test('SIRAGPT_USER_IDLE_DRY_RUN=true env enables dry-run', async () => {
    process.env.SIRAGPT_USER_IDLE_DRY_RUN = 'true';
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 120 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      users: [{ id: 'u1', email: 'a@x.io', plan: 'PRO', lastActiveAt: stale }],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.dryRun, true);
    assert.equal(capture.upserts.length, 0);
  });

  test('handles empty user table cleanly', async () => {
    const prisma = makePrisma({ users: [] });
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.scanned, 0);
    assert.equal(res.flagged, 0);
    assert.equal(res.cleared, 0);
  });

  test('mixed batch: flags stale + null, clears active', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 200 * 86400 * 1000);
    const recent = new Date(now.getTime() - 5 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      users: [
        { id: 'u1', email: 'a@x.io', plan: 'PRO', lastActiveAt: stale },
        { id: 'u2', email: 'b@x.io', plan: 'FREE', lastActiveAt: recent },
        { id: 'u3', email: 'c@x.io', plan: 'FREE', lastActiveAt: null },
      ],
      existingFlagKeys: [`${KEY_PREFIX}u2`],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.scanned, 3);
    assert.equal(res.flagged, 2); // u1 + u3
    assert.equal(capture.upserts.length, 2);
    assert.equal(capture.deletes.length, 1);
    assert.equal(capture.deletes[0].where.key, `${KEY_PREFIX}u2`);
  });

  test('does not count already-flagged idle user as newly detected', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const stale = new Date(now.getTime() - 120 * 86400 * 1000);
    const capture = {};
    const prisma = makePrisma({
      users: [{ id: 'u1', email: 'a@x.io', plan: 'PRO', lastActiveAt: stale }],
      existingFlagKeys: [`${KEY_PREFIX}u1`],
      capture,
    });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.flagged, 1);
    assert.equal(res.detected, 0);
    assert.equal(capture.upserts.length, 1);
  });

  test('cleans idle flags whose user is no longer scanned', async () => {
    const capture = {};
    const prisma = makePrisma({
      users: [],
      existingFlagKeys: [`${KEY_PREFIX}deleted-user`],
      capture,
    });

    const res = await run({ prisma, logger: silentLogger });

    assert.equal(res.scanned, 0);
    assert.equal(res.flagged, 0);
    assert.equal(res.orphaned, 1);
    assert.equal(res.cleared, 1);
    assert.equal(capture.deletes.length, 1);
    assert.equal(capture.deletes[0].where.key, `${KEY_PREFIX}deleted-user`);
  });
});
