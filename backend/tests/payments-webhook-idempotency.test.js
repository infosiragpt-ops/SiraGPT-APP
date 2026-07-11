'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const request = require('supertest');

const {
  buildRouteTestApp,
  reloadModule,
  mockResolvedModule,
} = require('./http-test-utils');

const DB_PATH = require.resolve('../src/config/database');
const STRIPE_PATH = require.resolve('../src/services/stripe');
const POSTHOG_PATH = require.resolve('../src/services/observability/posthog');
const USAGE_MONITOR_PATH = require.resolve('../src/services/usage-monitor');
const TRIGGERS_PATH = require.resolve('../src/services/trigger-registry');
const EMAIL_PATH = require.resolve('../src/services/email');
const EMAIL_PREFS_PATH = require.resolve('../src/services/email-preferences');

function clone(value) {
  return structuredClone(value);
}

function replaceArray(target, source) {
  target.splice(0, target.length, ...clone(source));
}

function prismaUniqueError(target = ['stripeEventId']) {
  const error = new Error('Unique constraint failed');
  error.code = 'P2002';
  error.meta = { target };
  return error;
}

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('not' in expected) return row[key] !== expected.not;
      if ('in' in expected) return expected.in.includes(row[key]);
      if ('equals' in expected) return isDeepStrictEqual(row[key], expected.equals);
    }
    return row[key] === expected;
  });
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'increment' in value) {
      row[key] = BigInt(row[key] ?? 0) + BigInt(value.increment);
    } else {
      row[key] = value;
    }
  }
}

function makeFakePrisma({
  user,
  payments = [],
  invoices = [],
  usageAlerts = [],
  subscriptionEvents = [],
  systemSettings = [],
  failUserUpdateTimes = 0,
  failNotificationTimes = 0,
  synchronizeEventPrechecks = false,
  simulateConcurrentFkDeadlock = false,
} = {}) {
  const state = {
    users: user ? [clone(user)] : [],
    payments: clone(payments),
    usageAlerts: clone(usageAlerts),
    subscriptionEvents: clone(subscriptionEvents),
    notifications: [],
    invoices: clone(invoices),
    systemSettings: clone(systemSettings),
  };
  const operations = [];
  const attempts = {
    userUpdates: 0,
    paymentUpdates: 0,
    usageAlertDeletes: 0,
    notificationCreates: 0,
    invoiceUpserts: 0,
  };
  const captures = {
    usageAlertDeleteWhere: null,
    subscriptionEventCreates: [],
  };
  let userFailuresLeft = failUserUpdateTimes;
  let notificationFailuresLeft = failNotificationTimes;
  let inTransaction = false;
  let transactionTail = Promise.resolve();
  let eventPrecheckCount = 0;
  const eventPrecheckWaiters = [];
  let userLockedInTransaction = false;

  function snapshot() {
    return clone(state);
  }

  function restore(saved) {
    replaceArray(state.users, saved.users);
    replaceArray(state.payments, saved.payments);
    replaceArray(state.usageAlerts, saved.usageAlerts);
    replaceArray(state.subscriptionEvents, saved.subscriptionEvents);
    replaceArray(state.notifications, saved.notifications);
    replaceArray(state.invoices, saved.invoices);
    replaceArray(state.systemSettings, saved.systemSettings);
  }

  const db = {
    _state: state,
    _operations: operations,
    _attempts: attempts,
    _captures: captures,
    user: {
      findUnique: async ({ where }) => {
        operations.push(`user.findUnique:${inTransaction ? 'inside' : 'outside'}`);
        const row = state.users.find((candidate) => (
          (where.id && candidate.id === where.id)
          || (where.stripeCustomerId && candidate.stripeCustomerId === where.stripeCustomerId)
        ));
        return row ? clone(row) : null;
      },
      update: async ({ where, data }) => {
        operations.push('user.update');
        attempts.userUpdates += 1;
        if (userFailuresLeft > 0) {
          userFailuresLeft -= 1;
          throw new Error('simulated user.update failure');
        }
        const row = state.users.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('user not found');
        applyData(row, data);
        return clone(row);
      },
    },
    payment: {
      findFirst: async ({ where, select } = {}) => {
        operations.push(`payment.findFirst:${inTransaction ? 'inside' : 'outside'}`);
        const row = state.payments.find((candidate) => matchesWhere(candidate, where));
        if (!row) return null;
        if (!select) return clone(row);
        return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
      },
      updateMany: async ({ where, data }) => {
        operations.push('payment.updateMany');
        attempts.paymentUpdates += 1;
        let count = 0;
        for (const row of state.payments) {
          if (!matchesWhere(row, where)) continue;
          applyData(row, data);
          count += 1;
        }
        return { count };
      },
    },
    subscriptionEvent: {
      create: async ({ data }) => {
        operations.push('subscriptionEvent.create');
        if (simulateConcurrentFkDeadlock && inTransaction && !userLockedInTransaction) {
          const error = new Error(
            'simulated deadlock: SubscriptionEvent FK key-share preceded the user row lock',
          );
          error.code = '40P01';
          throw error;
        }
        captures.subscriptionEventCreates.push(clone(data));
        if (data.stripeEventId && state.subscriptionEvents.some((row) => row.stripeEventId === data.stripeEventId)) {
          throw prismaUniqueError();
        }
        const row = { id: `se_${state.subscriptionEvents.length + 1}`, ...clone(data) };
        state.subscriptionEvents.push(row);
        return clone(row);
      },
      findUnique: async ({ where }) => {
        operations.push('subscriptionEvent.findUnique');
        if (
          synchronizeEventPrechecks
          && !inTransaction
          && where.stripeEventId
          && state.subscriptionEvents.length === 0
          && eventPrecheckCount < 2
        ) {
          eventPrecheckCount += 1;
          if (eventPrecheckCount === 1) {
            return new Promise((resolve) => {
              eventPrecheckWaiters.push(() => resolve(null));
            });
          }
          for (const release of eventPrecheckWaiters.splice(0)) release();
          return null;
        }
        const row = state.subscriptionEvents.find((candidate) => (
          (where.stripeEventId && candidate.stripeEventId === where.stripeEventId)
          || (where.id && candidate.id === where.id)
        ));
        return row ? clone(row) : null;
      },
      findMany: async ({ where = {} } = {}) => {
        operations.push('subscriptionEvent.findMany');
        return clone(state.subscriptionEvents.filter((candidate) => matchesWhere(candidate, where)));
      },
      update: async ({ where, data }) => {
        operations.push('subscriptionEvent.update');
        const row = state.subscriptionEvents.find((candidate) => (
          (where.id && candidate.id === where.id)
          || (where.stripeEventId && candidate.stripeEventId === where.stripeEventId)
        ));
        if (!row) throw new Error('subscription event not found');
        applyData(row, data);
        return clone(row);
      },
      updateMany: async ({ where = {}, data }) => {
        operations.push('subscriptionEvent.updateMany');
        let count = 0;
        for (const row of state.subscriptionEvents) {
          if (!matchesWhere(row, where)) continue;
          applyData(row, data);
          count += 1;
        }
        return { count };
      },
    },
    notification: {
      create: async ({ data }) => {
        operations.push('notification.create');
        attempts.notificationCreates += 1;
        if (notificationFailuresLeft > 0) {
          notificationFailuresLeft -= 1;
          throw new Error('simulated notification.create failure');
        }
        const row = { id: `notification_${state.notifications.length + 1}`, ...clone(data) };
        state.notifications.push(row);
        return clone(row);
      },
    },
    invoice: {
      findUnique: async ({ where }) => {
        operations.push('invoice.findUnique');
        const row = state.invoices.find(
          (candidate) => candidate.stripeInvoiceId === where.stripeInvoiceId,
        );
        return row ? clone(row) : null;
      },
      upsert: async ({ where, create, update }) => {
        operations.push('invoice.upsert');
        attempts.invoiceUpserts += 1;
        let row = state.invoices.find((candidate) => candidate.stripeInvoiceId === where.stripeInvoiceId);
        if (row) {
          applyData(row, update);
        } else {
          row = { id: `invoice_${state.invoices.length + 1}`, ...clone(create) };
          state.invoices.push(row);
        }
        return clone(row);
      },
    },
    usageAlert: {
      deleteMany: async ({ where }) => {
        operations.push('usageAlert.deleteMany');
        attempts.usageAlertDeletes += 1;
        captures.usageAlertDeleteWhere = clone(where);
        const before = state.usageAlerts.length;
        const retained = state.usageAlerts.filter((row) => row.userId !== where.userId);
        replaceArray(state.usageAlerts, retained);
        return { count: before - retained.length };
      },
    },
    systemSettings: {
      findUnique: async ({ where }) => {
        operations.push('systemSettings.findUnique');
        const row = state.systemSettings.find((candidate) => candidate.key === where.key);
        return row ? clone(row) : null;
      },
      upsert: async ({ where, create, update }) => {
        operations.push('systemSettings.upsert');
        let row = state.systemSettings.find((candidate) => candidate.key === where.key);
        if (row) applyData(row, update);
        else {
          row = { id: `setting_${state.systemSettings.length + 1}`, ...clone(create) };
          state.systemSettings.push(row);
        }
        return clone(row);
      },
      deleteMany: async ({ where }) => {
        operations.push('systemSettings.deleteMany');
        const before = state.systemSettings.length;
        replaceArray(
          state.systemSettings,
          state.systemSettings.filter((candidate) => !matchesWhere(candidate, where)),
        );
        return { count: before - state.systemSettings.length };
      },
    },
    $queryRawUnsafe: async (sql, ...params) => {
      if (/INSERT\s+INTO\s+"invoices"/iu.test(sql)) {
        operations.push('invoice.atomicUpsert');
        attempts.invoiceUpserts += 1;
        const [
          id,
          userId,
          stripeInvoiceId,
          stripeCustomerId,
          stripeSubscriptionId,
          number,
          status,
          amountDueCents,
          amountPaidCents,
          amountRemainingCents,
          subtotalCents,
          totalCents,
          currency,
          periodStart,
          periodEnd,
          hostedInvoiceUrl,
          invoicePdfUrl,
          linesJson,
          issuedAt,
          paidAt,
          dueDate,
        ] = params;
        let row = state.invoices.find(
          (candidate) => candidate.stripeInvoiceId === stripeInvoiceId,
        );
        if (row?.status === 'PAID' && status !== 'PAID') return [];
        const invoiceData = {
          userId,
          stripeInvoiceId,
          stripeCustomerId,
          stripeSubscriptionId,
          number,
          status,
          amountDueCents,
          amountPaidCents,
          amountRemainingCents,
          subtotalCents,
          totalCents,
          currency,
          periodStart,
          periodEnd,
          hostedInvoiceUrl,
          invoicePdfUrl,
          lines: linesJson === null
            ? (row?.lines ?? null)
            : JSON.parse(linesJson),
          issuedAt,
          paidAt,
          dueDate,
          updatedAt: new Date(),
        };
        if (row) {
          applyData(row, invoiceData);
        } else {
          row = {
            id,
            createdAt: new Date(),
            ...invoiceData,
          };
          state.invoices.push(row);
        }
        return [{ id: row.id, status: row.status }];
      }

      const [userId] = params;
      operations.push('user.lock');
      userLockedInTransaction = true;
      captures.userLock = { sql, userId };
      return [{ id: userId }];
    },
  };

  db.$transaction = (fn) => {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    return previous.then(async () => {
      const saved = snapshot();
      operations.push('transaction:start');
      inTransaction = true;
      userLockedInTransaction = false;
      try {
        const result = await fn(db);
        operations.push('transaction:commit');
        return result;
      } catch (error) {
        // A duplicate claim fails before this transaction mutates state. Do
        // not restore its old snapshot over a winner that is already draining
        // post-commit effects concurrently.
        if (error?.code !== 'P2002') restore(saved);
        operations.push('transaction:rollback');
        throw error;
      } finally {
        inTransaction = false;
        release();
      }
    });
  };

  return db;
}

