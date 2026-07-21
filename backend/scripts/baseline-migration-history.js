#!/usr/bin/env node
/**
 * U0 reviewed one-off: baseline Prisma migration history without replaying DDL.
 *
 * This script is intentionally separate from boot and `--migrate-only`.
 * Application startup must never mutate `_prisma_migrations` history.
 *
 * Required:
 *   MIGRATION_BASELINE_CONFIRM=I_REVIEWED_PRODUCTION_SCHEMA
 *   DIRECT_DATABASE_URL (or a direct DATABASE_URL / PRISMA_DATABASE_URL)
 *
 * Optional:
 *   MIGRATION_BASELINE_DRY_RUN=1 — inventory + equivalence check only
 *
 * Safety gates:
 *   1. Confirm phrase must match exactly
 *   2. Schema must be equivalent to schema.prisma (prisma migrate diff --exit-code)
 *   3. No failed/incomplete rows may exist in `_prisma_migrations`
 *   4. Only directories already present under prisma/migrations are marked applied
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { loadEnvFiles } = require('../src/config/load-env');
const {
  requireDirectMigrationDatabaseUrl,
  redactDatabaseUrls,
} = require('../src/config/database-url');
const {
  makePgClientOptions,
  runPrisma,
  prismaCommandExitStatus,
  resolveMigrationCommandTimeoutMs,
  closePgClient,
  DIRECT_DATABASE_URL_REQUIRED_CODE,
} = require('./start-with-migrations');

const BACKEND_DIR = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(BACKEND_DIR, 'prisma', 'migrations');
const CONFIRM_PHRASE = 'I_REVIEWED_PRODUCTION_SCHEMA';
const CONFIRM_ENV = 'MIGRATION_BASELINE_CONFIRM';
const DRY_RUN_ENV = 'MIGRATION_BASELINE_DRY_RUN';
const CONFIGURATION_EXIT_STATUS = 78;
const BASELINE_FAILED_EXIT_STATUS = 1;

function log(message, extra = {}) {
  const payload = {
    ts: new Date().toISOString(),
    component: 'baseline-migration-history',
    msg: message,
    ...extra,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function listMigrationDirectories(migrationsDir = MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d{14}_/.test(name))
    .filter((name) => fs.existsSync(path.join(migrationsDir, name, 'migration.sql')))
    .sort();
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function assertBaselineConfirm(env = process.env) {
  const provided = String(env[CONFIRM_ENV] || '').trim();
  if (provided !== CONFIRM_PHRASE) {
    const error = new Error(
      `Refusing baseline: set ${CONFIRM_ENV}=${CONFIRM_PHRASE} after reviewing production schema equivalence.`,
    );
    error.code = 'MIGRATION_BASELINE_CONFIRM_REQUIRED';
    error.exitStatus = CONFIGURATION_EXIT_STATUS;
    throw error;
  }
}

async function verifySchemaEquivalent(options = {}) {
  const env = options.env || process.env;
  const runPrismaImpl = options.runPrismaImpl || ((args, prismaOptions = {}) => runPrisma(
    args,
    { ...prismaOptions, env },
  ));
  const logFn = options.logFn || log;
  const diffArgs = [
    'migrate',
    'diff',
    '--from-schema-datasource',
    'prisma/schema.prisma',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--exit-code',
  ];
  logFn('verifying_schema_equivalence_for_baseline');
  const diff = await runPrismaImpl(diffArgs, {
    signal: options.signal,
    timeoutMs: resolveMigrationCommandTimeoutMs(env),
  });
  const diffStatus = diff.error
    ? Math.max(1, prismaCommandExitStatus(diff))
    : prismaCommandExitStatus(diff);
  if (diff.error || diffStatus !== 0) {
    logFn('schema_drift_blocks_baseline', {
      code: diff.migrationCode || diff.error?.code || 'MIGRATION_SCHEMA_NOT_EQUIVALENT',
      status: diffStatus,
    });
    return { ok: false, status: diffStatus || BASELINE_FAILED_EXIT_STATUS };
  }
  logFn('schema_equivalent_for_baseline');
  return { ok: true, status: 0 };
}

async function readMigrationHistory(options = {}) {
  const env = options.env || process.env;
  const createClient = options.createClient || ((opts) => new Client(opts));
  const url = requireDirectMigrationDatabaseUrl(env);
  const client = createClient(makePgClientOptions(url, env));
  try {
    await client.connect();
    let rows;
    try {
      const result = await client.query(
        `SELECT migration_name, finished_at, rolled_back_at, logs
         FROM "_prisma_migrations"
         ORDER BY migration_name ASC`,
      );
      rows = result.rows || [];
    } catch (err) {
      if (err && (err.code === '42P01' || /_prisma_migrations/i.test(String(err.message || '')))) {
        return {
          tableMissing: true,
          applied: [],
          failed: [],
          pendingIncomplete: [],
        };
      }
      throw err;
    }

    const applied = [];
    const failed = [];
    const pendingIncomplete = [];
    for (const row of rows) {
      const name = row.migration_name;
      if (!name) continue;
      if (row.rolled_back_at) continue;
      if (row.finished_at) {
        applied.push(name);
        continue;
      }
      pendingIncomplete.push(name);
      if (row.logs || true) failed.push(name);
    }
    return {
      tableMissing: false,
      applied,
      failed,
      pendingIncomplete,
    };
  } finally {
    await closePgClient(client);
  }
}

async function markMigrationApplied(migrationName, options = {}) {
  const env = options.env || process.env;
  const runPrismaImpl = options.runPrismaImpl || ((args, prismaOptions = {}) => runPrisma(
    args,
    { ...prismaOptions, env },
  ));
  const result = await runPrismaImpl(
    ['migrate', 'resolve', '--applied', migrationName],
    {
      signal: options.signal,
      timeoutMs: resolveMigrationCommandTimeoutMs(env),
    },
  );
  if (result.error || prismaCommandExitStatus(result) !== 0) {
    const status = result.error
      ? Math.max(1, prismaCommandExitStatus(result))
      : prismaCommandExitStatus(result);
    const error = new Error(`Failed to mark migration applied: ${migrationName}`);
    error.code = result.migrationCode || result.error?.code || 'MIGRATION_BASELINE_RESOLVE_FAILED';
    error.exitStatus = status || BASELINE_FAILED_EXIT_STATUS;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return 0;
}

async function baselineMigrationHistory(options = {}) {
  const env = options.env || process.env;
  const logFn = options.logFn || log;
  const dryRun = options.dryRun === true || isTruthyEnv(env[DRY_RUN_ENV]);
  const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;

  try {
    assertBaselineConfirm(env);
  } catch (error) {
    logFn('baseline_confirm_required', {
      code: error?.code || 'MIGRATION_BASELINE_CONFIRM_REQUIRED',
    });
    return Number.isInteger(error?.exitStatus)
      ? error.exitStatus
      : CONFIGURATION_EXIT_STATUS;
  }
  try {
    requireDirectMigrationDatabaseUrl(env);
  } catch (error) {
    logFn('baseline_database_configuration_rejected', {
      code: error?.code || DIRECT_DATABASE_URL_REQUIRED_CODE,
    });
    return Number.isInteger(error?.exitStatus)
      ? error.exitStatus
      : CONFIGURATION_EXIT_STATUS;
  }

  const directories = listMigrationDirectories(migrationsDir);
  if (directories.length === 0) {
    logFn('baseline_no_migration_directories', { code: 'MIGRATION_BASELINE_EMPTY' });
    return CONFIGURATION_EXIT_STATUS;
  }

  const equivalence = await verifySchemaEquivalent({
    env,
    signal: options.signal,
    runPrismaImpl: options.runPrismaImpl,
    logFn,
  });
  if (!equivalence.ok) return equivalence.status;

  const history = await (options.readHistoryImpl
    ? options.readHistoryImpl({ env })
    : readMigrationHistory({
      env,
      createClient: options.createClient,
    }));

  if (history.failed.length > 0 || history.pendingIncomplete.length > 0) {
    logFn('baseline_blocked_by_failed_migrations', {
      code: 'MIGRATION_BASELINE_FAILED_HISTORY',
      failed: history.failed,
      pendingIncomplete: history.pendingIncomplete,
    });
    return BASELINE_FAILED_EXIT_STATUS;
  }

  const appliedSet = new Set(history.applied);
  const toMark = directories.filter((name) => !appliedSet.has(name));

  logFn('baseline_inventory', {
    dryRun,
    tableMissing: Boolean(history.tableMissing),
    migrationDirectories: directories.length,
    alreadyApplied: history.applied.length,
    toMark: toMark.length,
  });

  if (dryRun) {
    logFn('baseline_dry_run_complete', {
      wouldMark: toMark,
    });
    return 0;
  }

  for (const migrationName of toMark) {
    logFn('baseline_marking_applied', { migrationName });
    await markMigrationApplied(migrationName, {
      env,
      signal: options.signal,
      runPrismaImpl: options.runPrismaImpl,
    });
  }

  logFn('baseline_complete', {
    markedApplied: toMark.length,
    totalDirectories: directories.length,
  });
  return 0;
}

async function cli(argv = process.argv.slice(2)) {
  loadEnvFiles(BACKEND_DIR);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: node scripts/baseline-migration-history.js',
        '',
        `Requires ${CONFIRM_ENV}=${CONFIRM_PHRASE}`,
        `Optional ${DRY_RUN_ENV}=1`,
        '',
        'Never invoke from boot or --migrate-only.',
      ].join('\n') + '\n',
    );
    return 0;
  }
  try {
    return await baselineMigrationHistory({});
  } catch (err) {
    log('baseline_fatal', {
      code: err?.code || 'MIGRATION_BASELINE_FAILED',
      error: redactDatabaseUrls(String(err?.message || err), process.env),
    });
    return Number.isInteger(err?.exitStatus) ? err.exitStatus : BASELINE_FAILED_EXIT_STATUS;
  }
}

if (require.main === module) {
  cli().then((status) => {
    process.exitCode = status;
  }).catch((err) => {
    log('baseline_unhandled', {
      code: err?.code || 'MIGRATION_BASELINE_FAILED',
      error: redactDatabaseUrls(String(err?.message || err), process.env),
    });
    process.exit(1);
  });
}

module.exports = {
  CONFIRM_PHRASE,
  CONFIRM_ENV,
  DRY_RUN_ENV,
  listMigrationDirectories,
  assertBaselineConfirm,
  verifySchemaEquivalent,
  readMigrationHistory,
  markMigrationApplied,
  baselineMigrationHistory,
  cli,
};
