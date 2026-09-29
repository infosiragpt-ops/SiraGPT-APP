'use strict';

// Live 2026-09-29 (Admin → Logs): «prisma:error Invalid
// `prisma.codexProactiveLease.create()` invocation: Unique constraint failed
// on the fields: (`projectId`)». Two sweeps racing for the same project is
// the normal contended case; the loser must get `null` without Prisma ever
// logging an error, so acquisition inserts with ON CONFLICT DO NOTHING.

const test = require('node:test');
const assert = require('node:assert/strict');

const { acquireProactiveLease, releaseProactiveLease } = require('../src/services/codex/proactive-lease');

function fakeLeaseModel() {
  const rows = new Map();
  const calls = { create: 0, createMany: 0 };
  return {
    rows,
    calls,
    async updateMany({ where, data }) {
      const row = rows.get(where.projectId);
      if (row && row.expiresAt <= where.expiresAt.lte) {
        rows.set(where.projectId, { ...row, ...data });
        return { count: 1 };
      }
      return { count: 0 };
    },
    async createMany({ data, skipDuplicates }) {
      calls.createMany++;
      assert.equal(skipDuplicates, true);
      let count = 0;
      for (const row of data) {
        if (rows.has(row.projectId)) continue;
        rows.set(row.projectId, row);
        count++;
      }
      return { count };
    },
    async create() {
      calls.create++;
      throw Object.assign(new Error('Unique constraint failed on the fields: (`projectId`)'), { code: 'P2002' });
    },
    async deleteMany({ where }) {
      const row = rows.get(where.projectId);
      if (row && row.token === where.token) rows.delete(where.projectId);
      return { count: row ? 1 : 0 };
    },
  };
}

test('a contended lease returns null through the conflict-free insert (create() is never called)', async () => {
  const model = fakeLeaseModel();
  const prisma = { codexProactiveLease: model };
  const now = new Date('2026-09-29T20:00:00Z');

  const first = await acquireProactiveLease({ prisma, projectId: 'p1', now });
  assert.ok(first && first.token);
  const second = await acquireProactiveLease({ prisma, projectId: 'p1', now });
  assert.equal(second, null);
  assert.equal(model.calls.create, 0, 'no throwing create() → no «prisma:error» log line');
  assert.equal(model.calls.createMany, 2);
});

test('an expired lease is reclaimed, and release frees it for the next sweep', async () => {
  const model = fakeLeaseModel();
  const prisma = { codexProactiveLease: model };
  const t0 = new Date('2026-09-29T20:00:00Z');
  const first = await acquireProactiveLease({ prisma, projectId: 'p1', now: t0 });
  const later = new Date(first.expiresAt.getTime() + 1000);
  const reclaimed = await acquireProactiveLease({ prisma, projectId: 'p1', now: later });
  assert.ok(reclaimed && reclaimed.token !== first.token);

  await releaseProactiveLease({ prisma, lease: reclaimed });
  assert.equal(model.rows.has('p1'), false);
  assert.ok(await acquireProactiveLease({ prisma, projectId: 'p1', now: later }));
});

test('without createMany the legacy create() path still maps P2002 to null', async () => {
  const model = fakeLeaseModel();
  model.rows.set('p1', { projectId: 'p1', token: 'held', expiresAt: new Date('2099-01-01') });
  delete model.createMany;
  const lease = await acquireProactiveLease({
    prisma: { codexProactiveLease: model },
    projectId: 'p1',
    now: new Date('2026-09-29T20:00:00Z'),
  });
  assert.equal(lease, null);
  assert.equal(model.calls.create, 1);
});
