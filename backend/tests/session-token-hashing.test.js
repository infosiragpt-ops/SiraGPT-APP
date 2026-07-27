'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SESSION_TOKEN_HASH_PREFIX,
  SESSION_TOKEN_SCOPE_APPSHOTS,
  SESSION_TOKEN_SCOPE_SESSION,
  SESSION_TOKEN_HASH_MODE_COMPAT,
  SESSION_TOKEN_HASH_MODE_HASH,
  SESSION_TOKEN_HASH_DOMAIN,
  SessionTokenCollisionError,
  createSessionTokenHashMigration,
  createSessionRecord,
  deleteOtherSessionsForUser,
  deleteSessionsByPresentedToken,
  findOtherSessionsForUser,
  findSessionByPresentedToken,
  getSessionTokenPersistenceHealth,
  hashSessionToken,
  isSessionTokenHash,
  parseSessionTokenHash,
  runSessionTokenHashBackfill,
  resolveSessionTokenHashMode,
  rotateSessionByPresentedToken,
  sessionTokenMatches,
} = require('../src/services/auth/session-token-persistence');
const { SessionRepository } = require('../src/repositories/SessionRepository');
const appshotsToken = require('../src/utils/appshots-token');

const HASH_MODE_ENV = Object.freeze({
  NODE_ENV: 'production',
  SESSION_TOKEN_HASH_MODE: 'hash',
  SESSION_TOKEN_HASH_COMPAT_DRAINED: '1',
});

function expectedDigest(token) {
  return crypto
    .createHash('sha256')
    .update(SESSION_TOKEN_HASH_DOMAIN)
    .update('\0')
    .update(token)
    .digest('hex');
}

function expectedHash(token, scope = SESSION_TOKEN_SCOPE_SESSION) {
  return `${SESSION_TOKEN_HASH_PREFIX}${scope}:${expectedDigest(token)}`;
}

function createSessionModel(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  return {
    rows,
    async create({ data }) {
      if (rows.some((row) => row.token === data.token)) {
        const error = new Error('Unique constraint failed on token');
        error.code = 'P2002';
        error.meta = { target: ['token'] };
        throw error;
      }
      const row = { id: `s-${rows.length + 1}`, ...data };
      rows.push(row);
      return { ...row };
    },
    async findUnique({ where }) {
      const row = rows.find((entry) => (
        where.id ? entry.id === where.id : entry.token === where.token
      ));
      return row ? { ...row } : null;
    },
    async findMany({ where, take }) {
      const prefix = where?.NOT?.token?.startsWith;
      const matches = prefix
        ? rows.filter((entry) => !entry.token.startsWith(prefix))
        : [...rows];
      return matches.slice(0, take).map((row) => ({ ...row }));
    },
    async count({ where }) {
      const prefix = where?.NOT?.token?.startsWith;
      return prefix
        ? rows.filter((entry) => !entry.token.startsWith(prefix)).length
        : rows.length;
    },
    async update({ where, data }) {
      const index = rows.findIndex((entry) => entry.token === where.token);
      if (index < 0) {
        const error = new Error('Record not found');
        error.code = 'P2025';
        throw error;
      }
      if (rows.some((entry, candidate) => (
        candidate !== index && data.token && entry.token === data.token
      ))) {
        const error = new Error('Unique constraint failed on token');
        error.code = 'P2002';
        error.meta = { target: ['token'] };
        throw error;
      }
      rows[index] = { ...rows[index], ...data };
      return { ...rows[index] };
    },
    async updateMany({ where, data }) {
      await new Promise((resolve) => setImmediate(resolve));
      const index = rows.findIndex((entry) => (
        entry.id === where.id && entry.token === where.token
      ));
      if (index < 0) return { count: 0 };
      if (rows.some((entry, candidate) => (
        candidate !== index && data.token && entry.token === data.token
      ))) {
        const error = new Error('Unique constraint failed on token');
        error.code = 'P2002';
        error.meta = { target: ['token'] };
        throw error;
      }
      rows[index] = { ...rows[index], ...data };
      return { count: 1 };
    },
    async deleteMany({ where }) {
      const before = rows.length;
      const hashes = Array.isArray(where?.token?.in)
        ? new Set(where.token.in)
        : new Set([where?.token]);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (hashes.has(rows[index].token)) rows.splice(index, 1);
      }
      return { count: before - rows.length };
    },
  };
}

