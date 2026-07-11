'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { computeFingerprint } = require('../src/utils/session-fingerprint');
const {
  ActiveSessionValidationError,
  createActiveSessionRevalidator,
  validateActiveSession,
} = require('../src/services/active-session-validator');
const backendPackage = require('../package.json');

const SECRET = 'active-session-validator-test-secret-at-least-32-chars';
const NOW = new Date('2026-07-11T09:00:00.000Z');

test('canonical backend suite registers every active-session auth contract', () => {
  for (const file of [
    'tests/active-session-validator.test.js',
    'tests/auth-revocation-distributed.test.js',
    'tests/auth-user-transaction.test.js',
    'tests/auth-deletion-revocation.test.js',
    'tests/auth-sessions-revoke-all.test.js',
    'tests/appshots-sessions.test.js',
    'tests/auth-optional-middleware.test.js',
    'tests/auth-2fa-sms.test.js',
    'tests/session-repository.test.js',
    'tests/partial-session-repository.test.js',
    'tests/session-service.test.js',
    'tests/login-service.test.js',
    'tests/auth-api-key.test.js',
  ]) {
    assert.match(backendPackage.scripts.test, new RegExp(file.replace(/\./g, '\\.')));
  }
});

test('socket revalidator coalesces and caches bounded successful checks but force bypasses cache', async () => {
  assert.equal(typeof createActiveSessionRevalidator, 'function');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const revalidator = createActiveSessionRevalidator({
    validateSession: async () => {
      calls += 1;
      await gate;
      return {
        userId: 'active-user',
        user: { id: 'active-user', deletedAt: null },
        session: { id: 'active-session' },
      };
    },
    ttlMs: 5_000,
    timeoutMs: 250,
  });
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

  const first = revalidator.validate({ token: 'signed-token', request });
  const second = revalidator.validate({ token: 'signed-token', request });
  release();
  await Promise.all([first, second]);
  await revalidator.validate({ token: 'signed-token', request });
  assert.equal(calls, 1);

  await revalidator.validate({ token: 'signed-token', request }, { force: true });
  assert.equal(calls, 2);
});

test('socket revalidator does not repopulate cache from a check invalidated in flight', async () => {
  let calls = 0;
  let releaseFirst;
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const revalidator = createActiveSessionRevalidator({
    validateSession: async () => {
      calls += 1;
      if (calls === 1) {
        enteredFirst();
        await firstGate;
      }
      return {
        userId: 'revoked-during-check',
        user: { id: 'revoked-during-check', deletedAt: null },
        session: { id: 'stale-session' },
      };
    },
    ttlMs: 5_000,
    timeoutMs: 250,
  });
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

  const staleCheck = revalidator.validate({ token: 'stale-token', request });
  await firstEntered;
  revalidator.invalidateUser('revoked-during-check');
  releaseFirst();
  await staleCheck;
  await revalidator.validate({ token: 'stale-token', request });

  assert.equal(calls, 2);
});

function requestFor(ip = '203.0.113.42', userAgent = 'SiraGPT Test/1.0') {
  return {
    headers: {
      'x-forwarded-for': ip,
      'user-agent': userAgent,
    },
    socket: { remoteAddress: ip },
  };
}

function makeHarness({
  deletedAt = null,
  sessionPresent = true,
  sessionExpiresAt = new Date(NOW.getTime() + 60_000),
  tokenUserId = 'user-1',
  sessionUserId = 'user-1',
  fingerprintRequest = requestFor(),
} = {}) {
  const token = jwt.sign(
    { userId: tokenUserId, orgId: 'org-1' },
    SECRET,
    { expiresIn: '1h' },
  );
  const session = sessionPresent
    ? {
        id: 'session-1',
        token,
        userId: sessionUserId,
        expiresAt: sessionExpiresAt,
        fingerprint: computeFingerprint(fingerprintRequest),
        user: {
          id: sessionUserId,
          email: 'active@example.test',
          deletedAt,
        },
      }
    : null;
  const deletes = [];
  const prisma = {
    session: {
      async findUnique(args) {
        assert.deepEqual(args, {
          where: { token },
          include: { user: true },
        });
        return session;
      },
      async deleteMany(args) {
        deletes.push(args.where);
        return { count: 1 };
      },
    },
  };
  return { token, session, prisma, deletes };
}

