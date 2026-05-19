'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run } = require('../src/jobs/sweep-expired-sessions');

function makePrisma({ deleted = 0, candidates = 0, capture = {} } = {}) {
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
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
  });
});