function createBackfillTransaction(session, queryCalls = []) {
  return {
    session,
    async $queryRawUnsafe(sql, id, rawToken, storedHash) {
      queryCalls.push({ sql, params: [id, rawToken, storedHash] });
      const rawIndex = session.rows.findIndex(
        (row) => row.id === id && row.token === rawToken,
      );
      if (rawIndex < 0) return [{ action: 'noop', winner: 'none' }];

      const raw = session.rows[rawIndex];
      const hashedIndex = session.rows.findIndex((row) => row.token === storedHash);
      if (hashedIndex < 0) {
        raw.token = storedHash;
        return [{ action: 'updated', winner: 'raw' }];
      }

      const hashed = session.rows[hashedIndex];
      const now = Date.now();
      const rank = (row) => [
        new Date(row.expiresAt || 0).getTime() > now ? 1 : 0,
        new Date(row.lastUsedAt || row.createdAt || 0).getTime(),
        new Date(row.expiresAt || 0).getTime(),
        new Date(row.createdAt || 0).getTime(),
        String(row.id),
      ];
      const rawRank = rank(raw);
      const hashedRank = rank(hashed);
      let rawWins = false;
      for (let index = 0; index < rawRank.length; index += 1) {
        if (rawRank[index] === hashedRank[index]) continue;
        rawWins = rawRank[index] > hashedRank[index];
        break;
      }
      if (rawWins) {
        const { id: _id, token: _token, ...latestData } = raw;
        Object.assign(hashed, latestData);
      }
      session.rows.splice(rawIndex, 1);
      return [{ action: 'collision', winner: rawWins ? 'raw' : 'hashed' }];
    },
  };
}

test('session tokens use a domain-separated SHA-256 digest', () => {
  const token = 'header.payload.signature';
  const digest = hashSessionToken(token);

  assert.equal(digest, expectedHash(token));
  assert.match(digest, /^sira:session-token:v1:session:[a-f0-9]{64}$/);
  assert.equal(isSessionTokenHash(digest), true);
  assert.equal(isSessionTokenHash(token), false);
  assert.notEqual(
    digest,
    crypto.createHash('sha256').update(token).digest('hex'),
    'the persistence digest must not be a bare SHA-256(token)',
  );
  assert.deepEqual(parseSessionTokenHash(digest), {
    version: 1,
    scope: 'session',
    digest: expectedDigest(token),
  });
  assert.equal(sessionTokenMatches(digest, token), true);
  assert.equal(sessionTokenMatches(token, token), true, 'legacy rows remain comparable during rollout');
});

