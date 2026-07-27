'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_IDEMPOTENCY_LEASE_MS,
  MAX_IDEMPOTENCY_LEASE_MS,
  MIN_IDEMPOTENCY_LEASE_MS,
  attachLedgerResource,
  completeLedgerTransaction,
  deterministicRefundKey,
  failLedgerTransaction,
  hashIdempotencyKey,
  heartbeatLedgerLease,
  refundLedgerTransaction,
  resolveIdempotencyLeaseMs,
  reserveFallbackCharge,
  reservePaidCharge,
  startLedgerLeaseHeartbeat,
  supportsRawLedgerClient,
} = require('../src/services/credit-ledger');

function cloneState(state) {
  return {
    credits: new Map(
      [...state.credits.entries()].map(([key, value]) => [key, { ...value }]),
    ),
    rows: state.rows.map((row) => ({
      ...row,
      metadata: structuredClone(row.metadata || {}),
    })),
  };
}

function sqlText(query) {
  return Array.isArray(query?.strings)
    ? query.strings.join('?')
    : String(query || '');
}

function createRawPrisma({
  balances = { 'user-1': 100n },
  failInsert = false,
} = {}) {
  const durable = {
    credits: new Map(
      Object.entries(balances).map(([userId, balance]) => [
        userId,
        {
          userId,
          orgId: null,
          balance: BigInt(balance),
          lifetimeSpent: 0n,
        },
      ]),
    ),
    rows: [],
  };
  const telemetry = {
    transactionCalls: 0,
    rootRawCalls: 0,
    txRawCalls: 0,
    queries: [],
  };
  let queue = Promise.resolve();

  function buildTx(working) {
    return {
      async $queryRaw(query) {
        telemetry.txRawCalls += 1;
        const text = sqlText(query);
        const values = [...(query?.values || [])];
        telemetry.queries.push({ text, values });

        if (text.includes('credit-ledger:lock-operation')
          || text.includes('credit-ledger:lock-fallback-quota')) {
          return [{ locked: 1 }];
        }
        if (text.includes('credit-ledger:select-by-key')) {
          return working.rows
            .filter((row) => row.idempotencyKey === values[0])
            .slice(0, 1);
        }
        if (text.includes('credit-ledger:guarded-debit')) {
          const [amountValue, _lifetimeAmount, userId] = values;
          const amount = BigInt(amountValue);
          const credit = working.credits.get(userId);
          if (!credit || credit.balance < amount) return [];
          credit.balance -= amount;
          credit.lifetimeSpent += amount;
          return [{ balance: credit.balance, orgId: credit.orgId }];
        }
        if (text.includes('credit-ledger:count-fallback')) {
          const [userId, start, end] = values;
          const used = working.rows.filter((row) => (
            row.userId === userId
            && row.metadata?.path === 'free_ia'
            && row.createdAt >= start
            && row.createdAt < end
          )).length;
          return [{ used }];
        }
        if (text.includes('credit-ledger:read-balance')) {
          const credit = working.credits.get(values[0]);
          return credit
            ? [{ balance: credit.balance, orgId: credit.orgId }]
            : [];
        }
        if (text.includes('credit-ledger:insert-transaction')) {
          if (failInsert) throw new Error('simulated ledger insert failure');
          const [
            id,
            userId,
            orgId,
            type,
            amountValue,
            balanceAfterValue,
            reason,
            metadataJson,
            idempotencyKey,
            createdAt,
          ] = values;
          if (working.rows.some((row) => row.idempotencyKey === idempotencyKey)) {
            const error = new Error('duplicate idempotency key');
            error.code = 'P2010';
            error.meta = { code: '23505' };
            throw error;
          }
          const row = {
            id,
            userId,
            orgId,
            type,
            amount: BigInt(amountValue),
            balanceAfter: BigInt(balanceAfterValue),
            reason,
            metadata: JSON.parse(metadataJson),
            idempotencyKey,
            createdAt,
          };
          working.rows.push(row);
          return [row];
        }
        if (text.includes('credit-ledger:select-by-id')) {
          return working.rows
            .filter((row) => row.id === values[0] && row.userId === values[1])
            .slice(0, 1);
        }
        if (text.includes('credit-ledger:select-refund-by-original')) {
          const [userId, refundedTxnId, transactionId] = values;
          return working.rows
            .filter((row) => (
              row.userId === userId
              && row.type === 'REFUND'
              && (
                row.metadata?.refundedTxnId === refundedTxnId
                || row.metadata?.transactionId === transactionId
              )
            ))
            .sort((left, right) => (
              left.createdAt - right.createdAt || left.id.localeCompare(right.id)
            ))
            .slice(0, 1);
        }
        if (text.includes('credit-ledger:update-owned-metadata')) {
          const [metadataJson, id, userId, expectedState, leaseToken] = values;
          const row = working.rows.find((entry) => (
            entry.id === id && entry.userId === userId
          ));
          if (!row) return [];
          if (
            row.metadata?.idempotency?.state !== expectedState
            || row.metadata?.idempotency?.leaseToken !== leaseToken
          ) {
            return [];
          }
          row.metadata = JSON.parse(metadataJson);
          return [row];
        }
        if (text.includes('credit-ledger:legacy-refund-cas')) {
          const [
            metadataJson,
            id,
            userId,
            preFencingSource,
            preIdempotencySource,
          ] = values;
          const row = working.rows.find((entry) => (
            entry.id === id
            && entry.userId === userId
            && entry.type === 'SPEND'
            && entry.amount < 0n
            && (
              (
                preFencingSource === 'pre_fencing'
                && entry.metadata?.path === 'paid'
                && entry.metadata?.idempotency?.state === 'completed'
                && entry.metadata?.idempotency?.leaseToken == null
              )
              || (
                preIdempotencySource === 'pre_idempotency'
                && !Object.prototype.hasOwnProperty.call(entry.metadata || {}, 'idempotency')
              )
            )
          ));
          if (!row) return [];
          row.metadata = JSON.parse(metadataJson);
          return [row];
        }
        if (text.includes('credit-ledger:legacy-refund-balance')) {
          const [
            amountValue,
            _lifetimeAmount,
            userId,
            originalId,
            originalUserId,
            legacyRefundCasToken,
            refundTransactionId,
          ] = values;
          const amount = BigInt(amountValue);
          const credit = working.credits.get(userId);
          const original = working.rows.find((row) => (
            row.id === originalId
            && row.userId === originalUserId
            && row.metadata?.idempotency?.state === 'refunded'
            && row.metadata?.idempotency?.leaseToken == null
            && row.metadata?.idempotency?.legacyRefundCasToken === legacyRefundCasToken
            && row.metadata?.idempotency?.refundTransactionId === refundTransactionId
          ));
          if (!credit || !original) return [];
          credit.balance += amount;
          credit.lifetimeSpent = credit.lifetimeSpent > amount
            ? credit.lifetimeSpent - amount
            : 0n;
          return [{ balance: credit.balance, orgId: credit.orgId }];
        }
        if (text.includes('credit-ledger:refund-balance')) {
          const [
            amountValue,
            _lifetimeAmount,
            userId,
            originalId,
            originalUserId,
            leaseToken,
            refundTransactionId,
          ] = values;
          const amount = BigInt(amountValue);
          const credit = working.credits.get(userId);
          const original = working.rows.find((row) => (
            row.id === originalId
            && row.userId === originalUserId
            && row.metadata?.idempotency?.state === 'refunded'
            && row.metadata?.idempotency?.leaseToken === leaseToken
            && row.metadata?.idempotency?.refundTransactionId === refundTransactionId
          ));
          if (!credit || !original) return [];
          credit.balance += amount;
          credit.lifetimeSpent = credit.lifetimeSpent > amount
            ? credit.lifetimeSpent - amount
            : 0n;
          return [{ balance: credit.balance, orgId: credit.orgId }];
        }
        throw new Error(`unhandled raw SQL in test fake: ${text}`);
      },
    };
  }

  const prisma = {
    get credit() {
      throw new Error('credit delegate must never be read');
    },
    get creditTransaction() {
      throw new Error('creditTransaction delegate must never be read');
    },
    async $queryRaw() {
      telemetry.rootRawCalls += 1;
      throw new Error('ledger raw SQL must run inside an interactive transaction');
    },
    $transaction(callback) {
      const run = queue.then(async () => {
        telemetry.transactionCalls += 1;
        const working = cloneState(durable);
        const result = await callback(buildTx(working));
        durable.credits = working.credits;
        durable.rows = working.rows;
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
    _state: durable,
    _telemetry: telemetry,
  };
  return prisma;
}

function paidInput(prismaClient, overrides = {}) {
  return {
    prismaClient,
    userId: 'user-1',
    amount: 10,
    feature: 'paraphrase',
    idempotencyKey: 'client-key-1',
    requestHash: 'request-hash-1',
    now: new Date('2026-07-10T12:00:00.000Z'),
    ...overrides,
  };
}

function fallbackInput(prismaClient, overrides = {}) {
  return {
    ...paidInput(prismaClient),
    dailyLimit: 2,
    windowStart: new Date('2026-07-10T00:00:00.000Z'),
    windowEnd: new Date('2026-07-11T00:00:00.000Z'),
    ...overrides,
  };
}

test('real generated Prisma surface has raw APIs but no credit delegates', async () => {
  const { PrismaClient } = require('@prisma/client');
  const client = new PrismaClient();
  try {
    assert.equal(client.credit, undefined);
    assert.equal(client.creditTransaction, undefined);
    assert.equal(typeof client.$transaction, 'function');
    assert.equal(typeof client.$queryRaw, 'function');
    assert.equal(supportsRawLedgerClient(client), true);
  } finally {
    await client.$disconnect();
  }
});

test('idempotency keys are user-scoped hashes and never contain the raw key', () => {
  const raw = 'shared-key\' ; DROP TABLE "credits"; --';
  const first = hashIdempotencyKey('user-1', raw);
  const same = hashIdempotencyKey('user-1', raw);
  const otherUser = hashIdempotencyKey('user-2', raw);
  assert.match(first, /^credit-idem:v1:[a-f0-9]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, otherUser);
  assert.equal(first.includes(raw), false);
});

test('paid debit and ledger insert use parameterized SQL in one transaction', async () => {
  const marker = '\'; SELECT pg_sleep(10); --';
  const prismaClient = createRawPrisma();
  const result = await reservePaidCharge(paidInput(prismaClient, {
    userId: `user-1${marker}`,
    idempotencyKey: `key${marker}`,
    metadata: { supplied: marker },
  }));
  assert.equal(result.ok, false, 'unknown injected user has no balance');
  assert.equal(result.code, 'INSUFFICIENT');

  const safe = await reservePaidCharge(paidInput(prismaClient, {
    metadata: { supplied: marker },
  }));
  assert.equal(safe.ok, true);
  assert.equal(safe.winner, true);
  assert.match(safe.txn.id, /^credit_[0-9a-f-]{36}$/);
  assert.equal(prismaClient._telemetry.transactionCalls, 2);
  assert.equal(prismaClient._telemetry.rootRawCalls, 0);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 90n);
  assert.equal(prismaClient._state.rows.length, 1);
  assert.equal(prismaClient._state.rows[0].metadata.idempotency.state, 'in_progress');
  assert.equal(prismaClient._state.rows[0].idempotencyKey.includes('client-key-1'), false);

  for (const query of prismaClient._telemetry.queries) {
    assert.equal(query.text.includes(marker), false, 'user input leaked into SQL text');
  }
  assert.equal(
    prismaClient._telemetry.queries.some((query) => (
      query.values.some((value) => String(value).includes(marker))
    )),
    true,
    'injected data should be present only as a bound value',
  );
});

test('a ledger insert failure rolls the guarded debit back', async () => {
  const prismaClient = createRawPrisma({ failInsert: true });
  await assert.rejects(
    reservePaidCharge(paidInput(prismaClient)),
    /simulated ledger insert failure/,
  );
  assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
  assert.equal(prismaClient._state.credits.get('user-1').lifetimeSpent, 0n);
  assert.equal(prismaClient._state.rows.length, 0);
});

test('fallback reserves one zero-amount row and enforces quota atomically', async () => {
  const prismaClient = createRawPrisma({ balances: { 'user-1': 0n } });
  const first = await reserveFallbackCharge(fallbackInput(prismaClient, {
    dailyLimit: 1,
  }));
  assert.equal(first.ok, true);
  assert.equal(first.winner, true);
  assert.equal(first.txn.amount, 0n);
  assert.equal(first.txn.metadata.path, 'free_ia');
  assert.match(
    first.txn.metadata.idempotency.leaseToken,
    /^[a-f0-9-]{36}$/i,
  );
  assert.equal(first.used, 1);

  const exhausted = await reserveFallbackCharge(fallbackInput(prismaClient, {
    idempotencyKey: 'client-key-2',
    requestHash: 'request-hash-2',
    dailyLimit: 1,
  }));
  assert.deepEqual(exhausted, {
    ok: false,
    code: 'FALLBACK_QUOTA_EXCEEDED',
    limit: 1,
    used: 1,
  });
  assert.equal(prismaClient._state.rows.length, 1);
});

test('one shared row prevents a fallback key switching to paid after top-up', async () => {
  const prismaClient = createRawPrisma({ balances: { 'user-1': 0n } });
  const fallback = await reserveFallbackCharge(fallbackInput(prismaClient));
  assert.equal(fallback.ok, true);
  prismaClient._state.credits.get('user-1').balance = 100n;

  const paid = await reservePaidCharge(paidInput(prismaClient));
  assert.equal(paid.ok, false);
  assert.equal(paid.code, 'IDEMPOTENCY_IN_PROGRESS');
  assert.equal(paid.retryable, true);
  assert.equal(paid.existingTransactionId, fallback.txn.id);
  assert.equal(paid.leaseUntil, fallback.txn.metadata.idempotency.leaseUntil);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
  assert.equal(prismaClient._state.rows.length, 1);
});

test('the same raw key is independent across users but conflicts across features', async () => {
  const prismaClient = createRawPrisma({
    balances: { 'user-1': 100n, 'user-2': 100n },
  });
  const first = await reservePaidCharge(paidInput(prismaClient));
  const otherUser = await reservePaidCharge(paidInput(prismaClient, {
    userId: 'user-2',
  }));
  assert.equal(first.ok, true);
  assert.equal(otherUser.ok, true);
  assert.notEqual(first.txn.idempotencyKey, otherUser.txn.idempotencyKey);

  const pathConflict = await reservePaidCharge(paidInput(prismaClient, {
    feature: 'image_generation',
  }));
  assert.equal(pathConflict.ok, false);
  assert.equal(pathConflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(prismaClient._state.rows.length, 2);
});

test('concurrent fallback reservations create one winner and consume one slot', async () => {
  const prismaClient = createRawPrisma({ balances: { 'user-1': 0n } });
  const [first, second] = await Promise.all([
    reserveFallbackCharge(fallbackInput(prismaClient)),
    reserveFallbackCharge(fallbackInput(prismaClient)),
  ]);
  assert.equal([first, second].filter((entry) => entry.winner).length, 1);
  assert.equal(
    [first, second].filter((entry) => entry.code === 'IDEMPOTENCY_IN_PROGRESS').length,
    1,
  );
  assert.equal(prismaClient._state.rows.length, 1);
});

test('completed responses replay; failed and in-progress states return stable conflicts', async () => {
  const prismaClient = createRawPrisma();
  const charge = await reservePaidCharge(paidInput(prismaClient));
  const inProgress = await reservePaidCharge(paidInput(prismaClient));
  assert.equal(inProgress.code, 'IDEMPOTENCY_IN_PROGRESS');

  await completeLedgerTransaction({
    prismaClient,
    transaction: charge.txn,
    statusCode: 200,
    body: { output: 'cached result' },
  });
  const completed = await reservePaidCharge(paidInput(prismaClient));
  assert.equal(completed.ok, true);
  assert.equal(completed.replay, true);
  assert.deepEqual(completed.cachedResponse, {
    statusCode: 200,
    body: { output: 'cached result' },
  });

  const failedCharge = await reserveFallbackCharge(fallbackInput(prismaClient, {
    idempotencyKey: 'failed-key',
    requestHash: 'failed-hash',
  }));
  await failLedgerTransaction({
    prismaClient,
    transaction: failedCharge.txn,
    code: 'PROVIDER_UNAVAILABLE',
    statusCode: 502,
  });
  const failedReplay = await reserveFallbackCharge(fallbackInput(prismaClient, {
    idempotencyKey: 'failed-key',
    requestHash: 'failed-hash',
  }));
  assert.equal(failedReplay.code, 'IDEMPOTENCY_FAILED');
  assert.equal(failedReplay.retryable, true);
});

test('idempotency lease duration is configurable and clamped', () => {
  assert.equal(resolveIdempotencyLeaseMs({}), DEFAULT_IDEMPOTENCY_LEASE_MS);
  assert.equal(
    resolveIdempotencyLeaseMs({ CREDIT_IDEMPOTENCY_LEASE_MS: '1' }),
    MIN_IDEMPOTENCY_LEASE_MS,
  );
  assert.equal(
    resolveIdempotencyLeaseMs({ CREDIT_IDEMPOTENCY_LEASE_MS: '999999999' }),
    MAX_IDEMPOTENCY_LEASE_MS,
  );
  assert.equal(
    resolveIdempotencyLeaseMs({ CREDIT_IDEMPOTENCY_LEASE_MS: '45000' }),
    45_000,
  );
  assert.ok(
    resolveIdempotencyLeaseMs({ IMAGE_GEN_TIMEOUT_MS: '600000' }) > 600_000,
    'the default lease must exceed the configured provider timeout',
  );
});

test('lease heartbeat conditionally extends only the matching in-progress token', async () => {
  const prismaClient = createRawPrisma();
  const original = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:00.000Z'),
    leaseMs: 5_000,
  }));
  const beat = await heartbeatLedgerLease({
    prismaClient,
    transaction: original.txn,
    now: new Date('2026-07-10T12:00:04.000Z'),
    leaseMs: 5_000,
  });
  assert.equal(beat.ok, true);
  assert.equal(
    beat.txn.metadata.idempotency.leaseUntil,
    '2026-07-10T12:00:09.000Z',
  );
  assert.equal(
    beat.txn.metadata.idempotency.heartbeatAt,
    '2026-07-10T12:00:04.000Z',
  );

  const recovered = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:09.001Z'),
    leaseMs: 5_000,
  }));
  const staleBeat = await heartbeatLedgerLease({
    prismaClient,
    transaction: original.txn,
    now: new Date('2026-07-10T12:00:10.000Z'),
    leaseMs: 5_000,
  });
  assert.equal(recovered.recovered, true);
  assert.equal(staleBeat.ok, false);
  assert.equal(staleBeat.code, 'LEASE_LOST');
});

