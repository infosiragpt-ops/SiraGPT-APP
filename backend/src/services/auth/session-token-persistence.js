'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { normalizeEnvironmentName } = require('../../utils/environment');

const SESSION_TOKEN_HASH_DOMAIN = 'siragpt:session-token:v1';
const SESSION_TOKEN_HASH_PREFIX = 'sira:session-token:v1:';
const SESSION_TOKEN_SCOPE_SESSION = 'session';
const SESSION_TOKEN_SCOPE_APPSHOTS = 'appshots';
const SESSION_TOKEN_SCOPES = new Set([
  SESSION_TOKEN_SCOPE_SESSION,
  SESSION_TOKEN_SCOPE_APPSHOTS,
]);
const SESSION_TOKEN_HASH_PATTERN = /^sira:session-token:v1:(session|appshots):([a-f0-9]{64})$/;
const LEGACY_SESSION_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_TOKEN_HASH_MODE_COMPAT = 'compat';
const SESSION_TOKEN_HASH_MODE_HASH = 'hash';
const SESSION_TOKEN_HASH_MODES = new Set([
  SESSION_TOKEN_HASH_MODE_COMPAT,
  SESSION_TOKEN_HASH_MODE_HASH,
]);

class SessionTokenCollisionError extends Error {
  constructor() {
    super('SESSION_TOKEN_HASH_COLLISION');
    this.name = 'SessionTokenCollisionError';
    this.code = 'SESSION_TOKEN_HASH_COLLISION';
  }
}

function normalizePresentedToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('session token must be a non-empty string');
  }
  return token;
}

function digestSessionToken(token) {
  const normalized = normalizePresentedToken(token);
  return crypto
    .createHash('sha256')
    .update(SESSION_TOKEN_HASH_DOMAIN)
    .update('\0')
    .update(normalized)
    .digest('hex');
}

function classifyPresentedSessionToken(token, options = {}) {
  const normalized = normalizePresentedToken(token);
  const env = options.env || process.env;
  const secret = options.jwtSecret || env?.JWT_SECRET;
  if (typeof secret !== 'string' || !secret) return SESSION_TOKEN_SCOPE_SESSION;
  try {
    const decoded = (options.verifyJwt || jwt.verify)(normalized, secret, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    });
    return decoded
      && typeof decoded === 'object'
      && decoded.scope === 'appshots:capture'
      ? SESSION_TOKEN_SCOPE_APPSHOTS
      : SESSION_TOKEN_SCOPE_SESSION;
  } catch (_error) {
    return SESSION_TOKEN_SCOPE_SESSION;
  }
}

function formatSessionTokenHash(digest, scope = SESSION_TOKEN_SCOPE_SESSION) {
  if (!LEGACY_SESSION_TOKEN_HASH_PATTERN.test(String(digest))) {
    throw new TypeError('session token digest must be a SHA-256 hex value');
  }
  if (!SESSION_TOKEN_SCOPES.has(scope)) {
    throw new TypeError('invalid session token scope class');
  }
  return `${SESSION_TOKEN_HASH_PREFIX}${scope}:${digest}`;
}

function hashSessionToken(token, options = {}) {
  return formatSessionTokenHash(
    digestSessionToken(token),
    classifyPresentedSessionToken(token, options),
  );
}

function parseSessionTokenHash(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(SESSION_TOKEN_HASH_PATTERN);
  if (!match) return null;
  return Object.freeze({
    version: 1,
    scope: match[1],
    digest: match[2],
  });
}

function isSessionTokenHash(value) {
  return parseSessionTokenHash(value) !== null;
}

