'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  COOKIE_AUTH_CSRF_MOUNTS,
  EXPENSIVE_GENERATION_MOUNTS,
  PUBLIC_GENERATED_APP_MOUNTS,
  createAuthCsrfMiddleware,
  createCookieAuthCsrfMiddleware,
  isExactSamlAssertionConsumerRequest,
} = require('../src/middleware/csrf-route-policy');

const REQUIRED_SURFACES = Object.freeze([
  '/api/ai',
  '/api/agent',
  '/api/codex',
  '/api/paraphrase',
  '/api/images',
  '/api/free-ia',
]);

function request(overrides = {}) {
  return {
    method: 'POST',
    originalUrl: '/api/new-cookie-auth-mutation',
    headers: {},
    cookies: { token: 'cookie-session' },
    ...overrides,
  };
}

function runPolicy(req) {
  let csrfCalls = 0;
  let nextCalls = 0;
  const middleware = createCookieAuthCsrfMiddleware((_req, _res, next) => {
    csrfCalls += 1;
    return next();
  });
  middleware(req, {}, () => {
    nextCalls += 1;
  });
  return { csrfCalls, nextCalls };
}

function runAuthPolicy(req) {
  let csrfCalls = 0;
  let nextCalls = 0;
  const middleware = createAuthCsrfMiddleware((_req, _res, next) => {
    csrfCalls += 1;
    return next();
  });
  middleware(req, {}, () => {
    nextCalls += 1;
  });
  return { csrfCalls, nextCalls };
}

test('route inventory covers requested and expensive cookie-auth generation surfaces', () => {
  for (const mount of REQUIRED_SURFACES) {
    assert.ok(COOKIE_AUTH_CSRF_MOUNTS.includes(mount), `missing CSRF inventory mount ${mount}`);
  }
  assert.ok(EXPENSIVE_GENERATION_MOUNTS.length >= 10, 'expensive generation inventory is incomplete');
  for (const mount of EXPENSIVE_GENERATION_MOUNTS) {
    assert.ok(COOKIE_AUTH_CSRF_MOUNTS.includes(mount), `expensive mount omitted from CSRF inventory: ${mount}`);
  }
  assert.deepEqual(PUBLIC_GENERATED_APP_MOUNTS, ['/api/apps-ai', '/api/apps-kv']);
});

test('catch-all policy protects arbitrary future cookie-auth API mutations', () => {
  assert.deepEqual(runPolicy(request()), { csrfCalls: 1, nextCalls: 1 });
});

test('catch-all policy bypasses unauthenticated public, safe, bearer, and API-key requests', () => {
  const cases = [
    request({ cookies: {} }),
    request({ method: 'GET' }),
    request({ headers: { authorization: 'Bearer jwt.value' } }),
    request({ headers: { authorization: 'Bearer sk_programmatic_key' } }),
    request({ authMethod: 'api_key', apiKey: { id: 'key-1' } }),
  ];
  for (const req of cases) {
    assert.deepEqual(runPolicy(req), { csrfCalls: 0, nextCalls: 1 });
  }
});

test('Stripe exemption is exact while generated-app exemptions are mount-boundary scoped', () => {
  for (const originalUrl of [
    '/api/payments/stripe/webhook',
    '/api/payments/stripe/webhook?delivery=retry',
    '/api/apps-ai/chat',
    '/api/apps-kv/project-1/items',
  ]) {
    assert.deepEqual(
      runPolicy(request({ originalUrl })),
      { csrfCalls: 0, nextCalls: 1 },
      `${originalUrl} should be exempt`,
    );
  }

  for (const originalUrl of [
    '/api/payments/stripe/webhook/child',
    '/api/payments/stripe/webhooks',
    '/api/apps-ai-evil/chat',
    '/api/apps-kv-evil/items',
  ]) {
    assert.deepEqual(
      runPolicy(request({ originalUrl })),
      { csrfCalls: 1, nextCalls: 1 },
      `${originalUrl} must remain protected`,
    );
  }
});

test('only exact SAML assertion-consumer POSTs bypass Sira CSRF', () => {
  for (const originalUrl of [
    '/api/auth/sso/acme/callback',
    '/api/auth/sso/team-2/callback?binding=post',
  ]) {
    const req = request({
      originalUrl,
      body: { SAMLResponse: 'signed-assertion' },
    });
    assert.equal(isExactSamlAssertionConsumerRequest(req), true, originalUrl);
    assert.deepEqual(runAuthPolicy(req), { csrfCalls: 0, nextCalls: 1 });
    assert.deepEqual(runPolicy(req), { csrfCalls: 0, nextCalls: 1 });
  }
});

test('SAML CSRF exemption rejects sibling paths, OIDC posts, and non-ACS auth writes', () => {
  const protectedRequests = [
    request({
      originalUrl: '/api/auth/sso/acme/callback/child',
      body: { SAMLResponse: 'signed-assertion' },
    }),
    request({
      originalUrl: '/api/auth/sso/acme/callbacks',
      body: { SAMLResponse: 'signed-assertion' },
    }),
    request({
      originalUrl: '/api/auth/sso/acme%2Fother/callback',
      body: { SAMLResponse: 'signed-assertion' },
    }),
    request({
      originalUrl: '/api/auth/sso/acme/callback',
      body: { code: 'oidc-code' },
    }),
    request({
      originalUrl: '/api/auth/sso/acme/callback',
      body: { samlResponse: 'non-standard-field' },
    }),
    request({
      originalUrl: '/api/auth/login',
      body: { SAMLResponse: 'signed-assertion' },
    }),
  ];

  for (const req of protectedRequests) {
    assert.equal(isExactSamlAssertionConsumerRequest(req), false, req.originalUrl);
    assert.deepEqual(runAuthPolicy(req), { csrfCalls: 1, nextCalls: 1 });
    assert.deepEqual(runPolicy(req), { csrfCalls: 1, nextCalls: 1 });
  }
});

test('index mounts the catch-all cookie-auth gate after cookies and before API routers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const cookieParserIndex = source.indexOf('app.use(cookieParser());');
  const csrfIndex = source.indexOf(
    "app.use('/api', createCookieAuthCsrfMiddleware(requireCsrf));",
  );
  const authCsrfIndex = source.indexOf(
    "app.use('/api/auth', createAuthCsrfMiddleware(requireCsrf));",
  );
  const firstRequestedRouterIndex = source.indexOf("app.use('/api/ai', aiRoutes);");

  assert.ok(cookieParserIndex >= 0, 'cookie parser mount missing');
  assert.ok(authCsrfIndex > cookieParserIndex, 'auth CSRF selector must run after cookie parsing');
  assert.ok(csrfIndex > cookieParserIndex, 'cookie-auth CSRF gate must run after cookie parsing');
  assert.ok(firstRequestedRouterIndex > csrfIndex, 'cookie-auth CSRF gate must run before API routers');
  assert.doesNotMatch(
    source,
    /app\.use\(['"]\/api\/apps-(?:ai|kv)['"],\s*requireCsrf/,
    'public generated-app mounts must not receive a strict CSRF gate',
  );
});