test('stored hashes preserve verified Appshots scope in a bounded versioned prefix', () => {
  const env = {
    JWT_SECRET: 'scope-classification-secret-at-least-32-chars',
  };
  const token = require('jsonwebtoken').sign(
    { userId: 'u-appshots', scope: 'appshots:capture' },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const stored = hashSessionToken(token, { env });

  assert.equal(stored, expectedHash(token, SESSION_TOKEN_SCOPE_APPSHOTS));
  assert.deepEqual(parseSessionTokenHash(stored), {
    version: 1,
    scope: SESSION_TOKEN_SCOPE_APPSHOTS,
    digest: expectedDigest(token),
  });
  assert.equal(stored.includes(token), false);
  assert.equal(stored.length < 128, true);
});

test('production defaults to rolling-safe compat mode while non-production defaults to hash', () => {
  assert.equal(resolveSessionTokenHashMode({ NODE_ENV: 'production' }), SESSION_TOKEN_HASH_MODE_COMPAT);
  assert.equal(resolveSessionTokenHashMode({ NODE_ENV: 'staging' }), SESSION_TOKEN_HASH_MODE_COMPAT);
  assert.equal(resolveSessionTokenHashMode({ NODE_ENV: 'test' }), SESSION_TOKEN_HASH_MODE_HASH);
  assert.equal(resolveSessionTokenHashMode({ NODE_ENV: 'development' }), SESSION_TOKEN_HASH_MODE_HASH);
});

test('compat mode writes raw tokens and reads either representation without upgrading', async () => {
  const compatEnv = {
    NODE_ENV: 'production',
    SESSION_TOKEN_HASH_MODE: 'compat',
  };
  const raw = 'compat-rolling-session-token';
  const session = createSessionModel();

  await createSessionRecord({ session }, {
    userId: 'u-compat',
    token: raw,
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }, { env: compatEnv });

  assert.equal(session.rows[0].token, raw);
  const updateMany = session.updateMany;
  let upgrades = 0;
  session.updateMany = async (...args) => {
    upgrades += 1;
    return updateMany(...args);
  };

  const rawRow = await findSessionByPresentedToken({ session }, raw, { env: compatEnv });
  assert.equal(rawRow.id, 's-1');
  assert.equal(session.rows[0].token, raw);

  session.rows[0].token = expectedHash(raw);
  const hashedRow = await findSessionByPresentedToken({ session }, raw, { env: compatEnv });
  assert.equal(hashedRow.id, 's-1');
  assert.equal(session.rows[0].token, expectedHash(raw));
  assert.equal(upgrades, 0, 'compat readers must never upgrade plaintext rows');
});

test('hash mode writes hashes and upgrades a legacy row once', async () => {
  const hashEnv = {
    NODE_ENV: 'production',
    SESSION_TOKEN_HASH_MODE: 'hash',
    SESSION_TOKEN_HASH_COMPAT_DRAINED: '1',
  };
  const raw = 'hash-mode-session-token';
  const session = createSessionModel([{
    id: 'legacy-hash-mode',
    userId: 'u-hash',
    token: raw,
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }]);

  const found = await findSessionByPresentedToken({ session }, raw, { env: hashEnv });
  assert.equal(found.id, 'legacy-hash-mode');
  assert.equal(session.rows[0].token, expectedHash(raw));

  await createSessionRecord({ session }, {
    userId: 'u-hash',
    token: 'new-hash-mode-token',
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }, { env: hashEnv });
  assert.equal(session.rows[1].token, expectedHash('new-hash-mode-token'));
});

test('compat rotation writes the replacement token raw for rollback-safe old replicas', async () => {
  const compatEnv = {
    NODE_ENV: 'production',
    SESSION_TOKEN_HASH_MODE: 'compat',
  };
  const current = 'compat-current-token';
  const replacement = 'compat-replacement-token';
  const session = createSessionModel([{
    id: 'compat-rotate',
    userId: 'u-compat',
    token: expectedHash(current),
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }]);

  const rotated = await rotateSessionByPresentedToken(
    { session },
    current,
    {
      token: replacement,
      expiresAt: new Date('2026-07-13T00:00:00.000Z'),
    },
    { env: compatEnv },
  );

  assert.equal(rotated.token, replacement);
  assert.equal(session.rows[0].token, replacement);
});

test('session persistence health reports the active rollout mode without token material', () => {
  const compat = getSessionTokenPersistenceHealth({ NODE_ENV: 'production' });
  assert.deepEqual(compat, {
    ok: true,
    mode: 'compat',
    explicit: false,
    writesHashed: false,
    upgradesLegacy: false,
    productionDefault: 'compat',
  });

  const hash = getSessionTokenPersistenceHealth({
    NODE_ENV: 'production',
    SESSION_TOKEN_HASH_MODE: 'hash',
    SESSION_TOKEN_HASH_COMPAT_DRAINED: 'true',
  });
  assert.equal(hash.mode, 'hash');
  assert.equal(hash.explicit, true);
  assert.equal(hash.writesHashed, true);
  assert.equal(hash.upgradesLegacy, true);
});

test('hash activation backfills raw rows transactionally with a verified scope class', async () => {
  const env = {
    NODE_ENV: 'production',
    SESSION_TOKEN_HASH_MODE: 'hash',
    SESSION_TOKEN_HASH_COMPAT_DRAINED: '1',
    JWT_SECRET: 'backfill-scope-secret-at-least-32-characters',
  };
  const jwt = require('jsonwebtoken');
  const appshots = jwt.sign(
    { userId: 'u-1', scope: 'appshots:capture' },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  const ordinary = jwt.sign(
    { userId: 'u-1' },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  const session = createSessionModel([
    { id: 'raw-appshots', userId: 'u-1', token: appshots },
    { id: 'raw-session', userId: 'u-1', token: ordinary },
  ]);
  let transactions = 0;
  const prisma = {
    session,
    async $transaction(work) {
      transactions += 1;
      return work(createBackfillTransaction(session));
    },
  };

  const result = await runSessionTokenHashBackfill(prisma, {
    env,
    batchSize: 1,
    maxBatches: 4,
  });

  assert.deepEqual(result, {
    complete: true,
    processed: 2,
    collisions: 0,
    remaining: 0,
    batches: 2,
  });
  assert.equal(transactions, 2, 'each bounded batch must have its own transaction');
  assert.equal(
    session.rows.find((row) => row.id === 'raw-appshots').token,
    expectedHash(appshots, SESSION_TOKEN_SCOPE_APPSHOTS),
  );
  assert.equal(
    session.rows.find((row) => row.id === 'raw-session').token,
    expectedHash(ordinary, SESSION_TOKEN_SCOPE_SESSION),
  );
});

test('hash backfill uses one parameterized PostgreSQL CTE statement per raw row', async () => {
  const raw = 'raw-token-must-never-be-interpolated-into-sql';
  const session = createSessionModel([{
    id: 'raw-sql-shape',
    userId: 'u-sql',
    token: raw,
    expiresAt: new Date('2099-07-12T00:00:00.000Z'),
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
  }]);
  const queryCalls = [];
  const prisma = {
    session,
    $transaction: (work) => work(createBackfillTransaction(session, queryCalls)),
  };

  const result = await runSessionTokenHashBackfill(prisma, {
    env: HASH_MODE_ENV,
    batchSize: 1,
    maxBatches: 1,
  });

  assert.equal(result.processed, 1);
  assert.equal(queryCalls.length, 1);
  const [{ sql, params }] = queryCalls;
  assert.match(sql, /WITH\s+"raw_row"\s+AS\s+MATERIALIZED/i);
  assert.match(sql, /ON\s+CONFLICT\s*\(\s*"token"\s*\)\s+DO\s+UPDATE/i);
  assert.match(sql, /"expiresAt"\s*>\s*CURRENT_TIMESTAMP/i);
  assert.match(sql, /COALESCE\([^)]*"lastUsedAt"[^,]*,[^)]*"createdAt"[^)]*\)/i);
  assert.match(sql, /DELETE\s+FROM\s+"sessions"/i);
  assert.match(sql, /INSERT\s+INTO\s+"sessions"/i);
  assert.deepEqual(params, ['raw-sql-shape', raw, expectedHash(raw)]);
  assert.equal(sql.includes(raw), false, 'token material must be passed only as a SQL parameter');
  assert.equal(sql.includes(expectedHash(raw)), false, 'hash material must not be interpolated');
});

