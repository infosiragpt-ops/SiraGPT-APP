'use strict';

/**
 * Unit tests for services/email-verification.js (ratchet 45).
 *
 * Pure-JS fake prisma — no DB. Validates mint + redeem semantics:
 *   - token shape (64-hex)
 *   - expired tokens rejected
 *   - already-consumed tokens rejected
 *   - happy path sets emailVerifiedAt + consumedAt atomically
 *   - missing token / short token returns not_found
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  mintToken,
  createVerificationToken,
  redeemVerificationToken,
  DEFAULT_TTL_MS,
} = require('../src/services/email-verification');

function makeFakePrisma() {
  const state = {
    tokens: [], // { id, userId, token, expiresAt, consumedAt, createdAt }
    users: new Map(), // id → { id, emailVerifiedAt }
    txCalls: 0,
  };
  const tx = {
    user: {
      update: async ({ where, data }) => {
        const u = state.users.get(where.id) || { id: where.id };
        Object.assign(u, data);
        state.users.set(where.id, u);
        return u;
      },
    },
    emailVerificationToken: {
      update: async ({ where, data }) => {
        const r = state.tokens.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data);
        return r;
      },
    },
  };
  const prisma = {
    _state: state,
    emailVerificationToken: {
      create: async ({ data }) => {
        const row = {
          id: `t-${state.tokens.length + 1}`,
          consumedAt: null,
          createdAt: new Date(),
          ...data,
        };
        state.tokens.push(row);
        return row;
      },
      findUnique: async ({ where }) =>
        state.tokens.find((r) => r.token === where.token) || null,
    },
    user: {
      update: async ({ where, data }) => {
        const u = state.users.get(where.id) || { id: where.id };
        Object.assign(u, data);
        state.users.set(where.id, u);
        return u;
      },
    },
    $transaction: async (fn) => {
      state.txCalls += 1;
      return fn(tx);
    },
  };
  return prisma;
}

describe('email-verification · mintToken', () => {
  test('produces a 64-char hex string', () => {
    const t = mintToken();
    assert.equal(typeof t, 'string');
    assert.equal(t.length, 64);
    assert.match(t, /^[0-9a-f]{64}$/);
  });

  test('two consecutive tokens differ', () => {
    assert.notEqual(mintToken(), mintToken());
  });
});

describe('email-verification · createVerificationToken', () => {
  test('stores a row and returns token + expiresAt ~24h ahead', async () => {
    const prisma = makeFakePrisma();
    const before = Date.now();
    const { token, expiresAt } = await createVerificationToken(prisma, 'u-1');
    const after = Date.now();

    assert.equal(prisma._state.tokens.length, 1);
    const row = prisma._state.tokens[0];
    assert.equal(row.token, token);
    assert.equal(row.userId, 'u-1');
    assert.equal(row.consumedAt, null);

    const expMs = expiresAt.getTime();
    assert.ok(expMs >= before + DEFAULT_TTL_MS - 50);
    assert.ok(expMs <= after + DEFAULT_TTL_MS + 50);
  });

  test('throws when prisma lacks the model', async () => {
    await assert.rejects(
      () => createVerificationToken({}, 'u-1'),
      /emailVerificationToken model unavailable/,
    );
  });
});

describe('email-verification · redeemVerificationToken', () => {
  let prisma;
  beforeEach(() => { prisma = makeFakePrisma(); });

  test('happy path: sets emailVerifiedAt + consumes token in one tx', async () => {
    const { token } = await createVerificationToken(prisma, 'u-happy');
    const txBefore = prisma._state.txCalls;
    const result = await redeemVerificationToken(prisma, token);
    assert.deepEqual(result, { ok: true, userId: 'u-happy' });
    assert.equal(prisma._state.txCalls, txBefore + 1, 'one transaction used');

    const row = prisma._state.tokens[0];
    assert.ok(row.consumedAt instanceof Date);

    const user = prisma._state.users.get('u-happy');
    assert.ok(user.emailVerifiedAt instanceof Date);
  });

  test('unknown token → not_found', async () => {
    const result = await redeemVerificationToken(prisma, 'a'.repeat(64));
    assert.deepEqual(result, { ok: false, code: 'not_found' });
  });

  test('empty / short token → not_found, no DB lookup', async () => {
    assert.deepEqual(await redeemVerificationToken(prisma, ''), { ok: false, code: 'not_found' });
    assert.deepEqual(await redeemVerificationToken(prisma, 'short'), { ok: false, code: 'not_found' });
    assert.deepEqual(await redeemVerificationToken(prisma, null), { ok: false, code: 'not_found' });
  });

  test('expired token → expired (no side effects)', async () => {
    const { token } = await createVerificationToken(prisma, 'u-exp');
    // Force the row into the past.
    prisma._state.tokens[0].expiresAt = new Date(Date.now() - 1000);
    const result = await redeemVerificationToken(prisma, token);
    assert.deepEqual(result, { ok: false, code: 'expired' });
    assert.equal(prisma._state.tokens[0].consumedAt, null);
    assert.equal(prisma._state.users.get('u-exp'), undefined);
  });

  test('already-consumed token → already_used', async () => {
    const { token } = await createVerificationToken(prisma, 'u-used');
    prisma._state.tokens[0].consumedAt = new Date(Date.now() - 60_000);
    const result = await redeemVerificationToken(prisma, token);
    assert.deepEqual(result, { ok: false, code: 'already_used' });
  });

  test('redeem is single-use: second call returns already_used', async () => {
    const { token } = await createVerificationToken(prisma, 'u-twice');
    const first = await redeemVerificationToken(prisma, token);
    assert.equal(first.ok, true);
    const second = await redeemVerificationToken(prisma, token);
    assert.deepEqual(second, { ok: false, code: 'already_used' });
  });
});