test('lease heartbeat interval is unrefed and stop prevents later beats', async () => {
  const prismaClient = createRawPrisma();
  const charge = await reservePaidCharge(paidInput(prismaClient));
  let heartbeats = 0;
  const heartbeat = startLedgerLeaseHeartbeat({
    prismaClient,
    transaction: charge.txn,
    intervalMs: 1_000,
    heartbeat: async () => {
      heartbeats += 1;
      return { ok: true };
    },
  });
  assert.equal(heartbeat.timer.hasRef(), false);
  await heartbeat.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(heartbeats, 0);
});

test('generatedImage resource attachment is fenced by in-progress lease ownership', async () => {
  const prismaClient = createRawPrisma();
  const original = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:00.000Z'),
    leaseMs: 5_000,
  }));
  const attached = await attachLedgerResource({
    prismaClient,
    transaction: original.txn,
    resourceType: 'generatedImage',
    resourceId: 'img_durable_1',
  });
  assert.equal(attached.ok, true);
  assert.equal(attached.txn.metadata.resourceType, 'generatedImage');
  assert.equal(attached.txn.metadata.resourceId, 'img_durable_1');

  const recovered = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:06.000Z'),
    leaseMs: 5_000,
  }));
  const staleAttach = await attachLedgerResource({
    prismaClient,
    transaction: original.txn,
    resourceType: 'generatedImage',
    resourceId: 'img_stale',
  });
  assert.equal(recovered.recovered, true);
  assert.equal(staleAttach.ok, false);
  assert.equal(staleAttach.code, 'LEASE_LOST');
  assert.equal(
    prismaClient._state.rows[0].metadata.resourceId,
    'img_durable_1',
  );
});