test('hash collision atomically promotes the latest active raw session without a post-P2002 query', async () => {
  const raw = 'rolling-collision-latest-raw';
  const storedHash = expectedHash(raw);
  const session = createSessionModel([
    {
      id: 'hashed-older',
      userId: 'u-old',
      token: storedHash,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      createdAt: new Date('2019-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2019-06-01T00:00:00.000Z'),
      fingerprint: 'old-fingerprint',
      label: 'old device',
    },
    {
      id: 'raw-latest',
      userId: 'u-current',
      token: raw,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-11T00:00:00.000Z'),
      lastUsedAt: new Date('2026-07-11T21:00:00.000Z'),
      fingerprint: 'current-fingerprint',
      label: 'current device',
    },
  ]);
  let aborted = false;
  let postAbortQueries = 0;
  session.updateMany = async () => {
    aborted = true;
    const error = new Error('unique collision aborts PostgreSQL transaction');
    error.code = 'P2002';
    throw error;
  };
  session.deleteMany = async () => {
    if (aborted) {
      postAbortQueries += 1;
      const error = new Error('current transaction is aborted');
      error.code = '25P02';
      throw error;
    }
    return { count: 0 };
  };
  const queryCalls = [];
  const prisma = {
    session,
    $transaction: (work) => work(createBackfillTransaction(session, queryCalls)),
  };

  const result = await runSessionTokenHashBackfill(prisma, {
    env: HASH_MODE_ENV,
    batchSize: 1,
    maxBatches: 1,
  });

  assert.equal(aborted, false, 'backfill must not provoke a unique-constraint abort');
  assert.equal(postAbortQueries, 0, 'backfill must never issue a statement after an abort');
  assert.equal(queryCalls.length, 1);
  assert.deepEqual(result, {
    complete: true,
    processed: 0,
    collisions: 1,
    remaining: 0,
    batches: 1,
  });
  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].id, 'hashed-older');
  assert.equal(session.rows[0].token, storedHash);
  assert.equal(session.rows[0].userId, 'u-current');
  assert.equal(session.rows[0].fingerprint, 'current-fingerprint');
  assert.equal(session.rows[0].label, 'current device');
});

