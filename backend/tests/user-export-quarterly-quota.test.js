'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const usersRoute = require('../src/routes/users');
const {
  EXPORT_QUARTERLY_LIMIT,
  quarterKeyForDate,
  quarterEndsAt,
  quarterSettingsKey,
  readQuarterCount,
  incrementQuarterCount,
  checkQuarterlyExportQuota,
  recordQuarterlyExport,
} = usersRoute.INTERNAL;

function makeFakePrisma() {
  const store = new Map();
  return {
    systemSettings: {
      async findUnique({ where }) {
        return store.get(where.key) || null;
      },
      async upsert({ where, create, update }) {
        const existing = store.get(where.key);
        if (existing) {
          const next = { ...existing, ...update };
          store.set(where.key, next);
          return next;
        }
        store.set(where.key, create);
        return create;
      },
    },
    _store: store,
  };
}

test('EXPORT_QUARTERLY_LIMIT is 10', () => {
  assert.equal(EXPORT_QUARTERLY_LIMIT, 10);
});

test('quarterKeyForDate maps months to Q1..Q4', () => {
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 0, 15))).label, '2026-Q1');
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 2, 31))).label, '2026-Q1');
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 3, 1))).label, '2026-Q2');
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 5, 30))).label, '2026-Q2');
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 6, 1))).label, '2026-Q3');
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 8, 30))).label, '2026-Q3');
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 9, 1))).label, '2026-Q4');
  assert.equal(quarterKeyForDate(new Date(Date.UTC(2026, 11, 31))).label, '2026-Q4');
});

test('quarterEndsAt returns first day of next quarter UTC', () => {
  assert.equal(quarterEndsAt(2026, 1).toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(quarterEndsAt(2026, 2).toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(quarterEndsAt(2026, 3).toISOString(), '2026-10-01T00:00:00.000Z');
  // Q4 rolls over to next year
  assert.equal(quarterEndsAt(2026, 4).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('quarterSettingsKey is stable and user-scoped', () => {
  const qInfo = { label: '2026-Q2' };
  assert.equal(quarterSettingsKey('u1', qInfo), 'user-export-quarter:u1:2026-Q2');
  assert.notEqual(
    quarterSettingsKey('u1', qInfo),
    quarterSettingsKey('u2', qInfo),
  );
});

test('readQuarterCount returns 0 when no row exists', async () => {
  const prisma = makeFakePrisma();
  const n = await readQuarterCount(prisma, 'u1', quarterKeyForDate());
  assert.equal(n, 0);
});

test('incrementQuarterCount increases the persisted count', async () => {
  const prisma = makeFakePrisma();
  const qInfo = quarterKeyForDate();
  await incrementQuarterCount(prisma, 'u1', qInfo);
  await incrementQuarterCount(prisma, 'u1', qInfo);
  await incrementQuarterCount(prisma, 'u1', qInfo);
  const n = await readQuarterCount(prisma, 'u1', qInfo);
  assert.equal(n, 3);
});

test('counters are isolated per user and per quarter', async () => {
  const prisma = makeFakePrisma();
  const q = quarterKeyForDate();
  const otherQ = { year: q.year, quarter: q.quarter === 4 ? 1 : q.quarter + 1, label: `${q.year}-Q${q.quarter === 4 ? 1 : q.quarter + 1}` };
  await incrementQuarterCount(prisma, 'u1', q);
  await incrementQuarterCount(prisma, 'u1', q);
  await incrementQuarterCount(prisma, 'u2', q);
  await incrementQuarterCount(prisma, 'u1', otherQ);
  assert.equal(await readQuarterCount(prisma, 'u1', q), 2);
  assert.equal(await readQuarterCount(prisma, 'u2', q), 1);
  assert.equal(await readQuarterCount(prisma, 'u1', otherQ), 1);
});

test('checkQuarterlyExportQuota returns ok while under the cap', async () => {
  const prisma = makeFakePrisma();
  for (let i = 0; i < EXPORT_QUARTERLY_LIMIT - 1; i++) {
    await recordQuarterlyExport(prisma, 'u1');
  }
  const result = await checkQuarterlyExportQuota(prisma, 'u1');
  assert.equal(result.ok, true);
  assert.equal(result.used, EXPORT_QUARTERLY_LIMIT - 1);
  assert.equal(result.limit, EXPORT_QUARTERLY_LIMIT);
});

test('checkQuarterlyExportQuota blocks once limit reached and exposes resetAt', async () => {
  const prisma = makeFakePrisma();
  for (let i = 0; i < EXPORT_QUARTERLY_LIMIT; i++) {
    await recordQuarterlyExport(prisma, 'u1');
  }
  const result = await checkQuarterlyExportQuota(prisma, 'u1');
  assert.equal(result.ok, false);
  assert.equal(result.used, EXPORT_QUARTERLY_LIMIT);
  assert.ok(result.resetAt instanceof Date);
  assert.ok(result.resetAt.getTime() > Date.now());
});

test('checkQuarterlyExportQuota fails open (ok:true) when prisma lacks systemSettings', async () => {
  const result = await checkQuarterlyExportQuota({}, 'u1');
  assert.equal(result.ok, true);
  assert.equal(result.used, 0);
});

test('readQuarterCount tolerates malformed JSON in stored row', async () => {
  const prisma = makeFakePrisma();
  const qInfo = quarterKeyForDate();
  prisma._store.set(quarterSettingsKey('u1', qInfo), {
    key: quarterSettingsKey('u1', qInfo),
    value: '{bad-json',
  });
  const n = await readQuarterCount(prisma, 'u1', qInfo);
  assert.equal(n, 0);
});

test('incrementQuarterCount swallows store errors without throwing', async () => {
  const broken = {
    systemSettings: {
      async findUnique() { throw new Error('db down'); },
      async upsert() { throw new Error('db down'); },
    },
  };
  await assert.doesNotReject(() => incrementQuarterCount(broken, 'u1', quarterKeyForDate()));
});
