'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const {
  createRbacBootstrapService,
} = require('../src/services/rbac-bootstrap');
const {
  RBAC_MUTATION_LOCK_KEY,
  RBAC_MUTATION_LOCK_SQL,
  acquireRbacMutationLock,
} = require('../src/services/rbac-system-assignments');
const {
  AUTH_USER_LOCK_SQL,
  acquireAuthUserLock,
  authUserLockKey,
} = require('../src/services/auth/auth-user-lock');
const {
  acquireCreditOperationLock,
  acquireFallbackQuotaLock,
} = require('../src/services/credit-ledger');
const { SessionRepository } = require('../src/repositories/SessionRepository');
const {
  isSessionTokenHash,
} = require('../src/services/auth/session-token-persistence');

const DIRECT_VOID_PROJECTION =
  /SELECT\s+pg_advisory_xact_lock\s*\((?:[^()]|\([^()]*\))*\)\s+AS\s+"?[a-z_][a-z0-9_]*"?/giu;

function javascriptFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return javascriptFiles(absolute);
    return entry.isFile() && /\.[cm]?js$/u.test(entry.name) ? [absolute] : [];
  });
}

function sqlText(query) {
  return Array.isArray(query?.strings)
    ? query.strings.join('?')
    : String(query || '');
}

function assertScalarLockCte(sql, label) {
  assert.match(
    sql,
    /WITH\s+[a-z_][a-z0-9_]*\s+AS\s*\(\s*SELECT\s+pg_advisory_xact_lock\s*\(/iu,
    `${label} must acquire the transaction lock in a CTE`,
  );
  assert.match(
    sql,
    /SELECT\s+1::(?:int|integer)\s+AS\s+locked\s+FROM\s+[a-z_][a-z0-9_]*/iu,
    `${label} must expose only a Prisma-supported integer projection`,
  );
}

test('all Prisma advisory transaction locks expose a supported scalar projection offline', async () => {
  const sourceRoot = path.resolve(__dirname, '../src');
  const violations = javascriptFiles(sourceRoot).flatMap((absolute) => {
    const source = fs.readFileSync(absolute, 'utf8');
    return [...source.matchAll(DIRECT_VOID_PROJECTION)].map((match) => ({
      file: path.relative(sourceRoot, absolute),
      projection: match[0].replace(/\s+/gu, ' '),
    }));
  });
  assert.deepEqual(
    violations,
    [],
    `raw pg_advisory_xact_lock void projections remain: ${JSON.stringify(violations)}`,
  );

  assertScalarLockCte(RBAC_MUTATION_LOCK_SQL, 'RBAC mutation lock');
  assertScalarLockCte(AUTH_USER_LOCK_SQL, 'auth user lock');

  const queries = [];
  const tx = {
    async $queryRaw(query) {
      queries.push(sqlText(query));
      return [{ locked: 1 }];
    },
  };
  assert.equal(typeof acquireCreditOperationLock, 'function');
  assert.equal(typeof acquireFallbackQuotaLock, 'function');
  await acquireCreditOperationLock(tx, 'offline-operation-key');
  await acquireFallbackQuotaLock(tx, 'offline-quota-key');
  assert.equal(queries.length, 2);
  assertScalarLockCte(queries[0], 'credit operation lock');
  assertScalarLockCte(queries[1], 'fallback quota lock');
});

function postgresIntegrationEnabled() {
  const databaseUrl = String(process.env.DATABASE_URL || '');
  const optedIn = process.env.CI === 'true'
    || process.env.RUN_POSTGRES_LOCK_INTEGRATION === '1';
  return optedIn && /^postgres(?:ql)?:\/\//iu.test(databaseUrl);
}

function singleConnectionUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set('connection_limit', '1');
  parsed.searchParams.set('pool_timeout', '10');
  return parsed.toString();
}

const PAIRING_AUTHORIZE_WORKER = path.resolve(
  __dirname,
  'fixtures/pairing-authorize-worker.js',
);

function waitForWorkerMessage(child, predicate, {
  label = 'pairing worker response',
  timeoutMs = 20_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `timed out waiting for ${label}; stderr=${child.pairingStderr || '<empty>'}`,
      ));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(
        `pairing worker exited before ${label}: code=${code} signal=${signal}; `
        + `stderr=${child.pairingStderr || '<empty>'}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

async function startPairingWorker({ databaseUrl, pepper }) {
  const child = fork(PAIRING_AUTHORIZE_WORKER, [], {
    env: {
      ...process.env,
      DATABASE_URL: singleConnectionUrl(databaseUrl),
      CHANNEL_PAIRING_PEPPER: pepper,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.pairingStderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    child.pairingStderr = `${child.pairingStderr}${chunk}`.slice(-8_000);
  });
  const ready = await waitForWorkerMessage(
    child,
    (message) => message?.type === 'ready',
    { label: 'pairing worker readiness' },
  );
  assert.equal(ready.pid, child.pid);
  return child;
}

let pairingWorkerRequestSequence = 0;

async function authorizeInWorker(child, {
  channel,
  senderRefs,
  startAt,
}) {
  pairingWorkerRequestSequence += 1;
  const requestId = `pairing-${process.pid}-${pairingWorkerRequestSequence}`;
  const responsePromise = waitForWorkerMessage(
    child,
    (message) => message?.type === 'result' && message.requestId === requestId,
    { label: `pairing authorization ${requestId}`, timeoutMs: 45_000 },
  );
  child.send({
    type: 'authorize',
    requestId,
    channel,
    senderRefs,
    startAt,
  });
  const response = await responsePromise;
  if (!response.ok) {
    const error = new Error(response.error?.message || 'pairing worker failed');
    error.code = response.error?.code;
    error.stack = response.error?.stack || error.stack;
    throw error;
  }
  return response.results;
}

async function stopPairingWorker(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    child.send({ type: 'shutdown' });
  } catch {
    child.kill('SIGKILL');
  }
  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      resolve();
    }, 5_000).unref();
  });
  await Promise.race([exited, timeout]);
}

async function tryBigintLock(client, key) {
  const rows = await client.$queryRawUnsafe(
    'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
    String(key),
  );
  return rows?.[0]?.locked === true;
}

async function tryTextHashLock(client, key) {
  const rows = await client.$queryRawUnsafe(
    'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
    String(key),
  );
  return rows?.[0]?.locked === true;
}

async function assertTransactionLockLifecycle({
  holderClient,
  observerClient,
  acquire,
  tryAcquire,
  label,
}) {
  let release;
  let markAcquired;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const acquired = new Promise((resolve) => {
    markAcquired = resolve;
  });
  const holder = holderClient.$transaction(async (tx) => {
    await acquire(tx);
    markAcquired();
    await hold;
  }, { timeout: 20_000 });

  await Promise.race([
    acquired,
    holder.then(() => {
      throw new Error(`${label} transaction ended before the lock was observed`);
    }),
  ]);
  try {
    assert.equal(
      await tryAcquire(observerClient),
      false,
      `${label} must exclude another PostgreSQL transaction while held`,
    );
  } finally {
    release();
  }
  await holder;
  assert.equal(
    await tryAcquire(observerClient),
    true,
    `${label} must be released automatically when its transaction commits`,
  );
}

test(
  'PostgreSQL acquires and releases every U2 Prisma lock, then bootstraps RBAC and issues a session',
  {
    skip: postgresIntegrationEnabled()
      ? false
      : 'requires CI DATABASE_URL or RUN_POSTGRES_LOCK_INTEGRATION=1',
    timeout: 90_000,
  },
  async () => {
    const runId = randomUUID();
    const databaseUrl = process.env.DATABASE_URL;
    const holderClient = new PrismaClient({
      datasources: {
        db: {
          url: singleConnectionUrl(databaseUrl),
        },
      },
    });
    const observerClient = new PrismaClient({
      datasources: {
        db: {
          url: singleConnectionUrl(databaseUrl),
        },
      },
    });
    const userId = `u2-lock-user-${runId}`;

    await Promise.all([holderClient.$connect(), observerClient.$connect()]);
    try {
      await assertTransactionLockLifecycle({
        holderClient,
        observerClient,
        label: 'RBAC global lock',
        acquire: (tx) => acquireRbacMutationLock(tx, { timeoutMs: 2_000 }),
        tryAcquire: (client) => tryBigintLock(client, RBAC_MUTATION_LOCK_KEY),
      });
      await assertTransactionLockLifecycle({
        holderClient,
        observerClient,
        label: 'auth user lock',
        acquire: (tx) => acquireAuthUserLock(tx, userId, { timeoutMs: 2_000 }),
        tryAcquire: (client) => tryBigintLock(client, authUserLockKey(userId)),
      });

      const operationKey = `u2-credit-operation-${runId}`;
      await assertTransactionLockLifecycle({
        holderClient,
        observerClient,
        label: 'credit operation lock',
        acquire: (tx) => acquireCreditOperationLock(tx, operationKey),
        tryAcquire: (client) => tryTextHashLock(client, operationKey),
      });
      const quotaKey = `u2-credit-quota-${runId}`;
      await assertTransactionLockLifecycle({
        holderClient,
        observerClient,
        label: 'fallback quota lock',
        acquire: (tx) => acquireFallbackQuotaLock(tx, quotaKey),
        tryAcquire: (client) => tryTextHashLock(client, quotaKey),
      });

      const bootstrap = createRbacBootstrapService({
        prisma: holderClient,
        env: {
          NODE_ENV: 'production',
          RBAC_ENFORCEMENT_MODE: 'enforce',
        },
        invalidatePermissionsCache: async () => {},
        writeAuditLog: async () => null,
        logger: { info() {}, warn() {}, error() {} },
      });
      const bootstrapStatus = await bootstrap.bootstrap();
      assert.equal(bootstrapStatus.ready, true);

      await holderClient.user.create({
        data: {
          id: userId,
          email: `${runId}@u2-lock.integration.invalid`,
          name: 'U2 lock integration',
          password: '!integration-test-no-login!',
        },
      });
      const rawToken = `u2-session-${runId}`;
      const sessions = new SessionRepository({
        prisma: holderClient,
        withRetry: (operation) => operation(),
        logger: { warn() {}, log() {}, error() {} },
        env: {
          NODE_ENV: 'test',
          SESSION_TOKEN_HASH_MODE: 'hash',
          SESSION_TOKEN_HASH_COMPAT_DRAINED: '1',
        },
      });
      const issued = await sessions.create({
        userId,
        token: rawToken,
        expiresAt: new Date(Date.now() + 60_000),
        fingerprint: 'u2-postgres-integration',
      });
      assert.equal(issued.userId, userId);
      assert.equal(isSessionTokenHash(issued.token), true);
      assert.notEqual(issued.token, rawToken);
    } finally {
      await holderClient.user.deleteMany({ where: { id: userId } }).catch(() => {});
      await Promise.all([
        holderClient.$disconnect(),
        observerClient.$disconnect(),
      ]);
    }
  },
);

test(
  'PostgreSQL serializes channel pairing across processes and enforces channel/company tenancy',
  {
    skip: postgresIntegrationEnabled()
      ? false
      : 'requires CI DATABASE_URL or RUN_POSTGRES_LOCK_INTEGRATION=1',
    timeout: 120_000,
  },
  async () => {
    const runId = randomUUID();
    const databaseUrl = process.env.DATABASE_URL;
    const pepper = `postgres-pairing-integration-${runId}`;
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: singleConnectionUrl(databaseUrl),
        },
      },
    });
    const userId = `pairing-lock-user-${runId}`;
    const companyIds = [];
    const workers = [];

    await prisma.$connect();
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${runId}@pairing-lock.integration.invalid`,
          name: 'Pairing lock integration',
          password: '!integration-test-no-login!',
        },
      });
      const projectA = await prisma.project.create({
        data: {
          userId,
          name: `Pairing company A ${runId}`,
        },
      });
      const projectB = await prisma.project.create({
        data: {
          userId,
          name: `Pairing company B ${runId}`,
        },
      });
      const companyA = await prisma.company.create({
        data: {
          userId,
          projectId: projectA.id,
          name: `Pairing company A ${runId}`,
        },
      });
      const companyB = await prisma.company.create({
        data: {
          userId,
          projectId: projectB.id,
          name: `Pairing company B ${runId}`,
        },
      });
      companyIds.push(companyA.id, companyB.id);
      const channelA = await prisma.businessChannel.create({
        data: {
          companyId: companyA.id,
          userId,
          kind: 'telegram',
          label: 'Pairing integration A',
          dmPolicy: 'pairing',
        },
      });
      const channelB = await prisma.businessChannel.create({
        data: {
          companyId: companyB.id,
          userId,
          kind: 'telegram',
          label: 'Pairing integration B',
          dmPolicy: 'pairing',
        },
      });
      const workerChannel = {
        id: channelA.id,
        companyId: companyA.id,
        userId,
      };

      workers.push(await startPairingWorker({ databaseUrl, pepper }));
      workers.push(await startPairingWorker({ databaseUrl, pepper }));

      const sameSender = `same-sender-${runId}`;
      const sameSenderStart = Date.now() + 300;
      const [left, right] = await Promise.all([
        authorizeInWorker(workers[0], {
          channel: workerChannel,
          senderRefs: [sameSender],
          startAt: sameSenderStart,
        }),
        authorizeInWorker(workers[1], {
          channel: workerChannel,
          senderRefs: [sameSender],
          startAt: sameSenderStart,
        }),
      ]);
      const sameSenderResults = [...left, ...right];
      assert.equal(sameSenderResults.length, 2);
      for (const result of sameSenderResults) {
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'pairing_required');
      }
      assert.equal(
        sameSenderResults[0].pairingCode,
        sameSenderResults[1].pairingCode,
        'the same sender must receive one stable code across processes',
      );
      assert.deepEqual(
        sameSenderResults.map((result) => result.created).sort(),
        [false, true],
        'only one process may create the pending pairing',
      );
      assert.equal(
        await prisma.businessChannelPairing.count({
          where: { channelId: channelA.id, senderRef: sameSender },
        }),
        1,
      );

      await prisma.businessChannelPairing.deleteMany({
        where: { channelId: channelA.id },
      });

      const senders = Array.from(
        { length: 20 },
        (_, index) => `bounded-sender-${index}-${runId}`,
      );
      const manySendersStart = Date.now() + 300;
      const [evenResults, oddResults] = await Promise.all([
        authorizeInWorker(workers[0], {
          channel: workerChannel,
          senderRefs: senders.filter((_, index) => index % 2 === 0),
          startAt: manySendersStart,
        }),
        authorizeInWorker(workers[1], {
          channel: workerChannel,
          senderRefs: senders.filter((_, index) => index % 2 === 1),
          startAt: manySendersStart,
        }),
      ]);
      const manySenderResults = [...evenResults, ...oddResults];
      assert.equal(manySenderResults.length, 20);
      for (const result of manySenderResults) {
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'pairing_required');
      }
      const retained = await prisma.businessChannelPairing.findMany({
        where: { channelId: channelA.id },
        select: { status: true },
      });
      assert.equal(retained.length, 3, 'pairing storage must remain bounded');
      assert.equal(
        retained.filter((pairing) => pairing.status === 'pending').length,
        3,
        'at most three live pending pairings may remain',
      );

      await assert.rejects(
        prisma.$executeRaw`
          INSERT INTO "business_channel_pairings" (
            "id",
            "companyId",
            "channelId",
            "senderRef",
            "codeHash",
            "status",
            "expiresAt",
            "updatedAt"
          ) VALUES (
            ${`cross-tenant-pairing-${runId}`},
            ${companyA.id},
            ${channelB.id},
            ${`cross-tenant-sender-${runId}`},
            ${'0'.repeat(64)},
            ${'pending'},
            ${new Date(Date.now() + 60_000)},
            ${new Date()}
          )
        `,
        (error) => {
          const diagnostic = [
            error?.code,
            error?.meta?.code,
            error?.meta?.message,
            error?.message,
          ].filter(Boolean).join(' ');
          assert.match(diagnostic, /23503|foreign key/iu);
          return true;
        },
        'company A must not own a pairing for company B channel',
      );

      await Promise.all(workers.map(stopPairingWorker));
      workers.length = 0;
      await prisma.user.delete({ where: { id: userId } });
      assert.equal(
        await prisma.businessChannelPairing.count({
          where: { companyId: { in: companyIds } },
        }),
        0,
        'deleting the fixture user must cascade through companies and pairings',
      );
    } finally {
      await Promise.all(workers.map(stopPairingWorker));
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
      await prisma.$disconnect();
    }
  },
);
