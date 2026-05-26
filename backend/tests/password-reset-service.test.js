'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mintToken,
  ttlMs,
  createPasswordResetToken,
  validatePasswordResetToken,
  consumePasswordResetToken,
  DEFAULT_TTL_MS,
} = require('../src/services/password-reset');

function makeFakePrisma() {
  const tokens = new Map();
  const users = new Map();
  const audit = { tx: 0 };
  return {
    _tokens: tokens,
    _users: users,
    _audit: audit,
    passwordResetToken: {
      async create({ data }) {
        const id = `t_${tokens.size + 1}`;
        const row = { id, consumedAt: null, ...data };
        tokens.set(data.token, row);
        return row;
      },
      async findUnique({ where: { token, id } }) {
        if (token !== undefined) return tokens.get(token) || null;
        for (const r of tokens.values()) if (r.id === id) return r;
        return null;
      },
      async update({ where: { id }, data }) {
        for (const r of tokens.values()) {
          if (r.id === id) {
            Object.assign(r, data);
            return r;
          }
        }
        throw new Error('not found');
      },
    },
    user: {
      async update({ where: { id }, data }) {
        const u = users.get(id) || { id };
        Object.assign(u, data);
        users.set(id, u);
        return u;
      },
    },
    async $transaction(fn) {
      audit.tx += 1;
      // Pass the same client to mimic Prisma's interactive tx
      return fn(this);
    },
  };
}

test('mintToken returns a 64-character hex string', () => {
  const t = mintToken();
  assert.equal(typeof t, 'string');
  assert.equal(t.length, 64);
  assert.match(t, /^[0-9a-f]+$/);
  // Repeated calls produce distinct tokens.
  assert.notEqual(mintToken(), mintToken());
});

test('ttlMs returns default when env unset', () => {
  const prev = process.env.PASSWORD_RESET_TTL_MS;
  delete process.env.PASSWORD_RESET_TTL_MS;
  try {
    assert.equal(ttlMs(), DEFAULT_TTL_MS);
  } finally {
    if (prev !== undefined) process.env.PASSWORD_RESET_TTL_MS = prev;
  }
});

test('ttlMs honours env override', () => {
  const prev = process.env.PASSWORD_RESET_TTL_MS;
  process.env.PASSWORD_RESET_TTL_MS = '900000';
  try {
    assert.equal(ttlMs(), 900_000);
  } finally {
    if (prev === undefined) delete process.env.PASSWORD_RESET_TTL_MS;
    else process.env.PASSWORD_RESET_TTL_MS = prev;
  }
});

test('createPasswordResetToken throws without prisma model', async () => {
  await assert.rejects(
    () => createPasswordResetToken({}, 'u1'),
    /passwordResetToken model unavailable/,
  );
});

test('createPasswordResetToken rejects empty userId', async () => {
  const prisma = makeFakePrisma();
  await assert.rejects(
    () => createPasswordResetToken(prisma, ''),
    /userId required/,
  );
});

test('createPasswordResetToken persists row with expiry', async () => {
  const prisma = makeFakePrisma();
  const result = await createPasswordResetToken(prisma, 'user-1', { requestedFromIp: '1.2.3.4' });
  assert.equal(typeof result.token, 'string');
  assert.ok(result.expiresAt instanceof Date);
  assert.ok(result.expiresAt.getTime() > Date.now());
  const stored = prisma._tokens.get(result.token);
  assert.equal(stored.userId, 'user-1');
  assert.equal(stored.requestedFromIp, '1.2.3.4');
});

test('validatePasswordResetToken returns not_found for unknown token', async () => {
  const prisma = makeFakePrisma();
  const r = await validatePasswordResetToken(prisma, 'a'.repeat(64));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

test('validatePasswordResetToken returns not_found for short token', async () => {
  const prisma = makeFakePrisma();
  const r = await validatePasswordResetToken(prisma, 'short');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

test('validatePasswordResetToken returns expired for past-due token', async () => {
  const prisma = makeFakePrisma();
  const token = mintToken();
  prisma._tokens.set(token, {
    id: 't1',
    userId: 'u1',
    token,
    expiresAt: new Date(Date.now() - 1000),
    consumedAt: null,
  });
  const r = await validatePasswordResetToken(prisma, token);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'expired');
});

test('validatePasswordResetToken returns already_used when consumed', async () => {
  const prisma = makeFakePrisma();
  const token = mintToken();
  prisma._tokens.set(token, {
    id: 't1',
    userId: 'u1',
    token,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: new Date(),
  });
  const r = await validatePasswordResetToken(prisma, token);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'already_used');
});

test('validatePasswordResetToken returns ok for valid token', async () => {
  const prisma = makeFakePrisma();
  const { token } = await createPasswordResetToken(prisma, 'u-42');
  const r = await validatePasswordResetToken(prisma, token);
  assert.equal(r.ok, true);
  assert.equal(r.userId, 'u-42');
});

test('consumePasswordResetToken updates password and marks token consumed', async () => {
  const prisma = makeFakePrisma();
  const { token } = await createPasswordResetToken(prisma, 'u-7');
  const r = await consumePasswordResetToken(prisma, token, { newPasswordHash: '$2a$12$fakehash' });
  assert.equal(r.ok, true);
  assert.equal(r.userId, 'u-7');
  assert.equal(prisma._users.get('u-7').password, '$2a$12$fakehash');
  assert.ok(prisma._tokens.get(token).consumedAt instanceof Date);
  assert.equal(prisma._audit.tx, 1);
});

test('consumePasswordResetToken rejects when token is invalid', async () => {
  const prisma = makeFakePrisma();
  const r = await consumePasswordResetToken(prisma, 'a'.repeat(64), { newPasswordHash: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

test('consumePasswordResetToken requires newPasswordHash', async () => {
  const prisma = makeFakePrisma();
  const { token } = await createPasswordResetToken(prisma, 'u-9');
  await assert.rejects(
    () => consumePasswordResetToken(prisma, token, {}),
    /newPasswordHash required/,
  );
});

test('consumePasswordResetToken second redemption returns already_used', async () => {
  const prisma = makeFakePrisma();
  const { token } = await createPasswordResetToken(prisma, 'u-3');
  await consumePasswordResetToken(prisma, token, { newPasswordHash: 'h1' });
  const r2 = await consumePasswordResetToken(prisma, token, { newPasswordHash: 'h2' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'already_used');
});