test('hash collision deterministically keeps the existing active hash when the raw duplicate is stale', async () => {
  const raw = 'rolling-collision-active-hash';
  const storedHash = expectedHash(raw);
  const session = createSessionModel([
    {
      id: 'hashed-current',
      userId: 'u-current',
      token: storedHash,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-11T00:00:00.000Z'),
      lastUsedAt: new Date('2026-07-11T21:00:00.000Z'),
      fingerprint: 'current-fingerprint',
    },
    {
      id: 'raw-stale',
      userId: 'u-stale',
      token: raw,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      createdAt: new Date('2019-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2019-06-01T00:00:00.000Z'),
      fingerprint: 'stale-fingerprint',
    },
  ]);
  const queryCalls = [];
  const prisma = {
    session,
    $transaction: (work) => work(createBackfillTransaction(session, queryCalls)),
  };

  const result = await runSessionTokenHashBackfill(prisma, {
    env: HASH_MODE_ENV,
    batchSize: 1,
    maxBatches: 1,
  });

  assert.equal(queryCalls.length, 1);
  assert.equal(result.collisions, 1);
  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].id, 'hashed-current');
  assert.equal(session.rows[0].userId, 'u-current');
  assert.equal(session.rows[0].fingerprint, 'current-fingerprint');
});

test('concurrent hash backfill passes are idempotent', async () => {
  const raw = 'concurrent-backfill-token';
  const session = createSessionModel([{
    id: 'raw-concurrent',
    userId: 'u-concurrent',
    token: raw,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
  }]);
  const queryCalls = [];
  const prisma = {
    session,
    $transaction: (work) => work(createBackfillTransaction(session, queryCalls)),
  };

  const results = await Promise.all([
    runSessionTokenHashBackfill(prisma, {
      env: HASH_MODE_ENV,
      batchSize: 1,
      maxBatches: 1,
    }),
    runSessionTokenHashBackfill(prisma, {
      env: HASH_MODE_ENV,
      batchSize: 1,
      maxBatches: 1,
    }),
  ]);

  assert.ok(queryCalls.length >= 1);
  assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 1);
  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].token, expectedHash(raw));
});