test('an expired in-progress lease is atomically recovered without another debit', async () => {
  const prismaClient = createRawPrisma();
  const startedAt = new Date('2026-07-10T12:00:00.000Z');
  const charge = await reservePaidCharge(paidInput(prismaClient, {
    now: startedAt,
    leaseMs: 5_000,
  }));
  assert.equal(charge.ok, true);
  assert.equal(
    charge.txn.metadata.idempotency.leaseUntil,
    '2026-07-10T12:00:05.000Z',
  );

  const active = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:04.999Z'),
    leaseMs: 5_000,
  }));
  assert.equal(active.ok, false);
  assert.equal(active.code, 'IDEMPOTENCY_IN_PROGRESS');
  assert.equal(active.leaseUntil, '2026-07-10T12:00:05.000Z');

  const recovered = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:05.001Z'),
    leaseMs: 5_000,
  }));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.winner, false);
  assert.equal(recovered.ownsLease, true);
  assert.equal(recovered.txn.id, charge.txn.id);
  assert.match(
    charge.txn.metadata.idempotency.leaseToken,
    /^[a-f0-9-]{36}$/i,
  );
  assert.notEqual(
    recovered.txn.metadata.idempotency.leaseToken,
    charge.txn.metadata.idempotency.leaseToken,
  );
  assert.equal(
    recovered.txn.metadata.idempotency.startedAt,
    '2026-07-10T12:00:05.001Z',
  );
  assert.equal(
    recovered.txn.metadata.idempotency.leaseUntil,
    '2026-07-10T12:00:10.001Z',
  );
  assert.equal(recovered.txn.metadata.idempotency.recoveryCount, 1);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 90n);
  assert.equal(prismaClient._state.rows.length, 1);
});

