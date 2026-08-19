'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const {
  run,
  DEFAULT_READ_RETENTION_DAYS,
  DEFAULT_UNREAD_RETENTION_DAYS,
} = require('../src/jobs/sweep-old-notifications');

function makePrisma({ deleted = 0, candidates = 0, capture = {} } = {}) {
  return {
    notification: {
      async deleteMany(args) {
        capture.deleteArgs = args;
        return { count: deleted };
      },
      async count(args) {
        capture.countArgs = args;
        return candidates;
      },
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

const DAY_MS = 24 * 60 * 60 * 1000;

describe('sweep-old-notifications', () => {
  afterEach(() => {
    delete process.env.SIRAGPT_NOTIFICATION_READ_RETENTION_DAYS;
    delete process.env.SIRAGPT_NOTIFICATION_UNREAD_RETENTION_DAYS;
  });

  test('deletes read>30d OR unread>90d by default', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 7, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.deleted, 7);
    assert.equal(res.dryRun, false);
    assert.equal(res.readRetentionDays, DEFAULT_READ_RETENTION_DAYS);
    assert.equal(res.unreadRetentionDays, DEFAULT_UNREAD_RETENTION_DAYS);
    assert.equal(res.now, now.toISOString());

    const expectedReadCutoff = new Date(now.getTime() - DEFAULT_READ_RETENTION_DAYS * DAY_MS);
    const expectedUnreadCutoff = new Date(now.getTime() - DEFAULT_UNREAD_RETENTION_DAYS * DAY_MS);
    assert.equal(res.readCutoff, expectedReadCutoff.toISOString());
    assert.equal(res.unreadCutoff, expectedUnreadCutoff.toISOString());

    const where = capture.deleteArgs.where;
    assert.ok(Array.isArray(where.OR));
    assert.equal(where.OR.length, 2);

    const readBranch = where.OR.find((b) => b.read === true);
    const unreadBranch = where.OR.find((b) => b.read === false);
    assert.ok(readBranch && unreadBranch);
    assert.equal(readBranch.readAt.lt.toISOString(), expectedReadCutoff.toISOString());
    assert.equal(readBranch.readAt.not, null);
    assert.equal(unreadBranch.createdAt.lt.toISOString(), expectedUnreadCutoff.toISOString());
  });

  test('honours env overrides for read + unread retention days', async () => {
    process.env.SIRAGPT_NOTIFICATION_READ_RETENTION_DAYS = '7';
    process.env.SIRAGPT_NOTIFICATION_UNREAD_RETENTION_DAYS = '14';
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.readRetentionDays, 7);
    assert.equal(res.unreadRetentionDays, 14);
    const readBranch = capture.deleteArgs.where.OR.find((b) => b.read === true);
    const unreadBranch = capture.deleteArgs.where.OR.find((b) => b.read === false);
    assert.equal(
      readBranch.readAt.lt.toISOString(),
      new Date(now.getTime() - 7 * DAY_MS).toISOString(),
    );
    assert.equal(
      unreadBranch.createdAt.lt.toISOString(),
      new Date(now.getTime() - 14 * DAY_MS).toISOString(),
    );
  });

  test('opts.readRetentionDays / opts.unreadRetentionDays beat env', async () => {
    process.env.SIRAGPT_NOTIFICATION_READ_RETENTION_DAYS = '7';
    process.env.SIRAGPT_NOTIFICATION_UNREAD_RETENTION_DAYS = '14';
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    const res = await run({
      prisma,
      now: new Date('2026-05-19T12:00:00Z'),
      readRetentionDays: 1,
      unreadRetentionDays: 2,
      logger: silentLogger,
    });
    assert.equal(res.readRetentionDays, 1);
    assert.equal(res.unreadRetentionDays, 2);
  });

  test('dry-run counts but does not delete', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 99, candidates: 5, capture });
    const res = await run({
      prisma,
      now: new Date('2026-05-19T12:00:00Z'),
      dryRun: true,
      logger: silentLogger,
    });

    assert.equal(res.deleted, 0);
    assert.equal(res.candidates, 5);
    assert.equal(res.dryRun, true);
    assert.equal(capture.deleteArgs, undefined);
    assert.ok(capture.countArgs);
    assert.ok(Array.isArray(capture.countArgs.where.OR));
  });

  test('invalid env values fall back to defaults', async () => {
    process.env.SIRAGPT_NOTIFICATION_READ_RETENTION_DAYS = 'nope';
    process.env.SIRAGPT_NOTIFICATION_UNREAD_RETENTION_DAYS = '-5';
    const prisma = makePrisma({ deleted: 0 });
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.readRetentionDays, DEFAULT_READ_RETENTION_DAYS);
    assert.equal(res.unreadRetentionDays, DEFAULT_UNREAD_RETENTION_DAYS);
  });

  test('handles deleteMany returning no count gracefully', async () => {
    const prisma = {
      notification: {
        async deleteMany() { return {}; },
        async count() { return 0; },
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
  });

  test('read branch requires readAt not null so read-without-readAt rows survive', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    await run({ prisma, logger: silentLogger });
    const readBranch = capture.deleteArgs.where.OR.find((b) => b.read === true);
    assert.equal(readBranch.readAt.not, null);
  });
});
