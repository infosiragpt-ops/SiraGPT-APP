'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const baseline = require('../scripts/baseline-migration-history');

function makeMigrationsFixture(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-baseline-migrations-'));
  for (const name of names) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'migration.sql'), '-- fixture\nSELECT 1;\n');
  }
  return root;
}

test('listMigrationDirectories returns sorted timestamped dirs with SQL only', () => {
  const root = makeMigrationsFixture([
    '20260102030405_second',
    '20250101010101_first',
    'not_a_migration',
  ]);
  fs.mkdirSync(path.join(root, '20270101010101_missing_sql'));
  try {
    assert.deepEqual(baseline.listMigrationDirectories(root), [
      '20250101010101_first',
      '20260102030405_second',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assertBaselineConfirm requires the exact reviewed phrase', () => {
  assert.throws(
    () => baseline.assertBaselineConfirm({}),
    (err) => err.code === 'MIGRATION_BASELINE_CONFIRM_REQUIRED',
  );
  assert.throws(
    () => baseline.assertBaselineConfirm({
      [baseline.CONFIRM_ENV]: 'yes',
    }),
    (err) => err.code === 'MIGRATION_BASELINE_CONFIRM_REQUIRED',
  );
  assert.doesNotThrow(() => baseline.assertBaselineConfirm({
    [baseline.CONFIRM_ENV]: baseline.CONFIRM_PHRASE,
  }));
});

test('baseline refuses missing confirm and never calls resolve', async () => {
  const calls = [];
  const status = await baseline.baselineMigrationHistory({
    env: {
      DIRECT_DATABASE_URL: 'postgres://migration.invalid/app',
    },
    runPrismaImpl: async (args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
    readHistoryImpl: async () => ({
      tableMissing: true,
      applied: [],
      failed: [],
      pendingIncomplete: [],
    }),
  });
  assert.equal(status, 78);
  assert.equal(calls.length, 0);
});

test('baseline dry-run proves equivalence and inventories without resolve', async () => {
  const root = makeMigrationsFixture([
    '20250101010101_alpha',
    '20250202020202_beta',
  ]);
  const calls = [];
  const logs = [];
  try {
    const status = await baseline.baselineMigrationHistory({
      migrationsDir: root,
      dryRun: true,
      env: {
        DIRECT_DATABASE_URL: 'postgres://migration.invalid/app',
        [baseline.CONFIRM_ENV]: baseline.CONFIRM_PHRASE,
      },
      logFn: (msg, extra = {}) => logs.push({ msg, ...extra }),
      runPrismaImpl: async (args) => {
        calls.push(args);
        assert.deepEqual(args.slice(0, 2), ['migrate', 'diff']);
        return { status: 0, stdout: '', stderr: '' };
      },
      readHistoryImpl: async () => ({
        tableMissing: true,
        applied: [],
        failed: [],
        pendingIncomplete: [],
      }),
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls.some((args) => args.includes('resolve')), false);
    assert.equal(logs.some((entry) => entry.msg === 'baseline_dry_run_complete'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('divergent schema blocks baseline without rewriting history', async () => {
  const root = makeMigrationsFixture(['20250101010101_alpha']);
  const calls = [];
  try {
    const status = await baseline.baselineMigrationHistory({
      migrationsDir: root,
      env: {
        DIRECT_DATABASE_URL: 'postgres://migration.invalid/app',
        [baseline.CONFIRM_ENV]: baseline.CONFIRM_PHRASE,
      },
      runPrismaImpl: async (args) => {
        calls.push(args);
        return { status: 2, stdout: 'drift', stderr: '' };
      },
      readHistoryImpl: async () => {
        throw new Error('history must not be read when schema drifts');
      },
    });
    assert.equal(status, 2);
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['migrate', 'diff']]);
    assert.equal(calls.some((args) => args.includes('resolve')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed migration history blocks baseline', async () => {
  const root = makeMigrationsFixture(['20250101010101_alpha']);
  try {
    const status = await baseline.baselineMigrationHistory({
      migrationsDir: root,
      env: {
        DIRECT_DATABASE_URL: 'postgres://migration.invalid/app',
        [baseline.CONFIRM_ENV]: baseline.CONFIRM_PHRASE,
      },
      runPrismaImpl: async () => ({ status: 0, stdout: '', stderr: '' }),
      readHistoryImpl: async () => ({
        tableMissing: false,
        applied: [],
        failed: ['20240101010101_broken'],
        pendingIncomplete: ['20240101010101_broken'],
      }),
    });
    assert.equal(status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production-shaped unbaselined database is resolved without DDL replay', async () => {
  const root = makeMigrationsFixture([
    '20250101010101_alpha',
    '20250202020202_beta',
  ]);
  const calls = [];
  try {
    const status = await baseline.baselineMigrationHistory({
      migrationsDir: root,
      env: {
        DIRECT_DATABASE_URL: 'postgres://migration.invalid/app',
        [baseline.CONFIRM_ENV]: baseline.CONFIRM_PHRASE,
      },
      runPrismaImpl: async (args) => {
        calls.push(args);
        if (args[1] === 'diff') return { status: 0, stdout: '', stderr: '' };
        if (args[1] === 'resolve') {
          assert.equal(args[2], '--applied');
          return { status: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected prisma args: ${args.join(' ')}`);
      },
      readHistoryImpl: async () => ({
        tableMissing: true,
        applied: [],
        failed: [],
        pendingIncomplete: [],
      }),
    });
    assert.equal(status, 0);
    assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
      ['migrate', 'diff', '--from-schema-datasource'],
      ['migrate', 'resolve', '--applied'],
      ['migrate', 'resolve', '--applied'],
    ]);
    assert.deepEqual(
      calls.filter((args) => args[1] === 'resolve').map((args) => args[3]),
      ['20250101010101_alpha', '20250202020202_beta'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('already-applied migrations are skipped idempotently', async () => {
  const root = makeMigrationsFixture([
    '20250101010101_alpha',
    '20250202020202_beta',
  ]);
  const calls = [];
  try {
    const status = await baseline.baselineMigrationHistory({
      migrationsDir: root,
      env: {
        DIRECT_DATABASE_URL: 'postgres://migration.invalid/app',
        [baseline.CONFIRM_ENV]: baseline.CONFIRM_PHRASE,
      },
      runPrismaImpl: async (args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
      readHistoryImpl: async () => ({
        tableMissing: false,
        applied: ['20250101010101_alpha', '20250202020202_beta'],
        failed: [],
        pendingIncomplete: [],
      }),
    });
    assert.equal(status, 0);
    assert.equal(calls.filter((args) => args[1] === 'resolve').length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