test('only one concurrent caller claims an expired lease recovery', async () => {
  const prismaClient = createRawPrisma();
  await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:00.000Z'),
    leaseMs: 5_000,
  }));
  const recoveryInput = paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:06.000Z'),
    leaseMs: 5_000,
  });
  const [first, second] = await Promise.all([
    reservePaidCharge(recoveryInput),
    reservePaidCharge(recoveryInput),
  ]);
  assert.equal([first, second].filter((entry) => entry.recovered).length, 1);
  assert.equal(
    [first, second].filter((entry) => entry.code === 'IDEMPOTENCY_IN_PROGRESS').length,
    1,
  );
  assert.equal(prismaClient._state.credits.get('user-1').balance, 90n);
  assert.equal(prismaClient._state.rows.length, 1);
});

test('lease recovery reads the existing idempotency row with a database row lock', async () => {
  const prismaClient = createRawPrisma();
  await reservePaidCharge(paidInput(prismaClient));
  const select = prismaClient._telemetry.queries.find(
    (query) => query.text.includes('credit-ledger:select-by-key'),
  );
  assert.ok(select);
  assert.match(select.text, /FOR UPDATE/i);
});

test('original finishing after recovered success cannot overwrite or refund the winner', async () => {
  const prismaClient = createRawPrisma();
  const original = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:00.000Z'),
    leaseMs: 5_000,
  }));
  const recovered = await reservePaidCharge(paidInput(prismaClient, {
    now: new Date('2026-07-10T12:00:06.000Z'),
    leaseMs: 5_000,
  }));

  const winnerCompletion = await completeLedgerTransaction({
    prismaClient,
    transaction: recovered.txn,
    body: { output: 'winner' },
  });
  assert.equal(winnerCompletion.ok, true);

  const staleCompletion = await completeLedgerTransaction({
    prismaClient,
    transaction: original.txn,
    body: { output: 'stale' },
  });
  assert.equal(staleCompletion.ok, false);
  assert.equal(staleCompletion.code, 'LEASE_LOST');

  const staleFailure = await failLedgerTransaction({
    prismaClient,
    transaction: original.txn,
    code: 'STALE_PROVIDER_ERROR',
    statusCode: 502,
  });
  assert.equal(staleFailure.ok, false);
  assert.equal(staleFailure.code, 'LEASE_LOST');

  const staleRefund = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: original.txn,
    reason: 'stale_provider_finished_late',
  });
  assert.equal(staleRefund.ok, false);
  assert.equal(staleRefund.code, 'LEASE_LOST');

  const replay = await reservePaidCharge(paidInput(prismaClient));
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.cachedResponse.body, { output: 'winner' });
  assert.equal(prismaClient._state.credits.get('user-1').balance, 90n);
  assert.equal(prismaClient._state.rows.length, 1);
  assert.equal(
    prismaClient._state.rows[0].metadata.idempotency.state,
    'completed',
  );
});

