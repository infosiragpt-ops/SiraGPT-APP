'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.RATE_LIMIT_SENSITIVE_POLICY = 'memory';

const paymentsRouter = require('../src/routes/payments');
const creditsRouter = require('../src/routes/credits');

function routeHandlerNames(router, method, path) {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method.toLowerCase()]
  ));
  assert.ok(layer, `missing ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((entry) => entry.handle.name);
}

function routeHandlers(router, method, path) {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method.toLowerCase()]
  ));
  assert.ok(layer, `missing ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((entry) => entry.handle);
}

function assertAuthThenBilling(router, method, path, expectedAction) {
  const handles = routeHandlers(router, method, path);
  const handlers = handles.map((handle) => handle.name);
  const authIndex = handlers.indexOf('authenticateToken');
  const billingIndex = handlers.indexOf('billingRateLimit');
  assert.ok(authIndex >= 0, `${method.toUpperCase()} ${path} must authenticate`);
  assert.ok(billingIndex >= 0, `${method.toUpperCase()} ${path} must use the billing limiter`);
  assert.ok(
    authIndex < billingIndex,
    `${method.toUpperCase()} ${path} must authenticate before deriving user billing keys`,
  );
  const billing = handles[billingIndex];
  assert.equal(
    billing.rateLimitAction,
    expectedAction,
    `${method.toUpperCase()} ${path} must have its own billing bucket`,
  );
  assert.ok(
    billing.rateLimitIpLimit >= billing.rateLimitUserLimit * 5,
    `${method.toUpperCase()} ${path} must keep a substantially higher NAT-safe IP ceiling`,
  );
  return { handles, handlers, authIndex, billingIndex };
}

test('checkout and verification routes use dedicated authenticated billing limits', () => {
  for (const [method, path, action] of [
    ['post', '/stripe', 'checkout-stripe'],
    ['post', '/paypal', 'checkout-paypal'],
    ['post', '/mercadopago', 'checkout-mercadopago'],
    ['post', '/verify-session', 'verify-session'],
  ]) {
    assertAuthThenBilling(paymentsRouter, method, path, action);
  }

  const legacyGet = routeHandlerNames(paymentsRouter, 'get', '/verify-session');
  assert.ok(legacyGet.includes('authenticateToken'));
  assert.equal(
    legacyGet.includes('billingRateLimit'),
    false,
    'read-only legacy status must not consume the fulfillment bucket',
  );
});

test('plan and subscription mutation routes use dedicated authenticated billing limits', () => {
  const routes = [
    ['/plan-change/preview', 'plan-change-preview'],
    ['/plan-change/execute', 'plan-change-execute'],
    ['/plan-change/cancel', 'plan-change-cancel'],
    ['/subscription/cancel', 'subscription-cancel'],
    ['/subscription/reactivate', 'subscription-reactivate'],
    ['/instant', 'instant-subscription'],
  ];
  for (const [path, action] of routes) {
    assertAuthThenBilling(paymentsRouter, 'post', path, action);
  }
  assert.equal(
    new Set(routes.map(([, action]) => action)).size,
    routes.length,
    'billing mutation actions must not share buckets',
  );

  const instant = assertAuthThenBilling(
    paymentsRouter,
    'post',
    '/instant',
    'instant-subscription',
  );
  const superAdminIndex = instant.handlers.indexOf('requireInstantSuperAdmin');
  assert.ok(
    superAdminIndex > instant.authIndex && superAdminIndex < instant.billingIndex,
    'instant must authorize superadmin before consuming a billing bucket',
  );
});

test('admin credit grants and refunds authorize before dedicated billing limits', () => {
  const router = creditsRouter.adminRouter;
  const routerAuthIndex = router.stack.findIndex(
    (entry) => entry.handle.name === 'authenticateToken',
  );
  assert.ok(routerAuthIndex >= 0, 'admin router must authenticate');

  for (const [path, action] of [
    ['/grant', 'admin-credit-grant'],
    ['/refund', 'admin-credit-refund'],
  ]) {
    const routeIndex = router.stack.findIndex((entry) => (
      entry.route
      && entry.route.path === path
      && entry.route.methods.post
    ));
    assert.ok(routerAuthIndex < routeIndex, `${path} must authenticate at router scope`);
    const handles = routeHandlers(router, 'post', path);
    const authzIndex = handles.findIndex(
      (handle) => handle.name === 'requireCreditSuperAdmin',
    );
    const billingIndex = handles.findIndex(
      (handle) => handle.name === 'billingRateLimit',
    );
    assert.ok(authzIndex >= 0 && authzIndex < billingIndex, `${path} must authorize before limiting`);
    assert.equal(handles[billingIndex].rateLimitAction, action);
    assert.ok(
      handles[billingIndex].rateLimitIpLimit
        >= handles[billingIndex].rateLimitUserLimit * 5,
      `${path} must keep a substantially higher NAT-safe IP ceiling`,
    );
  }
});
