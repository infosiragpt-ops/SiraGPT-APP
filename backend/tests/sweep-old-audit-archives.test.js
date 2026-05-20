'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

const {
  run,
  ARCHIVE_PREFIX,
  DEFAULT_RETENTION_MONTHS,
  _archiveEndOfMonth,
} = require('../src/jobs/sweep-old-audit-archives');

function makePrisma({ rows = [], deleted = null, capture = {} } = {}) {
  return {
    systemSettings: {
      async findMany(args) {
        capture.findManyArgs = args;
        return rows.map((r) => ({ key: r.key }));
      },
      async deleteMany(args) {
        capture.deleteArgs = args;
        if (deleted != null) return { count: deleted };
        // Default — count anything matching the in-list.
        const ids = (args?.where?.key?.in) || [];
        return { count: ids.length };
      },
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

describe('sweep-old-audit-archives', () => {
  afterEach(() => {
    delete process.env.SIRAGPT_AUDIT_ARCHIVE_RETENTION_MONTHS;
    delete process.env.SIRAGPT_AUDIT_ARCHIVE_SWEEP_DRY_RUN;
  });

  test('_archiveEndOfMonth parses YYYY-MM into end-of-month UTC', () => {
    const d = _archiveEndOfMonth('audit_archive:2023-04');
    assert.ok(d instanceof Date);
    // April has 30 days.
    assert.equal(d.toISOString(), '2023-04-30T23:59:59.999Z');
    // February non-leap.
    assert.equal(
      _archiveEndOfMonth('audit_archive:2023-02').toISOString(),
      '2023-02-28T23:59:59.999Z',
    );
    // February leap.
    assert.equal(
      _archiveEndOfMonth('audit_archive:2024-02').toISOString(),
      '2024-02-29T23:59:59.999Z',
    );
  });

  test('_archiveEndOfMonth rejects malformed keys', () => {
    assert.equal(_archiveEndOfMonth('audit_archive:2023-13'), null);
    assert.equal(_archiveEndOfMonth('audit_archive:not-a-date'), null);
    assert.equal(_archiveEndOfMonth('audit_archive:2023-00'), null);
    assert.equal(_archiveEndOfMonth('other:2023-01'), null);
    assert.equal(_archiveEndOfMonth(null), null);
    assert.equal(_archiveEndOfMonth(''), null);
  });

  test('deletes archives older than 3 years by default', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const capture = {};
    const rows = [
      { key: 'audit_archive:2022-04' }, // > 3y old → DELETE (Apr 2022)
      { key: 'audit_archive:2023-04' }, // > 3y old → DELETE (Apr 2023, ends Apr 30 — cutoff May 19 2023, end-of-month < cutoff)
      { key: 'audit_archive:2023-06' }, // within 3y → KEEP
      { key: 'audit_archive:2025-01' }, // recent → KEEP
      { key: 'audit_archive:bogus' },   // malformed → KEEP
    ];
    const prisma = makePrisma({ rows, capture });

    const res = await run({ prisma, now, logger: silentLogger });

    assert.equal(res.dryRun, false);
    assert.equal(res.scanned, 5);
    assert.equal(res.candidates, 2);
    assert.equal(res.deleted, 2);
    assert.equal(res.retentionMonths, DEFAULT_RETENTION_MONTHS);
    assert.equal(res.now, now.toISOString());

    // findMany filtered on the prefix.
    assert.deepEqual(capture.findManyArgs.where, { key: { startsWith: ARCHIVE_PREFIX } });
    // deleteMany received exactly the expired keys.
    const deletedKeys = capture.deleteArgs.where.key.in.slice().sort();
    assert.deepEqual(deletedKeys, ['audit_archive:2022-04', 'audit_archive:2023-04']);
  });

  test('dry-run counts but does not delete', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const capture = {};
    const rows = [
      { key: 'audit_archive:2020-01' },
      { key: 'audit_archive:2025-01' },
    ];
    const prisma = makePrisma({ rows, capture });

    const res = await run({ prisma, now, dryRun: true, logger: silentLogger });

    assert.equal(res.dryRun, true);
    assert.equal(res.scanned, 2);
    assert.equal(res.candidates, 1);
    assert.equal(res.deleted, 0);
    assert.equal(capture.deleteArgs, undefined);
  });

  test('honours env override for retention months', async () => {
    process.env.SIRAGPT_AUDIT_ARCHIVE_RETENTION_MONTHS = '12';
    const now = new Date('2026-05-19T12:00:00Z');
    const capture = {};
    const rows = [
      { key: 'audit_archive:2024-01' }, // > 12 months → DELETE
      { key: 'audit_archive:2025-08' }, // < 12 months → KEEP
    ];
    const prisma = makePrisma({ rows, capture });

    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.retentionMonths, 12);
    assert.equal(res.deleted, 1);
    assert.deepEqual(capture.deleteArgs.where.key.in, ['audit_archive:2024-01']);
  });

  test('opts.retentionMonths beats env', async () => {
    process.env.SIRAGPT_AUDIT_ARCHIVE_RETENTION_MONTHS = '12';
    const now = new Date('2026-05-19T12:00:00Z');
    const rows = [{ key: 'audit_archive:2024-01' }];
    const prisma = makePrisma({ rows });

    const res = await run({ prisma, now, retentionMonths: 60, logger: silentLogger });
    assert.equal(res.retentionMonths, 60);
    // 60 months back from 2026-05 → 2021-05, so 2024-01 is well within retention.
    assert.equal(res.deleted, 0);
  });

  test('SIRAGPT_AUDIT_ARCHIVE_SWEEP_DRY_RUN=true forces dry-run', async () => {
    process.env.SIRAGPT_AUDIT_ARCHIVE_SWEEP_DRY_RUN = 'true';
    const rows = [{ key: 'audit_archive:2000-01' }];
    const capture = {};
    const prisma = makePrisma({ rows, capture });

    const res = await run({ prisma, now: new Date('2026-05-19T12:00:00Z'), logger: silentLogger });
    assert.equal(res.dryRun, true);
    assert.equal(res.candidates, 1);
    assert.equal(capture.deleteArgs, undefined);
  });

  test('skips when prisma.systemSettings unavailable', async () => {
    const res = await run({ prisma: {}, logger: silentLogger });
    assert.equal(res.deleted, 0);
    assert.equal(res.scanned, 0);
  });

  test('end-of-month boundary keeps the in-progress month alive', async () => {
    // cutoff month exactly matches an archive month — the archive still
    // covers the full month, so it must not be swept.
    // Retention 36mo, now = 2026-05-19 → cutoff = 2023-05-19.
    // audit_archive:2023-05 ends 2023-05-31, which is >= cutoff → KEEP.
    const now = new Date('2026-05-19T12:00:00Z');
    const capture = {};
    const rows = [
      { key: 'audit_archive:2023-04' }, // ends Apr 30 2023 < cutoff → DELETE
      { key: 'audit_archive:2023-05' }, // ends May 31 2023 > cutoff → KEEP
    ];
    const prisma = makePrisma({ rows, capture });
    const res = await run({ prisma, now, logger: silentLogger });
    assert.equal(res.deleted, 1);
    assert.deepEqual(capture.deleteArgs.where.key.in, ['audit_archive:2023-04']);
  });

  test('no-op when no archives match', async () => {
    const capture = {};
    const prisma = makePrisma({ rows: [], capture });
    const res = await run({ prisma, now: new Date('2026-05-19T12:00:00Z'), logger: silentLogger });
    assert.equal(res.deleted, 0);
    assert.equal(res.candidates, 0);
    // No deleteMany call when nothing to delete.
    assert.equal(capture.deleteArgs, undefined);
  });

  test('handles deleteMany returning no count gracefully', async () => {
    const prisma = {
      systemSettings: {
        async findMany() { return [{ key: 'audit_archive:2000-01' }]; },
        async deleteMany() { return {}; },
      },
    };
    const res = await run({ prisma, now: new Date('2026-05-19T12:00:00Z'), logger: silentLogger });
    assert.equal(res.deleted, 0);
    assert.equal(res.candidates, 1);
  });

  test('invalid env values fall back to defaults', async () => {
    process.env.SIRAGPT_AUDIT_ARCHIVE_RETENTION_MONTHS = 'nope';
    const prisma = makePrisma({ rows: [] });
    const res = await run({ prisma, now: new Date('2026-05-19T12:00:00Z'), logger: silentLogger });
    assert.equal(res.retentionMonths, DEFAULT_RETENTION_MONTHS);
  });
});
