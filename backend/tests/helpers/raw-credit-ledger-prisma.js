'use strict';

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

function createRawCreditPrisma({
  balances = { 'user-1': 100n, u1: 100n },
  failInsert = false,
  failRefund = false,
} = {}) {
  const initialBalances = Object.fromEntries(
    Object.entries(balances).map(([userId, balance]) => [userId, BigInt(balance)]),
  );
  const state = {
    credits: new Map(),
    rows: [],
  };
  const telemetry = {
    transactionCalls: 0,
    rootRawCalls: 0,
    txRawCalls: 0,
    queries: [],
  };
  let queue = Promise.resolve();
  let refundFailureEnabled = failRefund;

  function reset() {
    state.credits = new Map(
      Object.entries(initialBalances).map(([userId, balance]) => [
        userId,
        {
          id: `balance-${userId}`,
          userId,
          orgId: null,
          balance,
          reservedBalance: 0n,
          lifetimeGranted: 0n,
          lifetimeSpent: 0n,
          lastRefillAt: null,
          nextRefillAt: null,
          createdAt: new Date('2026-07-10T00:00:00.000Z'),
          updatedAt: new Date('2026-07-10T00:00:00.000Z'),
        },
      ]),
    );
    state.rows = [];
    telemetry.transactionCalls = 0;
    telemetry.rootRawCalls = 0;
    telemetry.txRawCalls = 0;
    telemetry.queries = [];
    queue = Promise.resolve();
    refundFailureEnabled = failRefund;
  }

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
          return [{
            used: working.rows.filter((row) => (
              row.userId === userId
              && row.metadata?.path === 'free_ia'
              && row.createdAt >= start
              && row.createdAt < end
            )).length,
          }];
        }
        if (text.includes('credit-ledger:read-balance')) {
          const credit = working.credits.get(values[0]);
          return credit
            ? [{ balance: credit.balance, orgId: credit.orgId }]
            : [];
        }
        if (text.includes('credit-ledger:ensure-credit-row')) {
          const [id, userId, createdAt, updatedAt] = values;
          let credit = working.credits.get(userId);
          if (!credit) {
            credit = {
              id,
              userId,
              orgId: null,
              balance: 0n,
              reservedBalance: 0n,
              lifetimeGranted: 0n,
              lifetimeSpent: 0n,
              lastRefillAt: null,
              nextRefillAt: null,
              createdAt,
              updatedAt,
            };
            working.credits.set(userId, credit);
          }
          return [credit];
        }
        if (text.includes('credit-ledger:get-credit-row')) {
          const credit = working.credits.get(values[0]);
          return credit ? [credit] : [];
        }
        if (text.includes('credit-ledger:credit-balance-increment')) {
          const [amountValue, grantedValue, refundedValue, userId] = values;
          const credit = working.credits.get(userId);
          if (!credit) return [];
          credit.balance += BigInt(amountValue);
          credit.lifetimeGranted += BigInt(grantedValue);
          const refunded = BigInt(refundedValue);
          credit.lifetimeSpent = credit.lifetimeSpent > refunded
            ? credit.lifetimeSpent - refunded
            : 0n;
          return [{ balance: credit.balance, orgId: credit.orgId }];
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
          if (refundFailureEnabled) throw new Error('simulated refund balance failure');
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
          if (refundFailureEnabled) throw new Error('simulated refund balance failure');
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
      throw new Error('ledger raw SQL must use an interactive transaction');
    },
    $transaction(callback) {
      const run = queue.then(async () => {
        telemetry.transactionCalls += 1;
        const working = cloneState(state);
        const result = await callback(buildTx(working));
        state.credits = working.credits;
        state.rows = working.rows;
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
    setBalance(userId, value) {
      const existing = state.credits.get(userId) || {
        userId,
        orgId: null,
        lifetimeSpent: 0n,
      };
      existing.balance = BigInt(value);
      state.credits.set(userId, existing);
    },
    setRefundFailure(value) {
      refundFailureEnabled = Boolean(value);
    },
    reset,
    _state: state,
    _telemetry: telemetry,
  };
  reset();
  return prisma;
}

module.exports = {
  createRawCreditPrisma,
  sqlText,
};
