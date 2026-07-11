'use strict';

const crypto = require('node:crypto');

const AUTH_USER_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1::bigint) AS locked';
const AUTH_USER_LOCK_TIMEOUT_SQL =
  "SELECT set_config('lock_timeout', $1, TRUE) AS lock_timeout";
const DEFAULT_AUTH_USER_LOCK_TIMEOUT_MS = 500;
const MIN_AUTH_USER_LOCK_TIMEOUT_MS = 25;
const MAX_AUTH_USER_LOCK_TIMEOUT_MS = 5_000;

class AuthUserMutationBusyError extends Error {
  constructor({ timeoutMs = DEFAULT_AUTH_USER_LOCK_TIMEOUT_MS } = {}) {
    super('AUTH_USER_MUTATION_BUSY');
    this.name = 'AuthUserMutationBusyError';
    this.code = 'AUTH_USER_MUTATION_BUSY';
    this.status = 503;
    this.statusCode = 503;
    this.retryable = true;
    this.retryAfterSeconds = 1;
    this.expose = true;
    this.details = { timeoutMs };
  }
}

class AuthAccountInactiveError extends Error {
  constructor(userId = null) {
    super('Account is inactive');
    this.name = 'AuthAccountInactiveError';
    this.code = 'ACCOUNT_INACTIVE';
    this.status = 403;
    this.statusCode = 403;
    this.expose = true;
    this.userId = userId ? String(userId) : null;
  }
}

function normalizeLockTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTH_USER_LOCK_TIMEOUT_MS;
  return Math.min(
    MAX_AUTH_USER_LOCK_TIMEOUT_MS,
    Math.max(MIN_AUTH_USER_LOCK_TIMEOUT_MS, Math.floor(parsed)),
  );
}

function authUserLockKey(userId) {
  if (userId == null || String(userId).length === 0) {
    throw new TypeError('auth user lock requires userId');
  }
  return crypto
    .createHash('sha256')
    .update('sira:auth-user-lock:v1\0')
    .update(String(userId))
    .digest()
    .readBigInt64BE(0)
    .toString();
}

function isLockTimeout(error) {
  const codes = [
    error?.code,
    error?.meta?.code,
    error?.cause?.code,
    error?.cause?.meta?.code,
  ].map((value) => String(value || '').toUpperCase());
  if (codes.includes('55P03')) return true;
  return /lock timeout|canceling statement due to lock timeout/i.test(
    String(error?.message || ''),
  );
}

async function acquireAuthUserLock(
  transactionClient,
  userId,
  { timeoutMs = process.env.AUTH_USER_LOCK_TIMEOUT_MS } = {},
) {
  if (typeof transactionClient?.$queryRawUnsafe !== 'function') {
    const error = new Error('AUTH_USER_TRANSACTION_REQUIRED');
    error.code = 'AUTH_USER_TRANSACTION_REQUIRED';
    throw error;
  }
  const boundedTimeoutMs = normalizeLockTimeoutMs(timeoutMs);
  await transactionClient.$queryRawUnsafe(
    AUTH_USER_LOCK_TIMEOUT_SQL,
    `${boundedTimeoutMs}ms`,
  );
  try {
    await transactionClient.$queryRawUnsafe(
      AUTH_USER_LOCK_SQL,
      authUserLockKey(userId),
    );
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new AuthUserMutationBusyError({ timeoutMs: boundedTimeoutMs });
    }
    throw error;
  }
  // Keep the timeout scoped to lock acquisition. Session/challenge reads and
  // writes retain PostgreSQL's normal transaction-local timeout.
  await transactionClient.$queryRawUnsafe(
    AUTH_USER_LOCK_TIMEOUT_SQL,
    '0',
  );
}

async function runAuthUserTransaction(
  prismaClient,
  userId,
  callback,
  { timeoutMs, select } = {},
) {
  if (typeof prismaClient?.$transaction !== 'function') {
    const error = new Error('AUTH_USER_TRANSACTION_REQUIRED');
    error.code = 'AUTH_USER_TRANSACTION_REQUIRED';
    throw error;
  }
  if (typeof callback !== 'function') {
    throw new TypeError('auth user transaction callback is required');
  }
  return prismaClient.$transaction(async (tx) => {
    await acquireAuthUserLock(tx, userId, { timeoutMs });
    if (typeof tx?.user?.findUnique !== 'function') {
      const error = new Error('AUTH_USER_READER_REQUIRED');
      error.code = 'AUTH_USER_READER_REQUIRED';
      throw error;
    }
    const projection = select
      ? { ...select, id: true, deletedAt: true }
      : undefined;
    const user = await tx.user.findUnique({
      where: { id: String(userId) },
      ...(projection ? { select: projection } : {}),
    });
    if (!user || user.deletedAt != null) {
      throw new AuthAccountInactiveError(user?.id || userId);
    }
    return callback(tx, user);
  });
}

module.exports = {
  AUTH_USER_LOCK_SQL,
  AUTH_USER_LOCK_TIMEOUT_SQL,
  DEFAULT_AUTH_USER_LOCK_TIMEOUT_MS,
  AuthAccountInactiveError,
  AuthUserMutationBusyError,
  acquireAuthUserLock,
  authUserLockKey,
  normalizeLockTimeoutMs,
  runAuthUserTransaction,
};
