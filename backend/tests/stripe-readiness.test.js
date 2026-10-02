'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const {
  WEBHOOK_URL,
  REQUIRED_WEBHOOK_EVENTS,
  inspectStripeConfiguration,
  inspectStripeReadiness,
} = require('../src/services/stripe-readiness');

const liveKey = ['sk', 'live', 'A'.repeat(24)].join('_');
const webhookSecret = ['whsec', 'B'.repeat(24)].join('_');
const testKey = ['sk', 'test', 'C'.repeat(24)].join('_');
const liveEnv = Object.freeze({
  NODE_ENV: 'production',
  STRIPE_SECRET_KEY: liveKey,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  FRONTEND_URL: 'https://siragpt.com',
});

function endpoint(overrides = {}) {
  return { url: WEBHOOK_URL, status: 'enabled', livemode: true, enabled_events: [...REQUIRED_WEBHOOK_EVENTS], ...overrides };
}

function portalConfiguration(overrides = {}) {
  return {
    active: true, is_default: false, livemode: true, metadata: { siragpt_billing: 'v1' },
    features: {
      invoice_history: { enabled: true }, payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false },
    },
    ...overrides,
  };
}

function client(overrides = {}) {
  const calls = [];
  const responses = {
    account: { charges_enabled: true, payouts_enabled: true },
    balance: { livemode: true },
    webhooks: { data: [endpoint()], has_more: false },
    portal: { data: [portalConfiguration()], has_more: false },
    ...overrides,
  };
  const read = name => async (...args) => {
    calls.push({ name, args });
    const value = responses[name];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value() : value;
  };
  return {
    calls,
    stripe: {
      accounts: { retrieve: read('account') }, balance: { retrieve: read('balance') },
      webhookEndpoints: { list: read('webhooks') },
      billingPortal: { configurations: { list: read('portal') } },
    },
  };
}

test('production configuration requires live credentials, signing secret and the canonical HTTPS origin', () => {
  const ready = inspectStripeConfiguration(liveEnv);
  assert.equal(ready.ready, true);
  assert.equal(ready.mode, 'live');
  assert.deepEqual(ready.blockers, []);
  for (const [change, blocker] of [
    [{ STRIPE_SECRET_KEY: testKey }, 'STRIPE_LIVE_SECRET_REQUIRED'],
    [{ STRIPE_SECRET_KEY: '' }, 'STRIPE_SECRET_INVALID'],
    [{ STRIPE_SECRET_KEY: 'sk_live_...' }, 'STRIPE_SECRET_INVALID'],
    [{ STRIPE_SECRET_KEY: 'sk_live_' + 'masked'.repeat(6) }, 'STRIPE_SECRET_INVALID'],
    [{ STRIPE_WEBHOOK_SECRET: undefined }, 'STRIPE_WEBHOOK_SECRET_REQUIRED'],
    [{ STRIPE_WEBHOOK_SECRET: 'whsec_...' }, 'STRIPE_WEBHOOK_SECRET_REQUIRED'],
    [{ FRONTEND_URL: undefined }, 'STRIPE_FRONTEND_ORIGIN_INVALID'],
  ]) {
    const actual = inspectStripeConfiguration({ ...liveEnv, ...change });
    assert.equal(actual.ready, false);
    assert.ok(actual.blockers.includes(blocker));
  }
  assert.equal(inspectStripeConfiguration({ ...liveEnv, STRIPE_SECRET_KEY: liveKey.replace('sk_', 'rk_') }).ready, true);
});

test('the local check rejects unsafe and ambiguous checkout redirect origins', () => {
  for (const FRONTEND_URL of [
    'http://siragpt.com', 'https://siragpt.com.evil.example', 'https://evil.example',
    'https://siragpt.com@evil.example', 'https://user:pass@siragpt.com',
    'https://siragpt.com:8443', 'https://siragpt.com/path',
    'https://siragpt.com?redirect=https://evil.example', 'https://siragpt.com/#section',
    '//siragpt.com', 'javascript:alert(1)', 'https://localhost:3000',
  ]) {
    assert.equal(inspectStripeConfiguration({ ...liveEnv, FRONTEND_URL }).ready, false, FRONTEND_URL);
  }
  assert.equal(inspectStripeConfiguration({ ...liveEnv, FRONTEND_URL: 'https://siragpt.com/' }).ready, true);
});

