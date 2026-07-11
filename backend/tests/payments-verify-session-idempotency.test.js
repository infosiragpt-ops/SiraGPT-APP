'use strict';

// Regression — GET /payments/verify-session must grant plan credits at most
// once per payment, even when two verify calls (or a verify racing the
// checkout.session.completed webhook) both observe the payment as PENDING.
//
// The handler used to `prisma.payment.update(... COMPLETED ...)` unconditionally
// and then ADD credits, guarded only by a PENDING status it had read earlier in
// the request (non-atomic). Two requests that both read PENDING therefore each
// granted credits → double-grant (monthlyLimit += creditsForPlan twice). The
// fix claims the row with an atomic compare-and-set (status PENDING →
// COMPLETED) inside a $transaction and only the winner grants.
//
// To exercise the CAS deterministically the fake's payment.findFirst always
// reports PENDING (simulating the stale read both racers get), while the real
// row is flipped by the atomic updateMany. The second call's updateMany then
// matches zero rows and must skip the grant.

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { buildRouteTestApp, reloadModule, mockResolvedModule } = require('./http-test-utils');

const DB_PATH = require.resolve('../src/config/database');
const STRIPE_PATH = require.resolve('../src/services/stripe');

const JWT_SECRET = 'verify-session-idempotency-secret-at-least-32-chars';
process.env.JWT_SECRET = JWT_SECRET;

function makeFakePrisma({
  rows,
  user,
  forcePendingOnRead = true,
  subscriptionEvents = [],
}) {
  const userUpdates = [];
  const operations = [];
  const authUser = user;
  let txSequence = 0;

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, expected]) => {
      if (expected && typeof expected === 'object' && 'not' in expected) {
        return row[key] !== expected.not;
      }
      return row[key] === expected;
    });
  }

  function paymentModel(scope) {
    return {
      // Only the initial unlocked lookup is forced stale. Transactional
      // revalidation must observe the actual row after acquiring its lock.
      findFirst: async ({ where }) => {
        operations.push(`${scope}:payment.findFirst`);
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) return null;
        return scope === 'outside' && forcePendingOnRead
          ? { ...row, status: 'PENDING' }
          : { ...row };
      },
      updateMany: async ({ where, data }) => {
        operations.push(`${scope}:payment.updateMany`);
        let count = 0;
        for (const row of rows) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    };
  }

  function userModel(scope) {
    return {
      findUnique: async ({ where }) => {
        operations.push(`${scope}:user.findUnique`);
        return where.id === authUser.id ? { ...authUser } : null;
      },
      update: async ({ where, data }) => {
        operations.push(`${scope}:user.update`);
        assert.equal(where.id, authUser.id);
        userUpdates.push(data);
        Object.assign(authUser, data);
        return { ...authUser };
      },
    };
  }

  const db = {
    _userUpdates: userUpdates,
    _operations: operations,
    _rows: rows,
    session: {
      // authenticateToken loads the session with include: { user: true }.
      findUnique: async ({ where } = {}) => {
        if (!where || !where.token) return null;
        return {
          id: 'sess-1',
          token: where.token,
          userId: authUser.id,
          user: authUser,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        };
      },
    },
    payment: paymentModel('outside'),
    user: userModel('outside'),
    subscriptionEvent: {
      findMany: async ({ where = {} } = {}) => subscriptionEvents.filter((candidate) => {
        if (where.userId && candidate.userId !== where.userId) return false;
        if (
          where.stripeEventId?.not
          && candidate.stripeEventId === where.stripeEventId.not
        ) return false;
        if (
          Array.isArray(where.eventType?.in)
          && !where.eventType.in.includes(candidate.eventType)
        ) return false;
        return true;
      }).map((candidate) => ({ ...candidate, eventData: { ...candidate.eventData } })),
    },
  };
  db.$transaction = async (fn) => {
    const scope = `tx${++txSequence}`;
    const snapRows = rows.map((p) => ({ ...p }));
    const snapUser = { ...authUser };
    const tx = {
      ...db,
      payment: paymentModel(scope),
      user: userModel(scope),
      $queryRawUnsafe: async (sql, ...params) => {
        if (/FROM\s+"users"/iu.test(sql)) {
          operations.push(`${scope}:user.lock`);
          assert.equal(params[0], authUser.id);
          return [{ id: authUser.id }];
        }
        if (/FROM\s+"payments"/iu.test(sql)) {
          operations.push(`${scope}:payment.lock`);
          return [{ id: params[0] }];
        }
        throw new Error(`unexpected lock query: ${sql}`);
      },
    };
    operations.push(`${scope}:start`);
    try {
      const result = await fn(tx);
      operations.push(`${scope}:commit`);
      return result;
    } catch (err) {
      rows.splice(0, rows.length, ...snapRows);
      Object.keys(authUser).forEach((k) => delete authUser[k]);
      Object.assign(authUser, snapUser);
      operations.push(`${scope}:rollback`);
      throw err;
    }
  };
  return db;
}