test('validateActiveSession accepts a signed, persisted, nonexpired active-user session', async () => {
  const request = requestFor();
  const harness = makeHarness({ fingerprintRequest: request });

  const result = await validateActiveSession({
    token: harness.token,
    request,
    prismaClient: harness.prisma,
    jwtSecret: SECRET,
    now: NOW,
  });

  assert.equal(result.user.id, 'user-1');
  assert.equal(result.session.id, 'session-1');
  assert.equal(result.decoded.orgId, 'org-1');
  assert.deepEqual(harness.deletes, []);
});

test('validateActiveSession rejects a JWT whose persisted session was revoked', async () => {
  const harness = makeHarness({ sessionPresent: false });

  await assert.rejects(
    validateActiveSession({
      token: harness.token,
      request: requestFor(),
      prismaClient: harness.prisma,
      jwtSecret: SECRET,
      now: NOW,
    }),
    (error) => error instanceof ActiveSessionValidationError
      && error.code === 'session_not_found',
  );
});

test('validateActiveSession rejects a user deleted after JWT issuance and revokes the session family', async () => {
  const harness = makeHarness({ deletedAt: new Date('2026-07-11T08:59:00.000Z') });

  await assert.rejects(
    validateActiveSession({
      token: harness.token,
      request: requestFor(),
      prismaClient: harness.prisma,
      jwtSecret: SECRET,
      now: NOW,
    }),
    (error) => error instanceof ActiveSessionValidationError
      && error.code === 'account_inactive',
  );
  assert.deepEqual(harness.deletes, [{ userId: 'user-1' }]);
});

test('validateActiveSession rejects and deletes an expired persisted session', async () => {
  const harness = makeHarness({
    sessionExpiresAt: new Date(NOW.getTime() - 1),
  });

  await assert.rejects(
    validateActiveSession({
      token: harness.token,
      request: requestFor(),
      prismaClient: harness.prisma,
      jwtSecret: SECRET,
      now: NOW,
    }),
    (error) => error instanceof ActiveSessionValidationError
      && error.code === 'session_expired',
  );
  assert.deepEqual(harness.deletes, [{ token: harness.token }]);
});

test('validateActiveSession rejects subject mismatch instead of trusting JWT claims', async () => {
  const harness = makeHarness({
    tokenUserId: 'attacker-claimed-user',
    sessionUserId: 'persisted-user',
  });

  await assert.rejects(
    validateActiveSession({
      token: harness.token,
      request: requestFor(),
      prismaClient: harness.prisma,
      jwtSecret: SECRET,
      now: NOW,
    }),
    (error) => error instanceof ActiveSessionValidationError
      && error.code === 'session_subject_mismatch',
  );
  assert.deepEqual(harness.deletes, [{ token: harness.token }]);
});

test('validateActiveSession enforces stored fingerprint when request context is available', async () => {
  const harness = makeHarness({
    fingerprintRequest: requestFor('203.0.113.42', 'Original Browser'),
  });

  await assert.rejects(
    validateActiveSession({
      token: harness.token,
      request: requestFor('198.51.100.8', 'Different Browser'),
      prismaClient: harness.prisma,
      jwtSecret: SECRET,
      now: NOW,
    }),
    (error) => error instanceof ActiveSessionValidationError
      && error.code === 'fingerprint_mismatch',
  );
  assert.deepEqual(harness.deletes, [{ token: harness.token }]);
});

test('validateActiveSession rejects a token with an invalid signature before database lookup', async () => {
  let lookups = 0;
  const prisma = {
    session: {
      async findUnique() {
        lookups += 1;
        return null;
      },
    },
  };
  const token = jwt.sign({ userId: 'user-1' }, 'a-different-secret-at-least-32-characters');

  await assert.rejects(
    validateActiveSession({
      token,
      request: requestFor(),
      prismaClient: prisma,
      jwtSecret: SECRET,
      now: NOW,
    }),
    (error) => error instanceof ActiveSessionValidationError
      && error.code === 'invalid_token',
  );
  assert.equal(lookups, 0);
});