test('hash readiness stays blocked after a bounded pass and recovers on the next probe', async () => {
  const env = {
    NODE_ENV: 'production',
    SESSION_TOKEN_HASH_MODE: 'hash',
    SESSION_TOKEN_HASH_COMPAT_DRAINED: '1',
    SESSION_TOKEN_HASH_BACKFILL_BATCH_SIZE: '1',
    SESSION_TOKEN_HASH_BACKFILL_MAX_BATCHES: '1',
  };
  const session = createSessionModel([
    { id: 'raw-1', userId: 'u-1', token: 'raw-one' },
    { id: 'raw-2', userId: 'u-2', token: 'raw-two' },
  ]);
  const prisma = {
    session,
    $transaction: (work) => work(createBackfillTransaction(session)),
  };
  const migration = createSessionTokenHashMigration({ prisma, env });

  await assert.rejects(
    migration.ready(),
    (error) => error?.code === 'SESSION_TOKEN_HASH_BACKFILL_INCOMPLETE',
  );
  assert.equal(migration.health().ok, false);
  assert.equal(migration.health().complete, false);
  assert.equal(migration.health().remaining, 1);

  await migration.ready();
  assert.equal(migration.health().ok, true);
  assert.equal(migration.health().complete, true);
  assert.equal(migration.health().remaining, 0);
  assert.equal(session.rows.every((row) => isSessionTokenHash(row.token)), true);
});

test('compat readiness never backfills or upgrades raw session rows', async () => {
  const env = {
    NODE_ENV: 'production',
    SESSION_TOKEN_HASH_MODE: 'compat',
  };
  const session = createSessionModel([
    { id: 'raw-compat', userId: 'u-1', token: 'raw-compat-token' },
  ]);
  let transactions = 0;
  const migration = createSessionTokenHashMigration({
    prisma: {
      session,
      async $transaction(work) {
        transactions += 1;
        return work({ session });
      },
    },
    env,
  });

  await migration.ready();

  assert.equal(migration.health().ok, true);
  assert.equal(migration.health().status, 'compat');
  assert.equal(transactions, 0);
  assert.equal(session.rows[0].token, 'raw-compat-token');
});

test('repository create persists only a token hash', async () => {
  const session = createSessionModel();
  const repository = new SessionRepository({
    prisma: { session },
    withRetry: (operation) => operation(),
    logger: { warn() {} },
    env: HASH_MODE_ENV,
  });
  const raw = 'raw-session-token-never-store-me';

  await repository.create({
    userId: 'u-1',
    token: raw,
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  });

  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].token, expectedHash(raw));
  assert.equal(JSON.stringify(session.rows).includes(raw), false);
});

test('direct session record creation sanitizes unique token collisions', async () => {
  const raw = 'same-minted-token';
  const session = createSessionModel([{
    id: 'existing',
    userId: 'u-1',
    token: expectedHash(raw),
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }]);

  await assert.rejects(
    createSessionRecord({ session }, {
      userId: 'u-2',
      token: raw,
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
    }, { env: HASH_MODE_ENV }),
    (error) => {
      assert.equal(error instanceof SessionTokenCollisionError, true);
      assert.equal(error.code, 'SESSION_TOKEN_HASH_COLLISION');
      assert.equal(error.message.includes(raw), false);
      return true;
    },
  );
  assert.equal(session.rows.some((row) => row.token === raw), false);
});

test('lookup hashes first and atomically upgrades one legacy raw row', async () => {
  const raw = 'legacy-session-token';
  const session = createSessionModel([{
    id: 'legacy',
    userId: 'u-1',
    token: raw,
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }]);
  const queries = [];
  const originalFindUnique = session.findUnique;
  session.findUnique = async (args) => {
    queries.push(args.where.token);
    return originalFindUnique(args);
  };

  const found = await findSessionByPresentedToken({ session }, raw, { env: HASH_MODE_ENV });

  assert.equal(found.id, 'legacy');
  assert.equal(found.token, expectedHash(raw));
  assert.deepEqual(queries.slice(0, 2), [expectedHash(raw), raw]);
  assert.equal(session.rows[0].token, expectedHash(raw));
  assert.equal(session.rows.some((row) => row.token === raw), false);

  queries.length = 0;
  await findSessionByPresentedToken({ session }, raw, { env: HASH_MODE_ENV });
  assert.deepEqual(queries, [expectedHash(raw)], 'upgraded rows never trigger another raw lookup');
});

