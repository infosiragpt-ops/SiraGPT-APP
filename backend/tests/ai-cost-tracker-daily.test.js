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
