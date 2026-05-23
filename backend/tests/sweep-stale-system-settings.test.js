'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const {
  run,
  ORG_IDLE_PREFIX,
  USER_IDLE_PREFIX,
  APIUSAGE_SUMMARY_PREFIX,
  DEFAULT_ORG_IDLE_DAYS,
  DEFAULT_USER_IDLE_DAYS,
  DEFAULT_APIUSAGE_DAYS,
  _extractTimestamp,
  _ownerIdFromKey,
} = require('../src/jobs/sweep-stale-system-settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const silentLogger = { info() {}, warn() {}, error() {} };

function makePrisma({ rows = [], liveOrgIds = [], liveUserIds = [], capture = {} } = {}) {
  capture.deletedKeys = [];
  return {
    systemSettings: {
      async findMany(args) {
        const prefix = args?.where?.key?.startsWith;
        return rows.filter((r) => typeof prefix !== 'string' || r.key.startsWith(prefix));
      },
      async deleteMany(args) {
        const keys = args?.where?.key?.in || [];
        capture.deletedKeys.push(...keys);
        return { count: keys.length };
      },
    },
    organization: {
      async findMany(args) {
        const ids = args?.where?.id?.in || [];
        return ids.filter((id) => liveOrgIds.includes(id)).map((id) => ({ id }));
      },
    },
    user: {
      async findMany(args) {
        const ids = args?.where?.id?.in || [];
        return ids.filter((id) => liveUserIds.includes(id)).map((id) => ({ id }));
      },
    },
  };
}

function makeIdleRow(prefix, ownerId, detectedAt) {
  return {
    key: `${prefix}${ownerId}`,
    value: JSON.stringify({ detectedAt: detectedAt.toISOString() }),
  };
}

function makeApiusageRow(ym, userId, model = 'gpt-4o') {
  return {
    key: `${APIUSAGE_SUMMARY_PREFIX}${ym}:${userId}:${model}`,
    value: JSON.stringify({ yearMonth: ym, userId, model, calls: 1, tokens: '0', cost: 0 }),
  };
}

describe('sweep-stale-system-settings', () => {
  afterEach(() => {
    delete process.env.SIRAGPT_STALE_SYSTEM_SETTINGS_ORG_IDLE_DAYS;
    delete process.env.SIRAGPT_STALE_SYSTEM_SETTINGS_USER_IDLE_DAYS;
    delete process.env.SIRAGPT_STALE_SYSTEM_SETTINGS_APIUSAGE_DAYS;
    delete process.env.SIRAGPT_STALE_SYSTEM_SETTINGS_DRY_RUN;
  });

  test('exposes constants', () => {
    assert.equal(DEFAULT_ORG_IDLE_DAYS, 180);
    assert.equal(DEFAULT_USER_IDLE_DAYS, 180);
    assert.equal(DEFAULT_APIUSAGE_DAYS, 730);
    assert.equal(ORG_IDLE_PREFIX, 'org_idle:');
    assert.equal(USER_IDLE_PREFIX, 'user_idle:');
    assert.equal(APIUSAGE_SUMMARY_PREFIX, 'apiusage:summary:');
  });

  test('_ownerIdFromKey parses each prefix shape', () => {
    assert.deepEqual(_ownerIdFromKey('org_idle:o1'), { kind: 'org', id: 'o1' });
    assert.deepEqual(_ownerIdFromKey('user_idle:u1'), { kind: 'user', id: 'u1' });
    assert.deepEqual(
      _ownerIdFromKey('apiusage:summary:2024-01:u9:gpt-4o'),
      { kind: 'user', id: 'u9' },
    );
    assert.equal(_ownerIdFromKey('something-else'), null);
  });

  test('_extractTimestamp reads detectedAt for idle rows and EOM for apiusage rows', () => {
    const ts = new Date('2025-01-15T00:00:00Z');
    assert.equal(
      _extractTimestamp('org_idle:o1', { detectedAt: ts.toISOString() }).toISOString(),
      ts.toISOString(),
    );
    const ym = _extractTimestamp('apiusage:summary:2024-02:u1:m', null);
    // End of Feb 2024 (leap year — 29 days).
    assert.equal(ym.getUTCFullYear(), 2024);
    assert.equal(ym.getUTCMonth(), 1); // 0-indexed
    assert.equal(ym.getUTCDate(), 29);
    assert.equal(_extractTimestamp('apiusage:summary:bad-key:u:m', null), null);
    assert.equal(_extractTimestamp('org_idle:o1', null), null);
  });

  test('deletes only aged AND orphaned rows (conservative)', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const ancient = new Date(now.getTime() - 200 * DAY_MS);   // > 180d
    const recent = new Date(now.getTime() - 10 * DAY_MS);     // < 180d

    const rows = [
      // org_idle
      makeIdleRow(ORG_IDLE_PREFIX, 'org-alive-old', ancient),    // owner alive — keep
      makeIdleRow(ORG_IDLE_PREFIX, 'org-dead-old', ancient),     // orphan + aged — DELETE
      makeIdleRow(ORG_IDLE_PREFIX, 'org-dead-recent', recent),   // orphan but young — keep
      // user_idle
      makeIdleRow(USER_IDLE_PREFIX, 'user-alive-old', ancient),  // owner alive — keep
      makeIdleRow(USER_IDLE_PREFIX, 'user-dead-old', ancient),   // orphan + aged — DELETE
      // apiusage:summary — 730d retention. Use a year ≥ 3y ago.
      makeApiusageRow('2022-01', 'user-alive-old'),              // owner alive — keep
      makeApiusageRow('2022-01', 'user-dead-old'),               // orphan + aged — DELETE
      makeApiusageRow('2025-12', 'user-dead-old'),               // orphan but young — keep
    ];

    const capture = {};
    const prisma = makePrisma({
      rows,
      liveOrgIds: ['org-alive-old'],
      liveUserIds: ['user-alive-old'],
      capture,
    });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.dryRun, false);
    assert.equal(res.deleted, 3);
    assert.equal(res.perPrefix.org_idle, 1);
    assert.equal(res.perPrefix.user_idle, 1);
    assert.equal(res.perPrefix['apiusage:summary'], 1);

    const deleted = new Set(capture.deletedKeys);
    assert.ok(deleted.has('org_idle:org-dead-old'));
    assert.ok(deleted.has('user_idle:user-dead-old'));
    assert.ok(deleted.has('apiusage:summary:2022-01:user-dead-old:gpt-4o'));
    assert.equal(deleted.size, 3);
  });

  test('dry-run counts orphans but does not delete', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const ancient = new Date(now.getTime() - 365 * DAY_MS);
    const rows = [
      makeIdleRow(ORG_IDLE_PREFIX, 'gone-1', ancient),
      makeIdleRow(USER_IDLE_PREFIX, 'gone-2', ancient),
    ];

    const capture = {};
    const prisma = makePrisma({ rows, capture });
    const res = await run({ prisma, now, dryRun: true, logger: silentLogger });

    assert.equal(res.dryRun, true);
    assert.equal(res.deleted, 0);
    assert.equal(res.candidates, 2);
    assert.equal(res.perPrefix.org_idle, 1);
    assert.equal(res.perPrefix.user_idle, 1);
    assert.equal(capture.deletedKeys.length, 0);
  });

  test('SIRAGPT_STALE_SYSTEM_SETTINGS_DRY_RUN env triggers dry-run', async () => {
    process.env.SIRAGPT_STALE_SYSTEM_SETTINGS_DRY_RUN = 'true';
    const now = new Date('2026-05-19T12:00:00Z');
    const ancient = new Date(now.getTime() - 365 * DAY_MS);
    const rows = [makeIdleRow(ORG_IDLE_PREFIX, 'gone', ancient)];
    const capture = {};
    const prisma = makePrisma({ rows, capture });

    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.dryRun, true);
    assert.equal(capture.deletedKeys.length, 0);
  });

  test('opts overrides beat env for retention windows', async () => {
    process.env.SIRAGPT_STALE_SYSTEM_SETTINGS_ORG_IDLE_DAYS = '30';
    const now = new Date('2026-05-19T12:00:00Z');
    // 60d ago — under default 180d, but past the opts override of 5d.
    const sixtyDays = new Date(now.getTime() - 60 * DAY_MS);
    const rows = [makeIdleRow(ORG_IDLE_PREFIX, 'gone-org', sixtyDays)];
    const capture = {};
    const prisma = makePrisma({ rows, capture });

    const res = await run({
      prisma,
      now,
      orgIdleDays: 5,
      logger: silentLogger,
    });
    assert.equal(res.orgIdleDays, 5);
    assert.equal(res.deleted, 1);
  });

  test('rows with un-parseable values or timestamps are preserved', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const rows = [
      { key: 'org_idle:bad', value: '{not json' },
      { key: 'org_idle:nodt', value: JSON.stringify({ other: 'field' }) },
    ];
    const capture = {};
    const prisma = makePrisma({ rows, capture });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.deleted, 0);
    assert.equal(capture.deletedKeys.length, 0);
  });

  test('apiusage:summary key parsing extracts userId in the right slot', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    // 2022-01 → EOM end-of-Jan-2022 → ~3.3y old → past 730d cutoff.
    const rows = [
      makeApiusageRow('2022-01', 'orphan-user', 'gpt-4o'),
      makeApiusageRow('2022-01', 'orphan-user', 'gpt-4o-mini'),
      makeApiusageRow('2022-01', 'kept-user', 'gpt-4o'),
    ];
    const capture = {};
    const prisma = makePrisma({
      rows,
      liveUserIds: ['kept-user'],
      capture,
    });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.deleted, 2);
    assert.equal(res.perPrefix['apiusage:summary'], 2);
    for (const k of capture.deletedKeys) {
      assert.ok(k.startsWith('apiusage:summary:2022-01:orphan-user:'));
    }
  });

  test('returns a stable empty result when prisma.systemSettings is unavailable', async () => {
    const prisma = {}; // no systemSettings model — degraded mode.
    const res = await run({ prisma, logger: silentLogger });
    assert.equal(res.deleted, 0);
    assert.equal(res.scanned, 0);
  });
});