describe('GET /payments/verify-session · credit grant idempotency', () => {
  let restoreDb;
  let restoreStripe;

  function setup({ rows, user, subscriptionEvents = [], checkoutSession = {} }) {
    const fake = makeFakePrisma({ rows, user, subscriptionEvents });
    restoreDb = mockResolvedModule(DB_PATH, fake);
    restoreStripe = mockResolvedModule(STRIPE_PATH, {
      retrieveCheckoutSession: async () => ({
        id: 'cs_1',
        payment_status: 'paid',
        customer: 'cus_1',
        subscription: 'sub_123',
        created: 800,
        metadata: { userId: user.id, plan: 'PRO' },
        customer_details: { email: user.email },
        ...checkoutSession,
      }),
      isStripeLikeError: () => false,
      demoAllowed: false,
      isConfigured: true,
    });
    delete require.cache[require.resolve('../src/routes/payments')];
    const app = buildRouteTestApp('/payments', reloadModule('../src/routes/payments'));
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    return { app, token, fake };
  }

  afterEach(() => {
    restoreDb && restoreDb();
    restoreStripe && restoreStripe();
    delete require.cache[require.resolve('../src/routes/payments')];
  });

  function verify(app, token) {
    return request(app)
      .get('/payments/verify-session')
      .query({ session_id: 'cs_1' })
      .set('Authorization', `Bearer ${token}`);
  }

  test('two PENDING-reading verify calls grant credits exactly once', async () => {
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      stripeCustomerId: 'cus_1',
      plan: 'FREE',
      monthlyLimit: 0n,
      gemaTokenLimit: 0n,
    };
    const rows = [{
      id: 'pay1',
      stripeSessionId: 'cs_1',
      stripeCustomerId: 'cus_1',
      userId: 'u1',
      plan: 'PRO',
      amount: 5,
      status: 'PENDING',
    }];
    const { app, token, fake } = setup({ rows, user });

    const first = await verify(app, token);
    assert.equal(first.status, 200);
    assert.equal(fake._userUpdates.length, 1, 'first verify grants once');
    const grantedLimit = user.monthlyLimit;
    assert.ok(grantedLimit > 0n, 'credits were added');
    assert.equal(rows[0].status, 'COMPLETED', 'row was claimed');

    // Second verify still sees PENDING at read time (forced) but the atomic
    // claim now matches zero rows → no second grant.
    const second = await verify(app, token);
    assert.equal(second.status, 200);
    assert.equal(fake._userUpdates.length, 1, 'second verify must NOT grant again');
    assert.equal(user.monthlyLimit, grantedLimit, 'monthlyLimit unchanged on the duplicate');
  });

  test('delayed verify after cancellation completes payment without restoring premium', async () => {
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      stripeCustomerId: 'cus_1',
      plan: 'FREE',
      monthlyLimit: 1_000n,
      monthlyCallLimit: 3,
      gemaTokenLimit: 10_000n,
      stripeSubscriptionId: 'sub_123',
      subscriptionStatus: 'canceled',
    };
    const rows = [{
      id: 'pay1',
      stripeSessionId: 'cs_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: null,
      userId: 'u1',
      plan: 'PRO',
      amount: 5,
      status: 'PENDING',
    }];
    const subscriptionEvents = [{
      id: 'se-canceled',
      userId: 'u1',
      eventType: 'canceled',
      stripeEventId: 'evt_canceled_after_checkout',
      eventData: {
        stripeEventType: 'customer.subscription.deleted',
        subscriptionId: 'sub_123',
        status: 'canceled',
        eventCreated: 900,
        processing: { disposition: 'applied', reason: null },
      },
    }];
    const { app, token, fake } = setup({ rows, user, subscriptionEvents });

    const response = await verify(app, token);

    assert.equal(response.status, 200);
    assert.equal(response.body.paymentStatus, 'COMPLETED');
    assert.equal(rows[0].status, 'COMPLETED');
    assert.equal(rows[0].stripeSubscriptionId, 'sub_123');
    assert.equal(fake._userUpdates.length, 0);
    assert.equal(user.plan, 'FREE');
    assert.equal(user.monthlyLimit, 1_000n);
    assert.equal(user.monthlyCallLimit, 3);
    assert.equal(user.gemaTokenLimit, 10_000n);
    assert.equal(user.subscriptionStatus, 'canceled');
  });

  test('legacy canceled user can verify a paid replacement subscription without event history', async () => {
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_legacy_canceled',
      subscriptionStatus: 'canceled',
      plan: 'FREE',
      monthlyLimit: 1_000n,
      monthlyCallLimit: 3,
      gemaTokenLimit: 0n,
    };
    const rows = [{
      id: 'pay1',
      stripeSessionId: 'cs_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: null,
      userId: 'u1',
      plan: 'PRO',
      amount: 5,
      status: 'PENDING',
    }];
    const { app, token, fake } = setup({
      rows,
      user,
      checkoutSession: { subscription: 'sub_replacement' },
    });

    const response = await verify(app, token);

    assert.equal(response.status, 200);
    assert.equal(response.body.paymentStatus, 'COMPLETED');
    assert.equal(rows[0].status, 'COMPLETED');
    assert.equal(rows[0].stripeSubscriptionId, 'sub_replacement');
    assert.equal(fake._userUpdates.length, 1);
    assert.equal(user.plan, 'PRO');
    assert.ok(user.monthlyLimit > 1_000n);
    assert.ok(user.gemaTokenLimit > 0n);
    assert.equal(user.stripeSubscriptionId, 'sub_replacement');
    assert.equal(user.subscriptionStatus, 'active');
  });

  test('verify-session rejects a Stripe customer that does not own the durable payment', async () => {
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      stripeCustomerId: 'cus_1',
      plan: 'FREE',
      monthlyLimit: 1_000n,
      gemaTokenLimit: 0n,
    };
    const rows = [{
      id: 'pay1',
      stripeSessionId: 'cs_1',
      stripeCustomerId: 'cus_1',
      userId: 'u1',
      plan: 'PRO',
      amount: 5,
      status: 'PENDING',
    }];
    const { app, token, fake } = setup({
      rows,
      user,
      checkoutSession: { customer: 'cus_other' },
    });

    const response = await verify(app, token);

    assert.equal(response.status, 200);
    assert.equal(response.body.paymentStatus, 'PENDING');
    assert.equal(rows[0].status, 'PENDING');
    assert.equal(fake._userUpdates.length, 0);
    assert.equal(user.plan, 'FREE');
    assert.equal(user.monthlyLimit, 1_000n);
  });

  test('verify-session rejects a retrieved session that does not match the payment session', async () => {
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      stripeCustomerId: 'cus_1',
      plan: 'FREE',
      monthlyLimit: 1_000n,
      gemaTokenLimit: 0n,
    };
    const rows = [{
      id: 'pay1',
      stripeSessionId: 'cs_1',
      stripeCustomerId: 'cus_1',
      userId: 'u1',
      plan: 'PRO',
      amount: 5,
      status: 'PENDING',
    }];
    const { app, token, fake } = setup({
      rows,
      user,
      checkoutSession: { id: 'cs_other' },
    });

    const response = await verify(app, token);

    assert.equal(response.status, 200);
    assert.equal(response.body.paymentStatus, 'PENDING');
    assert.equal(rows[0].status, 'PENDING');
    assert.equal(fake._userUpdates.length, 0);
    assert.equal(user.plan, 'FREE');
  });

  test('verify-session rejects a subscription that conflicts with the durable payment identity', async () => {
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      stripeCustomerId: 'cus_1',
      plan: 'FREE',
      monthlyLimit: 1_000n,
      gemaTokenLimit: 0n,
    };
    const rows = [{
      id: 'pay1',
      stripeSessionId: 'cs_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_payment_bound',
      userId: 'u1',
      plan: 'PRO',
      amount: 5,
      status: 'PENDING',
    }];
    const { app, token, fake } = setup({
      rows,
      user,
      checkoutSession: { subscription: 'sub_other' },
    });

    const response = await verify(app, token);

    assert.equal(response.status, 200);
    assert.equal(response.body.paymentStatus, 'PENDING');
    assert.equal(rows[0].status, 'PENDING');
    assert.equal(rows[0].stripeSubscriptionId, 'sub_payment_bound');
    assert.equal(fake._userUpdates.length, 0);
    assert.equal(user.plan, 'FREE');
  });

  test('concurrent verifies lock and revalidate user before payment in every transaction', async () => {
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      stripeCustomerId: 'cus_1',
      plan: 'FREE',
      monthlyLimit: 0n,
      gemaTokenLimit: 0n,
    };
    const rows = [{
      id: 'pay1',
      stripeSessionId: 'cs_1',
      stripeCustomerId: 'cus_1',
      userId: 'u1',
      plan: 'PRO',
      amount: 5,
      status: 'PENDING',
    }];
    const { app, token, fake } = setup({ rows, user });

    const responses = await Promise.all([
      verify(app, token),
      verify(app, token),
    ]);

    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(fake._userUpdates.length, 1);
    for (const scope of ['tx1', 'tx2']) {
      const start = fake._operations.indexOf(`${scope}:start`);
      const userLock = fake._operations.indexOf(`${scope}:user.lock`);
      const userRead = fake._operations.indexOf(`${scope}:user.findUnique`);
      const paymentLock = fake._operations.indexOf(`${scope}:payment.lock`);
      const paymentRead = fake._operations.indexOf(`${scope}:payment.findFirst`);
      assert.ok(start >= 0, `${scope} started`);
      assert.ok(
        start < userLock
          && userLock < userRead
          && userRead < paymentLock
          && paymentLock < paymentRead,
        `${scope} must lock/revalidate user before locking/revalidating payment`,
      );
      const paymentWrite = fake._operations.indexOf(`${scope}:payment.updateMany`);
      if (paymentWrite >= 0) assert.ok(paymentRead < paymentWrite);
    }
  });
});
