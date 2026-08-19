'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run } = require('../src/jobs/sweep-webhook-secret-grace');

function makePrisma({ updated = 0, candidates = 0, capture = {} } = {}) {
  return {
    webhookEndpoint: {
      async updateMany(args) {
        capture.updateArgs = args;
        return { count: updated };
      },
      async count(args) {
        capture.countArgs = args;
        return candidates;
      },
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

describe('sweep-webhook-secret-grace', () => {
  test('clears previousSecret + previousSecretExpiresAt for elapsed grace windows', async () => {
    const capture = {};
    const prisma = makePrisma({ updated: 3, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.cleared, 3);
    assert.equal(res.dryRun, false);
    assert.equal(res.now, now.toISOString());
    assert.ok(capture.updateArgs);
    assert.deepEqual(capture.updateArgs.where, {
      previousSecretExpiresAt: { lt: now, not: null },
    });
    assert.deepEqual(capture.updateArgs.data, {
      previousSecret: null,
      previousSecretExpiresAt: null,
    });
  });

  test('dry-run counts but does not update', async () => {
    const capture = {};
    const prisma = makePrisma({ updated: 99, candidates: 5, capture });
    const now = new Date('2026-05-19T12:00:00Z');

    const res = await run({ prisma, now, dryRun: true, logger: silentLogger });

    assert.equal(res.cleared, 0);
    assert.equal(res.candidates, 5);
    assert.equal(res.dryRun, true);
    assert.equal(capture.updateArgs, undefined);
    assert.deepEqual(capture.countArgs.where, {
      previousSecretExpiresAt: { lt: now, not: null },
    });
  });

  test('null-expiry rows excluded (not: null guard)', async () => {
    const capture = {};
    const prisma = makePrisma({ updated: 0, capture });
    await run({ prisma, logger: silentLogger });
    assert.equal(capture.updateArgs.where.previousSecretExpiresAt.not, null);
  });

  test('handles updateMany returning no count gracefully', async () => {
    const prisma = {
      webhookEndpoint: {
        async updateMany() { return {}; },
        async count() { return 0; },
      },
    };
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.cleared, 0);
  });
});