test('lease-owned state transitions are fenced in SQL by status and leaseToken', async () => {
  const prismaClient = createRawPrisma();
  const completed = await reservePaidCharge(paidInput(prismaClient, {
    idempotencyKey: 'sql-complete-key',
    requestHash: 'sql-complete-hash',
  }));
  await completeLedgerTransaction({
    prismaClient,
    transaction: completed.txn,
    body: { ok: true },
  });

  const failed = await reservePaidCharge(paidInput(prismaClient, {
    idempotencyKey: 'sql-fail-key',
    requestHash: 'sql-fail-hash',
  }));
  await failLedgerTransaction({
    prismaClient,
    transaction: failed.txn,
    code: 'EXPECTED_FAILURE',
  });

  const refunded = await reservePaidCharge(paidInput(prismaClient, {
    idempotencyKey: 'sql-refund-key',
    requestHash: 'sql-refund-hash',
  }));
  await refundLedgerTransaction({
    prismaClient,
    originalTransaction: refunded.txn,
  });

  const ownedUpdates = prismaClient._telemetry.queries.filter(
    (query) => query.text.includes('credit-ledger:update-owned-metadata'),
  );
  assert.ok(ownedUpdates.length >= 3);
  for (const query of ownedUpdates) {
    assert.match(query.text, /idempotency.+state/is);
    assert.match(query.text, /idempotency.+leaseToken/is);
  }
});

