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
 *   MIGRATION_BASELINE_SYNC_SCHEMA=1 — before baselining, run `prisma db push`
 *     (NO --accept-data-loss) so residual db-push-era drift is applied under the
 *     same reviewed confirm gate, then re-check equivalence
 *
 * Safety gates:
 *   1. Confirm phrase must match exactly
 *   2. Schema must be equivalent to schema.prisma (prisma migrate diff --exit-code)
 *      — or sync+recheck when MIGRATION_BASELINE_SYNC_SCHEMA=1
 *   3. No failed/incomplete rows may exist in `_prisma_migrations`
 *   4. Only directories already present under prisma/migrations are marked applied
 *   5. Schema sync never uses --accept-data-loss (destructive push fails closed)
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
const SYNC_SCHEMA_ENV = 'MIGRATION_BASELINE_SYNC_SCHEMA';
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

function clipPrismaOutput(text, maxChars = 4000) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated]`;
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
      stdout: clipPrismaOutput(diff.stdout),
      stderr: clipPrismaOutput(diff.stderr),
      hint: `Set ${SYNC_SCHEMA_ENV}=1 with ${CONFIRM_ENV}=${CONFIRM_PHRASE} to apply residual schema via db push (no --accept-data-loss), then baseline.`,
    });
    return {
      ok: false,
      status: diffStatus || BASELINE_FAILED_EXIT_STATUS,
      stdout: diff.stdout || '',
      stderr: diff.stderr || '',
    };
  }
  logFn('schema_equivalent_for_baseline');
  return { ok: true, status: 0 };
}

async function syncSchemaToDatamodel(options = {}) {
  const env = options.env || process.env;
  const runPrismaImpl = options.runPrismaImpl || ((args, prismaOptions = {}) => runPrisma(
    args,
    { ...prismaOptions, env },
  ));
  const logFn = options.logFn || log;
  const dryRun = options.dryRun === true || isTruthyEnv(env[DRY_RUN_ENV]);

  // Intentional: never pass --accept-data-loss. Residual U0 drift must be
  // additive / non-destructive; anything that requires data loss fails closed.
  const pushArgs = ['db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'];
  if (dryRun) {
    logFn('baseline_schema_sync_dry_run', { wouldRun: pushArgs.join(' ') });
    return { ok: true, status: 0, dryRun: true };
  }

  logFn('baseline_schema_sync_starting', { args: pushArgs });
  const push = await runPrismaImpl(pushArgs, {
    signal: options.signal,
    timeoutMs: resolveMigrationCommandTimeoutMs(env),
  });
  const pushStatus = push.error
    ? Math.max(1, prismaCommandExitStatus(push))
    : prismaCommandExitStatus(push);
  if (push.error || pushStatus !== 0) {
    logFn('baseline_schema_sync_failed', {
      code: push.migrationCode || push.error?.code || 'MIGRATION_BASELINE_SYNC_FAILED',
      status: pushStatus,
      stdout: clipPrismaOutput(push.stdout),
      stderr: clipPrismaOutput(push.stderr),
    });
    return { ok: false, status: pushStatus || BASELINE_FAILED_EXIT_STATUS };
  }
  logFn('baseline_schema_sync_complete');
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

  const syncSchema = options.syncSchema === true || isTruthyEnv(env[SYNC_SCHEMA_ENV]);
  let equivalence = await verifySchemaEquivalent({
    env,
    signal: options.signal,
    runPrismaImpl: options.runPrismaImpl,
    logFn,
  });

  if (!equivalence.ok && syncSchema) {
    logFn('baseline_schema_drift_detected_syncing', {
      code: 'MIGRATION_SCHEMA_NOT_EQUIVALENT',
      status: equivalence.status,
    });
    const sync = await syncSchemaToDatamodel({
      env,
      dryRun,
      signal: options.signal,
      runPrismaImpl: options.runPrismaImpl,
      logFn,
    });
    if (!sync.ok) return sync.status;
    if (!dryRun) {
      equivalence = await verifySchemaEquivalent({
        env,
        signal: options.signal,
        runPrismaImpl: options.runPrismaImpl,
        logFn,
      });
    } else {
      // Dry-run sync does not mutate the DB; treat post-sync equivalence as
      // assumed only for inventory. Real deploy always rechecks after push.
      equivalence = { ok: true, status: 0 };
      logFn('baseline_schema_sync_dry_run_skips_recheck');
    }
  }

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
        `Optional ${SYNC_SCHEMA_ENV}=1 (db push without --accept-data-loss, then baseline)`,
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
  SYNC_SCHEMA_ENV,
  listMigrationDirectories,
  assertBaselineConfirm,
  verifySchemaEquivalent,
  syncSchemaToDatamodel,
  readMigrationHistory,
  markMigrationApplied,
  baselineMigrationHistory,
  cli,
};
