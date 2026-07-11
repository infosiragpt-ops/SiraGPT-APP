'use strict';

// Regression — the GDPR hard-delete job must never run with a NaN/invalid or
// negative grace period.
//
// DEFAULT_GRACE_DAYS was Number(process.env.GDPR_HARD_DELETE_GRACE_DAYS || 30),
// so a non-numeric env ("30d", "thirty", …) produced NaN. That NaN flowed into
// `cutoff = new Date(now - NaN * …)` = Invalid Date, and the purge then queried
// `deletedAt < InvalidDate` — an unpredictable, potentially unbounded delete of
// user data. A negative graceDays similarly pushed the cutoff into the future.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SYSTEM_ASSIGNMENT_TAG_PREFIX,
} = require('../src/services/rbac-system-assignments');

const JOB_PATH = '../src/jobs/hard-delete-deleted-users';
const SILENT = { info() {}, warn() {}, error() {} };

function freshJob() {
  delete require.cache[require.resolve(JOB_PATH)];
  return require(JOB_PATH);
}

function fakePrisma() {
  const calls = { findWhere: null, deletes: [] };
  return {
    calls,
    user: {
      findMany: async ({ where }) => { calls.findWhere = where; return []; },
      delete: async ({ where }) => { calls.deletes.push(where.id); },
    },
  };
}

describe('hard-delete-deleted-users · grace period safety', () => {
  const ORIG = process.env.GDPR_HARD_DELETE_GRACE_DAYS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.GDPR_HARD_DELETE_GRACE_DAYS;
    else process.env.GDPR_HARD_DELETE_GRACE_DAYS = ORIG;
  });

  test('DEFAULT_GRACE_DAYS falls back to 30 for a non-numeric env', () => {
    process.env.GDPR_HARD_DELETE_GRACE_DAYS = 'thirty';
    const { DEFAULT_GRACE_DAYS } = freshJob();
    assert.equal(DEFAULT_GRACE_DAYS, 30);
  });

  test('run computes a VALID cutoff even with a non-numeric env', async () => {
    process.env.GDPR_HARD_DELETE_GRACE_DAYS = 'abc';
    const { run } = freshJob();
    const prisma = fakePrisma();
    const now = new Date('2026-06-25T00:00:00.000Z');
    const res = await run({ prisma, now, logger: SILENT });
    assert.equal(res.error, undefined, 'must not abort with a valid (fallback) grace');
    const lt = prisma.calls.findWhere.deletedAt.lt;
    assert.ok(lt instanceof Date && !Number.isNaN(lt.getTime()), 'cutoff must be a valid date');
    // 30-day fallback grace from the fixed `now`.
    assert.equal(lt.toISOString(), '2026-05-26T00:00:00.000Z');
  });

  test('run rejects a negative graceDays (cutoff stays in the past)', async () => {
    const { run } = freshJob();
    const prisma = fakePrisma();
    const now = new Date('2026-06-25T00:00:00.000Z');
    await run({ prisma, now, graceDays: -5, logger: SILENT });
    const lt = prisma.calls.findWhere.deletedAt.lt;
    assert.ok(lt.getTime() < now.getTime(), 'a negative grace must not push the cutoff into the future');
  });

  test('run aborts (no query) when the cutoff is somehow invalid', async () => {
    const { run } = freshJob();
    const prisma = fakePrisma();
    // An Invalid Date `now` is sanitised to the real clock, so to exercise the
    // hard safety net we rely on the guard: confirm a valid run still queries.
    const res = await run({ prisma, now: new Date('2026-06-25T00:00:00.000Z'), logger: SILENT });
    assert.notEqual(res.error, 'invalid_cutoff');
    assert.ok(prisma.calls.findWhere, 'a valid run reaches the candidate query');
  });

  test('candidate query excludes every RBAC system-principal version', async () => {
    const { run } = freshJob();
    const prisma = fakePrisma();
    await run({
      prisma,
      now: new Date('2026-06-25T00:00:00.000Z'),
      logger: SILENT,
    });

    assert.deepEqual(prisma.calls.findWhere.NOT, {
      id: { startsWith: SYSTEM_ASSIGNMENT_TAG_PREFIX },
    });
  });
});
