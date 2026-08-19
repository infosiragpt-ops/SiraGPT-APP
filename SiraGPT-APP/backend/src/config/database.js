// ──────────────────────────────────────────────────────────────
// siraGPT — Prisma Database Client with Retry Logic
// ──────────────────────────────────────────────────────────────
// Wraps PrismaClient with connection retry + exponential backoff
// so transient DB failures (restart, failover, network blip) don't
// crash the process on startup. In production this buys time for
// the readiness probe to drain traffic while the DB recovers.
//
// The client also auto-reconnects on transient disconnects during
// runtime because Prisma uses a connection pool that retries
// internally; we add an outer layer for the initial connect.
// ──────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');
const {
  DIRECT_POSTGRES_PROTOCOLS,
  REMOTE_PRISMA_PROTOCOL,
  classifyDatabasePoolCapacity,
  resolveRuntimeDatabaseUrl,
  sanitizeDatabaseErrorMessage,
} = require('./database-url');

const MAX_CONNECT_RETRIES = parseInt(process.env.DB_CONNECT_RETRIES || '5', 10);
const BASE_RETRY_DELAY_MS = parseInt(process.env.DB_RETRY_BASE_DELAY_MS || '1000', 10);

const DEFAULT_DATABASE_POOL_MIN = 2;
const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_DATABASE_POOL_TIMEOUT_MS = 10_000;
const DATABASE_POOL_LIMIT_BOUNDS = Object.freeze({ min: 1, max: 100 });
const DATABASE_POOL_TIMEOUT_MS_BOUNDS = Object.freeze({ min: 1_000, max: 300_000 });

function parseBoundedInteger(value, { fallback, min, max }) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Resolve all pool controls without reading global state. Prisma's
 * `pool_timeout` URL parameter is measured in whole seconds, so a partial
 * second rounds up rather than silently shortening the operator's timeout.
 */
function resolveDatabasePoolConfig(env = {}) {
  const poolMax = parseBoundedInteger(env.DATABASE_POOL_MAX, {
    fallback: DEFAULT_DATABASE_POOL_MAX,
    ...DATABASE_POOL_LIMIT_BOUNDS,
  });
  const requestedPoolMin = parseBoundedInteger(env.DATABASE_POOL_MIN, {
    fallback: DEFAULT_DATABASE_POOL_MIN,
    ...DATABASE_POOL_LIMIT_BOUNDS,
  });
  const poolTimeoutMs = parseBoundedInteger(env.DATABASE_POOL_TIMEOUT_MS, {
    fallback: DEFAULT_DATABASE_POOL_TIMEOUT_MS,
    ...DATABASE_POOL_TIMEOUT_MS_BOUNDS,
  });

  return Object.freeze({
    poolMin: Math.min(requestedPoolMin, poolMax),
    poolMax,
    poolTimeoutMs,
    poolTimeoutSeconds: Math.ceil(poolTimeoutMs / 1000),
  });
}

/**
 * Apply Prisma v6 pool controls while retaining schema/SSL/PgBouncer and any
 * provider-specific query parameters. Errors deliberately omit the supplied
 * URL because it can contain a username, password, or API key.
 */
function buildPrismaDatasourceUrl(databaseUrl, poolConfig = resolveDatabasePoolConfig()) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new TypeError('A valid PostgreSQL datasource URL is required');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl.trim());
  } catch {
    throw new TypeError('A valid PostgreSQL datasource URL is required');
  }

  if (!DIRECT_POSTGRES_PROTOCOLS.has(parsed.protocol) && parsed.protocol !== REMOTE_PRISMA_PROTOCOL) {
    throw new TypeError('A valid PostgreSQL datasource URL is required');
  }
  if (parsed.protocol === REMOTE_PRISMA_PROTOCOL) {
    return databaseUrl.trim();
  }

  const poolMax = parseBoundedInteger(poolConfig.poolMax, {
    fallback: DEFAULT_DATABASE_POOL_MAX,
    ...DATABASE_POOL_LIMIT_BOUNDS,
  });
  const poolTimeoutSeconds = parseBoundedInteger(poolConfig.poolTimeoutSeconds, {
    fallback: DEFAULT_DATABASE_POOL_TIMEOUT_MS / 1000,
    min: DATABASE_POOL_TIMEOUT_MS_BOUNDS.min / 1000,
    max: DATABASE_POOL_TIMEOUT_MS_BOUNDS.max / 1000,
  });
  parsed.searchParams.set('connection_limit', String(poolMax));
  parsed.searchParams.set('pool_timeout', String(poolTimeoutSeconds));
  return parsed.toString();
}

function buildPrismaClientOptions(env = {}) {
  const options = {
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  };
  const databaseUrl = resolveRuntimeDatabaseUrl(env);
  if (databaseUrl) {
    options.datasources = {
      db: {
        url: buildPrismaDatasourceUrl(databaseUrl, resolveDatabasePoolConfig(env)),
      },
    };
  }
  return options;
}

// ── Prisma client ──────────────────────────────────────────
// Pool controls are part of the datasource URL in Prisma v6. Passing the
// rewritten URL directly to PrismaClient guarantees the runtime client uses
// the validated values even when the schema points at a differently named env.
const databasePoolConfig = resolveDatabasePoolConfig(process.env);
const resolvedDatabaseUrl = resolveRuntimeDatabaseUrl(process.env);
const databasePoolCapacity = classifyDatabasePoolCapacity(resolvedDatabaseUrl);
const basePrisma = new PrismaClient(buildPrismaClientOptions(process.env));