function baseUser(overrides = {}) {
  return {
    id: 'u1',
    email: 'u1@example.com',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_old',
    plan: 'PRO',
    monthlyLimit: 100_000n,
    gemaTokenLimit: 10_000n,
    apiUsage: 900n,
    monthlyCallLimit: 4n,
    subscriptionStatus: 'active',
    subscriptionEndDate: null,
    ...overrides,
  };
}

function event(id, type, object, created = 1_700_000_000) {
  return { id, type, created, data: { object } };
}

const CHECKOUT_EVENT = event('evt_checkout_1', 'checkout.session.completed', {
  id: 'cs_1',
  customer: 'cus_1',
  subscription: 'sub_checkout',
  payment_status: 'paid',
  metadata: { userId: 'u1', plan: 'PRO' },
});

const INVOICE_SUCCEEDED_EVENT = event('evt_invoice_paid_1', 'invoice.payment_succeeded', {
  id: 'in_paid_1',
  customer: 'cus_1',
  billing_reason: 'subscription_cycle',
  parent: {
    type: 'subscription_details',
    subscription_details: { subscription: 'sub_old' },
  },
  status: 'paid',
  amount_due: 500,
  amount_paid: 500,
  amount_remaining: 0,
  subtotal: 500,
  total: 500,
  currency: 'usd',
  created: 1_700_000_000,
});

const INVOICE_FAILED_EVENT = event('evt_invoice_failed_1', 'invoice.payment_failed', {
  id: 'in_failed_1',
  customer: 'cus_1',
  billing_reason: 'subscription_cycle',
  parent: {
    type: 'subscription_details',
    subscription_details: { subscription: 'sub_old' },
  },
  status: 'open',
  amount_due: 500,
  amount_paid: 0,
  amount_remaining: 500,
  subtotal: 500,
  total: 500,
  currency: 'usd',
  created: 1_700_000_000,
  last_finalization_error: { message: 'Card declined' },
});

const SUBSCRIPTION_CREATED_EVENT = event('evt_sub_created_1', 'customer.subscription.created', {
  id: 'sub_new',
  customer: 'cus_1',
  status: 'active',
  current_period_end: 1_700_000_000,
  items: { data: [{ price: { nickname: 'Pro' } }] },
});

const SUBSCRIPTION_UPDATED_EVENT = event('evt_sub_updated_1', 'customer.subscription.updated', {
  id: 'sub_old',
  customer: 'cus_1',
  status: 'past_due',
  current_period_end: 1_700_000_100,
});

const SUBSCRIPTION_DELETED_EVENT = event('evt_sub_deleted_1', 'customer.subscription.deleted', {
  id: 'sub_old',
  customer: 'cus_1',
  status: 'canceled',
  ended_at: 1_700_000_200,
});

let restores = [];

function setup({
  stripeEvent,
  user = baseUser(),
  payments = [],
  invoices = [],
  usageAlerts = [],
  subscriptionEvents = [],
  systemSettings = [],
  failUserUpdateTimes = 0,
  failNotificationTimes = 0,
  synchronizeEventPrechecks = false,
  simulateConcurrentFkDeadlock = false,
  failTriggerTimes = 0,
  failEmailTimes = 0,
  triggerResults = [],
  emailResults = [],
  emailConfigured = false,
  posthogConfigured = true,
  posthogResults = [],
  recoveryMaxAttempts,
  recoveryBackoffBaseMs,
  failSubscriptionReadAfter = Number.POSITIVE_INFINITY,
  retrieveSubscriptionState = false,
} = {}) {
  const db = makeFakePrisma({
    user,
    payments,
    invoices,
    usageAlerts,
    subscriptionEvents,
    systemSettings,
    failUserUpdateTimes,
    failNotificationTimes,
    synchronizeEventPrechecks,
    simulateConcurrentFkDeadlock,
  });
  const external = {
    posthog: [],
    triggers: [],
    emails: [],
    legacyUsageResets: 0,
    subscriptionReads: 0,
    triggerAttempts: 0,
    emailAttempts: 0,
  };
  let activeStripeEvent = clone(stripeEvent);
  let triggerFailuresLeft = failTriggerTimes;
  let emailFailuresLeft = failEmailTimes;
  const queuedTriggerResults = clone(triggerResults);
  const queuedEmailResults = clone(emailResults);
  const queuedPosthogResults = clone(posthogResults);
  const stripeStub = {
    constructWebhookEvent: () => clone(activeStripeEvent),
    toHttpError: (error) => ({ statusCode: 400, body: { message: error?.message || 'bad signature' } }),
    retrieveSubscription: async () => {
      external.subscriptionReads += 1;
      if (external.subscriptionReads > failSubscriptionReadAfter) {
        throw new Error('simulated Stripe subscription read failure');
      }
      return { id: 'sub_old', status: 'active', current_period_end: 1_700_000_300 };
    },
  };
  const previousRecoveryEnv = {
    maxAttempts: process.env.STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS,
    backoffBaseMs: process.env.STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS,
    retrieveSubscriptionState: process.env.STRIPE_WEBHOOK_RETRIEVE_SUBSCRIPTION_STATE,
  };
  if (recoveryMaxAttempts !== undefined) {
    process.env.STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS = String(recoveryMaxAttempts);
  }
  if (recoveryBackoffBaseMs !== undefined) {
    process.env.STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS = String(recoveryBackoffBaseMs);
  }
  if (retrieveSubscriptionState) {
    process.env.STRIPE_WEBHOOK_RETRIEVE_SUBSCRIPTION_STATE = 'true';
  } else {
    delete process.env.STRIPE_WEBHOOK_RETRIEVE_SUBSCRIPTION_STATE;
  }
  restores = [
    mockResolvedModule(DB_PATH, db),
    mockResolvedModule(STRIPE_PATH, stripeStub),
    mockResolvedModule(POSTHOG_PATH, {
      getPostHogStatus: () => ({
        configured: posthogConfigured,
        requested: posthogConfigured,
        enabled: posthogConfigured,
        started: true,
        reason: posthogConfigured ? 'running' : 'missing_api_key',
      }),
      capturePostHogEvent: (payload) => {
        db._operations.push('external.posthog');
        external.posthog.push(clone(payload));
        return queuedPosthogResults.length > 0
          ? queuedPosthogResults.shift()
          : posthogConfigured;
      },
    }),
    mockResolvedModule(USAGE_MONITOR_PATH, {
      resetMonthlyUsage: async () => { external.legacyUsageResets += 1; },
    }),
    mockResolvedModule(TRIGGERS_PATH, {
      publish: async (...args) => {
        db._operations.push('external.trigger');
        external.triggerAttempts += 1;
        if (triggerFailuresLeft > 0) {
          triggerFailuresLeft -= 1;
          throw new Error('simulated trigger failure');
        }
        external.triggers.push(clone(args));
        return queuedTriggerResults.length > 0
          ? queuedTriggerResults.shift()
          : { dispatched: 1, deduped: false, errors: [] };
      },
    }),
    mockResolvedModule(EMAIL_PATH, {
      isConfigured: () => emailConfigured,
      sendPaymentFailureAlert: async (...args) => {
        db._operations.push('external.email');
        external.emailAttempts += 1;
        if (emailFailuresLeft > 0) {
          emailFailuresLeft -= 1;
          throw new Error('simulated email failure');
        }
        external.emails.push(clone(args));
        return queuedEmailResults.length > 0
          ? queuedEmailResults.shift()
          : { ok: true, messageId: 'mail_1' };
      },
    }),
    mockResolvedModule(EMAIL_PREFS_PATH, {
      shouldSendEmail: async () => true,
    }),
    () => {
      if (previousRecoveryEnv.maxAttempts === undefined) {
        delete process.env.STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS;
      } else {
        process.env.STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS = previousRecoveryEnv.maxAttempts;
      }
      if (previousRecoveryEnv.backoffBaseMs === undefined) {
        delete process.env.STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS;
      } else {
        process.env.STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS = previousRecoveryEnv.backoffBaseMs;
      }
      if (previousRecoveryEnv.retrieveSubscriptionState === undefined) {
        delete process.env.STRIPE_WEBHOOK_RETRIEVE_SUBSCRIPTION_STATE;
      } else {
        process.env.STRIPE_WEBHOOK_RETRIEVE_SUBSCRIPTION_STATE =
          previousRecoveryEnv.retrieveSubscriptionState;
      }
    },
  ];
  delete require.cache[require.resolve('../src/routes/payments')];
  const paymentsRouter = reloadModule('../src/routes/payments');
  const app = buildRouteTestApp('/payments', paymentsRouter);
  return {
    app,
    db,
    external,
    internal: paymentsRouter.INTERNAL,
    setStripeEvent(next) {
      activeStripeEvent = clone(next);
    },
  };
}

