'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run } = require('../src/jobs/sweep-expired-verification-tokens');

function makePrisma({ deleted = 0, candidates = 0, capture = {} } = {}) {
  return {
    emailVerificationToken: {
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

describe('sweep-expired-verification-tokens', () => {
  test('deletes consumed-or-expired rows older than 30d', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 5, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    const expectedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    assert.equal(res.deleted, 5);
    assert.equal(res.dryRun, false);
    assert.equal(res.retentionDays, 30);
    assert.equal(res.cutoff, expectedCutoff.toISOString());
    assert.ok(capture.deleteArgs);
    assert.ok(Array.isArray(capture.deleteArgs.where.OR));
    assert.equal(capture.deleteArgs.where.OR.length, 2);
    // consumedAt branch
    assert.deepEqual(capture.deleteArgs.where.OR[0], {
      consumedAt: { not: null, lt: expectedCutoff },
    });
    // expiresAt branch
    assert.deepEqual(capture.deleteArgs.where.OR[1], {
      expiresAt: { lt: expectedCutoff },
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
    assert.equal(capture.countArgs.where.OR.length, 2);
  });

  test('honors custom retentionDays override', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 1, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({
      prisma, now, retentionDays: 7, logger: silentLogger,
    });

    const expectedCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    assert.equal(res.retentionDays, 7);
    assert.equal(res.cutoff, expectedCutoff.toISOString());
    assert.deepEqual(capture.deleteArgs.where.OR[1], {
      expiresAt: { lt: expectedCutoff },
    });
  });

  test('handles deleteMany returning no count gracefully', async () => {
    const prisma = {
      emailVerificationToken: {
        async deleteMany() { return {}; },
        async count() { return 0; },
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
  });
});
