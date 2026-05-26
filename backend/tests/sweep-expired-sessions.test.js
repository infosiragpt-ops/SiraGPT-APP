'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run } = require('../src/jobs/sweep-expired-sessions');

function makePrisma({ deleted = 0, candidates = 0, rows = [], capture = {} } = {}) {
  return {
    session: {
      async deleteMany(args) {
        capture.deleteArgs = args;
        return { count: deleted };
      },
      async count(args) {
        capture.countArgs = args;
        return candidates;
      },
      async findMany(args) {
        capture.findManyArgs = args;
        return rows;
      },
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

describe('sweep-expired-sessions', () => {
  test('deletes Session rows with expiresAt <= now', async () => {
    const capture = {};
    const prisma = makePrisma({ deleted: 7, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.deleted, 7);
    assert.equal(res.dryRun, false);
    assert.equal(res.cutoff, now.toISOString());
    assert.deepEqual(capture.deleteArgs, { where: { expiresAt: { lte: now } } });
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
    assert.deepEqual(capture.countArgs, { where: { expiresAt: { lte: now } } });
  });

  test('handles deleteMany returning no count gracefully', async () => {
    const prisma = {
      session: {
        async deleteMany() { return {}; },
        async count() { return 0; },
        async findMany() { return []; },
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
  });

  test('fans sendAppshotsDeviceAutoRevoked per appshots row, dedups, skips deleted users', async () => {
    const calls = [];
    const emailService = {
      sendAppshotsDeviceAutoRevoked: async (user, info) => {
        calls.push({ user, info });
        return true;
      },
    };
    // Token classifier: only the literal string 'APPSHOTS' counts.
    const isAppshotsToken = (t) => t === 'APPSHOTS';
    const rows = [
      // Regular web session — must NOT email.
      { id: 's1', token: 'web', user: { id: 'u1', email: 'u1@example.com', name: 'U1', deletedAt: null } },
      // Two appshots rows for the same user — both emails should fire (one per session id).
      { id: 's2', token: 'APPSHOTS', user: { id: 'u2', email: 'u2@example.com', name: 'U2', deletedAt: null } },
      { id: 's3', token: 'APPSHOTS', user: { id: 'u2', email: 'u2@example.com', name: 'U2', deletedAt: null } },
      // Soft-deleted user — must NOT email.
      { id: 's4', token: 'APPSHOTS', user: { id: 'u3', email: 'u3@example.com', name: 'U3', deletedAt: new Date() } },
      // Missing email — must NOT email.
      { id: 's5', token: 'APPSHOTS', user: { id: 'u4', email: null, name: 'U4', deletedAt: null } },
      // Duplicate of s2 (defensive against accidental duplicates in findMany).
      { id: 's2', token: 'APPSHOTS', user: { id: 'u2', email: 'u2@example.com', name: 'U2', deletedAt: null } },
    ];
    const prisma = makePrisma({ deleted: rows.length, rows });
    const now = new Date('2026-05-21T00:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger, emailService, isAppshotsToken });

    // Two distinct appshots session ids on a live user: s2 and s3.
    assert.equal(res.appshotsNotices, 2);
    // Yield microtask so fire-and-forget promises settle before we assert.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.user.id, 'u2');
      assert.equal(c.info.reason, 'token_expired');
      assert.ok(c.info.when instanceof Date);
    }
  });

  test('dry-run does NOT email even with appshots candidates', async () => {
    const calls = [];
    const emailService = {
      sendAppshotsDeviceAutoRevoked: async (u, i) => { calls.push({ u, i }); return true; },
    };
    const rows = [
      { id: 's2', token: 'APPSHOTS', user: { id: 'u2', email: 'u2@example.com', deletedAt: null } },
    ];
    const prisma = makePrisma({ candidates: 1, rows });
    const res = await run({
      prisma,
      dryRun: true,
      logger: silentLogger,
      emailService,
      isAppshotsToken: (t) => t === 'APPSHOTS',
    });
    assert.equal(res.dryRun, true);
    assert.equal(calls.length, 0);
  });

  test('survives findMany failure and still deletes', async () => {
    const calls = [];
    const emailService = {
      sendAppshotsDeviceAutoRevoked: async (u, i) => { calls.push({ u, i }); return true; },
    };
    const prisma = {
      session: {
        async deleteMany() { return { count: 3 }; },
        async count() { return 3; },
        async findMany() { throw new Error('db blew up'); },
      },
    };
    const res = await run({
      prisma,
      logger: silentLogger,
      emailService,
      isAppshotsToken: (t) => t === 'APPSHOTS',
    });
    assert.equal(res.deleted, 3);
    assert.equal(res.appshotsNotices, 0);
    assert.equal(calls.length, 0);
  });
});
