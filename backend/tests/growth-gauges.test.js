'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const { run, DEFAULT_ACTIVE_DAYS } = require('../src/jobs/growth-gauges');

const silentLogger = { info() {}, warn() {}, error() {} };

function makePrisma({
  usersRegistered = 0,
  usersActive7d = 0,
  orgsRegistered = 0,
  capture = {},
} = {}) {
  capture.userCountCalls = [];
  capture.orgCountCalls = [];
  return {
    user: {
      async count(args) {
        capture.userCountCalls.push(args);
        // First call = registered; second = active-7d.
        return capture.userCountCalls.length === 1 ? usersRegistered : usersActive7d;
        // (Promise.all preserves argument order, so call order is deterministic)
      },
    },
    organization: {
      async count() {
        return orgsRegistered;
      },
    },
  };
}

describe('growth-gauges', () => {
  afterEach(() => {
    delete process.env.SIRAGPT_GROWTH_ACTIVE_DAYS;
    delete process.env.SIRAGPT_GROWTH_DRY_RUN;
  });

  test('counts users, active-7d users and orgs', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const capture = {};
    const prisma = makePrisma({
      usersRegistered: 42,
      usersActive7d: 17,
      orgsRegistered: 5,
      capture,
    });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.usersRegistered, 42);
    assert.equal(res.usersActive7d, 17);
    assert.equal(res.orgsRegistered, 5);
    assert.equal(res.activeDays, DEFAULT_ACTIVE_DAYS);
    assert.equal(res.dryRun, false);
  });

  test('query excludes deleted + super-admin users in both user counts', async () => {
    const capture = {};
    const prisma = makePrisma({ usersRegistered: 0, usersActive7d: 0, capture });
    await run({ prisma, logger: silentLogger });

    assert.equal(capture.userCountCalls.length, 2);
    const baseWhere = { deletedAt: null, isSuperAdmin: false };
    assert.deepEqual(capture.userCountCalls[0].where, baseWhere);
    assert.equal(capture.userCountCalls[1].where.deletedAt, null);
    assert.equal(capture.userCountCalls[1].where.isSuperAdmin, false);
    assert.ok(capture.userCountCalls[1].where.lastActiveAt);
    assert.ok(typeof capture.userCountCalls[1].where.lastActiveAt.gte === 'object');
  });

  test('active cutoff derives from now minus activeDays', async () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const capture = {};
    const prisma = makePrisma({ capture });
    const res = await run({ prisma, now, logger: silentLogger });

    const cutoff = new Date(capture.userCountCalls[1].where.lastActiveAt.gte);
    const expected = new Date(now.getTime() - DEFAULT_ACTIVE_DAYS * 86400 * 1000);
    assert.equal(cutoff.getTime(), expected.getTime());
    assert.equal(res.activeCutoff, expected.toISOString());
  });

  test('honours SIRAGPT_GROWTH_ACTIVE_DAYS env override', async () => {
    process.env.SIRAGPT_GROWTH_ACTIVE_DAYS = '30';
    const now = new Date('2026-08-22T12:00:00Z');
    const capture = {};
    const prisma = makePrisma({ capture });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.activeDays, 30);
  });

  test('opts.activeDays overrides env and default', async () => {
    process.env.SIRAGPT_GROWTH_ACTIVE_DAYS = '30';
    const prisma = makePrisma({});
    const res = await run({ prisma, activeDays: 14, logger: silentLogger });
    assert.equal(res.activeDays, 14);
  });

  test('invalid env override falls back to default', async () => {
    process.env.SIRAGPT_GROWTH_ACTIVE_DAYS = 'not-a-number';
    const prisma = makePrisma({});
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.activeDays, DEFAULT_ACTIVE_DAYS);
  });

  test('dry-run skips metric emission but still computes counts', async () => {
    const capture = {};
    const prisma = makePrisma({
      usersRegistered: 9,
      usersActive7d: 3,
      orgsRegistered: 2,
      capture,
    });
    const res = await run({ prisma, dryRun: true, logger: silentLogger });
    assert.equal(res.dryRun, true);
    assert.equal(res.usersRegistered, 9);
  });

  test('handles empty database cleanly', async () => {
    const prisma = makePrisma({});
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.usersRegistered, 0);
    assert.equal(res.usersActive7d, 0);
    assert.equal(res.orgsRegistered, 0);
  });
});