test('refund_pending is durable and can be strictly reconciled to refunded', async () => {
  const prismaClient = createRawPrisma();
  const charge = await reservePaidCharge(paidInput(prismaClient));
  const pending = await failLedgerTransaction({
    prismaClient,
    transaction: charge.txn,
    code: 'REFUND_FAILED',
    statusCode: 503,
    state: 'refund_pending',
  });
  assert.equal(pending.ok, true);
  assert.equal(pending.txn.metadata.idempotency.state, 'refund_pending');

  const replay = await reservePaidCharge(paidInput(prismaClient));
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'IDEMPOTENCY_REFUND_PENDING');
  assert.equal(replay.retryable, true);
  assert.equal(replay.txn.id, charge.txn.id);

  const refund = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: replay.txn,
    reason: 'reconcile_refund_pending',
  });
  assert.equal(refund.ok, true);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
  const original = prismaClient._state.rows.find((row) => row.id === charge.txn.id);
  assert.equal(original.metadata.idempotency.state, 'refunded');
});

test('refund and refund-ledger are atomic, deterministic, and mark original refunded', async () => {
  const prismaClient = createRawPrisma();
  const charge = await reservePaidCharge(paidInput(prismaClient));
  const first = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: charge.txn,
    reason: 'similarity_gate',
  });
  const replay = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: charge.txn,
    reason: 'similarity_gate',
  });

  assert.equal(first.ok, true);
  assert.equal(first.winner, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.txn.id, first.txn.id);
  assert.match(first.txn.idempotencyKey, /^credit-idem:v1:[a-f0-9]{64}$/);
  assert.equal(first.txn.idempotencyKey.includes(`refund:${charge.txn.id}`), false);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
  assert.equal(prismaClient._state.rows.length, 2);
  const original = prismaClient._state.rows.find((row) => row.id === charge.txn.id);
  assert.equal(original.metadata.idempotency.state, 'refunded');

  const retryOriginalKey = await reservePaidCharge(paidInput(prismaClient));
  assert.equal(retryOriginalKey.code, 'IDEMPOTENCY_REFUNDED');
  assert.equal(retryOriginalKey.retryable, true);
});

