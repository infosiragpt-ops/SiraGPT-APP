'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run } = require('../src/jobs/sweep-expired-pending-transfers');

function makePrisma({ rows = [], capture = {} } = {}) {
  return {
    orgPendingTransfer: {
      async findMany(args) {
        capture.findManyArgs = args;
        return rows.slice();
      },
      async deleteMany(args) {
        capture.deleteManyArgs = args;
        const ids = new Set((args?.where?.id?.in) || []);
        return { count: rows.filter((r) => ids.has(r.id)).length };
      },
      async count(args) {
        capture.countArgs = args;
        return rows.length;
      },
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

describe('sweep-expired-pending-transfers', () => {
  test('deletes expired unaccepted rows and emits one audit per row', async () => {
    const capture = {};
    const now = new Date('2026-05-20T12:00:00Z');
    const past = new Date('2026-05-19T12:00:00Z');
    const rows = [
      {
        id: 'pt1',
        orgId: 'o1',
        fromOwnerId: 'u-owner1',
        toOwnerId: 'u-new1',
        requestedAt: past,
        expiresAt: past,
      },
      {
        id: 'pt2',
        orgId: 'o2',
        fromOwnerId: 'u-owner2',
        toOwnerId: 'u-new2',
        requestedAt: past,
        expiresAt: past,
      },
    ];
    const prisma = makePrisma({ rows, capture });
    const audits = [];
    const writeAuditLog = (_db, payload) => { audits.push(payload); };

    const res = await run({ prisma, now, logger: silentLogger, writeAuditLog });

    assert.equal(res.deleted, 2);
    assert.equal(res.dryRun, false);
    assert.equal(res.now, now.toISOString());
    assert.deepEqual(capture.findManyArgs.where, {
      expiresAt: { lt: now },
      acceptedAt: null,
    });
    assert.deepEqual(capture.deleteManyArgs.where, {
      id: { in: ['pt1', 'pt2'] },
      acceptedAt: null,
    });
    assert.equal(audits.length, 2);
    assert.equal(audits[0].action, 'org_ownership_transfer_expired');
    assert.equal(audits[0].actorType, 'system');
    assert.equal(audits[0].resource, 'organization');
    assert.equal(audits[0].resourceId, 'o1');
    assert.equal(audits[0].metadata.transferId, 'pt1');
    assert.equal(audits[0].metadata.fromOwnerId, 'u-owner1');
    assert.equal(audits[0].metadata.toOwnerId, 'u-new1');
    assert.equal(audits[0].metadata.orgId, 'o1');
    assert.equal(audits[0].metadata.expiresAt, past.toISOString());
  });

  test('dry-run counts but does not delete or audit', async () => {
    const capture = {};
    const now = new Date('2026-05-20T12:00:00Z');
    const past = new Date('2026-05-19T12:00:00Z');
    const rows = [
      { id: 'pt1', orgId: 'o1', fromOwnerId: 'u1', toOwnerId: 'u2', requestedAt: past, expiresAt: past },
      { id: 'pt2', orgId: 'o2', fromOwnerId: 'u3', toOwnerId: 'u4', requestedAt: past, expiresAt: past },
      { id: 'pt3', orgId: 'o3', fromOwnerId: 'u5', toOwnerId: 'u6', requestedAt: past, expiresAt: past },
    ];
    const prisma = makePrisma({ rows, capture });
    const audits = [];
    const writeAuditLog = (_db, payload) => { audits.push(payload); };

    const res = await run({ prisma, now, dryRun: true, logger: silentLogger, writeAuditLog });

    assert.equal(res.deleted, 0);
    assert.equal(res.candidates, 3);
    assert.equal(res.dryRun, true);
    assert.equal(capture.deleteManyArgs, undefined);
    assert.equal(audits.length, 0);
    assert.deepEqual(capture.countArgs.where, {
      expiresAt: { lt: now },
      acceptedAt: null,
    });
  });

  test('no candidates short-circuits without deleteMany or audit', async () => {
    const capture = {};
    const prisma = makePrisma({ rows: [], capture });
    const audits = [];
    const writeAuditLog = (_db, payload) => { audits.push(payload); };

    const res = await run({ prisma, logger: silentLogger, writeAuditLog });

    assert.equal(res.deleted, 0);
    assert.equal(res.dryRun, false);
    assert.equal(capture.deleteManyArgs, undefined);
    assert.equal(audits.length, 0);
  });

  test('filter excludes accepted rows via acceptedAt: null', async () => {
    const capture = {};
    const prisma = makePrisma({ rows: [], capture });
    await run({ prisma, logger: silentLogger, writeAuditLog: () => {} });
    assert.equal(capture.findManyArgs.where.acceptedAt, null);
  });

  test('audit failure does not abort the sweep', async () => {
    const capture = {};
    const now = new Date('2026-05-20T12:00:00Z');
    const past = new Date('2026-05-19T12:00:00Z');
    const rows = [
      { id: 'pt1', orgId: 'o1', fromOwnerId: 'u1', toOwnerId: 'u2', requestedAt: past, expiresAt: past },
    ];
    const prisma = makePrisma({ rows, capture });
    const writeAuditLog = () => { throw new Error('audit boom'); };

    const res = await run({ prisma, now, logger: silentLogger, writeAuditLog });
    assert.equal(res.deleted, 1);
  });
});
