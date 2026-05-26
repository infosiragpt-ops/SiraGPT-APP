'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run, CONSUMED_GRACE_MS } = require('../src/jobs/sweep-expired-partial-sessions');

function makePrisma({ deleted = 0, candidates = 0, capture = {} } = {}) {
  return {
    partialSession: {
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

describe('sweep-expired-partial-sessions', () => {
  test('deletes rows past expiresAt OR consumed more than 1h ago', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 5, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.deleted, 5);
    assert.equal(res.dryRun, false);
    assert.equal(res.now, now.toISOString());

    assert.ok(capture.deleteArgs);
    const where = capture.deleteArgs.where;
    assert.ok(Array.isArray(where.OR) && where.OR.length === 2);

    // Branch 1: expiresAt < now
    assert.deepEqual(where.OR[0], { expiresAt: { lt: now } });

    // Branch 2: consumedAt < now - 1h, and not null
    const expectedCutoff = new Date(now.getTime() - CONSUMED_GRACE_MS);
    assert.equal(where.OR[1].consumedAt.lt.getTime(), expectedCutoff.getTime());
    assert.equal(where.OR[1].consumedAt.not, null);
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
    assert.ok(Array.isArray(capture.countArgs.where.OR));
  });

  test('grace window is exactly 1 hour', () => {
    assert.equal(CONSUMED_GRACE_MS, 60 * 60 * 1000);
  });

  test('handles deleteMany returning no count gracefully', async () => {
    const prisma = {
      partialSession: {
        async deleteMany() { return {}; },
        async count() { return 0; },
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
  });

  test('uses default now when none provided', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    const before = Date.now();
    const res = await run({ prisma, logger: silentLogger });
    const after = Date.now();
    const t = Date.parse(res.now);
    assert.ok(t >= before && t <= after);
  });
});
