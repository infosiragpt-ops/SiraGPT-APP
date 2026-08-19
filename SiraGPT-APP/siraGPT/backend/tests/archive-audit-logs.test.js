'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run, _yearMonth, _archiveKey } = require('../src/jobs/archive-audit-logs');

function buildPrismaStub({ now }) {
  // Three rows past 1y, one fresh row inside the window.
  const old1 = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
  const old2 = new Date(now.getTime() - 380 * 24 * 60 * 60 * 1000);
  const old3 = new Date(now.getTime() - 370 * 24 * 60 * 60 * 1000);
  const fresh = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const state = {
    rows: [
      { id: 'a-1', actorType: 'user', actorId: 'u-1', actorName: 'Alice',
        resourceType: 'doc', resourceId: 'd-1', action: 'create',
        before: null, after: { x: 1 }, diff: null, metadata: null, createdAt: old1 },
      { id: 'a-2', actorType: 'user', actorId: 'u-2', actorName: 'Bob',
        resourceType: 'doc', resourceId: 'd-2', action: 'update',
        before: { x: 1 }, after: { x: 2 }, diff: { x: [1, 2] }, metadata: null, createdAt: old2 },
      { id: 'a-3', actorType: 'system', actorId: null, actorName: null,
        resourceType: 'user', resourceId: 'u-9', action: 'delete',
        before: null, after: null, diff: null, metadata: { reason: 'gdpr' }, createdAt: old3 },
      { id: 'a-4', actorType: 'user', actorId: 'u-1', actorName: 'Alice',
        resourceType: 'doc', resourceId: 'd-3', action: 'create',
        before: null, after: null, diff: null, metadata: null, createdAt: fresh },
    ],
    settings: new Map(),
  };

  return {
    auditLog: {
      async findMany({ where, take, cursor, skip }) {
        let rows = state.rows.filter((r) => r.createdAt < where.createdAt.lt);
        rows.sort((a, b) => a.createdAt - b.createdAt);
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          rows = rows.slice(idx + (skip || 0));
        }
        return rows.slice(0, take || rows.length);
      },
      async deleteMany({ where }) {
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => r.createdAt >= where.createdAt.lt);
        return { count: before - state.rows.length };
      },
    },
    systemSettings: {
      async findUnique({ where }) {
        const v = state.settings.get(where.key);
        return v ? { key: where.key, value: v } : null;
      },
      async upsert({ where, update, create }) {
        if (state.settings.has(where.key)) {
          state.settings.set(where.key, update.value);
        } else {
          state.settings.set(where.key, create.value);
        }
      },
    },
    _state: state,
  };
}

describe('archive-audit-logs', () => {
  test('archives rows >1y old into SystemSettings and deletes them', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });

    const res = await run({
      prisma,
      now,
      retentionDays: 365,
      batchSize: 10,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(res.archived, 3);
    assert.equal(res.deleted, 3);
    assert.equal(res.dryRun, false);
    assert.ok(res.archives >= 1);
    // Fresh row survives.
    assert.equal(prisma._state.rows.length, 1);
    assert.equal(prisma._state.rows[0].id, 'a-4');
    // At least one archive key was written under the expected prefix.
    const keys = Array.from(prisma._state.settings.keys());
    assert.ok(keys.every((k) => k.startsWith('audit_archive:')));
    // Round-trip JSON works.
    const parsed = JSON.parse(prisma._state.settings.get(keys[0]));
    assert.equal(typeof parsed.yearMonth, 'string');
    assert.ok(Array.isArray(parsed.rows));
    assert.ok(parsed.rows.length >= 1);
    assert.ok(parsed.rows[0].id && parsed.rows[0].action);
  });

  test('dry-run does not touch DB or store', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });

    const res = await run({
      prisma,
      now,
      retentionDays: 365,
      batchSize: 10,
      dryRun: true,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(res.archived, 3);
    assert.equal(res.deleted, 0);
    assert.equal(res.dryRun, true);
    // Nothing deleted, nothing written.
    assert.equal(prisma._state.rows.length, 4);
    assert.equal(prisma._state.settings.size, 0);
  });

  test('re-running merges by id without duplicating archived rows', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });
    const logger = { info() {}, warn() {}, error() {} };

    await run({ prisma, now, retentionDays: 365, batchSize: 10, logger });
    // Manually re-insert one old row to simulate a partial-progress
    // recovery scenario — the merge should dedupe by id.
    prisma._state.rows.push({
      id: 'a-1', actorType: 'user', actorId: 'u-1', actorName: 'Alice',
      resourceType: 'doc', resourceId: 'd-1', action: 'create',
      before: null, after: { x: 1 }, diff: null, metadata: null,
      createdAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000),
    });
    const res2 = await run({ prisma, now, retentionDays: 365, batchSize: 10, logger });
    assert.equal(res2.archived, 1);
    assert.equal(res2.deleted, 1);
    // Archive for that month should still contain exactly one copy of a-1.
    const archiveKeys = Array.from(prisma._state.settings.keys());
    let countOfA1 = 0;
    for (const k of archiveKeys) {
      const parsed = JSON.parse(prisma._state.settings.get(k));
      countOfA1 += parsed.rows.filter((r) => r.id === 'a-1').length;
    }
    assert.equal(countOfA1, 1);
  });

  test('_yearMonth + _archiveKey produce expected keys', () => {
    const d = new Date('2025-03-09T12:00:00Z');
    assert.equal(_yearMonth(d), '2025-03');
    assert.equal(_archiveKey('2025-03'), 'audit_archive:2025-03');
  });

  test('returns zero counts when no rows are past cutoff', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });
    // Use a huge retention so nothing is past the cutoff.
    const res = await run({
      prisma,
      now,
      retentionDays: 100_000,
      batchSize: 10,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(res.archived, 0);
    assert.equal(res.deleted, 0);
    assert.equal(res.archives, 0);
    assert.equal(prisma._state.rows.length, 4);
    assert.equal(prisma._state.settings.size, 0);
  });
});
