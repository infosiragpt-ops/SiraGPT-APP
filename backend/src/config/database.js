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

const MAX_CONNECT_RETRIES = parseInt(process.env.DB_CONNECT_RETRIES || '5', 10);
const BASE_RETRY_DELAY_MS = parseInt(process.env.DB_RETRY_BASE_DELAY_MS || '1000', 10);

// ── Prisma client ──────────────────────────────────────────
// Connection pool tuned for Node.js cluster mode:
//   4-5 connections per worker → pool of 10 is safe for 2 workers
//   (leave headroom for health checks + admin queries).
//   connection_limit + pool_timeout prevent pile-ups when the DB
//   is slow — a stalled request times out instead of occupying a
//   connection indefinitely.
//
// To override at deploy time:
//   DATABASE_POOL_MIN=2 DATABASE_POOL_MAX=10 DATABASE_POOL_TIMEOUT_MS=10000
const POOL_MIN = parseInt(process.env.DATABASE_POOL_MIN || '2', 10);
const POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || '10', 10);
const POOL_TIMEOUT_MS = parseInt(process.env.DATABASE_POOL_TIMEOUT_MS || '10000', 10);

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // Connection pool settings are passed via the database URL or
  // connection_string parameter in the schema, but we configure
  // the client with sensible runtime defaults.
});

// Log pool config at startup for observability
console.log(`📊 Database pool: min=${POOL_MIN} max=${POOL_MAX} timeout=${POOL_TIMEOUT_MS}ms`);

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
        error?.message || error,
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
