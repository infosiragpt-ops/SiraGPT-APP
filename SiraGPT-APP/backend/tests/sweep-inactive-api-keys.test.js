'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const { run, DEFAULT_INACTIVE_DAYS } = require('../src/jobs/sweep-inactive-api-keys');

function makePrisma({ deleted = 0, candidates = 0, capture = {} } = {}) {
  return {
    apiKey: {
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

describe('sweep-inactive-api-keys', () => {
  afterEach(() => {
    delete process.env.SIRAGPT_API_KEY_INACTIVE_DAYS;
  });

  test('deletes rows whose lastUsedAt is older than the default 180d', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 6, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.deleted, 6);
    assert.equal(res.dryRun, false);
    assert.equal(res.inactiveDays, DEFAULT_INACTIVE_DAYS);
    assert.equal(res.now, now.toISOString());

    const expectedCutoff = new Date(now.getTime() - DEFAULT_INACTIVE_DAYS * 24 * 60 * 60 * 1000);
    assert.equal(res.cutoff, expectedCutoff.toISOString());
    assert.deepEqual(capture.deleteArgs.where, {
      lastUsedAt: { lt: expectedCutoff, not: null },
    });
  });

  test('honours SIRAGPT_API_KEY_INACTIVE_DAYS env override', async () => {
    process.env.SIRAGPT_API_KEY_INACTIVE_DAYS = '30';
    const capture = {};
    const prisma = makePrisma({ deleted: 1, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.inactiveDays, 30);
    const expectedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    assert.equal(capture.deleteArgs.where.lastUsedAt.lt.toISOString(), expectedCutoff.toISOString());
  });

  test('opts.inactiveDays overrides env and default', async () => {
    process.env.SIRAGPT_API_KEY_INACTIVE_DAYS = '30';
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, inactiveDays: 7, logger: silentLogger });

    assert.equal(res.inactiveDays, 7);
  });

  test('dry-run counts but does not delete', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 99, candidates: 4, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, dryRun: true, logger: silentLogger });

    assert.equal(res.deleted, 0);
    assert.equal(res.candidates, 4);
    assert.equal(res.dryRun, true);
    assert.equal(capture.deleteArgs, undefined);
    assert.ok(capture.countArgs);
    assert.equal(capture.countArgs.where.lastUsedAt.not, null);
  });

  test('null-lastUsedAt keys are excluded (not: null guard)', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    await run({ prisma, logger: silentLogger });
    assert.equal(capture.deleteArgs.where.lastUsedAt.not, null);
  });

  test('invalid env override falls back to default', async () => {
    process.env.SIRAGPT_API_KEY_INACTIVE_DAYS = 'not-a-number';
    const capture = {};
    const prisma = makePrisma({ deleted: 0, capture });
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.inactiveDays, DEFAULT_INACTIVE_DAYS);
  });

  test('handles deleteMany returning no count gracefully', async () => {
    const prisma = {
      apiKey: {
        async deleteMany() { return {}; },
        async count() { return 0; },
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
  });
});