test('development can use a test key but never passes the production account probe', async () => {
  const env = { NODE_ENV: 'test', STRIPE_SECRET_KEY: testKey };
  assert.equal(inspectStripeConfiguration(env).ready, true);
  const fake = client();
  const result = await inspectStripeReadiness({ env, stripe: fake.stripe });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes('STRIPE_LIVE_SECRET_REQUIRED'));
  assert.equal(fake.calls.length, 0);
});

test('missing configuration never calls the provider or implicitly reads process.env', async () => {
  const fake = client();
  const result = await inspectStripeReadiness({ stripe: fake.stripe });
  assert.equal(result.ready, false);
  assert.equal(fake.calls.length, 0);
  assert.equal(inspectStripeConfiguration().ready, false);
});

test('readiness requires charge capability, live mode and one complete matching webhook', async () => {
  const fake = client();
  const result = await inspectStripeReadiness({ env: liveEnv, stripe: fake.stripe });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, ['STRIPE_WEBHOOK_SIGNATURE_NOT_VERIFIED']);
  assert.deepEqual(result.checks, {
    liveMode: true, chargesEnabled: true, webhookEndpoint: true, webhookEvents: true, portalConfigured: true,
  });
  assert.equal(fake.calls.length, 4);
  for (const call of fake.calls) assert.deepEqual(call.args.at(-1), { timeout: 5000, maxNetworkRetries: 0 });
  assert.deepEqual(fake.calls.find(c => c.name === 'webhooks').args[0], { limit: 100 });
  assert.deepEqual(fake.calls.find(c => c.name === 'portal').args[0], { active: true, limit: 100 });
});

test('unverified account fields and API failures cannot report readiness', async () => {
  for (const [overrides, blocker] of [
    [{ account: { charges_enabled: false } }, 'STRIPE_CHARGES_DISABLED'],
    [{ account: {} }, 'STRIPE_CHARGES_DISABLED'],
    [{ balance: { livemode: false } }, 'STRIPE_LIVE_MODE_UNVERIFIED'],
    [{ balance: {} }, 'STRIPE_LIVE_MODE_UNVERIFIED'],
    [{ account: new Error('forbidden') }, 'STRIPE_ACCOUNT_PROBE_FAILED'],
    [{ balance: new Error('invalid credentials') }, 'STRIPE_MODE_PROBE_FAILED'],
    [{ webhooks: new Error('forbidden') }, 'STRIPE_WEBHOOK_PROBE_FAILED'],
  ]) {
    const result = await inspectStripeReadiness({ env: liveEnv, stripe: client(overrides).stripe });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.includes(blocker));
  }
});

test('disabled, test-mode, foreign and incomplete webhooks are not accepted', async () => {
  for (const item of [
    endpoint({ status: 'disabled' }), endpoint({ livemode: false }),
    endpoint({ url: WEBHOOK_URL + '?ignored=1' }), endpoint({ url: 'https://evil.example/api/payments/stripe/webhook' }),
    endpoint({ url: 'https://siragpt.com.evil.example/api/payments/stripe/webhook' }),
    endpoint({ enabled_events: ['checkout.session.completed'] }),
  ]) {
    const result = await inspectStripeReadiness({ env: liveEnv, stripe: client({ webhooks: { data: [item] } }).stripe });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some(code => /^STRIPE_WEBHOOK_(?:ENDPOINT|EVENTS)_MISSING$/.test(code)));
  }
  const union = [endpoint({ enabled_events: REQUIRED_WEBHOOK_EVENTS.slice(0, 3) }), endpoint({ enabled_events: REQUIRED_WEBHOOK_EVENTS.slice(3) })];
  assert.equal((await inspectStripeReadiness({ env: liveEnv, stripe: client({ webhooks: { data: union } }).stripe })).ready, false);
  assert.equal((await inspectStripeReadiness({ env: liveEnv, stripe: client({ webhooks: { data: [endpoint({ enabled_events: ['*'] })] } }).stripe })).ready, true);
});

test('truncated webhook lists fail closed when the required endpoint was not found', async () => {
  const result = await inspectStripeReadiness({ env: liveEnv, stripe: client({ webhooks: { data: [], has_more: true } }).stripe });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes('STRIPE_WEBHOOK_LIST_INCOMPLETE'));
});

