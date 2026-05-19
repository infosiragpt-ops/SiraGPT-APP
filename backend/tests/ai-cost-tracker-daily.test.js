/**
 * Tests for cost-tracker daily persistence (ratchet 45):
 *   - aggregateDaily() folds records by (date, userId, model, provider, org)
 *   - flushDaily() upserts via injected Prisma stub and advances watermark
 *   - loadDailyReport() converts persisted rows to a report envelope
 *   - mergeReports() sums persistent + recent without double-counting
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ct = require('../src/services/ai/cost-tracker');

beforeEach(() => ct._reset());

function makePrismaStub() {
  const rows = new Map();
  const keyOf = (w) => `${w.date.toISOString()}|${w.userId}|${w.model}|${w.provider}|${w.organizationId}`;
  return {
    rows,
    costUsageDaily: {
      async upsert({ where, create, update }) {
        const w = where.cost_usage_daily_unique;
        const k = keyOf(w);
        const existing = rows.get(k);
        if (!existing) {
          rows.set(k, { ...create });
          return create;
        }
        // Emulate prisma `{ increment: n }` semantics.
        for (const field of Object.keys(update)) {
          const op = update[field];
          if (op && typeof op === 'object' && 'increment' in op) {
            const cur = existing[field];
            if (typeof cur === 'bigint' || typeof op.increment === 'bigint') {
              existing[field] = BigInt(cur || 0) + BigInt(op.increment);
            } else {
              existing[field] = Number(cur || 0) + Number(op.increment);
            }
          } else {
            existing[field] = op;
          }
        }
        return existing;
      },
      async findMany({ where = {} } = {}) {
        const out = [];
        for (const r of rows.values()) {
          if (where.date) {
            if (where.date.gte && r.date < where.date.gte) continue;
            if (where.date.lte && r.date > where.date.lte) continue;
          }
          if (where.userId != null && r.userId !== where.userId) continue;
          if (where.organizationId != null && r.organizationId !== where.organizationId) continue;
          out.push(r);
        }
        return out;
      },
    },
  };
}

test('aggregateDaily folds records by day + key', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', provider: 'openai', inputTokens: 100, outputTokens: 50, ts: new Date('2026-05-10T10:00:00Z') });
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', provider: 'openai', inputTokens: 200, outputTokens: 0, ts: new Date('2026-05-10T18:00:00Z') });
  ct.track({ userId: 'u2', model: 'gpt-4o-mini', provider: 'openai', inputTokens: 50, outputTokens: 0, ts: new Date('2026-05-10T18:00:00Z') });
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', provider: 'openai', inputTokens: 10, outputTokens: 0, ts: new Date('2026-05-11T01:00:00Z') });
  const rows = ct.aggregateDaily({ since: 0 });
  // 3 distinct (day,userId) combos.
  assert.equal(rows.length, 3);
  const u1d10 = rows.find((r) => r.userId === 'u1' && r.date.toISOString().startsWith('2026-05-10'));
  assert.ok(u1d10);
  assert.equal(u1d10.inputTokens, 300);
  assert.equal(u1d10.outputTokens, 50);
  assert.equal(u1d10.requests, 2);
});

test('aggregateDaily honours since high-water mark', () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 100, ts: new Date('2026-05-10T10:00:00Z') });
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 200, ts: new Date('2026-05-10T20:00:00Z') });
  const rows = ct.aggregateDaily({ since: new Date('2026-05-10T15:00:00Z') });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 200);
});

test('aggregateDaily uses userOrgIndex map', () => {
  ct.track({ userId: 'u1', model: 'm', inputTokens: 10, ts: new Date('2026-05-10T10:00:00Z') });
  const index = new Map([['u1', 'org-1']]);
  const rows = ct.aggregateDaily({ since: 0, userOrgIndex: index });
  assert.equal(rows[0].organizationId, 'org-1');
});

test('flushDaily upserts each bucket and advances watermark', async () => {
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, ts: new Date('2026-05-10T10:00:00Z') });
  ct.track({ userId: 'u1', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, ts: new Date('2026-05-10T11:00:00Z') });
  const stub = makePrismaStub();
  const res = await ct.flushDaily({ prisma: stub, until: new Date('2026-05-11T00:00:00Z') });
  assert.equal(res.rows, 1);
  assert.equal(res.persisted, 1);
  assert.equal(res.errors, 0);
  const row = [...stub.rows.values()][0];
  assert.equal(row.userId, 'u1');
  assert.equal(row.requests, 2);
  assert.equal(BigInt(row.inputTokens), 2_000_000n);

  // Running flush again with the same records should be a no-op because
  // the watermark advanced past them.
  const res2 = await ct.flushDaily({ prisma: stub, until: new Date('2026-05-11T01:00:00Z') });
  assert.equal(res2.rows, 0);
});

test('flushDaily is additive across runs (increment upsert)', async () => {
  ct.track({ userId: 'u1', model: 'm', inputTokens: 100, ts: new Date('2026-05-10T10:00:00Z') });
  const stub = makePrismaStub();
  await ct.flushDaily({ prisma: stub, until: new Date('2026-05-10T12:00:00Z') });
  // New record AFTER the previous watermark → next flush adds to existing row.
  ct.track({ userId: 'u1', model: 'm', inputTokens: 50, ts: new Date('2026-05-10T15:00:00Z') });
  await ct.flushDaily({ prisma: stub, until: new Date('2026-05-10T20:00:00Z') });
  const row = [...stub.rows.values()][0];
  assert.equal(BigInt(row.inputTokens), 150n);
  assert.equal(row.requests, 2);
});

test('flushDaily returns errors envelope when prisma is unavailable', async () => {
  ct.track({ userId: 'u1', model: 'm', inputTokens: 100 });
  const res = await ct.flushDaily({ prisma: {} });
  assert.equal(res.errors, 1);
  assert.equal(res.persisted, 0);
});

test('loadDailyReport produces report envelope from persisted rows', async () => {
  const stub = makePrismaStub();
  // Seed two rows.
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: new Date('2026-05-10T00:00:00Z'), userId: 'u1', model: 'm', provider: 'p', organizationId: '' } },
    create: { date: new Date('2026-05-10T00:00:00Z'), userId: 'u1', model: 'm', provider: 'p', organizationId: '', inputTokens: 100n, outputTokens: 50n, costUSD: 1.5, requests: 3 },
    update: {},
  });
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: new Date('2026-05-11T00:00:00Z'), userId: 'u2', model: 'm', provider: 'p', organizationId: '' } },
    create: { date: new Date('2026-05-11T00:00:00Z'), userId: 'u2', model: 'm', provider: 'p', organizationId: '', inputTokens: 200n, outputTokens: 0n, costUSD: 2.0, requests: 5 },
    update: {},
  });
  const r = await ct.loadDailyReport({ from: new Date('2026-05-01'), to: new Date('2026-05-30'), prisma: stub });
  assert.equal(r.totals.records, 8);
  assert.equal(r.totals.costUSD, 3.5);
  assert.equal(r.perUser.length, 2);
  // Sorted by costUSD desc.
  assert.equal(r.perUser[0].userId, 'u2');
});

test('loadDailyReport filters by userId', async () => {
  const stub = makePrismaStub();
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: new Date('2026-05-10T00:00:00Z'), userId: 'u1', model: 'm', provider: '', organizationId: '' } },
    create: { date: new Date('2026-05-10T00:00:00Z'), userId: 'u1', model: 'm', provider: '', organizationId: '', inputTokens: 100n, outputTokens: 0n, costUSD: 1, requests: 1 },
    update: {},
  });
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: new Date('2026-05-10T00:00:00Z'), userId: 'u2', model: 'm', provider: '', organizationId: '' } },
    create: { date: new Date('2026-05-10T00:00:00Z'), userId: 'u2', model: 'm', provider: '', organizationId: '', inputTokens: 100n, outputTokens: 0n, costUSD: 1, requests: 1 },
    update: {},
  });
  const r = await ct.loadDailyReport({ userId: 'u1', prisma: stub });
  assert.equal(r.totals.records, 1);
  assert.equal(r.perUser[0].userId, 'u1');
});

test('loadDailyReport returns empty envelope when prisma is missing', async () => {
  const r = await ct.loadDailyReport({ prisma: {} });
  assert.equal(r.totals.records, 0);
  assert.deepEqual(r.perUser, []);
});

function makePrismaWithArchive() {
  const stub = makePrismaStub();
  const settings = new Map();
  stub.systemSettings = {
    async findUnique({ where }) {
      const row = settings.get(where.key);
      return row || null;
    },
    async upsert({ where, create, update }) {
      const existing = settings.get(where.key);
      if (!existing) {
        settings.set(where.key, { ...create });
        return create;
      }
      Object.assign(existing, update);
      return existing;
    },
    async findMany({ where = {} } = {}) {
      const out = [];
      const startsWith = where.key && where.key.startsWith;
      for (const r of settings.values()) {
        if (startsWith && !r.key.startsWith(startsWith)) continue;
        out.push(r);
      }
      return out;
    },
  };
  // Extend findMany to support `date.lt` filter used by archiveOldDaily.
  const origFindMany = stub.costUsageDaily.findMany;
  stub.costUsageDaily.findMany = async ({ where = {} } = {}) => {
    if (where.date && where.date.lt) {
      const out = [];
      for (const r of stub.rows.values()) {
        if (r.date < where.date.lt) out.push(r);
      }
      return out;
    }
    return origFindMany({ where });
  };
  stub.costUsageDaily.deleteMany = async ({ where = {} } = {}) => {
    let count = 0;
    for (const [k, r] of [...stub.rows.entries()]) {
      if (where.date && where.date.lt && !(r.date < where.date.lt)) continue;
      stub.rows.delete(k);
      count += 1;
    }
    return { count };
  };
  stub._settings = settings;
  return stub;
}

test('archiveOldDaily folds rows >13 months into SystemSettings and deletes them', async () => {
  const stub = makePrismaWithArchive();
  // Seed: one row 14 months old, one row 3 months old.
  const now = new Date('2026-05-19T00:00:00Z');
  const oldDate = new Date('2025-03-10T00:00:00Z'); // ~14 months old
  const recentDate = new Date('2026-02-10T00:00:00Z'); // ~3 months old
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: oldDate, userId: 'u1', model: 'm', provider: 'p', organizationId: '' } },
    create: { date: oldDate, userId: 'u1', model: 'm', provider: 'p', organizationId: '', inputTokens: 100n, outputTokens: 50n, costUSD: 1.5, requests: 3 },
    update: {},
  });
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: oldDate, userId: 'u1', model: 'm2', provider: 'p', organizationId: '' } },
    create: { date: oldDate, userId: 'u1', model: 'm2', provider: 'p', organizationId: '', inputTokens: 10n, outputTokens: 5n, costUSD: 0.5, requests: 1 },
    update: {},
  });
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: recentDate, userId: 'u1', model: 'm', provider: 'p', organizationId: '' } },
    create: { date: recentDate, userId: 'u1', model: 'm', provider: 'p', organizationId: '', inputTokens: 99n, outputTokens: 0n, costUSD: 2, requests: 7 },
    update: {},
  });
  const res = await ct.archiveOldDaily({ prisma: stub, now });
  assert.equal(res.scanned, 2);
  assert.equal(res.archivedKeys, 1);
  assert.equal(res.deleted, 2);
  assert.equal(res.errors, 0);
  // Only the recent row should remain.
  assert.equal(stub.rows.size, 1);
  // Archive entry exists with the expected key + merged totals.
  const key = `${ct.ARCHIVE_KEY_PREFIX}2025-03-u1`;
  const entry = JSON.parse(stub._settings.get(key).value);
  assert.equal(entry.month, '2025-03');
  assert.equal(entry.userId, 'u1');
  assert.equal(entry.requests, 4);
  assert.equal(entry.costUSD, 2);
  assert.equal(entry.perModel.length, 2);
});

test('archiveOldDaily is idempotent — re-running merges additively', async () => {
  const stub = makePrismaWithArchive();
  const now = new Date('2026-05-19T00:00:00Z');
  const oldDate = new Date('2025-03-10T00:00:00Z');
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: oldDate, userId: 'u1', model: 'm', provider: '', organizationId: '' } },
    create: { date: oldDate, userId: 'u1', model: 'm', provider: '', organizationId: '', inputTokens: 100n, outputTokens: 0n, costUSD: 1, requests: 1 },
    update: {},
  });
  await ct.archiveOldDaily({ prisma: stub, now });
  // Insert another old row in the same (month,user) and re-run.
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: oldDate, userId: 'u1', model: 'm', provider: '', organizationId: '' } },
    create: { date: oldDate, userId: 'u1', model: 'm', provider: '', organizationId: '', inputTokens: 50n, outputTokens: 0n, costUSD: 0.5, requests: 1 },
    update: {},
  });
  await ct.archiveOldDaily({ prisma: stub, now });
  const key = `${ct.ARCHIVE_KEY_PREFIX}2025-03-u1`;
  const entry = JSON.parse(stub._settings.get(key).value);
  assert.equal(entry.requests, 2);
  assert.equal(entry.costUSD, 1.5);
});

test('archiveOldDaily preserves rows when archive upsert fails', async () => {
  const stub = makePrismaWithArchive();
  const now = new Date('2026-05-19T00:00:00Z');
  const oldDate = new Date('2025-03-10T00:00:00Z');
  await stub.costUsageDaily.upsert({
    where: { cost_usage_daily_unique: { date: oldDate, userId: 'u1', model: 'm', provider: '', organizationId: '' } },
    create: { date: oldDate, userId: 'u1', model: 'm', provider: '', organizationId: '', inputTokens: 1n, outputTokens: 0n, costUSD: 0.1, requests: 1 },
    update: {},
  });
  stub.systemSettings.upsert = async () => { throw new Error('db down'); };
  const res = await ct.archiveOldDaily({ prisma: stub, now });
  assert.equal(res.errors, 1);
  assert.equal(res.deleted, 0);
  assert.equal(stub.rows.size, 1);
});

test('archiveOldDaily returns errors envelope when prisma is unavailable', async () => {
  const res = await ct.archiveOldDaily({ prisma: {} });
  assert.equal(res.errors, 1);
});

test('loadArchivedReport reads SystemSettings cost_archive:* entries', async () => {
  const stub = makePrismaWithArchive();
  stub._settings.set(`${ct.ARCHIVE_KEY_PREFIX}2025-01-u1`, {
    key: `${ct.ARCHIVE_KEY_PREFIX}2025-01-u1`,
    value: JSON.stringify({
      month: '2025-01', userId: 'u1', costUSD: 2.5, inputTokens: 1000, outputTokens: 500, requests: 10,
      perModel: [{ model: 'm', costUSD: 2.5, requests: 10 }],
    }),
  });
  stub._settings.set(`${ct.ARCHIVE_KEY_PREFIX}2025-02-u2`, {
    key: `${ct.ARCHIVE_KEY_PREFIX}2025-02-u2`,
    value: JSON.stringify({
      month: '2025-02', userId: 'u2', costUSD: 1.0, inputTokens: 200, outputTokens: 50, requests: 4,
      perModel: [{ model: 'm', costUSD: 1.0, requests: 4 }],
    }),
  });
  const r = await ct.loadArchivedReport({ from: new Date('2025-01-01'), to: new Date('2025-12-31'), prisma: stub });
  assert.equal(r.totals.records, 14);
  assert.equal(r.totals.costUSD, 3.5);
  assert.equal(r.perUser.length, 2);
  // Filter by userId.
  const ru1 = await ct.loadArchivedReport({ userId: 'u1', prisma: stub });
  assert.equal(ru1.perUser.length, 1);
  assert.equal(ru1.perUser[0].userId, 'u1');
});

test('loadArchivedReport filters by month range (from/to)', async () => {
  const stub = makePrismaWithArchive();
  stub._settings.set(`${ct.ARCHIVE_KEY_PREFIX}2024-12-u1`, {
    key: `${ct.ARCHIVE_KEY_PREFIX}2024-12-u1`,
    value: JSON.stringify({ month: '2024-12', userId: 'u1', costUSD: 1, requests: 1, perModel: [] }),
  });
  stub._settings.set(`${ct.ARCHIVE_KEY_PREFIX}2025-06-u1`, {
    key: `${ct.ARCHIVE_KEY_PREFIX}2025-06-u1`,
    value: JSON.stringify({ month: '2025-06', userId: 'u1', costUSD: 2, requests: 2, perModel: [] }),
  });
  const r = await ct.loadArchivedReport({ from: new Date('2025-01-01'), prisma: stub });
  assert.equal(r.totals.requests || r.totals.records, 2);
  assert.equal(r.perUser[0].costUSD, 2);
});

test('loadArchivedReport ignores malformed archive payloads', async () => {
  const stub = makePrismaWithArchive();
  stub._settings.set(`${ct.ARCHIVE_KEY_PREFIX}bad`, {
    key: `${ct.ARCHIVE_KEY_PREFIX}bad`,
    value: 'not-json',
  });
  const r = await ct.loadArchivedReport({ prisma: stub });
  assert.equal(r.totals.records, 0);
});

test('mergeReports sums totals + per-user + per-model without dropping data', () => {
  const persisted = {
    totals: { records: 5, costUSD: 1.5, inputTokens: 100, outputTokens: 50 },
    perUser: [{ userId: 'u1', costUSD: 1.5, inputTokens: 100, outputTokens: 50, requests: 5 }],
    perModel: [{ model: 'gpt-4o-mini', costUSD: 1.5, requests: 5 }],
    records: [],
  };
  const recent = {
    totals: { records: 2, costUSD: 0.5, inputTokens: 20, outputTokens: 10 },
    perUser: [
      { userId: 'u1', costUSD: 0.3, inputTokens: 10, outputTokens: 5, requests: 1 },
      { userId: 'u2', costUSD: 0.2, inputTokens: 10, outputTokens: 5, requests: 1 },
    ],
    perModel: [{ model: 'gpt-4o-mini', costUSD: 0.5, requests: 2 }],
    records: [{ ts: '2026-05-11T10:00:00Z' }],
  };
  const merged = ct.mergeReports(persisted, recent);
  assert.equal(merged.totals.records, 7);
  assert.equal(merged.totals.costUSD, 2);
  assert.equal(merged.totals.inputTokens, 120);
  assert.equal(merged.perUser.length, 2);
  const u1 = merged.perUser.find((u) => u.userId === 'u1');
  assert.equal(u1.requests, 6);
  assert.equal(u1.costUSD, 1.8);
  assert.equal(merged.perModel[0].requests, 7);
  // Records list comes from the recent (in-memory) side.
  assert.equal(merged.records.length, 1);
});