test('concurrent legacy lookups converge on one hashed row', async () => {
  const raw = 'legacy-concurrent-session-token';
  const session = createSessionModel([{
    id: 'legacy',
    userId: 'u-1',
    token: raw,
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }]);

  const [left, right] = await Promise.all([
    findSessionByPresentedToken({ session }, raw, { env: HASH_MODE_ENV }),
    findSessionByPresentedToken({ session }, raw, { env: HASH_MODE_ENV }),
  ]);

  assert.equal(left.id, 'legacy');
  assert.equal(right.id, 'legacy');
  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].token, expectedHash(raw));
});

test('revoke and rotation hash every presented token', async () => {
  const oldRaw = 'old-raw-token';
  const newRaw = 'new-raw-token';
  const session = createSessionModel([{
    id: 's-1',
    userId: 'u-1',
    token: expectedHash(oldRaw),
    expiresAt: new Date('2026-07-12T00:00:00.000Z'),
  }]);

  const rotated = await rotateSessionByPresentedToken(
    { session },
    oldRaw,
    {
      token: newRaw,
      expiresAt: new Date('2026-07-13T00:00:00.000Z'),
    },
    { env: HASH_MODE_ENV },
  );
  assert.equal(rotated.token, expectedHash(newRaw));
  assert.equal(session.rows[0].token, expectedHash(newRaw));
  assert.equal(JSON.stringify(session.rows).includes(newRaw), false);

  const revoked = await deleteSessionsByPresentedToken({ session }, newRaw);
  assert.deepEqual(revoked, { count: 1 });
  assert.equal(session.rows.length, 0);
});

test('revoke removes hashed and legacy copies of the same presented token', async () => {
  const raw = 'duplicate-rolling-deploy-token';
  const session = createSessionModel([
    {
      id: 'hashed',
      userId: 'u-1',
      token: expectedHash(raw),
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
    },
    {
      id: 'legacy',
      userId: 'u-1',
      token: raw,
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
    },
  ]);

  const revoked = await deleteSessionsByPresentedToken({ session }, raw);

  assert.deepEqual(revoked, { count: 2 });
  assert.deepEqual(session.rows, []);
});

test('revoke-others excludes both raw and hashed forms of the current token', async () => {
  const calls = [];
  const prisma = {
    session: {
      async deleteMany(args) {
        calls.push(['delete', args]);
        return { count: 2 };
      },
      async findMany(args) {
        calls.push(['find', args]);
        return [];
      },
    },
  };
  const current = 'current-token-with-two-rollout-representations';
  const expected = {
    userId: 'u-current',
    NOT: {
      token: {
        in: [
          current,
          expectedHash(current, SESSION_TOKEN_SCOPE_SESSION),
          expectedHash(current, SESSION_TOKEN_SCOPE_APPSHOTS),
          expectedDigest(current),
        ],
      },
    },
  };

  await deleteOtherSessionsForUser(prisma, 'u-current', current);
  await findOtherSessionsForUser(prisma, 'u-current', current);

  assert.deepEqual(calls[0][1].where, expected);
  assert.deepEqual(calls[1][1].where, expected);
});

