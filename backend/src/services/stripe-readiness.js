'use strict';

// Payment readiness is separate from the general reachability probe. This
// module never imports the Stripe singleton, reads an env file, creates a
// payment/session, or returns provider responses. Callers inject their client.
const PRODUCTION_ORIGIN = 'https://siragpt.com';
const WEBHOOK_URL = `${PRODUCTION_ORIGIN}/api/payments/stripe/webhook`;
const REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

function normalizedSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function secretMode(value) {
  const key = normalizedSecret(value);
  // Reject partial/masked examples. Prefix recognition is only a local
  // configuration check; authentication still needs the read-only probe.
  const match = /^(?:sk|rk)_(live|test)_[A-Za-z0-9]{16,}$/.exec(key);
  if (!match || /(?:redacted|masked|placeholder|yourkey)/i.test(key)) return null;
  return match[1];
}

function hasWebhookSecret(value) {
  const key = normalizedSecret(value);
  return /^whsec_[A-Za-z0-9]{16,}$/.test(key)
    && !/(?:redacted|masked|placeholder|yourkey)/i.test(key);
}

function isProductionFrontendOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.origin === PRODUCTION_ORIGIN
      && url.username === '' && url.password === ''
      && url.pathname === '/' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/** Pure local check. It never treats a test key as live in production. */
function inspectStripeConfiguration(env = {}) {
  const production = env.NODE_ENV === 'production';
  const mode = secretMode(env.STRIPE_SECRET_KEY);
  const checks = {
    secretKey: mode !== null,
    liveSecret: mode === 'live',
    webhookSecret: hasWebhookSecret(env.STRIPE_WEBHOOK_SECRET),
    frontendOrigin: isProductionFrontendOrigin(env.FRONTEND_URL),
  };
  const blockers = [];
  if (!checks.secretKey) blockers.push('STRIPE_SECRET_INVALID');
  else if (production && !checks.liveSecret) blockers.push('STRIPE_LIVE_SECRET_REQUIRED');
  if (production && !checks.webhookSecret) blockers.push('STRIPE_WEBHOOK_SECRET_REQUIRED');
  if (production && !checks.frontendOrigin) blockers.push('STRIPE_FRONTEND_ORIGIN_INVALID');
  return { ready: blockers.length === 0, mode, checks, blockers };
}

function boundedTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) ? Math.min(10_000, Math.max(1, Math.trunc(value))) : 5_000;
}

async function readProbe(fn, timeoutMs) {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe_timeout')), timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch {
    // Provider errors can contain credentials/account data. Deliberately do
    // not copy any fields or message into this diagnostic result.
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function endpointHasRequiredEvents(endpoint) {
  if (!Array.isArray(endpoint?.enabled_events)) return false;
  const events = new Set(endpoint.enabled_events);
  return events.has('*') || REQUIRED_WEBHOOK_EVENTS.every(event => events.has(event));
}

function safePortalConfiguration(configuration) {
  const features = configuration?.features;
  return configuration?.active === true
    && configuration?.metadata?.siragpt_billing === 'v1'
    && configuration?.livemode === true
    && features?.invoice_history?.enabled === true
    && features?.payment_method_update?.enabled === true
    && features?.subscription_cancel?.enabled === true
    && features?.subscription_cancel?.mode === 'at_period_end'
    && features?.subscription_update?.enabled === false;
}

/**
 * Read-only PRODUCTION readiness. All four requests are GETs, bounded and
 * without SDK retries. A true result is configuration/account readiness, not
 * proof of a successful charge or signed webhook delivery: Stripe does not
 * return an existing endpoint's signing secret, so that match cannot be
 * established by listing endpoints. Portal readiness never gates checkout.
 */
async function inspectStripeReadiness({ env = {}, stripe, timeoutMs = 5_000 } = {}) {
  const configuration = inspectStripeConfiguration({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    FRONTEND_URL: env.FRONTEND_URL,
  });
  const checks = {
    liveMode: false,
    chargesEnabled: false,
    webhookEndpoint: false,
    webhookEvents: false,
    portalConfigured: false,
  };
  const blockers = [...configuration.blockers];
  const warnings = [];
  const result = () => ({ ready: blockers.length === 0, configuration, checks, blockers, warnings });
  if (!configuration.ready) return result();

  const timeout = boundedTimeout(timeoutMs);
  const options = { timeout, maxNetworkRetries: 0 };
  const [account, balance, webhooks, portal] = await Promise.all([
    readProbe(() => stripe.accounts.retrieve(undefined, options), timeout),
    readProbe(() => stripe.balance.retrieve({}, options), timeout),
    readProbe(() => stripe.webhookEndpoints.list({ limit: 100 }, options), timeout),
    readProbe(() => stripe.billingPortal.configurations.list({ active: true, limit: 100 }, options), timeout),
  ]);

  if (!account.ok) blockers.push('STRIPE_ACCOUNT_PROBE_FAILED');
  else {
    checks.chargesEnabled = account.value?.charges_enabled === true;
    if (!checks.chargesEnabled) blockers.push('STRIPE_CHARGES_DISABLED');
    if (account.value?.payouts_enabled === false) warnings.push('STRIPE_PAYOUTS_DISABLED');
  }
  if (!balance.ok) blockers.push('STRIPE_MODE_PROBE_FAILED');
  else {
    checks.liveMode = balance.value?.livemode === true;
    if (!checks.liveMode) blockers.push('STRIPE_LIVE_MODE_UNVERIFIED');
  }

  if (!webhooks.ok) blockers.push('STRIPE_WEBHOOK_PROBE_FAILED');
  else {
    const endpoints = Array.isArray(webhooks.value?.data) ? webhooks.value.data.slice(0, 100) : [];
    const matches = endpoints.filter(endpoint => endpoint?.url === WEBHOOK_URL
      && endpoint?.status === 'enabled' && endpoint?.livemode === true);
    checks.webhookEndpoint = matches.length > 0;
    checks.webhookEvents = matches.some(endpointHasRequiredEvents);
    if (!checks.webhookEndpoint) blockers.push(webhooks.value?.has_more === true
      ? 'STRIPE_WEBHOOK_LIST_INCOMPLETE' : 'STRIPE_WEBHOOK_ENDPOINT_MISSING');
    else if (!checks.webhookEvents) blockers.push('STRIPE_WEBHOOK_EVENTS_MISSING');
  }

  if (!portal.ok) warnings.push('STRIPE_PORTAL_PROBE_FAILED');
  else {
    const configurations = Array.isArray(portal.value?.data) ? portal.value.data.slice(0, 100) : [];
    checks.portalConfigured = configurations.some(safePortalConfiguration);
    if (!checks.portalConfigured) warnings.push('STRIPE_PORTAL_NOT_READY');
  }
  warnings.push('STRIPE_WEBHOOK_SIGNATURE_NOT_VERIFIED');
  return result();
}

module.exports = {
  PRODUCTION_ORIGIN,
  WEBHOOK_URL,
  REQUIRED_WEBHOOK_EVENTS,
  inspectStripeConfiguration,
  inspectStripeReadiness,
};