function isLegacySessionTokenHash(value) {
  return typeof value === 'string' && LEGACY_SESSION_TOKEN_HASH_PATTERN.test(value);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionTokenMatches(storedToken, presentedToken) {
  if (typeof storedToken !== 'string' || typeof presentedToken !== 'string') return false;
  const parsed = parseSessionTokenHash(storedToken);
  const expected = parsed
    ? digestSessionToken(presentedToken)
    : isLegacySessionTokenHash(storedToken)
      ? digestSessionToken(presentedToken)
      : presentedToken;
  const actual = parsed ? parsed.digest : storedToken;
  return safeEqual(actual, expected);
}

function isUniqueConstraint(error) {
  return error?.code === 'P2002';
}

function sessionTokenPersistenceError(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveSessionTokenHashMode(env = process.env) {
  const configured = String(env?.SESSION_TOKEN_HASH_MODE || '').trim().toLowerCase();
  if (configured) {
    if (!SESSION_TOKEN_HASH_MODES.has(configured)) {
      const error = new Error('SESSION_TOKEN_HASH_MODE_INVALID');
      error.code = 'SESSION_TOKEN_HASH_MODE_INVALID';
      throw error;
    }
    return configured;
  }
  const environment = normalizeEnvironmentName(env);
  return environment === 'production' || environment === 'staging'
    ? SESSION_TOKEN_HASH_MODE_COMPAT
    : SESSION_TOKEN_HASH_MODE_HASH;
}

function getSessionTokenPersistenceHealth(env = process.env) {
  const mode = resolveSessionTokenHashMode(env);
  return Object.freeze({
    ok: true,
    mode,
    explicit: Boolean(String(env?.SESSION_TOKEN_HASH_MODE || '').trim()),
    writesHashed: mode === SESSION_TOKEN_HASH_MODE_HASH,
    upgradesLegacy: mode === SESSION_TOKEN_HASH_MODE_HASH,
    productionDefault: SESSION_TOKEN_HASH_MODE_COMPAT,
  });
}

function sessionTokenBackfillConfig(env = process.env) {
  return Object.freeze({
    batchSize: boundedInteger(
      env?.SESSION_TOKEN_HASH_BACKFILL_BATCH_SIZE,
      100,
      1,
      1_000,
    ),
    maxBatches: boundedInteger(
      env?.SESSION_TOKEN_HASH_BACKFILL_MAX_BATCHES,
      10,
      1,
      100,
    ),
  });
}

const UNVERSIONED_SESSION_TOKEN_WHERE = Object.freeze({
  NOT: {
    token: {
      startsWith: SESSION_TOKEN_HASH_PREFIX,
    },
  },
});

const SESSION_TOKEN_HASH_BACKFILL_SQL = `
WITH "raw_row" AS MATERIALIZED (
  DELETE FROM "sessions"
  WHERE "id" = $1 AND "token" = $2
  RETURNING
    "id", "userId", "token", "expiresAt", "createdAt", "lastUsedAt",
    "fingerprint", "userAgent", "ipHint", "label", "geoHint"
),
"upserted" AS (
  INSERT INTO "sessions" AS "current" (
    "id", "userId", "token", "expiresAt", "createdAt", "lastUsedAt",
    "fingerprint", "userAgent", "ipHint", "label", "geoHint"
  )
  SELECT
    "id", "userId", $3, "expiresAt", "createdAt", "lastUsedAt",
    "fingerprint", "userAgent", "ipHint", "label", "geoHint"
  FROM "raw_row"
  ON CONFLICT ("token") DO UPDATE
  SET
    "userId" = EXCLUDED."userId",
    "expiresAt" = EXCLUDED."expiresAt",
    "createdAt" = EXCLUDED."createdAt",
    "lastUsedAt" = EXCLUDED."lastUsedAt",
    "fingerprint" = EXCLUDED."fingerprint",
    "userAgent" = EXCLUDED."userAgent",
    "ipHint" = EXCLUDED."ipHint",
    "label" = EXCLUDED."label",
    "geoHint" = EXCLUDED."geoHint"
  WHERE (
    CASE WHEN EXCLUDED."expiresAt" > CURRENT_TIMESTAMP THEN 1 ELSE 0 END,
    COALESCE(EXCLUDED."lastUsedAt", EXCLUDED."createdAt"),
    EXCLUDED."expiresAt",
    EXCLUDED."createdAt",
    EXCLUDED."id"
  ) > (
    CASE WHEN "current"."expiresAt" > CURRENT_TIMESTAMP THEN 1 ELSE 0 END,
    COALESCE("current"."lastUsedAt", "current"."createdAt"),
    "current"."expiresAt",
    "current"."createdAt",
    "current"."id"
  )
  RETURNING ("current"."id" <> $1) AS "collision"
)
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM "raw_row") THEN 'noop'
    WHEN NOT EXISTS (SELECT 1 FROM "upserted") THEN 'collision'
    WHEN (SELECT "collision" FROM "upserted" LIMIT 1) THEN 'collision'
    ELSE 'updated'
  END AS "action"
`;

async function atomicallyBackfillSessionToken(transaction, row, storedHash) {
  if (typeof transaction?.$queryRawUnsafe !== 'function') {
    throw sessionTokenPersistenceError('SESSION_TOKEN_HASH_BACKFILL_SQL_UNAVAILABLE');
  }
  const result = await transaction.$queryRawUnsafe(
    SESSION_TOKEN_HASH_BACKFILL_SQL,
    row.id,
    row.token,
    storedHash,
  );
  const action = Array.isArray(result) ? result[0]?.action : null;
  if (!['updated', 'collision', 'noop'].includes(action)) {
    throw sessionTokenPersistenceError('SESSION_TOKEN_HASH_BACKFILL_SQL_INVALID_RESULT');
  }
  return action;
}

async function backfillSessionTokenBatch(transaction, { env, batchSize }) {
  if (typeof transaction?.session?.findMany !== 'function'
    || typeof transaction?.session?.count !== 'function') {
    throw sessionTokenPersistenceError('SESSION_TOKEN_HASH_BACKFILL_UNAVAILABLE');
  }
  const rows = await transaction.session.findMany({
    where: UNVERSIONED_SESSION_TOKEN_WHERE,
    select: { id: true, token: true },
    orderBy: { id: 'asc' },
    take: batchSize,
  });
  let processed = 0;
  let collisions = 0;

  for (const row of rows) {
    if (!row?.id || typeof row.token !== 'string') {
      throw sessionTokenPersistenceError('SESSION_TOKEN_HASH_BACKFILL_INVALID_ROW');
    }
    if (isLegacySessionTokenHash(row.token)) {
      throw sessionTokenPersistenceError('SESSION_TOKEN_HASH_BACKFILL_UNCLASSIFIABLE', {
        sessionId: row.id,
      });
    }
    const storedHash = hashSessionToken(row.token, { env });
    // One parameterized PostgreSQL statement locks both representations and
    // either updates the raw row or resolves the duplicate. It never relies on
    // catching P2002 and therefore never issues work in an aborted transaction.
    // eslint-disable-next-line no-await-in-loop
    const action = await atomicallyBackfillSessionToken(transaction, row, storedHash);
    if (action === 'updated') processed += 1;
    if (action === 'collision') collisions += 1;
  }

  const remaining = await transaction.session.count({
    where: UNVERSIONED_SESSION_TOKEN_WHERE,
  });
  return {
    processed,
    collisions,
    remaining: Number(remaining) || 0,
    hadRows: rows.length > 0,
  };
}

async function runSessionTokenHashBackfill(prismaClient, options = {}) {
  if (typeof prismaClient?.$transaction !== 'function') {
    throw sessionTokenPersistenceError('SESSION_TOKEN_HASH_BACKFILL_UNAVAILABLE');
  }
  const env = options.env || process.env;
  const configured = sessionTokenBackfillConfig(env);
  const batchSize = boundedInteger(options.batchSize, configured.batchSize, 1, 1_000);
  const maxBatches = boundedInteger(options.maxBatches, configured.maxBatches, 1, 100);
  let processed = 0;
  let collisions = 0;
  let remaining = null;
  let batches = 0;

  while (batches < maxBatches) {
    // Each transaction contains at most batchSize rows, keeping locks and
    // transaction duration bounded even for a large legacy table.
    // eslint-disable-next-line no-await-in-loop
    const batch = await prismaClient.$transaction(
      (transaction) => backfillSessionTokenBatch(transaction, { env, batchSize }),
    );
    processed += batch.processed;
    collisions += batch.collisions;
    remaining = batch.remaining;
    if (batch.hadRows) batches += 1;
    if (remaining === 0) break;
  }

  return Object.freeze({
    complete: remaining === 0,
    processed,
    collisions,
    remaining: remaining ?? 0,
    batches,
  });
}

function createSessionTokenHashMigration({
  prisma,
  env = process.env,
} = {}) {
  const mode = resolveSessionTokenHashMode(env);
  const config = sessionTokenBackfillConfig(env);
  let status = mode === SESSION_TOKEN_HASH_MODE_COMPAT ? 'compat' : 'pending';
  let complete = mode === SESSION_TOKEN_HASH_MODE_COMPAT;
  let processed = 0;
  let collisions = 0;
  let remaining = null;
  let lastErrorCode = null;
  let readyPromise = null;

  function health() {
    return Object.freeze({
      ok: mode === SESSION_TOKEN_HASH_MODE_COMPAT || complete,
      mode,
      status,
      complete,
      processed,
      collisions,
      remaining,
      lastErrorCode,
      formatVersion: 1,
    });
  }

  async function ready() {
    if (mode === SESSION_TOKEN_HASH_MODE_COMPAT || complete) return health();
    if (readyPromise) return readyPromise;
    status = 'backfilling';
    readyPromise = (async () => {
      try {
        const result = await runSessionTokenHashBackfill(prisma, {
          env,
          batchSize: config.batchSize,
          maxBatches: config.maxBatches,
        });
        processed += result.processed;
        collisions += result.collisions;
        remaining = result.remaining;
        complete = result.complete;
        if (!complete) {
          lastErrorCode = 'SESSION_TOKEN_HASH_BACKFILL_INCOMPLETE';
          throw sessionTokenPersistenceError(lastErrorCode, {
            remaining,
          });
        }
        status = 'ready';
        lastErrorCode = null;
        return health();
      } catch (error) {
        complete = false;
        status = error?.code === 'SESSION_TOKEN_HASH_BACKFILL_INCOMPLETE'
          ? 'backfilling'
          : 'failed';
        lastErrorCode = error?.code || 'SESSION_TOKEN_HASH_BACKFILL_FAILED';
        throw error;
      } finally {
        readyPromise = null;
      }
    })();
    return readyPromise;
  }

  return Object.freeze({
    ready,
    health,
    config() {
      return Object.freeze({
        mode,
        batchSize: config.batchSize,
        maxBatches: config.maxBatches,
        formatVersion: 1,
        scopeClasses: [
          SESSION_TOKEN_SCOPE_SESSION,
          SESSION_TOKEN_SCOPE_APPSHOTS,
        ],
      });
    },
  });
}

function storedTokenForWrite(token, env = process.env) {
  const raw = normalizePresentedToken(token);
  return resolveSessionTokenHashMode(env) === SESSION_TOKEN_HASH_MODE_HASH
    ? hashSessionToken(raw, { env })
    : raw;
}

function hashSessionData(data, options = {}) {
  if (!data || typeof data !== 'object') {
    throw new TypeError('session data is required');
  }
  return {
    ...data,
    token: storedTokenForWrite(data.token, options.env),
  };
}

async function createSessionRecord(prismaClient, data, options = {}) {
  if (typeof prismaClient?.session?.create !== 'function') {
    throw new TypeError('session.create is required');
  }
  try {
    return await prismaClient.session.create({ data: hashSessionData(data, options) });
  } catch (error) {
    if (isUniqueConstraint(error)) throw new SessionTokenCollisionError();
    throw error;
  }
}

function queryOptions(options) {
  if (!options || typeof options !== 'object') return {};
  const out = {};
  if (options.include) out.include = options.include;
  if (options.select) out.select = options.select;
  return out;
}

async function lookupByStoredToken(prismaClient, storedToken, options) {
  return prismaClient.session.findUnique({
    where: { token: storedToken },
    ...queryOptions(options),
  });
}

/**
 * Resolve a bearer token against Session.token.
 *
 * The normal path performs one digest lookup. During the rolling migration a
 * miss gets one legacy raw-token lookup followed by a conditional updateMany;
 * that compare-and-swap makes concurrent upgrades converge without ever
 * rewriting a hash back to plaintext.
 */
async function findSessionByPresentedToken(prismaClient, presentedToken, options = {}) {
  if (typeof prismaClient?.session?.findUnique !== 'function') {
    throw new TypeError('session.findUnique is required');
  }
  const raw = normalizePresentedToken(presentedToken);
  const storedHash = hashSessionToken(raw, { env: options.env });
  const hashMode = resolveSessionTokenHashMode(options.env) === SESSION_TOKEN_HASH_MODE_HASH;
  const candidates = hashMode
    ? [storedHash, raw]
    : [raw, storedHash];
  let legacy = null;
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const current = await lookupByStoredToken(prismaClient, candidate, options);
    if (!current) continue;
    if (!hashMode || candidate === storedHash) return current;
    legacy = current;
    break;
  }
  if (!legacy) return null;
  if (!hashMode) return legacy;
  if (!legacy.id || typeof prismaClient.session.updateMany !== 'function') {
    throw new Error('SESSION_TOKEN_LEGACY_UPGRADE_UNAVAILABLE');
  }

  try {
    const upgraded = await prismaClient.session.updateMany({
      where: { id: legacy.id, token: raw },
      data: { token: storedHash },
    });
    if (Number(upgraded?.count) === 1) {
      return { ...legacy, token: storedHash };
    }
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    // A concurrent creator/upgrader won the unique digest. Remove only the
    // exact legacy row so plaintext cannot remain at rest, then use the winner.
    await prismaClient.session.deleteMany?.({
      where: { id: legacy.id, token: raw },
    });
  }

  return lookupByStoredToken(prismaClient, storedHash, options);
}

async function deleteSessionsByPresentedToken(prismaClient, presentedToken) {
  if (typeof prismaClient?.session?.deleteMany !== 'function') {
    throw new TypeError('session.deleteMany is required');
  }
  const raw = normalizePresentedToken(presentedToken);
  const digest = digestSessionToken(raw);
  const candidates = [
    formatSessionTokenHash(digest, SESSION_TOKEN_SCOPE_SESSION),
    formatSessionTokenHash(digest, SESSION_TOKEN_SCOPE_APPSHOTS),
    digest,
    raw,
  ];
  // Delete both representations in one statement. Normally only the digest
  // exists; including the legacy value ensures a rolling-deploy duplicate
  // cannot survive revocation if another replica created the digest first.
  return prismaClient.session.deleteMany({
    where: { token: { in: candidates } },
  });
}

async function deleteOtherSessionsForUser(prismaClient, userId, keepPresentedToken) {
  if (typeof prismaClient?.session?.deleteMany !== 'function') {
    throw new TypeError('session.deleteMany is required');
  }
  const raw = normalizePresentedToken(keepPresentedToken);
  const digest = digestSessionToken(raw);
  return prismaClient.session.deleteMany({
    where: {
      userId,
      NOT: {
        token: {
          in: [
            raw,
            formatSessionTokenHash(digest, SESSION_TOKEN_SCOPE_SESSION),
            formatSessionTokenHash(digest, SESSION_TOKEN_SCOPE_APPSHOTS),
            digest,
          ],
        },
      },
    },
  });
}

async function findOtherSessionsForUser(
  prismaClient,
  userId,
  keepPresentedToken,
  options = {},
) {
  if (typeof prismaClient?.session?.findMany !== 'function') {
    throw new TypeError('session.findMany is required');
  }
  const raw = normalizePresentedToken(keepPresentedToken);
  const digest = digestSessionToken(raw);
  return prismaClient.session.findMany({
    where: {
      userId,
      NOT: {
        token: {
          in: [
            raw,
            formatSessionTokenHash(digest, SESSION_TOKEN_SCOPE_SESSION),
            formatSessionTokenHash(digest, SESSION_TOKEN_SCOPE_APPSHOTS),
            digest,
          ],
        },
      },
    },
    ...queryOptions(options),
  });
}

async function rotateSessionByPresentedToken(prismaClient, presentedToken, data, options = {}) {
  if (typeof prismaClient?.session?.update !== 'function') {
    throw new TypeError('session.update is required');
  }
  const raw = normalizePresentedToken(presentedToken);
  const mode = resolveSessionTokenHashMode(options.env);
  const preferredStoredToken = mode === SESSION_TOKEN_HASH_MODE_HASH
    ? hashSessionToken(raw, { env: options.env })
    : raw;
  const nextData = {
    ...data,
    token: storedTokenForWrite(data.token, options.env),
  };
  try {
    return await prismaClient.session.update({
      where: { token: preferredStoredToken },
      data: nextData,
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw new SessionTokenCollisionError();
    if (error?.code !== 'P2025') throw error;
  }

  const found = await findSessionByPresentedToken(prismaClient, presentedToken, {
    select: { id: true, token: true },
    env: options.env,
  });
  if (!found) {
    const error = new Error('SESSION_NOT_FOUND');
    error.code = 'P2025';
    throw error;
  }
  try {
    return await prismaClient.session.update({
      where: { token: found.token },
      data: nextData,
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw new SessionTokenCollisionError();
    throw error;
  }
}

module.exports = {
  SESSION_TOKEN_HASH_PREFIX,
  SESSION_TOKEN_SCOPE_APPSHOTS,
  SESSION_TOKEN_SCOPE_SESSION,
  SESSION_TOKEN_HASH_MODE_COMPAT,
  SESSION_TOKEN_HASH_MODE_HASH,
  SESSION_TOKEN_HASH_DOMAIN,
  SessionTokenCollisionError,
  classifyPresentedSessionToken,
  createSessionTokenHashMigration,
  createSessionRecord,
  deleteOtherSessionsForUser,
  deleteSessionsByPresentedToken,
  digestSessionToken,
  findOtherSessionsForUser,
  findSessionByPresentedToken,
  formatSessionTokenHash,
  getSessionTokenPersistenceHealth,
  hashSessionData,
  hashSessionToken,
  isSessionTokenHash,
  parseSessionTokenHash,
  resolveSessionTokenHashMode,
  rotateSessionByPresentedToken,
  runSessionTokenHashBackfill,
  sessionTokenBackfillConfig,
  sessionTokenMatches,
};