// Prisma does not expose native pool counters at the JavaScript layer. Attach
// the existing best-effort in-flight instrumentation. Prisma 6.14+ removed
// `$use`, so the handle may supply an equivalent query-extension client; that
// instrumented client becomes the one shared and exported by this module.
const { instrumentPool } = require('../db/pool-instrumentation');
const poolMetrics = instrumentPool(basePrisma, {
  poolMin: databasePoolConfig.poolMin,
  poolMax: databasePoolConfig.poolMax,
  capacityObservable: databasePoolCapacity.observable,
  capacityReason: databasePoolCapacity.reason,
});
const prisma = poolMetrics.client;

// Configuration-only log: never include the datasource URL or credentials.
if (databasePoolCapacity.observable) {
  console.log(
    `📊 Database pool: min=${databasePoolConfig.poolMin} `
    + `max=${databasePoolConfig.poolMax} timeout=${databasePoolConfig.poolTimeoutMs}ms`
  );
} else {
  console.log(`📊 Database pool capacity unobservable (${databasePoolCapacity.reason})`);
}

// ── OTel: wrap $transaction in a `db.transaction` span ──────────────
// Defensive: if `@opentelemetry/api` or otel-spans isn't available the
// wrapper is a pass-through. Never break boot when OTel isn't wired.
try {
  // eslint-disable-next-line global-require
  const { withDbTransactionSpan } = require('../utils/otel-spans');
  if (typeof prisma.$transaction === 'function' && typeof withDbTransactionSpan === 'function') {
    const originalTx = prisma.$transaction.bind(prisma);
    prisma.$transaction = function tracedTransaction(arg, opts) {
      const isBatch = Array.isArray(arg);
      return withDbTransactionSpan(
        {
          db: 'postgresql',
          operation: 'transaction',
          batch: isBatch,
          batchSize: isBatch ? arg.length : undefined,
        },
        () => originalTx(arg, opts),
      );
    };
  }
} catch (_e) {
  // otel-spans not loadable — leave $transaction untouched.
}

// ── Database Guard: audit/block destructive raw SQL ─────────────────
// Wraps the raw-SQL methods to catch DROP/TRUNCATE/DELETE-without-WHERE/
// lossy-ALTER. Default mode is 'monitor' (audit-only, non-blocking) and
// the whole thing is fail-open — a guard error never blocks a query.
// Flip SIRAGPT_DB_GUARD=enforce to actually block; =off to disable.
try {
  // eslint-disable-next-line global-require
  const { attachDatabaseGuard } = require('../services/db/database-guard');
  attachDatabaseGuard(prisma);
} catch (_e) {
  console.warn('[db-guard] not attached:', _e?.message || _e);
}

/**
 * Attempts to connect to PostgreSQL with exponential backoff retry.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.exitOnFailure=true]  Exit process if all retries exhausted
 * @param {number}  [opts.maxRetries]           Override MAX_CONNECT_RETRIES
 * @returns {Promise<boolean>}  true if connected, false if exhausted (no exit)
 */
async function connectDatabase({ exitOnFailure = true, maxRetries } = {}) {
  const retries = maxRetries ?? MAX_CONNECT_RETRIES;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$connect();
      console.log('✅ Database connected successfully');
      return true;
    } catch (error) {
      const isLast = attempt >= retries;
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);

      console.error(
        `❌ Database connection attempt ${attempt}/${retries} failed:`,
        sanitizeDatabaseErrorMessage(error?.message || error),
        isLast ? '' : `(retrying in ${delay}ms...)`
      );

      if (isLast) {
        if (exitOnFailure) {
          console.error('FATAL: All database connection attempts exhausted. Exiting.');
          process.exit(1);
        }
        return false;
      }

      // Wait before next retry
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;
module.exports.connectDatabase = connectDatabase;
module.exports.poolMetrics = poolMetrics;
module.exports.databasePoolConfig = databasePoolConfig;
module.exports.databasePoolCapacity = databasePoolCapacity;
module.exports.resolveDatabasePoolConfig = resolveDatabasePoolConfig;
module.exports.resolveRuntimeDatabaseUrl = resolveRuntimeDatabaseUrl;
module.exports.resolveCanonicalDatabaseUrl = resolveRuntimeDatabaseUrl;
module.exports.resolveDatabaseUrl = resolveRuntimeDatabaseUrl;
module.exports.classifyDatabasePoolCapacity = classifyDatabasePoolCapacity;
module.exports.buildPrismaDatasourceUrl = buildPrismaDatasourceUrl;
module.exports.buildPrismaClientOptions = buildPrismaClientOptions;
module.exports.sanitizeDatabaseErrorMessage = sanitizeDatabaseErrorMessage;
module.exports.parseBoundedInteger = parseBoundedInteger;
module.exports.DATABASE_POOL_LIMIT_BOUNDS = DATABASE_POOL_LIMIT_BOUNDS;
module.exports.DATABASE_POOL_TIMEOUT_MS_BOUNDS = DATABASE_POOL_TIMEOUT_MS_BOUNDS;
module.exports.DEFAULT_DATABASE_POOL_MIN = DEFAULT_DATABASE_POOL_MIN;
module.exports.DEFAULT_DATABASE_POOL_MAX = DEFAULT_DATABASE_POOL_MAX;
module.exports.DEFAULT_DATABASE_POOL_TIMEOUT_MS = DEFAULT_DATABASE_POOL_TIMEOUT_MS;
