'use strict';

// Regression — GET /payments/verify-session must grant plan credits at most
// once per payment, even when two verify calls (or a verify racing the
// checkout.session.completed webhook) both observe the payment as PENDING.
//
// The handler used to `prisma.payment.update(... COMPLETED ...)` unconditionally
// and then ADD credits, guarded only by a PENDING status it had read earlier in
// the request (non-atomic). Two requests that both read PENDING therefore each
// granted credits → double-grant (monthlyLimit += creditsForPlan twice). The
// fix claims the row with an atomic compare-and-set (status != COMPLETED →
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

function makeFakePrisma({ rows, user, forcePendingOnRead = true }) {
  const userUpdates = [];
  const authUser = user;
  const db = {
    _userUpdates: userUpdates,
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
    payment: {
      // The verify handler reads the payment up-front (non-transactional). Both
      // racers see PENDING here — that's the whole point of the bug.
      findFirst: async ({ where }) => {
        const r = rows.find((p) => p.stripeSessionId === where.stripeSessionId && p.userId === where.userId);
        if (!r) return null;
        return forcePendingOnRead ? { ...r, status: 'PENDING' } : { ...r };
      },
      // Atomic compare-and-set on the real rows.
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const p of rows) {
          if (p.id !== where.id) continue;
          if (where.status && where.status.not !== undefined && p.status === where.status.not) continue;
          Object.assign(p, data);
          count += 1;
        }
        return { count };
      },
    },
    user: {
      findUnique: async ({ where }) => (where.id === authUser.id ? { ...authUser } : null),
      update: async ({ where, data }) => {
        assert.equal(where.id, authUser.id);
        userUpdates.push(data);
        Object.assign(authUser, data);
        return { ...authUser };
      },
    },
  };
  db.$transaction = async (fn) => {
    const snapRows = rows.map((p) => ({ ...p }));
    const snapUser = { ...authUser };
    try {
      return await fn(db);
    } catch (err) {
      rows.splice(0, rows.length, ...snapRows);
      Object.keys(authUser).forEach((k) => delete authUser[k]);
      Object.assign(authUser, snapUser);
      throw err;
    }
  };
  return db;
}

describe('GET /payments/verify-session · credit grant idempotency', () => {
  let restoreDb;
  let restoreStripe;

  function setup({ rows, user }) {
    const fake = makeFakePrisma({ rows, user });
    restoreDb = mockResolvedModule(DB_PATH, fake);
    restoreStripe = mockResolvedModule(STRIPE_PATH, {
      retrieveCheckoutSession: async () => ({
        payment_status: 'paid',
        subscription: 'sub_123',
        customer_details: { email: user.email },
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
    const user = { id: 'u1', email: 'u1@example.com', plan: 'FREE', monthlyLimit: 0n, gemaTokenLimit: 0n };
    const rows = [{ id: 'pay1', stripeSessionId: 'cs_1', userId: 'u1', plan: 'PRO', amount: 5, status: 'PENDING' }];
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
});