test('admin refund supports completed pre-fencing SPEND rows without leaseToken exactly once', async () => {
  const prismaClient = createRawPrisma({ balances: { 'user-1': 90n } });
  prismaClient._state.credits.get('user-1').lifetimeSpent = 10n;
  const historical = {
    id: 'legacy-spend-1',
    userId: 'user-1',
    orgId: null,
    type: 'SPEND',
    amount: -10n,
    balanceAfter: 90n,
    reason: 'historical image generation',
    metadata: {
      feature: 'image_generation',
      requestHash: 'legacy-request-hash',
      requestedAmount: '10',
      path: 'paid',
      idempotency: {
        state: 'completed',
        response: { statusCode: 201, body: { imageId: 'legacy-image' } },
        completedAt: '2026-06-01T00:00:00.000Z',
        startedAt: '2026-06-01T00:00:00.000Z',
        leaseUntil: '2026-06-01T00:02:00.000Z',
        leaseId: 'pre-fencing-owner-id',
      },
    },
    idempotencyKey: hashIdempotencyKey('user-1', 'legacy-client-key'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  };
  prismaClient._state.rows.push(historical);

  const first = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: historical,
    reason: 'admin_historical_refund',
  });
  const replay = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: historical,
    reason: 'admin_historical_refund',
  });

  assert.equal(first.ok, true);
  assert.equal(first.winner, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.txn.id, first.txn.id);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
  assert.equal(prismaClient._state.rows.length, 2);
  const original = prismaClient._state.rows.find((row) => row.id === historical.id);
  assert.equal(original.metadata.idempotency.state, 'refunded');
  assert.equal(original.metadata.idempotency.leaseToken, undefined);
  assert.match(original.metadata.idempotency.legacyRefundCasToken, /^[a-f0-9-]{36}$/i);
  const legacyCas = prismaClient._telemetry.queries.find(
    (query) => query.text.includes('credit-ledger:legacy-refund-cas'),
  );
  assert.ok(legacyCas);
  assert.match(legacyCas.text, /state.+completed/is);
  assert.match(legacyCas.text, /leaseToken.+IS NULL/is);
  assert.match(legacyCas.text, /type.+SPEND/is);
  assert.match(legacyCas.text, /path.+paid/is);
});

test('admin refund accepts a null-key pre-idempotency negative SPEND exactly once', async () => {
  const prismaClient = createRawPrisma({ balances: { 'user-1': 75n } });
  prismaClient._state.credits.get('user-1').lifetimeSpent = 25n;
  const historical = {
    id: 'pre-idempotency-spend-1',
    userId: 'user-1',
    orgId: null,
    type: 'SPEND',
    amount: -25n,
    balanceAfter: 75n,
    reason: 'legacy manual generation',
    metadata: {
      feature: 'image_generation',
      importedFrom: 'pre_idempotency_ledger',
    },
    idempotencyKey: null,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
  };
  prismaClient._state.rows.push(historical);

  const first = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: historical,
    reason: 'admin_pre_idempotency_refund',
  });
  assert.equal(first.ok, true);
  assert.equal(first.winner, true);
  const replay = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: historical,
    reason: 'admin_pre_idempotency_refund',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.txn.id, first.txn.id);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
  assert.equal(prismaClient._state.rows.length, 2);
  const lookupIndex = prismaClient._telemetry.queries.findIndex(
    (query) => query.text.includes('credit-ledger:select-refund-by-original'),
  );
  const balanceIndex = prismaClient._telemetry.queries.findIndex(
    (query) => query.text.includes('credit-ledger:legacy-refund-balance'),
  );
  assert.ok(lookupIndex >= 0);
  assert.ok(balanceIndex > lookupIndex);
  const original = prismaClient._state.rows.find((row) => row.id === historical.id);
  assert.equal(original.metadata.idempotency.state, 'refunded');
  assert.equal(
    original.metadata.idempotency.legacyRefundSource,
    'pre_idempotency',
  );
  const legacyCas = prismaClient._telemetry.queries.find(
    (query) => query.text.includes('credit-ledger:legacy-refund-cas'),
  );
  assert.ok(legacyCas);
  assert.match(legacyCas.text, /NOT.+metadata.+\?.+idempotency/is);
});

test('admin refund accepts a historically keyed SPEND without idempotency metadata once', async () => {
  const prismaClient = createRawPrisma({ balances: { 'user-1': 80n } });
  prismaClient._state.credits.get('user-1').lifetimeSpent = 20n;
  const historical = {
    id: 'keyed-pre-idempotency-spend-1',
    userId: 'user-1',
    orgId: null,
    type: 'SPEND',
    amount: -20n,
    balanceAfter: 80n,
    reason: 'historically keyed spend',
    metadata: {
      feature: 'image_generation',
      path: 'historical_paid_path',
    },
    idempotencyKey: 'legacy-client-key:unhashed:v0',
    createdAt: new Date('2025-12-02T00:00:00.000Z'),
  };
  prismaClient._state.rows.push(historical);

  const first = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: historical,
    reason: 'admin_keyed_historical_refund',
  });
  const replay = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: historical,
    reason: 'admin_keyed_historical_refund',
  });

  assert.equal(first.ok, true);
  assert.equal(first.winner, true);
  assert.equal(first.txn.idempotencyKey, deterministicRefundKey(historical));
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.txn.id, first.txn.id);
  assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
  assert.equal(prismaClient._state.rows.length, 2);
  const lookupIndex = prismaClient._telemetry.queries.findIndex(
    (query) => query.text.includes('credit-ledger:select-refund-by-original'),
  );
  const balanceIndex = prismaClient._telemetry.queries.findIndex(
    (query) => query.text.includes('credit-ledger:legacy-refund-balance'),
  );
  assert.ok(lookupIndex >= 0);
  assert.ok(balanceIndex > lookupIndex);
});