test('portal requirements never gate checkout but exclude plan changes and immediate cancellation', async () => {
  const good = portalConfiguration();
  for (const portal of [
    { data: [] },
    new Error('permission denied'),
    { data: [portalConfiguration({ livemode: false })] },
    { data: [portalConfiguration({ metadata: {}, is_default: true })] },
    { data: [portalConfiguration({ features: { ...good.features, subscription_update: { enabled: true } } })] },
    { data: [portalConfiguration({ features: { ...good.features, subscription_cancel: { enabled: true, mode: 'immediately' } } })] },
    { data: [portalConfiguration({ features: { ...good.features, payment_method_update: { enabled: false } } })] },
  ]) {
    const result = await inspectStripeReadiness({ env: liveEnv, stripe: client({ portal }).stripe });
    assert.equal(result.ready, true);
    assert.equal(result.checks.portalConfigured, false);
    assert.ok(result.warnings.some(code => code.startsWith('STRIPE_PORTAL_')));
  }
});

test('payout status is a distinct warning, not a claim that charges are disabled', async () => {
  const result = await inspectStripeReadiness({ env: liveEnv, stripe: client({ account: { charges_enabled: true, payouts_enabled: false } }).stripe });
  assert.equal(result.ready, true);
  assert.ok(result.warnings.includes('STRIPE_PAYOUTS_DISABLED'));
});

test('errors and responses never leak credentials, account identities, balances or endpoints', async () => {
  const privateValue = 'PRIVATE_ACCOUNT_CONTACT_AND_BALANCE';
  const failure = new Error(`${liveKey} ${webhookSecret} ${privateValue}`);
  failure.raw = { api_key: liveKey, account: privateValue };
  for (const overrides of [
    { account: failure, balance: failure, webhooks: failure, portal: failure },
    { account: { charges_enabled: true, id: privateValue, email: privateValue }, balance: { livemode: true, available: [{ amount: 987654321 }] } },
  ]) {
    const serialized = JSON.stringify(await inspectStripeReadiness({ env: liveEnv, stripe: client(overrides).stripe }));
    for (const value of [liveKey, webhookSecret, privateValue, '987654321', WEBHOOK_URL]) assert.equal(serialized.includes(value), false);
  }
});

test('a stalled client is bounded and cannot mark readiness true', async () => {
  const never = () => new Promise(() => {});
  const fake = client({ account: never, balance: never, webhooks: never, portal: never });
  const started = Date.now();
  const result = await inspectStripeReadiness({ env: liveEnv, stripe: fake.stripe, timeoutMs: 5 });
  assert.equal(result.ready, false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.blockers.length, 3);
  assert.ok(result.warnings.includes('STRIPE_PORTAL_PROBE_FAILED'));
});

test('the actual Stripe SDK emits only the four expected GET requests without writes', async () => {
  const requests = [];
  const stripe = new Stripe(liveKey, {
    httpClient: Stripe.createFetchHttpClient(async (url, options) => {
      const parsed = new URL(url);
      requests.push({ path: parsed.pathname, method: options.method, params: parsed.searchParams });
      const bodies = {
        '/v1/account': { charges_enabled: true, payouts_enabled: true },
        '/v1/balance': { livemode: true },
        '/v1/webhook_endpoints': { object: 'list', data: [endpoint()], has_more: false },
        '/v1/billing_portal/configurations': { object: 'list', data: [portalConfiguration()], has_more: false },
      };
      assert.ok(bodies[parsed.pathname], 'unexpected Stripe endpoint');
      return new Response(JSON.stringify(bodies[parsed.pathname]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });
  const result = await inspectStripeReadiness({ env: liveEnv, stripe });
  assert.equal(result.ready, true);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.method === 'GET'));
  assert.deepEqual(requests.map(request => request.path).sort(), ['/v1/account', '/v1/balance', '/v1/billing_portal/configurations', '/v1/webhook_endpoints']);
  assert.equal(requests.find(request => request.path === '/v1/webhook_endpoints').params.get('limit'), '100');
  assert.equal(requests.find(request => request.path === '/v1/billing_portal/configurations').params.has('is_default'), false);
});
