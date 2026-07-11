'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const {
  computeFingerprint,
  compareFingerprints,
} = require('../utils/session-fingerprint');

const MAX_SESSION_TOKEN_LENGTH = 8192;
const DEFAULT_REVALIDATION_TTL_MS = 5_000;
const DEFAULT_REVALIDATION_TIMEOUT_MS = 2_000;
const DEFAULT_REVALIDATION_MAX_ENTRIES = 2_000;

class ActiveSessionValidationError extends Error {
  constructor(code, options = {}) {
    super(code, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ActiveSessionValidationError';
    this.code = code;
    this.statusCode = 401;
    this.session = options.session || null;
    this.userId = options.userId || null;
  }
}

function tokenSubject(decoded) {
  const value = decoded?.userId ?? decoded?.id ?? decoded?.sub;
  return value == null ? null : String(value);
}

async function bestEffortDelete(prismaClient, where) {
  if (typeof prismaClient?.session?.deleteMany !== 'function') return;
  try {
    await prismaClient.session.deleteMany({ where });
  } catch {
    // Authentication still fails closed. Cleanup can be retried by the
    // deletion/session sweeper when the database becomes writable again.
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new ActiveSessionValidationError('auth_revalidation_timeout');
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function revalidationCacheKey(token, request) {
  const fingerprint = request ? computeFingerprint(request) : '';
  return crypto
    .createHash('sha256')
    .update(String(token))
    .update('\0')
    .update(String(fingerprint || ''))
    .digest('hex');
}

/**
 * Bounded positive-result cache for long-lived transports.
 *
 * Cache keys include the request fingerprint so a successful check from one
 * network/device context can never authorize a replay from another. Failures
 * are intentionally not cached. `force:true` is used immediately after socket
 * indexing to close the validate→index deletion race.
 */
function createActiveSessionRevalidator({
  prismaClient,
  jwtSecret = process.env.JWT_SECRET,
  validateSession = validateActiveSession,
  ttlMs = process.env.AUTH_SOCKET_REVALIDATION_CACHE_TTL_MS,
  timeoutMs = process.env.AUTH_SOCKET_REVALIDATION_TIMEOUT_MS,
  maxEntries = process.env.AUTH_SOCKET_REVALIDATION_CACHE_MAX,
  clock = Date.now,
} = {}) {
  const boundedTtlMs = clampInteger(
    ttlMs,
    DEFAULT_REVALIDATION_TTL_MS,
    100,
    30_000,
  );
  const boundedTimeoutMs = clampInteger(
    timeoutMs,
    DEFAULT_REVALIDATION_TIMEOUT_MS,
    10,
    10_000,
  );
  const boundedMaxEntries = clampInteger(
    maxEntries,
    DEFAULT_REVALIDATION_MAX_ENTRIES,
    10,
    20_000,
  );
  const entries = new Map();
  const inFlight = new Map();
  let invalidationGeneration = 0;

  function prune() {
    const now = clock();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size >= boundedMaxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  async function validate(input = {}, { force = false } = {}) {
    const key = revalidationCacheKey(input.token, input.request);
    const cached = entries.get(key);
    if (!force && cached && cached.expiresAt > clock()) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.value;
    }
    if (cached) entries.delete(key);

    const flightKey = `${key}:${force ? 'force' : 'cached'}`;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const generation = invalidationGeneration;
    const pending = withTimeout(
      Promise.resolve().then(() => validateSession({
        ...input,
        prismaClient: input.prismaClient || prismaClient,
        jwtSecret: input.jwtSecret || jwtSecret,
      })),
      boundedTimeoutMs,
    ).then((value) => {
      if (invalidationGeneration === generation) {
        prune();
        entries.set(key, {
          value,
          userId: String(value?.userId || ''),
          expiresAt: clock() + boundedTtlMs,
        });
      }
      return value;
    }).finally(() => {
      inFlight.delete(flightKey);
    });
    inFlight.set(flightKey, pending);
    return pending;
  }

  function invalidateUser(userId) {
    invalidationGeneration += 1;
    if (!userId) {
      entries.clear();
      return;
    }
    const normalized = String(userId);
    for (const [key, entry] of entries) {
      if (entry.userId === normalized) entries.delete(key);
    }
  }

  return {
    validate,
    invalidateUser,
    clear: () => invalidateUser(null),
    status: () => ({
      entries: entries.size,
      inFlight: inFlight.size,
      ttlMs: boundedTtlMs,
      timeoutMs: boundedTimeoutMs,
      maxEntries: boundedMaxEntries,
    }),
  };
}

/**
 * Validate a normal application session end to end.
 *
 * Order is deliberate: cryptographic signature → persisted session → database
 * expiry → active persisted user → token/session subject binding → optional
 * request fingerprint. Callers must use the returned user rather than claims.
 */
async function validateActiveSession({
  token,
  request = null,
  prismaClient,
  jwtSecret = process.env.JWT_SECRET,
  now = new Date(),
  loadSession = null,
  checkFingerprint = true,
} = {}) {
  if (
    typeof token !== 'string'
    || token.length === 0
    || token.length > MAX_SESSION_TOKEN_LENGTH
    || /[\s\r\n\0]/.test(token)
  ) {
    throw new ActiveSessionValidationError('invalid_token');
  }
  if (!jwtSecret) {
    throw new ActiveSessionValidationError('auth_configuration_error');
  }
  if (!prismaClient?.session?.findUnique && typeof loadSession !== 'function') {
    throw new ActiveSessionValidationError('auth_lookup_failed');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch (cause) {
    const code = cause?.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    throw new ActiveSessionValidationError(code, { cause });
  }

  let session;
  try {
    session = typeof loadSession === 'function'
      ? await loadSession(token)
      : await prismaClient.session.findUnique({
          where: { token },
          include: { user: true },
        });
  } catch (cause) {
    throw new ActiveSessionValidationError('auth_lookup_failed', { cause });
  }
  if (!session) {
    throw new ActiveSessionValidationError('session_not_found');
  }

  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const expiresAt = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
    await bestEffortDelete(prismaClient, { token });
    throw new ActiveSessionValidationError('session_expired', {
      session,
      userId: session.userId,
    });
  }

  const user = session.user || null;
  const persistedUserId = user?.id ?? session.userId;
  if (!user || user.deletedAt != null) {
    await bestEffortDelete(
      prismaClient,
      persistedUserId ? { userId: String(persistedUserId) } : { token },
    );
    throw new ActiveSessionValidationError('account_inactive', {
      session,
      userId: persistedUserId ? String(persistedUserId) : null,
    });
  }

  const claimedUserId = tokenSubject(decoded);
  if (!claimedUserId || claimedUserId !== String(persistedUserId)) {
    await bestEffortDelete(prismaClient, { token });
    throw new ActiveSessionValidationError('session_subject_mismatch', {
      session,
      userId: String(persistedUserId),
    });
  }

  if (checkFingerprint && session.fingerprint && request) {
    const currentFingerprint = computeFingerprint(request);
    if (!compareFingerprints(currentFingerprint, session.fingerprint)) {
      await bestEffortDelete(prismaClient, { token });
      throw new ActiveSessionValidationError('fingerprint_mismatch', {
        session,
        userId: String(persistedUserId),
      });
    }
  }

  return {
    decoded,
    session,
    user,
    userId: String(persistedUserId),
  };
}

module.exports = {
  ActiveSessionValidationError,
  DEFAULT_REVALIDATION_MAX_ENTRIES,
  DEFAULT_REVALIDATION_TIMEOUT_MS,
  DEFAULT_REVALIDATION_TTL_MS,
  MAX_SESSION_TOKEN_LENGTH,
  createActiveSessionRevalidator,
  tokenSubject,
  validateActiveSession,
};
