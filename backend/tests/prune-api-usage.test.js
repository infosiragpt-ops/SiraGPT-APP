'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { run, _yearMonth, _summaryKey } = require('../src/jobs/prune-api-usage');
const metrics = require('../src/utils/metrics');

function buildPrismaStub({ now }) {
  // Two old rows (past 90d) and one fresh row (within 90d). Use BigInt
  // tokens to mirror the Prisma schema.
  const old1 = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
  const old2 = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000);
  const fresh = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

  const state = {
    rows: [
      { id: 'r-1', userId: 'u-1', model: 'gpt-4', tokens: 100n, cost: 0.5, timestamp: old1 },
      { id: 'r-2', userId: 'u-1', model: 'gpt-4', tokens: 200n, cost: 1.0, timestamp: old2 },
      { id: 'r-3', userId: 'u-2', model: 'claude', tokens: 50n, cost: 0.25, timestamp: old2 },
      { id: 'r-4', userId: 'u-1', model: 'gpt-4', tokens: 999n, cost: 9.99, timestamp: fresh },
    ],
    settings: new Map(),
    deleted: 0,
  };

  return {
    apiUsage: {
      async findMany({ where, orderBy, take, cursor, skip }) {
        let rows = state.rows.filter((r) => r.timestamp < where.timestamp.lt);
        rows.sort((a, b) => a.timestamp - b.timestamp);
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          rows = rows.slice(idx + (skip || 0));
        }
        return rows.slice(0, take || rows.length);
      },
      async deleteMany({ where }) {
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => r.timestamp >= where.timestamp.lt);
        const count = before - state.rows.length;
        state.deleted += count;
        return { count };
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

describe('prune-api-usage', () => {
  test('aggregates old rows into monthly summaries and deletes them', async () => {
    metrics._reset();
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });

    const res = await run({
      prisma,
      now,
      rawDays: 90,
      batchSize: 10,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(res.aggregated, 3);
    assert.equal(res.deleted, 3);
    assert.equal(res.dryRun, false);
    assert.ok(res.summaries >= 2);

    // Fresh row survives.
    assert.equal(prisma._state.rows.length, 1);
    assert.equal(prisma._state.rows[0].id, 'r-4');

    // Summary contents are correct for (u-1, gpt-4) — two rows merged.
    const ym = _yearMonth(new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000));
    // Two old rows for u-1 may straddle months: we just check union.
    let totalU1Calls = 0;
    let totalU1Tokens = 0n;
    for (const [key, val] of prisma._state.settings) {
      if (!key.includes(':u-1:gpt-4')) continue;
      const parsed = JSON.parse(val);
      totalU1Calls += parsed.calls;
      totalU1Tokens += BigInt(parsed.tokens);
    }
    assert.equal(totalU1Calls, 2);
    assert.equal(totalU1Tokens, 300n);

    // Metrics bumped.
    const txt = metrics.renderText();
    assert.match(txt, /siragpt_apiusage_pruned_total\{kind="row"\} 3/);

    // Key shape sanity.
    assert.ok(_summaryKey(ym, 'u-1', 'gpt-4').startsWith('apiusage:summary:'));
  });

  test('dry-run does not delete rows or write summaries', async () => {
    metrics._reset();
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });

    const res = await run({
      prisma,
      now,
      rawDays: 90,
      dryRun: true,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(res.dryRun, true);
    assert.equal(res.deleted, 0);
    assert.equal(prisma._state.rows.length, 4); // nothing deleted
    assert.equal(prisma._state.settings.size, 0); // nothing written

    const txt = metrics.renderText();
    assert.doesNotMatch(txt, /siragpt_apiusage_pruned_total\{kind="row"\} [1-9]/);
  });

  test('no-op when no rows are past the cutoff', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });

    const res = await run({
      prisma,
      now,
      rawDays: 365 * 10, // very far in the past
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(res.aggregated, 0);
    assert.equal(res.deleted, 0);
    assert.equal(res.summaries, 0);
    assert.equal(prisma._state.rows.length, 4);
  });

  test('summaries are additive across re-runs (upsert merges totals)', async () => {
    const now = new Date('2026-05-19T00:00:00Z');
    const prisma = buildPrismaStub({ now });

    // First run prunes the 3 old rows.
    const r1 = await run({
      prisma,
      now,
      rawDays: 90,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(r1.aggregated, 3);

    // Seed a new old row in u-1/gpt-4 and re-run; summary tokens should grow.
    const extraTs = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
    prisma._state.rows.push({
      id: 'r-5', userId: 'u-1', model: 'gpt-4', tokens: 50n, cost: 0.1, timestamp: extraTs,
    });

    const r2 = await run({
      prisma,
      now,
      rawDays: 90,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(r2.aggregated, 1);
    assert.equal(r2.deleted, 1);

    let totalU1Tokens = 0n;
    for (const [key, val] of prisma._state.settings) {
      if (!key.includes(':u-1:gpt-4')) continue;
      totalU1Tokens += BigInt(JSON.parse(val).tokens);
    }
    assert.equal(totalU1Tokens, 350n);
  });
});