for (const {
  metadataField,
  historicalRefundKey,
} of [
  {
    metadataField: 'refundedTxnId',
    historicalRefundKey: 'legacy-refund-key:arbitrary-format',
  },
  {
    metadataField: 'transactionId',
    historicalRefundKey: null,
  },
]) {
  test(`historical REFUND metadata.${metadataField} replays twice without another credit`, async () => {
    const prismaClient = createRawPrisma({ balances: { 'user-1': 100n } });
    const spend = {
      id: `historical-spend-${metadataField}`,
      userId: 'user-1',
      orgId: null,
      type: 'SPEND',
      amount: -15n,
      balanceAfter: 85n,
      reason: 'historical spend already refunded',
      metadata: { feature: 'image_generation' },
      idempotencyKey: `historical-spend-key:${metadataField}`,
      createdAt: new Date('2025-11-01T00:00:00.000Z'),
    };
    const historicalRefund = {
      id: `historical-refund-${metadataField}`,
      userId: 'user-1',
      orgId: null,
      type: 'REFUND',
      amount: 15n,
      balanceAfter: 100n,
      reason: 'historical refund',
      metadata: {
        feature: 'image_generation',
        [metadataField]: spend.id,
      },
      idempotencyKey: historicalRefundKey,
      createdAt: new Date('2025-11-02T00:00:00.000Z'),
    };
    prismaClient._state.rows.push(spend, historicalRefund);

    const first = await refundLedgerTransaction({
      prismaClient,
      originalTransaction: spend,
      reason: 'must_replay_historical_refund',
    });
    const second = await refundLedgerTransaction({
      prismaClient,
      originalTransaction: spend,
      reason: 'must_replay_historical_refund',
    });

    assert.equal(first.ok, true);
    assert.equal(first.replay, true);
    assert.equal(first.winner, false);
    assert.equal(first.txn.id, historicalRefund.id);
    assert.equal(second.ok, true);
    assert.equal(second.replay, true);
    assert.equal(second.txn.id, historicalRefund.id);
    assert.equal(prismaClient._state.credits.get('user-1').balance, 100n);
    assert.equal(prismaClient._state.rows.length, 2);
    const lookups = prismaClient._telemetry.queries.filter(
      (query) => query.text.includes('credit-ledger:select-refund-by-original'),
    );
    assert.equal(lookups.length, 2);
    assert.match(lookups[0].text, /refundedTxnId.+OR.+transactionId/is);
    assert.deepEqual(lookups[0].values, ['user-1', spend.id, spend.id]);
    assert.equal(
      prismaClient._telemetry.queries.some(
        (query) => query.text.includes('credit-ledger:legacy-refund-balance'),
      ),
      false,
    );
    assert.equal(
      prismaClient._telemetry.queries.some(
        (query) => query.text.includes('credit-ledger:refund-balance'),
      ),
      false,
    );
  });
}

test('pre-idempotency refund rejects supplied transaction type or amount mismatch', async () => {
  for (const suppliedPatch of [
    { type: 'GRANT' },
    { amount: -99n },
  ]) {
    const prismaClient = createRawPrisma({ balances: { 'user-1': 90n } });
    const historical = {
      id: `strict-legacy-${suppliedPatch.type || 'amount'}`,
      userId: 'user-1',
      orgId: null,
      type: 'SPEND',
      amount: -10n,
      balanceAfter: 90n,
      reason: 'strict historical fixture',
      metadata: { feature: 'image_generation' },
      idempotencyKey: null,
      createdAt: new Date('2025-12-01T00:00:00.000Z'),
    };
    prismaClient._state.rows.push(historical);

    const result = await refundLedgerTransaction({
      prismaClient,
      originalTransaction: { ...historical, ...suppliedPatch },
      reason: 'must_reject_mismatched_fixture',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(prismaClient._state.credits.get('user-1').balance, 90n);
    assert.equal(prismaClient._state.rows.length, 1);
  }
});

test('legacy no-token refund CAS rejects non-completed historical rows', async () => {
  const prismaClient = createRawPrisma({ balances: { 'user-1': 90n } });
  const historical = {
    id: 'legacy-in-progress-1',
    userId: 'user-1',
    orgId: null,
    type: 'SPEND',
    amount: -10n,
    balanceAfter: 90n,
    reason: 'unfinished historical charge',
    metadata: {
      feature: 'image_generation',
      requestHash: 'legacy-in-progress-hash',
      requestedAmount: '10',
      path: 'paid',
      idempotency: { state: 'in_progress' },
    },
    idempotencyKey: hashIdempotencyKey('user-1', 'legacy-in-progress-key'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  };
  prismaClient._state.rows.push(historical);

  const result = await refundLedgerTransaction({
    prismaClient,
    originalTransaction: historical,
    reason: 'must_not_refund_unfenced_in_progress',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LEASE_LOST');
  assert.equal(prismaClient._state.credits.get('user-1').balance, 90n);
  assert.equal(prismaClient._state.rows.length, 1);
});
