'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run } = require('../src/jobs/sweep-expired-announcements');

function makePrisma({ deleted = 0, candidates = 0, capture = {} } = {}) {
  return {
    orgAnnouncement: {
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

describe('sweep-expired-announcements', () => {
  test('deletes rows whose expiresAt is in the past', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 5, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.deleted, 5);
    assert.equal(res.dryRun, false);
    assert.equal(res.now, now.toISOString());
    assert.ok(capture.deleteArgs);
    assert.deepEqual(capture.deleteArgs.where, {
      expiresAt: { lt: now, not: null },
    });
  });

  test('dry-run counts but does not delete', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 99, candidates: 3, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, dryRun: true, logger: silentLogger });

    assert.equal(res.deleted, 0);
    assert.equal(res.candidates, 3);
    assert.equal(res.dryRun, true);
    assert.equal(capture.deleteArgs, undefined);
    assert.ok(capture.countArgs);
    assert.deepEqual(capture.countArgs.where, {
      expiresAt: { lt: now, not: null },
    });
  });

  test('null-expiry (pinned) announcements are excluded via not: null guard', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    await run({ prisma, logger: silentLogger });
    assert.equal(capture.deleteArgs.where.expiresAt.not, null);
  });

  test('handles deleteMany returning no count gracefully', async () => {
    const prisma = {
      orgAnnouncement: {
        async deleteMany() { return {}; },
        async count() { return 0; },
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
  });
});