test('hashed Appshots sessions remain classifiable without decoding Session.token', () => {
  assert.equal(typeof appshotsToken.markAppshotsUserAgent, 'function');
  assert.equal(typeof appshotsToken.visibleAppshotsUserAgent, 'function');
  assert.equal(typeof appshotsToken.isAppshotsSession, 'function');

  const rawUserAgent = 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36';
  const storedUserAgent = appshotsToken.markAppshotsUserAgent(rawUserAgent);
  const session = {
    token: expectedHash('appshots-bearer', SESSION_TOKEN_SCOPE_APPSHOTS),
    userAgent: null,
  };

  assert.equal(appshotsToken.isAppshotsSession(session), true);
  assert.equal(appshotsToken.visibleAppshotsUserAgent(storedUserAgent), rawUserAgent);
  assert.equal(appshotsToken.isAppshotsSession({
    token: expectedHash('ordinary-bearer'),
    userAgent: storedUserAgent,
  }), false);
});

test('compat Appshots classification verifies signatures while ignoring expiration only', () => {
  const jwt = require('jsonwebtoken');
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'compat-appshots-classifier-secret-32-chars';
  try {
    const expired = jwt.sign(
      { userId: 'u-expired', scope: 'appshots:capture' },
      process.env.JWT_SECRET,
      { expiresIn: -1 },
    );
    const forged = jwt.sign(
      { userId: 'u-forged', scope: 'appshots:capture' },
      'different-signing-secret-at-least-32-chars',
      { expiresIn: '1h' },
    );

    assert.equal(appshotsToken.isAppshotsSession({ token: expired }), true);
    assert.equal(appshotsToken.isAppshotsSession({ token: forged }), false);
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});

test('Appshots persistence and classifiers never depend on decoding a token hash', () => {
  const srcRoot = path.resolve(__dirname, '../src');
  const offenders = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const source = fs.readFileSync(absolute, 'utf8');
        if (/isAppshotsToken\(\s*(?:row|s)\.token\b/.test(source)) {
          offenders.push(path.relative(path.resolve(__dirname, '..'), absolute));
        }
      }
    }
  }

  walk(srcRoot);
  assert.deepEqual(offenders, []);

  const appshotsRoute = fs.readFileSync(
    path.join(srcRoot, 'routes/appshots.js'),
    'utf8',
  );
  assert.match(appshotsRoute, /userAgent:\s*markAppshotsUserAgent\(/);
  assert.match(appshotsRoute, /isAppshotsSession\(row\)/);
});

test('production source has no direct Session.token query or write outside the persistence boundary', () => {
  const srcRoot = path.resolve(__dirname, '../src');
  const scriptsRoot = path.resolve(__dirname, '../scripts');
  const allowed = new Set([
    path.join(srcRoot, 'services/auth/session-token-persistence.js'),
  ]);
  const offenders = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js') && !allowed.has(absolute)) {
        const source = fs.readFileSync(absolute, 'utf8');
        const patterns = [
          /\.session\.(?:findUnique|findFirst|update|updateMany|delete|deleteMany)\s*\(\s*\{\s*where\s*:\s*\{\s*token\s*:/,
          /\.session\.(?:findMany|deleteMany)\s*\(\s*\{\s*where\s*:\s*\{[\s\S]{0,160}?\bNOT\s*:\s*\{\s*token\s*:/,
          /\.session\.create\s*\(/,
        ];
        if (patterns.some((pattern) => pattern.test(source))) {
          offenders.push(path.relative(path.resolve(__dirname, '..'), absolute));
        }
      }
    }
  }

  walk(srcRoot);
  walk(scriptsRoot);
  assert.deepEqual(offenders, []);
});

test('auth-security readiness gates hash mode on the transactional session backfill', () => {
  const backendIndex = fs.readFileSync(
    path.resolve(__dirname, '../index.js'),
    'utf8',
  );

  assert.match(backendIndex, /createSessionTokenHashMigration\(\{\s*prisma,\s*env:\s*process\.env/s);
  assert.match(backendIndex, /sessionTokenHashMigration\.ready\(\)/);
  assert.match(backendIndex, /const sessionTokens = sessionTokenHashMigration\.health\(\)/);
  assert.match(backendIndex, /ok:\s*Boolean\([^)]*sessionTokens\.ok\)/);
  assert.match(backendIndex, /sessionTokens:\s*sessionTokenHashMigration\.config\(\)/);
});