function deliver(app) {
  return request(app)
    .post('/payments/stripe/webhook')
    .set('stripe-signature', 'sig')
    .set('Content-Type', 'application/json')
    .send(Buffer.from('{}'));
}

afterEach(() => {
  restores.forEach((restore) => restore());
  restores = [];
  delete require.cache[require.resolve('../src/routes/payments')];
});

describe('POST /payments/stripe/webhook · durable Stripe event claims', () => {
  const cases = [
    {
      name: 'checkout.session.completed',
      stripeEvent: CHECKOUT_EVENT,
      user: baseUser({ plan: 'FREE', monthlyLimit: 1_000n, gemaTokenLimit: 0n }),
      payments: [{
        id: 'pay_1',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: null,
        status: 'PENDING',
        plan: 'PRO',
      }],
      verify({ db, external }) {
        assert.equal(db._state.users[0].plan, 'PRO');
        assert.ok(db._state.users[0].monthlyLimit > 1_000n);
        assert.equal(db._state.payments[0].status, 'COMPLETED');
        assert.equal(external.posthog.length, 1);
        assert.equal(external.posthog[0].properties.$insert_id, CHECKOUT_EVENT.id);
      },
    },
    {
      name: 'invoice.payment_succeeded',
      stripeEvent: INVOICE_SUCCEEDED_EVENT,
      user: baseUser({ subscriptionStatus: 'past_due' }),
      usageAlerts: [{ id: 'alert_1', userId: 'u1' }],
      verify({ db, external }) {
        assert.equal(
          db._state.users[0].subscriptionStatus,
          'past_due',
          'invoice payment does not own entitlement lifecycle state',
        );
        assert.equal(db._state.users[0].apiUsage, 0);
        assert.equal(db._state.users[0].monthlyCallLimit, 0);
        assert.equal(db._state.usageAlerts.length, 0);
        assert.equal(db._state.invoices.length, 1);
        assert.equal(db._attempts.usageAlertDeletes, 1);
        const cutoff = db._captures.usageAlertDeleteWhere?.sentAt?.lt;
        assert.ok(cutoff instanceof Date, 'usage-alert reset keeps the existing UTC month cutoff');
        assert.equal(cutoff.getUTCDate(), 1);
        assert.equal(cutoff.getUTCHours(), 0);
        assert.equal(external.legacyUsageResets, 0, 'quota reset must use the transaction client');
        assert.equal(external.triggers.length, 1);
        assert.equal(external.triggers[0][1].stripeEventId, INVOICE_SUCCEEDED_EVENT.id);
      },
    },
    {
      name: 'invoice.payment_failed',
      stripeEvent: INVOICE_FAILED_EVENT,
      emailConfigured: true,
      verify({ db, external }) {
        assert.equal(
          db._state.users[0].subscriptionStatus,
          'active',
          'subscription.updated owns past_due lifecycle state',
        );
        assert.equal(db._state.notifications.length, 1);
        assert.equal(db._state.notifications[0].metadata.stripeEventId, INVOICE_FAILED_EVENT.id);
        assert.equal(db._state.invoices.length, 1);
        assert.equal(external.emails.length, 1);
        assert.equal(external.emails[0][1].idempotencyKey, INVOICE_FAILED_EVENT.id);
        assert.equal(external.triggers.length, 1);
        assert.equal(external.triggers[0][1].stripeEventId, INVOICE_FAILED_EVENT.id);
      },
    },
    {
      name: 'customer.subscription.created',
      stripeEvent: SUBSCRIPTION_CREATED_EVENT,
      verify({ db }) {
        assert.equal(db._state.users[0].stripeSubscriptionId, 'sub_new');
        assert.equal(db._state.users[0].subscriptionStatus, 'active');
      },
    },
    {
      name: 'customer.subscription.updated',
      stripeEvent: SUBSCRIPTION_UPDATED_EVENT,
      verify({ db }) {
        assert.equal(db._state.users[0].subscriptionStatus, 'past_due');
      },
    },
    {
      name: 'customer.subscription.deleted',
      stripeEvent: SUBSCRIPTION_DELETED_EVENT,
      verify({ db }) {
        assert.equal(db._state.users[0].plan, 'FREE');
        assert.equal(db._state.users[0].monthlyLimit, 1_000n);
        assert.equal(db._state.users[0].monthlyCallLimit, 3);
        assert.equal(db._state.users[0].subscriptionStatus, 'canceled');
      },
    },
  ];

  for (const scenario of cases) {
    test(`${scenario.name}: duplicate delivery has one globally durable effect`, async () => {
      const harness = setup(scenario);

      const first = await deliver(harness.app);
      const committedAfterFirst = clone(harness.db._state);
      const attemptsAfterFirst = clone(harness.db._attempts);
      const externalAfterFirst = clone(harness.external);
      const second = await deliver(harness.app);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(harness.db._state, committedAfterFirst, 'duplicate must not mutate durable state');
      assert.deepEqual(harness.db._attempts, attemptsAfterFirst, 'duplicate must not repeat critical writes');
      assert.deepEqual(
        {
          posthog: harness.external.posthog,
          triggers: harness.external.triggers,
          emails: harness.external.emails,
          legacyUsageResets: harness.external.legacyUsageResets,
        },
        {
          posthog: externalAfterFirst.posthog,
          triggers: externalAfterFirst.triggers,
          emails: externalAfterFirst.emails,
          legacyUsageResets: externalAfterFirst.legacyUsageResets,
        },
        'duplicate must not repeat external notifications',
      );
      assert.equal(harness.db._state.subscriptionEvents.length, 1, 'one canonical event/audit row');
      assert.equal(harness.db._state.subscriptionEvents[0].stripeEventId, scenario.stripeEvent.id);
      assert.equal(harness.db._state.subscriptionEvents[0].eventData.stripeEventType, scenario.stripeEvent.type);
      const transactionStart = harness.db._operations.indexOf('transaction:start');
      const userLock = harness.db._operations.indexOf('user.lock', transactionStart);
      const eventClaim = harness.db._operations.indexOf(
        'subscriptionEvent.create',
        transactionStart,
      );
      assert.ok(
        transactionStart < userLock && userLock < eventClaim,
        `${scenario.name} must lock the user before acquiring the event FK key-share`,
      );
      scenario.verify(harness);
    });
  }

  test('subscription event ID is the Stripe event.id, never the subscription.id', async () => {
    const { app, db } = setup({ stripeEvent: SUBSCRIPTION_CREATED_EVENT });

    assert.equal((await deliver(app)).status, 200);

    assert.equal(db._state.subscriptionEvents[0].stripeEventId, 'evt_sub_created_1');
    assert.notEqual(db._state.subscriptionEvents[0].stripeEventId, 'sub_new');
    assert.equal(db._state.subscriptionEvents[0].eventData.subscriptionId, 'sub_new');
  });

  test('affected user is resolved read-only, then locked before the claim transaction inserts', async () => {
    const { app, db } = setup({ stripeEvent: SUBSCRIPTION_UPDATED_EVENT });

    assert.equal((await deliver(app)).status, 200);

    assert.deepEqual(db._operations.slice(0, 5), [
      'user.findUnique:outside',
      'subscriptionEvent.findUnique',
      'transaction:start',
      'user.lock',
      'subscriptionEvent.create',
    ]);
    assert.match(db._captures.userLock.sql, /FOR NO KEY UPDATE/i);
  });

  test('concurrent distinct events cannot form the SubscriptionEvent FK/user-lock deadlock cycle', async () => {
    const first = event(
      'evt_distinct_concurrent_a',
      'customer.subscription.updated',
      {
        ...SUBSCRIPTION_UPDATED_EVENT.data.object,
        status: 'active',
        current_period_end: 1_800_000_000,
      },
      800,
    );
    const second = event(
      'evt_distinct_concurrent_b',
      'customer.subscription.updated',
      {
        ...SUBSCRIPTION_UPDATED_EVENT.data.object,
        status: 'past_due',
        current_period_end: 1_800_000_100,
      },
      801,
    );
    const harness = setup({
      stripeEvent: first,
      simulateConcurrentFkDeadlock: true,
    });

    await Promise.all([
      harness.internal.processStripeWebhookEvent(first),
      harness.internal.processStripeWebhookEvent(second),
    ]);

    assert.equal(harness.db._state.subscriptionEvents.length, 2);
    const transactionStarts = harness.db._operations
      .map((operation, index) => (operation === 'transaction:start' ? index : -1))
      .filter((index) => index >= 0);
    for (const start of transactionStarts) {
      const lock = harness.db._operations.indexOf('user.lock', start);
      const claim = harness.db._operations.indexOf('subscriptionEvent.create', start);
      assert.ok(lock > start && lock < claim);
    }
  });

  test('integration-shaped unique race gives two concurrent deliveries one transaction winner', async () => {
    const { app, db, external } = setup({
      stripeEvent: CHECKOUT_EVENT,
      user: baseUser({ plan: 'FREE', monthlyLimit: 1_000n, gemaTokenLimit: 0n }),
      payments: [{
        id: 'pay_1',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
      synchronizeEventPrechecks: true,
    });

    const [left, right] = await Promise.all([deliver(app), deliver(app)]);

    assert.deepEqual([left.status, right.status].sort(), [200, 200]);
    assert.equal(db._state.subscriptionEvents.length, 1);
    assert.equal(db._captures.subscriptionEventCreates.length, 2, 'both requests reached the unique claim');
    assert.ok(db._operations.includes('transaction:rollback'), 'unique loser rolled its transaction back');
    assert.equal(db._attempts.userUpdates, 1);
    assert.equal(db._attempts.paymentUpdates, 1);
    assert.equal(external.posthog.length, 1);
  });

  test('invoice processing is offline-deterministic by default', async () => {
    const { app, db, external } = setup({
      stripeEvent: INVOICE_SUCCEEDED_EVENT,
      failSubscriptionReadAfter: 0,
    });

    assert.equal((await deliver(app)).status, 200);
    assert.equal(external.subscriptionReads, 0);

    assert.equal((await deliver(app)).status, 200);
    assert.equal(external.subscriptionReads, 0);
    assert.equal(db._state.subscriptionEvents.length, 1);
  });

  test('configured subscription retrieval happens once before a duplicate short-circuits', async () => {
    const { app, db, external } = setup({
      stripeEvent: INVOICE_SUCCEEDED_EVENT,
      failSubscriptionReadAfter: 1,
      retrieveSubscriptionState: true,
    });

    assert.equal((await deliver(app)).status, 200);
    assert.equal(external.subscriptionReads, 1);

    assert.equal((await deliver(app)).status, 200);
    assert.equal(external.subscriptionReads, 1, 'durable claim short-circuits remote hydration');
    assert.equal(db._state.subscriptionEvents.length, 1);
  });

  test('transaction stores pending effect descriptors before any external effect runs', async () => {
    const { app, db } = setup({
      stripeEvent: INVOICE_FAILED_EVENT,
      emailConfigured: true,
    });

    const response = await deliver(app);

    assert.equal(response.status, 200);
    const created = db._captures.subscriptionEventCreates[0];
    assert.deepEqual(
      created.eventData.outbox.effects.map(
        (effect) => [effect.type, effect.status, effect.required],
      ),
      [
        ['email.payment_failed', 'pending', false],
        ['trigger.payment_failed', 'pending', false],
      ],
    );
    const commitIndex = db._operations.indexOf('transaction:commit');
    assert.ok(commitIndex >= 0);
    assert.ok(db._operations.indexOf('external.email') > commitIndex);
    assert.ok(db._operations.indexOf('external.trigger') > commitIndex);
    assert.deepEqual(
      db._state.subscriptionEvents[0].eventData.outbox.effects.map((effect) => effect.status),
      ['completed', 'completed'],
    );
  });

  test('unconfigured optional SMTP is durably completed as skipped-success', async () => {
    const { app, db, external } = setup({
      stripeEvent: INVOICE_FAILED_EVENT,
      emailConfigured: false,
    });

    const response = await deliver(app);

    assert.equal(response.status, 200);
    const [emailEffect, triggerEffect] =
      db._state.subscriptionEvents[0].eventData.outbox.effects;
    assert.equal(emailEffect.required, false);
    assert.equal(emailEffect.status, 'completed');
    assert.deepEqual(emailEffect.completion, {
      outcome: 'skipped',
      reason: 'email_not_configured',
    });
    assert.equal(triggerEffect.status, 'completed');
    assert.equal(external.emailAttempts, 0);
  });

  test('unconfigured optional PostHog is durably completed as skipped-success', async () => {
    const { app, db, external } = setup({
      stripeEvent: CHECKOUT_EVENT,
      posthogConfigured: false,
      user: baseUser({ plan: 'FREE', monthlyLimit: 1_000n, gemaTokenLimit: 0n }),
      payments: [{
        id: 'pay_posthog_optional',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
    });

    const response = await deliver(app);

    assert.equal(response.status, 200);
    const effect = db._state.subscriptionEvents[0].eventData.outbox.effects[0];
    assert.equal(effect.required, false);
    assert.equal(effect.status, 'completed');
    assert.deepEqual(effect.completion, {
      outcome: 'skipped',
      reason: 'posthog_not_configured',
    });
    assert.equal(external.posthog.length, 0);
  });

  test('configured optional PostHog still requires an explicit queued success', async () => {
    const { app, db, external } = setup({
      stripeEvent: CHECKOUT_EVENT,
      posthogConfigured: true,
      posthogResults: [false],
      user: baseUser({ plan: 'FREE', monthlyLimit: 1_000n, gemaTokenLimit: 0n }),
      payments: [{
        id: 'pay_posthog_failure',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
    });

    const response = await deliver(app);

    assert.equal(response.status, 500);
    const effect = db._state.subscriptionEvents[0].eventData.outbox.effects[0];
    assert.equal(effect.required, false);
    assert.equal(effect.status, 'pending');
    assert.equal(external.posthog.length, 1);
  });

  test('effect failure returns 500, stays pending, and redelivery retries only unfinished effects', async () => {
    const { app, db, external } = setup({
      stripeEvent: INVOICE_FAILED_EVENT,
      emailConfigured: true,
      failTriggerTimes: 1,
    });

    const failed = await deliver(app);
    const criticalAttempts = {
      userUpdates: db._attempts.userUpdates,
      invoiceUpserts: db._attempts.invoiceUpserts,
      notificationCreates: db._attempts.notificationCreates,
    };

    assert.equal(failed.status, 500);
    assert.equal(db._state.subscriptionEvents.length, 1, 'critical transaction remains committed');
    assert.equal(db._state.notifications.length, 1);
    assert.deepEqual(
      db._state.subscriptionEvents[0].eventData.outbox.effects.map((effect) => [effect.type, effect.status]),
      [
        ['email.payment_failed', 'completed'],
        ['trigger.payment_failed', 'pending'],
      ],
    );
    assert.equal(external.emailAttempts, 1);
    assert.equal(external.triggerAttempts, 1);

    const retried = await deliver(app);
    assert.equal(retried.status, 200);
    assert.deepEqual(
      {
        userUpdates: db._attempts.userUpdates,
        invoiceUpserts: db._attempts.invoiceUpserts,
        notificationCreates: db._attempts.notificationCreates,
      },
      criticalAttempts,
      'redelivery must not repeat committed critical effects',
    );
    assert.equal(external.emailAttempts, 1, 'completed email effect is not repeated');
    assert.equal(external.triggerAttempts, 2);
    assert.equal(external.emails.length, 1);
    assert.equal(external.triggers.length, 1);

    assert.equal((await deliver(app)).status, 200);
    assert.equal(external.emailAttempts, 1);
    assert.equal(external.triggerAttempts, 2);
  });

  test('trigger-registry errors keep the effect pending until an explicit error-free result', async () => {
    const { app, db, external } = setup({
      stripeEvent: INVOICE_SUCCEEDED_EVENT,
      triggerResults: [
        {
          dispatched: 1,
          deduped: false,
          errors: [{ stage: 'webhook', message: 'downstream rejected delivery' }],
        },
        { dispatched: 1, deduped: false, errors: [] },
      ],
    });

    const failed = await deliver(app);
    assert.equal(failed.status, 500);
    let effect = db._state.subscriptionEvents[0].eventData.outbox.effects[0];
    assert.equal(effect.status, 'pending');
    assert.match(effect.lastError, /downstream rejected delivery/);
    assert.equal(external.triggerAttempts, 1);

    const recovered = await deliver(app);
    assert.equal(recovered.status, 200);
    effect = db._state.subscriptionEvents[0].eventData.outbox.effects[0];
    assert.equal(effect.status, 'completed');
    assert.equal(external.triggerAttempts, 2);
  });

  for (const [name, failedResult] of [
    ['swallowed undefined', undefined],
    ['false', false],
    ['error object', { ok: false, error: 'SMTP accepted no recipients' }],
  ]) {
    test(`email ${name} result keeps the effect pending until explicit success`, async () => {
      const { app, db, external } = setup({
        stripeEvent: INVOICE_FAILED_EVENT,
        emailConfigured: true,
        emailResults: [failedResult, { ok: true, messageId: 'mail_retried' }],
      });

      const failed = await deliver(app);
      assert.equal(failed.status, 500);
      let [emailEffect, triggerEffect] =
        db._state.subscriptionEvents[0].eventData.outbox.effects;
      assert.equal(emailEffect.status, 'pending');
      assert.equal(triggerEffect.status, 'pending');
      assert.equal(external.emailAttempts, 1);
      assert.equal(external.triggerAttempts, 0);

      const recovered = await deliver(app);
      assert.equal(recovered.status, 200);
      [emailEffect, triggerEffect] =
        db._state.subscriptionEvents[0].eventData.outbox.effects;
      assert.equal(emailEffect.status, 'completed');
      assert.equal(triggerEffect.status, 'completed');
      assert.equal(external.emailAttempts, 2);
      assert.equal(external.triggerAttempts, 1);
    });
  }

  test('an unexpired processing lease returns 500 so a crashed worker cannot strand the effect', async () => {
    const effectKey = `stripe:${INVOICE_SUCCEEDED_EVENT.id}:trigger.payment_succeeded`;
    const harness = setup({
      stripeEvent: INVOICE_SUCCEEDED_EVENT,
      subscriptionEvents: [{
        id: 'se_inflight',
        userId: 'u1',
        eventType: 'payment_succeeded',
        stripeEventId: INVOICE_SUCCEEDED_EVENT.id,
        eventData: {
          stripeEventType: INVOICE_SUCCEEDED_EVENT.type,
          outbox: {
            version: 1,
            effects: [{
              key: effectKey,
              type: 'trigger.payment_succeeded',
              status: 'processing',
              attempts: 1,
              claimToken: 'abandoned-worker',
              leaseUntil: new Date(Date.now() + 60_000).toISOString(),
              payload: {
                invoiceId: 'in_paid_1',
                amount: 5,
                currency: 'usd',
                stripeEventId: INVOICE_SUCCEEDED_EVENT.id,
                idempotencyKey: `stripe:${INVOICE_SUCCEEDED_EVENT.id}:payment_succeeded`,
              },
            }],
          },
        },
      }],
    });

    const busy = await deliver(harness.app);
    assert.equal(busy.status, 500, 'Stripe must keep retrying while another lease is unresolved');
    assert.equal(harness.external.triggerAttempts, 0);

    harness.db._state.subscriptionEvents[0].eventData.outbox.effects[0].leaseUntil =
      new Date(Date.now() - 1).toISOString();
    const recovered = await deliver(harness.app);
    assert.equal(recovered.status, 200);
    assert.equal(harness.external.triggerAttempts, 1);
    assert.equal(
      harness.db._state.subscriptionEvents[0].eventData.outbox.effects[0].status,
      'completed',
    );
  });

  test('outbox failures persist backoff and stop autonomously retrying after the attempt cap', async () => {
    const harness = setup({
      stripeEvent: INVOICE_SUCCEEDED_EVENT,
      failTriggerTimes: 5,
      recoveryMaxAttempts: 2,
      recoveryBackoffBaseMs: 1_000,
    });

    assert.equal((await deliver(harness.app)).status, 500);
    let effect = harness.db._state.subscriptionEvents[0].eventData.outbox.effects[0];
    assert.equal(effect.status, 'pending');
    assert.equal(effect.attempts, 1);
    assert.ok(Date.parse(effect.nextAttemptAt) > Date.now());

    assert.equal((await deliver(harness.app)).status, 500);
    effect = harness.db._state.subscriptionEvents[0].eventData.outbox.effects[0];
    assert.equal(effect.status, 'failed');
    assert.equal(effect.attempts, 2);
    assert.equal(effect.nextAttemptAt, null);
    assert.equal(harness.external.triggerAttempts, 2);

    assert.equal((await deliver(harness.app)).status, 200);
    assert.equal(harness.external.triggerAttempts, 2);
  });

  test('recovery skips a deferred effect and still drains every due effect in the row', async () => {
    const nowMs = Date.parse('2026-07-11T02:00:00.000Z');
    const stripeEventId = 'evt_mixed_due_effects';
    const harness = setup({
      stripeEvent: INVOICE_FAILED_EVENT,
      emailConfigured: true,
      subscriptionEvents: [{
        id: 'se_mixed_due_effects',
        userId: 'u1',
        eventType: 'payment_failed',
        stripeEventId,
        eventData: {
          outbox: {
            version: 1,
            effects: [
              {
                key: `stripe:${stripeEventId}:email.payment_failed`,
                type: 'email.payment_failed',
                required: false,
                status: 'pending',
                attempts: 1,
                nextAttemptAt: new Date(nowMs + 60_000).toISOString(),
                payload: { stripeEventId, amount: 5 },
              },
              {
                key: `stripe:${stripeEventId}:trigger.payment_failed`,
                type: 'trigger.payment_failed',
                required: false,
                status: 'pending',
                attempts: 0,
                nextAttemptAt: null,
                payload: { stripeEventId, invoiceId: 'in_mixed_due_effects' },
              },
            ],
          },
        },
      }],
    });

    const result = await harness.internal.drainStripeWebhookEffects(stripeEventId, {
      respectBackoff: true,
      now: () => nowMs,
    });

    const [deferred, completed] =
      harness.db._state.subscriptionEvents[0].eventData.outbox.effects;
    assert.equal(deferred.status, 'pending');
    assert.equal(completed.status, 'completed');
    assert.equal(harness.external.emailAttempts, 0);
    assert.equal(harness.external.triggerAttempts, 1);
    assert.equal(result.deferred, true);
    assert.equal(result.completed, 1);
    assert.equal(result.nextAttemptAt, deferred.nextAttemptAt);
  });

  test('recovery attempts later due effects even when an earlier due effect fails', async () => {
    const nowMs = Date.parse('2026-07-11T02:00:00.000Z');
    const stripeEventId = 'evt_multiple_due_effects';
    const harness = setup({
      stripeEvent: INVOICE_FAILED_EVENT,
      emailConfigured: true,
      failTriggerTimes: 1,
      subscriptionEvents: [{
        id: 'se_multiple_due_effects',
        userId: 'u1',
        eventType: 'payment_failed',
        stripeEventId,
        eventData: {
          outbox: {
            version: 1,
            effects: [
              {
                key: `stripe:${stripeEventId}:trigger.payment_failed`,
                type: 'trigger.payment_failed',
                required: false,
                status: 'pending',
                attempts: 0,
                payload: { stripeEventId, invoiceId: 'in_multiple_due_effects' },
              },
              {
                key: `stripe:${stripeEventId}:email.payment_failed`,
                type: 'email.payment_failed',
                required: false,
                status: 'pending',
                attempts: 0,
                payload: { stripeEventId, amount: 5 },
              },
            ],
          },
        },
      }],
    });

    await assert.rejects(
      harness.internal.drainStripeWebhookEffects(stripeEventId, {
        respectBackoff: true,
        now: () => nowMs,
      }),
      /simulated trigger failure/,
    );

    const [failed, completed] =
      harness.db._state.subscriptionEvents[0].eventData.outbox.effects;
    assert.equal(failed.status, 'pending');
    assert.equal(completed.status, 'completed');
    assert.equal(harness.external.triggerAttempts, 1);
    assert.equal(harness.external.emailAttempts, 1);
  });

  test('critical failure rolls back the claim and remains retryable', async () => {
    const { app, db } = setup({
      stripeEvent: SUBSCRIPTION_DELETED_EVENT,
      failUserUpdateTimes: 1,
    });

    const failed = await deliver(app);
    assert.equal(failed.status, 500);
    assert.equal(db._state.subscriptionEvents.length, 0, 'failed claim transaction rolled back');
    assert.equal(db._state.users[0].plan, 'PRO', 'critical mutation rolled back');

    const retried = await deliver(app);
    assert.equal(retried.status, 200);
    assert.equal(db._state.subscriptionEvents.length, 1);
    assert.equal(db._state.users[0].plan, 'FREE');
  });

  test('transactional notification failure rolls back and retries without duplicates', async () => {
    const { app, db, external } = setup({
      stripeEvent: INVOICE_FAILED_EVENT,
      failNotificationTimes: 1,
      emailConfigured: true,
    });

    const failed = await deliver(app);
    assert.equal(failed.status, 500);
    assert.equal(db._state.subscriptionEvents.length, 0);
    assert.equal(db._state.notifications.length, 0);
    assert.equal(db._state.users[0].subscriptionStatus, 'active');
    assert.equal(external.emails.length, 0, 'post-commit email must not run for a rolled-back attempt');

    const retried = await deliver(app);
    assert.equal(retried.status, 200);
    assert.equal(db._state.subscriptionEvents.length, 1);
    assert.equal(db._state.notifications.length, 1);
    assert.equal(external.emails.length, 1);

    assert.equal((await deliver(app)).status, 200);
    assert.equal(db._state.notifications.length, 1);
    assert.equal(external.emails.length, 1);
  });

  test('checkout already completed by verify-session records the event without granting again', async () => {
    const { app, db, external } = setup({
      stripeEvent: CHECKOUT_EVENT,
      user: baseUser({ plan: 'PRO', monthlyLimit: 101_000n }),
      payments: [{
        id: 'pay_1',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        status: 'COMPLETED',
        plan: 'PRO',
      }],
    });

    assert.equal((await deliver(app)).status, 200);
    assert.equal(db._state.subscriptionEvents.length, 1);
    assert.equal(db._attempts.userUpdates, 0);
    assert.equal(db._state.users[0].monthlyLimit, 101_000n);
    assert.equal(external.posthog.length, 0);
  });

  test('delayed paid checkout after cancellation completes accounting without restoring premium', async () => {
    const newerCancellation = event('evt_newer_subscription_cancellation', 'customer.subscription.deleted', {
      id: 'sub_checkout_delayed',
      customer: 'cus_1',
      status: 'canceled',
      ended_at: 900,
    }, 900);
    const delayedPaidCheckout = event('evt_delayed_paid_checkout', 'checkout.session.completed', {
      id: 'cs_delayed_paid',
      customer: 'cus_1',
      subscription: 'sub_checkout_delayed',
      payment_status: 'paid',
      metadata: { userId: 'u1', plan: 'PRO' },
    }, 800);
    const harness = setup({
      stripeEvent: newerCancellation,
      user: baseUser({
        stripeSubscriptionId: 'sub_checkout_delayed',
      }),
      payments: [{
        id: 'pay_delayed_checkout',
        userId: 'u1',
        stripeSessionId: 'cs_delayed_paid',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: null,
        status: 'PENDING',
        plan: 'PRO',
      }],
    });

    assert.equal((await deliver(harness.app)).status, 200);
    const canceledQuota = {
      monthlyLimit: harness.db._state.users[0].monthlyLimit,
      monthlyCallLimit: harness.db._state.users[0].monthlyCallLimit,
      gemaTokenLimit: harness.db._state.users[0].gemaTokenLimit,
    };
    assert.equal(harness.db._state.users[0].plan, 'FREE');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'canceled');

    harness.setStripeEvent(delayedPaidCheckout);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.payments[0].status, 'COMPLETED');
    assert.equal(harness.db._state.payments[0].stripeSubscriptionId, 'sub_checkout_delayed');
    assert.equal(harness.db._state.users[0].plan, 'FREE');
    assert.deepEqual({
      monthlyLimit: harness.db._state.users[0].monthlyLimit,
      monthlyCallLimit: harness.db._state.users[0].monthlyCallLimit,
      gemaTokenLimit: harness.db._state.users[0].gemaTokenLimit,
    }, canceledQuota);
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'canceled');
    assert.equal(harness.external.posthog.length, 0);
    const checkoutRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === delayedPaidCheckout.id,
    );
    assert.equal(checkoutRecord.eventData.processing.disposition, 'accounting_only');
    assert.equal(
      checkoutRecord.eventData.processing.reason,
      'newer_terminal_entitlement',
    );
  });

  test('paid checkout grants a replacement subscription despite newer past_due state on the old subscription', async () => {
    const oldSubscriptionPastDue = event(
      'evt_old_subscription_past_due',
      'customer.subscription.updated',
      {
        id: 'sub_old_replaced',
        customer: 'cus_1',
        status: 'past_due',
        current_period_end: 900,
      },
      900,
    );
    const replacementCheckout = event(
      'evt_replacement_checkout',
      'checkout.session.completed',
      {
        id: 'cs_replacement',
        customer: 'cus_1',
        subscription: 'sub_replacement',
        payment_status: 'paid',
        metadata: { userId: 'u1', plan: 'PRO' },
      },
      800,
    );
    const harness = setup({
      stripeEvent: oldSubscriptionPastDue,
      user: baseUser({
        plan: 'FREE',
        monthlyLimit: 1_000n,
        gemaTokenLimit: 0n,
        stripeSubscriptionId: 'sub_old_replaced',
      }),
      payments: [{
        id: 'pay_replacement',
        userId: 'u1',
        stripeSessionId: 'cs_replacement',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: null,
        status: 'PENDING',
        plan: 'PRO',
      }],
    });

    assert.equal((await deliver(harness.app)).status, 200);
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'past_due');

    harness.setStripeEvent(replacementCheckout);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.payments[0].status, 'COMPLETED');
    assert.equal(harness.db._state.users[0].plan, 'PRO');
    assert.ok(harness.db._state.users[0].monthlyLimit > 1_000n);
    assert.ok(harness.db._state.users[0].gemaTokenLimit > 0n);
    assert.equal(harness.db._state.users[0].stripeSubscriptionId, 'sub_replacement');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
    assert.equal(harness.external.posthog.length, 1);
    const checkoutRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === replacementCheckout.id,
    );
    assert.equal(checkoutRecord.eventData.processing.disposition, 'applied');
    assert.equal(checkoutRecord.eventData.processing.reason, null);
  });

  test('equal-second terminal state blocks delayed checkout without event-ID ordering', async () => {
    const delayedPaidCheckout = event('evt_checkout_equal_terminal', 'checkout.session.completed', {
      id: 'cs_equal_terminal',
      customer: 'cus_1',
      subscription: 'sub_equal_terminal',
      payment_status: 'paid',
      metadata: { userId: 'u1', plan: 'PRO' },
    }, 800);
    const subscriptionEvents = [
      {
        id: 'se_active_same_second',
        userId: 'u1',
        eventType: 'updated',
        stripeEventId: 'evt_z_active_same_second',
        eventData: {
          stripeEventType: 'customer.subscription.updated',
          subscriptionId: 'sub_equal_terminal',
          status: 'active',
          eventCreated: 900,
          processing: { disposition: 'applied', reason: null },
        },
      },
      {
        id: 'se_terminal_same_second',
        userId: 'u1',
        eventType: 'updated',
        stripeEventId: 'evt_a_terminal_same_second',
        eventData: {
          stripeEventType: 'customer.subscription.updated',
          subscriptionId: 'sub_equal_terminal',
          status: 'past_due',
          eventCreated: 900,
          processing: { disposition: 'applied', reason: null },
        },
      },
    ];
    const harness = setup({
      stripeEvent: delayedPaidCheckout,
      user: baseUser({
        plan: 'FREE',
        monthlyLimit: 1_000n,
        gemaTokenLimit: 0n,
        stripeSubscriptionId: 'sub_equal_terminal',
        subscriptionStatus: 'active',
      }),
      payments: [{
        id: 'pay_equal_terminal',
        userId: 'u1',
        stripeSessionId: 'cs_equal_terminal',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
      subscriptionEvents,
    });

    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.payments[0].status, 'COMPLETED');
    assert.equal(harness.db._state.users[0].plan, 'FREE');
    assert.equal(harness.db._state.users[0].monthlyLimit, 1_000n);
    assert.equal(harness.db._state.users[0].gemaTokenLimit, 0n);
    assert.equal(harness.external.posthog.length, 0);
    const checkoutRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === delayedPaidCheckout.id,
    );
    assert.equal(checkoutRecord.eventData.processing.disposition, 'accounting_only');
    assert.equal(
      checkoutRecord.eventData.processing.reason,
      'newer_terminal_entitlement',
    );
  });

  const invalidCheckoutCases = [
    {
      name: 'unpaid session',
      event: event('evt_checkout_unpaid', 'checkout.session.completed', {
        ...CHECKOUT_EVENT.data.object,
        payment_status: 'unpaid',
      }),
      payments: [{
        id: 'pay_unpaid',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
      reason: 'checkout_unpaid',
    },
    {
      name: 'missing durable payment',
      event: event('evt_checkout_missing_payment', 'checkout.session.completed', {
        ...CHECKOUT_EVENT.data.object,
      }),
      payments: [],
      reason: 'checkout_payment_not_found',
    },
    {
      name: 'non-Stripe payment provider',
      event: event('evt_checkout_provider_mismatch', 'checkout.session.completed', {
        ...CHECKOUT_EVENT.data.object,
      }),
      payments: [{
        id: 'pay_provider_mismatch',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        provider: 'PAYPAL',
        status: 'PENDING',
        plan: 'PRO',
      }],
      reason: 'checkout_payment_provider_mismatch',
    },
    {
      name: 'customer mismatch',
      event: event('evt_checkout_customer_mismatch', 'checkout.session.completed', {
        ...CHECKOUT_EVENT.data.object,
      }),
      payments: [{
        id: 'pay_customer_mismatch',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_other',
        status: 'PENDING',
        plan: 'PRO',
      }],
      reason: 'checkout_customer_mismatch',
    },
    {
      name: 'user mismatch',
      event: event('evt_checkout_user_mismatch', 'checkout.session.completed', {
        ...CHECKOUT_EVENT.data.object,
      }),
      payments: [{
        id: 'pay_user_mismatch',
        userId: 'u_other',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
      reason: 'checkout_user_mismatch',
    },
    {
      name: 'plan mismatch',
      event: event('evt_checkout_plan_mismatch', 'checkout.session.completed', {
        ...CHECKOUT_EVENT.data.object,
      }),
      payments: [{
        id: 'pay_plan_mismatch',
        userId: 'u1',
        stripeSessionId: 'cs_1',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO_MAX',
      }],
      reason: 'checkout_plan_mismatch',
    },
  ];

  for (const scenario of invalidCheckoutCases) {
    test(`checkout ${scenario.name} is recorded but never grants a paid plan`, async () => {
      const { app, db, external } = setup({
        stripeEvent: scenario.event,
        user: baseUser({ plan: 'FREE', monthlyLimit: 1_000n, gemaTokenLimit: 0n }),
        payments: scenario.payments,
      });

      const response = await deliver(app);

      assert.equal(response.status, 200);
      assert.equal(db._state.users[0].plan, 'FREE');
      assert.equal(db._state.users[0].monthlyLimit, 1_000n);
      assert.equal(db._attempts.userUpdates, 0);
      assert.equal(db._state.subscriptionEvents.length, 1);
      assert.equal(
        db._state.subscriptionEvents[0].eventData.processing.disposition,
        'no_op',
      );
      assert.equal(
        db._state.subscriptionEvents[0].eventData.processing.reason,
        scenario.reason,
      );
      assert.equal(external.posthog.length, 0);
    });
  }

  test('cancel_at_period_end projects an active subscription as canceling through period end', async () => {
    const currentPeriodEnd = 4_102_444_800;
    const cancelingUpdate = event(
      'evt_subscription_canceling',
      'customer.subscription.updated',
      {
        id: 'sub_old',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: true,
        current_period_end: currentPeriodEnd,
      },
      700,
    );
    const harness = setup({ stripeEvent: cancelingUpdate });

    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].subscriptionStatus, 'canceling');
    assert.equal(
      harness.db._state.users[0].subscriptionEndDate.getTime(),
      currentPeriodEnd * 1000,
    );
    assert.equal(
      harness.db._state.subscriptionEvents[0].eventData.status,
      'canceling',
    );
  });

  test('old-subscription update cannot overwrite a newer active subscription', async () => {
    const newSubscription = event('evt_sub_newer_created', 'customer.subscription.created', {
      id: 'sub_new',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_800_000_000,
    }, 300);
    const staleOldUpdate = event('evt_sub_old_stale_update', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'past_due',
      current_period_end: 1_700_000_000,
    }, 200);
    const harness = setup({ stripeEvent: newSubscription });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(staleOldUpdate);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].stripeSubscriptionId, 'sub_new');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
    const staleRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === staleOldUpdate.id,
    );
    assert.equal(staleRecord.eventData.processing.disposition, 'stale');
    assert.equal(staleRecord.eventData.processing.reason, 'subscription_id_mismatch');
  });

  test('older delete cannot downgrade a subscription after a newer update', async () => {
    const newerUpdate = event('evt_sub_newer_update', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_800_000_000,
    }, 300);
    const olderDelete = event('evt_sub_older_delete', 'customer.subscription.deleted', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'canceled',
      ended_at: 1_700_000_000,
    }, 200);
    const harness = setup({ stripeEvent: newerUpdate });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(olderDelete);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].plan, 'PRO');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
    assert.equal(
      harness.db._state.users[0].subscriptionEndDate.getTime(),
      1_800_000_000 * 1000,
    );
    const staleRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === olderDelete.id,
    );
    assert.equal(staleRecord.eventData.processing.disposition, 'stale');
    assert.equal(staleRecord.eventData.processing.reason, 'event_out_of_order');
    assert.ok(
      harness.db._operations.lastIndexOf('user.lock')
        < harness.db._operations.lastIndexOf('subscriptionEvent.findMany'),
      'the user row lock serializes event.created fence reads',
    );
    assert.match(harness.db._captures.userLock.sql, /\$1/);
    assert.doesNotMatch(harness.db._captures.userLock.sql, /sub_old/);
  });

  test('older update for the same subscription cannot reverse newer state', async () => {
    const newerUpdate = event('evt_sub_latest_update', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_800_000_000,
    }, 400);
    const olderUpdate = event('evt_sub_reversed_update', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'past_due',
      current_period_end: 1_700_000_000,
    }, 350);
    const harness = setup({ stripeEvent: newerUpdate });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(olderUpdate);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
    assert.equal(
      harness.db._state.users[0].subscriptionEndDate.getTime(),
      1_800_000_000 * 1000,
    );
    const staleRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === olderUpdate.id,
    );
    assert.equal(staleRecord.eventData.processing.disposition, 'stale');
    assert.equal(staleRecord.eventData.processing.reason, 'event_out_of_order');
  });

  test('equal-second same-kind subscription updates never use event IDs as ordering evidence', async () => {
    const lexicallyLater = event('evt_z_equal_second', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_800_000_000,
    }, 700);
    const lexicallyEarlier = event('evt_a_equal_second', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'past_due',
      current_period_end: 1_700_000_000,
    }, 700);
    const harness = setup({ stripeEvent: lexicallyLater });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(lexicallyEarlier);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].subscriptionStatus, 'past_due');
    const appliedRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === lexicallyEarlier.id,
    );
    assert.equal(appliedRecord.eventData.processing.disposition, 'applied');
    assert.equal(appliedRecord.eventData.processing.reason, null);
  });

  test('equal-second deletion dominates an update even when its event ID sorts earlier', async () => {
    const update = event('evt_z_equal_update', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_800_000_000,
    }, 701);
    const deletion = event('evt_a_equal_delete', 'customer.subscription.deleted', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'canceled',
      ended_at: 1_800_000_000,
    }, 701);
    const harness = setup({ stripeEvent: update });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(deletion);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].plan, 'FREE');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'canceled');
    const deletionRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === deletion.id,
    );
    assert.equal(deletionRecord.eventData.processing.disposition, 'applied');
    assert.equal(deletionRecord.eventData.processing.reason, null);
  });

  test('equal-second update cannot reverse a deletion even when its event ID sorts later', async () => {
    const deletion = event('evt_a_equal_delete_first', 'customer.subscription.deleted', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'canceled',
      ended_at: 1_800_000_000,
    }, 702);
    const update = event('evt_z_equal_update_later', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_900_000_000,
    }, 702);
    const harness = setup({ stripeEvent: deletion });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(update);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].plan, 'FREE');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'canceled');
    const staleRecord = harness.db._state.subscriptionEvents.find(
      (row) => row.stripeEventId === update.id,
    );
    assert.equal(staleRecord.eventData.processing.disposition, 'stale');
    assert.equal(staleRecord.eventData.processing.reason, 'event_out_of_order');
  });

  for (const invoiceType of ['invoice.payment_succeeded', 'invoice.payment_failed']) {
    test(`${invoiceType} with a non-cycle billing reason is a durable no-op`, async () => {
      const base = invoiceType === 'invoice.payment_succeeded'
        ? INVOICE_SUCCEEDED_EVENT
        : INVOICE_FAILED_EVENT;
      const stripeEvent = event(
        `evt_${invoiceType.replaceAll('.', '_')}_non_cycle`,
        invoiceType,
        {
          ...base.data.object,
          id: `in_${invoiceType.endsWith('succeeded') ? 'paid' : 'failed'}_non_cycle`,
          billing_reason: 'subscription_update',
        },
        710,
      );
      const harness = setup({
        stripeEvent,
        emailConfigured: true,
        usageAlerts: [{ id: 'alert_non_cycle', userId: 'u1' }],
      });

      assert.equal((await deliver(harness.app)).status, 200);

      assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
      assert.equal(harness.db._state.users[0].apiUsage, 900n);
      assert.equal(harness.db._state.users[0].monthlyCallLimit, 4n);
      assert.equal(harness.db._state.usageAlerts.length, 1);
      assert.equal(harness.db._state.notifications.length, 0);
      assert.equal(harness.db._state.invoices.length, 1, 'invoice history still synchronizes');
      const row = harness.db._state.subscriptionEvents[0];
      assert.equal(row.eventData.processing.disposition, 'no_op');
      assert.equal(row.eventData.processing.reason, 'invoice_not_subscription_cycle');
      assert.deepEqual(row.eventData.outbox.effects, []);
      assert.equal(harness.external.triggerAttempts, 0);
      assert.equal(harness.external.emailAttempts, 0);
    });
  }

  test('every non-cycle invoice event mirrors before semantic no-op fencing', async () => {
    const paid = event('evt_z_non_cycle_paid', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_non_cycle_fenced',
      billing_reason: 'subscription_update',
    }, 730);
    const staleFailure = event('evt_a_non_cycle_failed', 'invoice.payment_failed', {
      ...INVOICE_FAILED_EVENT.data.object,
      id: 'in_non_cycle_fenced',
      billing_reason: 'subscription_update',
    }, 730);
    const harness = setup({
      stripeEvent: paid,
      emailConfigured: true,
    });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(staleFailure);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.invoices[0].status, 'PAID');
    assert.equal(harness.db._attempts.invoiceUpserts, 2);
    const failedRecord = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === staleFailure.id,
    );
    assert.equal(failedRecord.eventData.processing.disposition, 'no_op');
    assert.equal(failedRecord.eventData.processing.reason, 'invoice_not_subscription_cycle');
    assert.equal(harness.db._state.notifications.length, 0);
    assert.equal(harness.external.emailAttempts, 0);
  });

  test('one-off invoice events mirror without subscription entitlement effects', async () => {
    const paid = event('evt_z_one_off_paid', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_one_off_fenced',
      billing_reason: 'manual',
      parent: null,
      subscription: null,
    }, 740);
    const staleFailure = event('evt_a_one_off_failed', 'invoice.payment_failed', {
      ...INVOICE_FAILED_EVENT.data.object,
      id: 'in_one_off_fenced',
      billing_reason: 'manual',
      parent: null,
      subscription: null,
    }, 740);
    const harness = setup({
      stripeEvent: paid,
      emailConfigured: true,
    });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(staleFailure);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.invoices[0].status, 'PAID');
    assert.equal(harness.db._attempts.invoiceUpserts, 2);
    const failedRecord = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === staleFailure.id,
    );
    assert.equal(failedRecord.eventData.subscriptionId, null);
    assert.equal(failedRecord.eventData.invoiceId, 'in_one_off_fenced');
    assert.equal(failedRecord.eventData.processing.disposition, 'no_op');
    assert.equal(failedRecord.eventData.processing.reason, 'invoice_not_subscription_cycle');
  });

  test('one-off invoice mirrors remain independent across invoice IDs', async () => {
    const newerInvoice = event('evt_one_off_newer_a', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_one_off_a',
      billing_reason: 'manual',
      parent: null,
      subscription: null,
    }, 900);
    const olderDifferentInvoice = event('evt_one_off_older_b', 'invoice.payment_failed', {
      ...INVOICE_FAILED_EVENT.data.object,
      id: 'in_one_off_b',
      billing_reason: 'manual',
      parent: null,
      subscription: null,
    }, 800);
    const harness = setup({ stripeEvent: newerInvoice });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(olderDifferentInvoice);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.invoices.length, 2);
    const secondRecord = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === olderDifferentInvoice.id,
    );
    assert.equal(secondRecord.eventData.processing.disposition, 'no_op');
    assert.equal(secondRecord.eventData.processing.reason, 'invoice_not_subscription_cycle');
  });

  for (const invoiceType of ['invoice.payment_succeeded', 'invoice.payment_failed']) {
    test(`${invoiceType} for a mismatched subscription cannot mutate the active subscription`, async () => {
      const base = invoiceType === 'invoice.payment_succeeded'
        ? INVOICE_SUCCEEDED_EVENT
        : INVOICE_FAILED_EVENT;
      const stripeEvent = event(
        `evt_${invoiceType.replaceAll('.', '_')}_mismatch`,
        invoiceType,
        {
          ...base.data.object,
          id: `in_${invoiceType.endsWith('succeeded') ? 'paid' : 'failed'}_mismatch`,
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: { id: 'sub_other' } },
          },
        },
        720,
      );
      const harness = setup({
        stripeEvent,
        emailConfigured: true,
        usageAlerts: [{ id: 'alert_mismatch', userId: 'u1' }],
      });

      assert.equal((await deliver(harness.app)).status, 200);

      assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
      assert.equal(harness.db._state.users[0].apiUsage, 900n);
      assert.equal(harness.db._state.users[0].monthlyCallLimit, 4n);
      assert.equal(harness.db._state.usageAlerts.length, 1);
      assert.equal(harness.db._state.notifications.length, 0);
      assert.equal(harness.db._state.invoices.length, 1, 'mismatched subscription invoice still mirrors');
      assert.equal(harness.db._state.invoices[0].stripeSubscriptionId, 'sub_other');
      const row = harness.db._state.subscriptionEvents[0];
      assert.equal(row.eventData.subscriptionId, 'sub_other');
      assert.equal(row.eventData.processing.disposition, 'no_op');
      assert.equal(row.eventData.processing.reason, 'subscription_id_mismatch');
      assert.deepEqual(row.eventData.outbox.effects, []);
    });
  }

  for (const invoiceType of ['invoice.payment_succeeded', 'invoice.payment_failed']) {
    test(`delayed ${invoiceType} for a previous subscription mirrors without active-subscription effects`, async () => {
      const replacement = event('evt_replacement_subscription', 'customer.subscription.created', {
        id: 'sub_current',
        customer: 'cus_1',
        status: 'active',
        current_period_end: 2_000_000_000,
      }, 900);
      const base = invoiceType === 'invoice.payment_succeeded'
        ? INVOICE_SUCCEEDED_EVENT
        : INVOICE_FAILED_EVENT;
      const suffix = invoiceType.endsWith('succeeded') ? 'paid' : 'failed';
      const delayed = event(
        `evt_delayed_previous_${suffix}`,
        invoiceType,
        {
          ...base.data.object,
          id: `in_delayed_previous_${suffix}`,
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_old' },
          },
        },
        800,
      );
      const harness = setup({
        stripeEvent: replacement,
        emailConfigured: true,
        usageAlerts: [{ id: 'alert_previous_subscription', userId: 'u1' }],
      });

      assert.equal((await deliver(harness.app)).status, 200);
      harness.setStripeEvent(delayed);
      assert.equal((await deliver(harness.app)).status, 200);

      assert.equal(harness.db._state.users[0].stripeSubscriptionId, 'sub_current');
      assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
      assert.equal(harness.db._state.users[0].apiUsage, 900n);
      assert.equal(harness.db._state.users[0].monthlyCallLimit, 4n);
      assert.equal(harness.db._state.usageAlerts.length, 1);
      assert.equal(harness.db._state.invoices.length, 1);
      assert.equal(harness.db._state.invoices[0].stripeSubscriptionId, 'sub_old');
      assert.equal(harness.db._state.notifications.length, 0);
      assert.equal(harness.external.triggerAttempts, 0);
      assert.equal(harness.external.emailAttempts, 0);
      const delayedRecord = harness.db._state.subscriptionEvents.find(
        (candidate) => candidate.stripeEventId === delayed.id,
      );
      assert.equal(delayedRecord.eventData.processing.disposition, 'no_op');
      assert.equal(delayedRecord.eventData.processing.reason, 'subscription_id_mismatch');
      const upsertIndex = harness.db._operations.lastIndexOf('invoice.atomicUpsert');
      const fenceReadIndex = harness.db._operations.lastIndexOf('user.findUnique:inside');
      assert.ok(upsertIndex >= 0 && upsertIndex < fenceReadIndex);
    });
  }

  test('invoice ordering is independent from newer entitlement lifecycle events', async () => {
    const newerUpdate = event('evt_z_newer_than_invoice', 'customer.subscription.updated', {
      id: 'sub_old',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_800_000_000,
    }, 900);
    const staleInvoice = event('evt_a_stale_cycle_invoice', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_stale_cycle',
    }, 800);
    const harness = setup({
      stripeEvent: newerUpdate,
      usageAlerts: [{ id: 'alert_stale_invoice', userId: 'u1' }],
    });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(staleInvoice);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].apiUsage, 0);
    assert.equal(harness.db._state.users[0].monthlyCallLimit, 0);
    assert.equal(harness.db._state.usageAlerts.length, 0);
    assert.equal(harness.external.triggerAttempts, 1);
    const row = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === staleInvoice.id,
    );
    assert.equal(row.eventData.processing.disposition, 'applied');
    assert.equal(row.eventData.processing.reason, null);
  });

  test('a delayed deletion still cancels after a newer final invoice', async () => {
    const finalInvoice = event('evt_final_invoice_newer', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_before_delayed_delete',
    }, 900);
    const delayedDelete = event('evt_delayed_delete', 'customer.subscription.deleted', {
      ...SUBSCRIPTION_DELETED_EVENT.data.object,
      ended_at: 1_700_000_200,
    }, 800);
    const harness = setup({ stripeEvent: finalInvoice });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(delayedDelete);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].plan, 'FREE');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'canceled');
    const deletionRecord = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === delayedDelete.id,
    );
    assert.equal(deletionRecord.eventData.processing.disposition, 'applied');
    assert.equal(deletionRecord.eventData.processing.reason, null);
  });

  test('a newer invoice can never supersede an applied cancellation', async () => {
    const cancellation = event('evt_cancellation_first', 'customer.subscription.deleted', {
      ...SUBSCRIPTION_DELETED_EVENT.data.object,
      ended_at: 1_700_000_200,
    }, 800);
    const laterInvoice = event('evt_invoice_after_cancellation', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_after_cancellation',
    }, 900);
    const harness = setup({ stripeEvent: cancellation });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(laterInvoice);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].plan, 'FREE');
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'canceled');
    assert.equal(harness.db._state.invoices[0].status, 'PAID');
  });

  test('every valid invoice mirrors before PAID semantically suppresses an equal-second failure', async () => {
    const paid = event('evt_z_invoice_paid_equal', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_monotonic_paid',
    }, 1_000);
    const staleFailure = event('evt_a_invoice_failed_equal', 'invoice.payment_failed', {
      ...INVOICE_FAILED_EVENT.data.object,
      id: 'in_monotonic_paid',
    }, 1_000);
    const harness = setup({
      stripeEvent: paid,
      emailConfigured: true,
    });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(staleFailure);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.invoices.length, 1);
    assert.equal(harness.db._state.invoices[0].status, 'PAID');
    assert.equal(harness.db._attempts.invoiceUpserts, 2);
    assert.equal(harness.db._state.notifications.length, 0);
    assert.equal(harness.external.emailAttempts, 0);
    const suppressedRecord = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === staleFailure.id,
    );
    assert.equal(suppressedRecord.eventData.processing.disposition, 'no_op');
    assert.equal(suppressedRecord.eventData.processing.reason, 'invoice_status_regression');
  });

  test('PAID suppresses a lexically later equal-second failure without failed-payment effects', async () => {
    const paid = event('evt_a_invoice_paid_equal', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_semantic_paid_first',
    }, 1_001);
    const failure = event('evt_z_invoice_failed_equal', 'invoice.payment_failed', {
      ...INVOICE_FAILED_EVENT.data.object,
      id: 'in_semantic_paid_first',
    }, 1_001);
    const harness = setup({
      stripeEvent: paid,
      emailConfigured: true,
    });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(failure);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.invoices[0].status, 'PAID');
    assert.equal(harness.db._attempts.invoiceUpserts, 2);
    assert.equal(harness.db._state.notifications.length, 0);
    assert.equal(harness.external.emailAttempts, 0);
    assert.equal(
      harness.db._state.subscriptionEvents[1].eventData.processing.reason,
      'invoice_status_regression',
    );
  });

  test('equal-second succeeded/PAID supersedes failure despite reverse event IDs', async () => {
    const failure = event('evt_z_invoice_failure_first', 'invoice.payment_failed', {
      ...INVOICE_FAILED_EVENT.data.object,
      id: 'in_semantic_paid_later',
    }, 1_002);
    const paid = event('evt_a_invoice_paid_later', 'invoice.payment_succeeded', {
      ...INVOICE_SUCCEEDED_EVENT.data.object,
      id: 'in_semantic_paid_later',
    }, 1_002);
    const harness = setup({
      stripeEvent: failure,
      emailConfigured: true,
      usageAlerts: [{ id: 'alert_semantic_paid', userId: 'u1' }],
    });

    assert.equal((await deliver(harness.app)).status, 200);
    harness.setStripeEvent(paid);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.invoices[0].status, 'PAID');
    assert.equal(harness.db._state.users[0].apiUsage, 0);
    assert.equal(harness.db._state.users[0].monthlyCallLimit, 0);
    assert.equal(harness.db._state.usageAlerts.length, 0);
    assert.equal(harness.external.triggerAttempts, 2);
    const paidRecord = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === paid.id,
    );
    assert.equal(paidRecord.eventData.processing.disposition, 'applied');
    assert.equal(paidRecord.eventData.processing.reason, null);
  });

  test('equal-second subscription update semantically outranks checkout regardless of event ID', async () => {
    const checkout = event('evt_z_checkout_latest', 'checkout.session.completed', {
      ...CHECKOUT_EVENT.data.object,
      id: 'cs_latest',
      subscription: { id: 'sub_checkout_latest' },
    }, 1_000);
    const equalSecondOlderUpdate = event(
      'evt_a_update_behind_checkout',
      'customer.subscription.updated',
      {
        id: 'sub_checkout_latest',
        customer: { id: 'cus_1' },
        status: 'past_due',
        current_period_end: 1_700_000_000,
      },
      1_000,
    );
    const harness = setup({
      stripeEvent: checkout,
      user: baseUser({
        plan: 'FREE',
        monthlyLimit: 1_000n,
        gemaTokenLimit: 0n,
      }),
      payments: [{
        id: 'pay_checkout_latest',
        userId: 'u1',
        stripeSessionId: 'cs_latest',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
    });

    assert.equal((await deliver(harness.app)).status, 200);
    assert.equal(harness.db._state.users[0].stripeSubscriptionId, 'sub_checkout_latest');
    harness.setStripeEvent(equalSecondOlderUpdate);
    assert.equal((await deliver(harness.app)).status, 200);

    assert.equal(harness.db._state.users[0].subscriptionStatus, 'past_due');
    const row = harness.db._state.subscriptionEvents.find(
      (candidate) => candidate.stripeEventId === equalSecondOlderUpdate.id,
    );
    assert.equal(row.eventData.processing.disposition, 'applied');
    assert.equal(row.eventData.processing.reason, null);
  });

  test('checkout with expanded Stripe resources persists and mutates only normalized IDs', async () => {
    const expanded = event('evt_checkout_expanded', 'checkout.session.completed', {
      ...CHECKOUT_EVENT.data.object,
      id: 'cs_expanded',
      customer: { id: 'cus_1', email: 'not-persisted@example.com' },
      subscription: { id: 'sub_expanded', status: 'active' },
    }, 1_100);
    const harness = setup({
      stripeEvent: expanded,
      user: baseUser({ plan: 'FREE', monthlyLimit: 1_000n, gemaTokenLimit: 0n }),
      payments: [{
        id: 'pay_expanded',
        userId: 'u1',
        stripeSessionId: 'cs_expanded',
        stripeCustomerId: 'cus_1',
        status: 'PENDING',
        plan: 'PRO',
      }],
    });

    assert.equal((await deliver(harness.app)).status, 200);
    assert.equal(harness.db._state.users[0].stripeCustomerId, 'cus_1');
    assert.equal(harness.db._state.users[0].stripeSubscriptionId, 'sub_expanded');
    assert.equal(harness.db._state.payments[0].stripeSubscriptionId, 'sub_expanded');
    assert.equal(harness.db._state.subscriptionEvents[0].eventData.customerId, 'cus_1');
    assert.equal(harness.db._state.subscriptionEvents[0].eventData.subscriptionId, 'sub_expanded');
  });

  test('unresolved user is durably pending, returns 500, and redelivery recovers after mapping exists', async () => {
    const unresolvedEvent = event(
      'evt_unresolved_user_1',
      'customer.subscription.updated',
      {
        id: 'sub_pending',
        customer: 'cus_pending',
        status: 'active',
        current_period_end: 1_800_000_000,
        email: 'victim@example.com',
        metadata: { secret: 'do-not-persist-this' },
      },
      500,
    );
    const harness = setup({ stripeEvent: unresolvedEvent, user: null });

    const first = await deliver(harness.app);
    assert.equal(first.status, 500, 'Stripe must retry unresolved mappings');
    assert.equal(harness.db._state.subscriptionEvents.length, 0);
    assert.equal(harness.db._state.systemSettings.length, 1);
    assert.equal(
      harness.db._state.systemSettings[0].key,
      'stripe:webhook:unresolved:evt_unresolved_user_1',
    );
    let pending = JSON.parse(harness.db._state.systemSettings[0].value);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.attempts, 1);
    assert.equal(pending.event.id, unresolvedEvent.id);
    assert.equal(pending.event.data.object.customer, 'cus_pending');
    assert.doesNotMatch(harness.db._state.systemSettings[0].value, /victim@example\.com/);
    assert.doesNotMatch(harness.db._state.systemSettings[0].value, /do-not-persist-this/);

    const second = await deliver(harness.app);
    assert.equal(second.status, 500);
    pending = JSON.parse(harness.db._state.systemSettings[0].value);
    assert.equal(pending.attempts, 2);

    harness.db._state.users.push(baseUser({
      stripeCustomerId: 'cus_pending',
      stripeSubscriptionId: 'sub_pending',
      subscriptionStatus: 'past_due',
    }));
    const recovered = await deliver(harness.app);

    assert.equal(recovered.status, 200);
    assert.equal(harness.db._state.subscriptionEvents.length, 1);
    assert.equal(harness.db._state.users[0].subscriptionStatus, 'active');
    const resolved = JSON.parse(harness.db._state.systemSettings[0].value);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolvedUserId, 'u1');
    assert.ok(resolved.resolvedAt);
  });

  test('unknown verified event remains a side-effect-free 200', async () => {
    const unknown = event('evt_unknown_1', 'customer.tax_id.created', {
      id: 'txi_1',
      customer: 'cus_1',
    });
    const { app, db, external } = setup({ stripeEvent: unknown });

    const response = await deliver(app);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { received: true });
    assert.equal(db._state.subscriptionEvents.length, 0);
    assert.equal(db._operations.length, 0);
    assert.equal(external.posthog.length, 0);
    assert.equal(external.triggers.length, 0);
  });
});
