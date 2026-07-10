'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

test.after(async () => {
  const prisma = require('../src/config/database');
  if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
});

function loadSubject() {
  try {
    return require('../src/services/observability/metrics-exposition');
  } catch (error) {
    if (
      error?.code === 'MODULE_NOT_FOUND'
      && String(error.message).includes('metrics-exposition')
    ) {
      assert.fail('metrics-exposition module must exist');
    }
    throw error;
  }
}

function metricFamilies(text) {
  return Array.from(text.matchAll(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) \w+$/gm), (match) => match[1]);
}

function assertValidPrometheusText(text) {
  const samplePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{.*\})? (?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[-+]?Inf|NaN)(?: \d+)?$/;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
    assert.match(line, samplePattern, `invalid Prometheus sample: ${line}`);
  }
}

function fakeRequest({
  remoteAddress = '203.0.113.10',
  authorization,
  ip = '203.0.113.10',
  headers = {},
  rawHeaders,
} = {}) {
  return {
    ip,
    socket: { remoteAddress },
    headers: {
      ...headers,
      ...(authorization ? { authorization } : {}),
    },
    rawHeaders,
    get(name) {
      return String(name).toLowerCase() === 'authorization' ? authorization : undefined;
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: Object.create(null),
    headersSent: false,
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    set(name, value) {
      this.setHeader(name, value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

test('composes process, utility, agent, cognitive, and Free IA metric families', () => {
  const { formatMetricsExposition, findDuplicateMetricFamilies } = loadSubject();
  const text = formatMetricsExposition();

  for (const family of [
    'siragpt_build_info',
    'siragpt_http_requests_total',
    'se_agent_invocations_total',
    'sira_chat_turns_total',
    'sira_cognitive_routing_total',
    'sira_free_ia_fallback_total',
  ]) {
    assert.match(text, new RegExp(`^# TYPE ${family} `, 'm'), `missing ${family}`);
  }

  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(findDuplicateMetricFamilies(text), []);
});

test('database pool estimate gauges are bounded, label-free, and include the advisory target', () => {
  const subject = loadSubject();
  const {
    DATABASE_POOL_GAUGE_BOUNDS,
    DATABASE_POOL_GAUGE_NAMES,
    configureDatabasePoolMetrics,
    formatMetricsExposition,
  } = subject;
  configureDatabasePoolMetrics({
    snapshot: () => ({
      capacity: { observable: true, reason: 'direct_postgres_datasource' },
      pool: { max: 10 },
      estimated_connections_active: Number.MAX_VALUE,
      estimated_connections_idle: -5,
      queries_in_flight: Number.POSITIVE_INFINITY,
      estimated_saturation_ratio: Number.MAX_VALUE,
    }),
    recommendation: () => ({
      running: true,
      currentLimit: 10,
      recommendedLimit: 9999,
    }),
  });

  try {
    const text = formatMetricsExposition();
    const expected = {
      [DATABASE_POOL_GAUGE_NAMES.capacityObservable]: 1,
      [DATABASE_POOL_GAUGE_NAMES.estimatedConnectionsActive]: DATABASE_POOL_GAUGE_BOUNDS.estimateMax,
      [DATABASE_POOL_GAUGE_NAMES.estimatedConnectionsIdle]: 0,
      [DATABASE_POOL_GAUGE_NAMES.queriesInFlight]: 0,
      [DATABASE_POOL_GAUGE_NAMES.estimatedSaturationRatio]: DATABASE_POOL_GAUGE_BOUNDS.ratioMax,
      [DATABASE_POOL_GAUGE_NAMES.currentLimit]: 10,
      [DATABASE_POOL_GAUGE_NAMES.recommendedLimit]: DATABASE_POOL_GAUGE_BOUNDS.limitMax,
      [DATABASE_POOL_GAUGE_NAMES.autoscalerRunning]: 1,
    };

    for (const [name, value] of Object.entries(expected)) {
      assert.match(text, new RegExp(`^# TYPE ${name} gauge$`, 'm'));
      assert.match(text, new RegExp(`^${name} ${value}$`, 'm'));
      const metric = require('../src/utils/metrics').registry.get(name);
      assert.deepEqual(metric.labels, [], `${name} must remain low-cardinality`);
      assert.ok(metric.series.size <= 1, `${name} emitted more than one series`);
    }
  } finally {
    configureDatabasePoolMetrics();
  }
});

test('unobservable remote capacity omits local estimates, limits, and recommendations', () => {
  const subject = loadSubject();
  const {
    DATABASE_POOL_GAUGE_NAMES,
    configureDatabasePoolMetrics,
    formatMetricsExposition,
  } = subject;
  configureDatabasePoolMetrics({
    snapshot: () => ({
      capacity: { observable: false, reason: 'remote_prisma_datasource' },
      pool: null,
      estimated_connections_active: null,
      estimated_connections_idle: null,
      estimated_saturation_ratio: null,
      queries_in_flight: 3,
    }),
    recommendation: () => ({
      running: true,
      recommendedLimit: 99,
    }),
  });

  try {
    const text = formatMetricsExposition();
    assert.match(text, new RegExp(`^${DATABASE_POOL_GAUGE_NAMES.capacityObservable} 0$`, 'm'));
    assert.match(text, new RegExp(`^${DATABASE_POOL_GAUGE_NAMES.queriesInFlight} 3$`, 'm'));
    assert.match(text, new RegExp(`^${DATABASE_POOL_GAUGE_NAMES.autoscalerRunning} 0$`, 'm'));
    for (const name of [
      DATABASE_POOL_GAUGE_NAMES.estimatedConnectionsActive,
      DATABASE_POOL_GAUGE_NAMES.estimatedConnectionsIdle,
      DATABASE_POOL_GAUGE_NAMES.estimatedSaturationRatio,
      DATABASE_POOL_GAUGE_NAMES.currentLimit,
      DATABASE_POOL_GAUGE_NAMES.recommendedLimit,
    ]) {
      assert.doesNotMatch(text, new RegExp(`^${name} (?:[-+]?\\d|NaN)`, 'm'));
    }
  } finally {
    configureDatabasePoolMetrics();
  }
});

test('emits one HELP and TYPE declaration for every metric family', () => {
  const { formatMetricsExposition } = loadSubject();
  const text = formatMetricsExposition();
  const families = metricFamilies(text);

  assertValidPrometheusText(text);
  assert.ok(families.length > 20, 'expected the combined registry inventory');
  assert.equal(new Set(families).size, families.length, 'duplicate TYPE declarations');
  for (const family of families) {
    const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal((text.match(new RegExp(`^# HELP ${escaped}(?: |$)`, 'gm')) || []).length, 1);
    assert.equal((text.match(new RegExp(`^# TYPE ${escaped}(?: |$)`, 'gm')) || []).length, 1);
  }
});

test('rejects duplicate metric families while composing exposition sources', () => {
  const { composeExpositions } = loadSubject();
  assert.throws(
    () => composeExpositions([
      '# HELP duplicate_family first\n# TYPE duplicate_family counter\nduplicate_family 1\n',
      '# HELP duplicate_family second\n# TYPE duplicate_family gauge\nduplicate_family 2\n',
    ]),
    /duplicate Prometheus metric family.*duplicate_family/i,
  );
});

test('local bypass trusts only the socket peer address', () => {
  const { isLoopbackPeer } = loadSubject();

  assert.equal(isLoopbackPeer(fakeRequest({ remoteAddress: '127.0.0.42' })), true);
  assert.equal(isLoopbackPeer(fakeRequest({ remoteAddress: '::1' })), true);
  assert.equal(isLoopbackPeer(fakeRequest({ remoteAddress: '::ffff:127.0.0.9' })), true);
  assert.equal(
    isLoopbackPeer(fakeRequest({ remoteAddress: '203.0.113.10', ip: '127.0.0.1' })),
    false,
    'req.ip must not grant the local bypass',
  );
});

test('Bearer metrics token comparison accepts exact tokens and rejects mismatches', () => {
  const { constantTimeTokenEquals } = loadSubject();

  assert.equal(constantTimeTokenEquals('scrape-secret', 'scrape-secret'), true);
  assert.equal(constantTimeTokenEquals('wrong', 'scrape-secret'), false);
  assert.equal(constantTimeTokenEquals('scrape-secret-extra', 'scrape-secret'), false);
  assert.equal(constantTimeTokenEquals(undefined, 'scrape-secret'), false);
});

test('authorizeMetricsRequest requires credentials for production loopback unless explicitly enabled', async () => {
  const { authorizeMetricsRequest } = loadSubject();
  let authCalls = 0;
  const authMiddlewares = [
    (_req, res) => {
      authCalls += 1;
      return res.status(401).json({ error: 'Access token required' });
    },
  ];
  const directLoopback = fakeRequest({ remoteAddress: '::1' });

  const productionResponse = fakeResponse();
  assert.equal(await authorizeMetricsRequest(directLoopback, productionResponse, {
    env: { NODE_ENV: 'production' },
    authMiddlewares,
  }), false);
  assert.equal(productionResponse.statusCode, 401);
  assert.equal(authCalls, 1);

  assert.equal(await authorizeMetricsRequest(directLoopback, fakeResponse(), {
    env: {
      NODE_ENV: 'production',
      METRICS_ALLOW_LOOPBACK: 'true',
    },
    authMiddlewares,
  }), true);
  assert.equal(authCalls, 1);

  assert.equal(await authorizeMetricsRequest(directLoopback, fakeResponse(), {
    env: { NODE_ENV: 'test' },
    authMiddlewares,
  }), true);
  assert.equal(authCalls, 1);
});

test('createMetricsAccessPolicy never grants proxy-marked loopback bypass', async () => {
  const { createMetricsAccessPolicy } = loadSubject();
  let authCalls = 0;
  const policy = createMetricsAccessPolicy({
    env: { NODE_ENV: 'test' },
    authMiddlewares: [
      (_req, res) => {
        authCalls += 1;
        return res.status(401).json({ error: 'Access token required' });
      },
    ],
  });

  for (const requestOptions of [
    { headers: { forwarded: 'for=203.0.113.7' } },
    { headers: { 'x-forwarded-for': '203.0.113.7' } },
    { headers: { 'x-forwarded-host': 'api.example.test' } },
    { headers: { 'X-Forwarded-Custom': 'present' } },
    { rawHeaders: ['Forwarded', 'for=203.0.113.7'] },
  ]) {
    const res = fakeResponse();
    let nextCalled = false;
    await policy(
      fakeRequest({ remoteAddress: '127.0.0.1', ...requestOptions }),
      res,
      (error) => {
        if (error) throw error;
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(authCalls, 5);
});

test('shared handler allows a valid metrics token without JWT middleware', async () => {
  const { createMetricsHandler } = loadSubject();
  let authCalls = 0;
  const handler = createMetricsHandler({
    env: {
      NODE_ENV: 'production',
      METRICS_TOKEN: 'scrape-secret',
    },
    authMiddlewares: [
      (_req, _res, next) => {
        authCalls += 1;
        next();
      },
    ],
    render: () => '# HELP test_metric test\n# TYPE test_metric gauge\ntest_metric 1\n',
  });
  const res = fakeResponse();

  await handler(
    fakeRequest({
      remoteAddress: '127.0.0.1',
      authorization: 'Bearer scrape-secret',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    }),
    res,
    (error) => { if (error) throw error; },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(authCalls, 0);
  assert.match(res.headers['content-type'], /^text\/plain; version=0\.0\.4/);
  assert.match(res.body, /^# HELP test_metric/m);
});

test('shared handler returns 401 for a wrong token', async () => {
  const { createMetricsHandler } = loadSubject();
  const handler = createMetricsHandler({
    env: { METRICS_TOKEN: 'scrape-secret' },
    authMiddlewares: [
      (_req, res) => res.status(401).json({ error: 'Invalid or expired token' }),
    ],
    render: () => 'must not render',
  });
  const res = fakeResponse();

  await handler(
    fakeRequest({ authorization: 'Bearer wrong-token' }),
    res,
    (error) => { if (error) throw error; },
  );

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired token' });
});

test('shared handler denies an authenticated non-superadmin with 403', async () => {
  const { createMetricsHandler } = loadSubject();
  const { requireAdmin, requireSuperAdmin } = require('../src/middleware/auth');
  const handler = createMetricsHandler({
    env: { METRICS_TOKEN: 'scrape-secret' },
    authMiddlewares: [
      (req, _res, next) => {
        req.user = { id: 'regular-user', isAdmin: false, isSuperAdmin: false };
        next();
      },
      requireAdmin,
      requireSuperAdmin,
    ],
    render: () => 'must not render',
  });
  const res = fakeResponse();

  await handler(
    fakeRequest({ authorization: 'Bearer valid-user-jwt' }),
    res,
    (error) => { if (error) throw error; },
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Admin access required' });
});

test('spoofed proxy IP does not bypass authentication', async () => {
  const { createMetricsHandler } = loadSubject();
  let authCalls = 0;
  const handler = createMetricsHandler({
    env: {},
    authMiddlewares: [
      (_req, res) => {
        authCalls += 1;
        res.status(401).json({ error: 'Access token required' });
      },
    ],
    render: () => 'must not render',
  });
  const res = fakeResponse();

  await handler(
    fakeRequest({ remoteAddress: '198.51.100.8', ip: '127.0.0.1' }),
    res,
    (error) => { if (error) throw error; },
  );

  assert.equal(authCalls, 1);
  assert.equal(res.statusCode, 401);
});

test('metrics session guard denies API keys and JWTs without a validated session', () => {
  const { requireSessionMetricsAuth } = loadSubject();

  for (const req of [
    { authMethod: 'api_key', userSession: { id: 'not-relevant' } },
    { authMethod: 'jwt' },
  ]) {
    const res = fakeResponse();
    let nextCalled = false;
    requireSessionMetricsAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  }

  const res = fakeResponse();
  let nextCalled = false;
  requireSessionMetricsAuth(
    { authMethod: 'jwt', userSession: { id: 'session-1' } },
    res,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(res.headersSent, false);
});

test('shared handler renders before setting Prometheus Content-Type and forwards render errors', async () => {
  const { createMetricsHandler } = loadSubject();
  const failure = new Error('metrics render failed');
  const handler = createMetricsHandler({
    accessPolicy: (_req, _res, next) => next(),
    render: () => { throw failure; },
  });
  const res = fakeResponse();
  let forwarded;

  await handler(fakeRequest(), res, (error) => { forwarded = error; });

  assert.equal(forwarded, failure);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], undefined);
  assert.equal(res.headersSent, false);
});

test('central label escaping blocks CR/LF injection and escapes quotes and backslashes', () => {
  const {
    escapePrometheusLabelValue,
  } = require('../src/utils/prometheus-labels');
  const escaped = escapePrometheusLabelValue('line1\r\nline2\nline3"\\tail');

  assert.equal(escaped, 'line1\\nline2\\nline3\\"\\\\tail');
  assert.equal(escaped.includes('\r'), false);
  assert.equal(escaped.includes('\n'), false);
});

test('Free-IA exposition cannot be newline-poisoned through feature or error-code labels', () => {
  const freeIaMetrics = require('../src/services/free-ia-metrics');
  freeIaMetrics.reset();
  freeIaMetrics.recordFallback({ feature: 'chat\r\ninjected_metric 1"\\tail', amount: 1 });
  freeIaMetrics.recordUpstreamError({ code: 'HTTP 503\r\ninjected_metric 1"\\tail' });

  const text = freeIaMetrics.toPrometheusText();
  assert.equal(text.includes('\r'), false);
  assert.equal(text.split('\n').some((line) => line.startsWith('injected_metric ')), false);
  assert.ok(text.includes('feature="chat\\ninjected_metric 1\\"\\\\tail"'));
});

test('Free-IA error-code labels are normalized and automatically capped', () => {
  const freeIaMetrics = require('../src/services/free-ia-metrics');
  const { MAX_ERROR_CODE_LABELS } = freeIaMetrics;
  freeIaMetrics.reset();

  for (let i = 0; i < MAX_ERROR_CODE_LABELS + 25; i += 1) {
    freeIaMetrics.recordUpstreamError({ code: ` Error ${i} / tenant-${i} ` });
  }

  const byCode = freeIaMetrics.snapshot().upstream.errorsByCode;
  assert.ok(Object.keys(byCode).length <= MAX_ERROR_CODE_LABELS);
  assert.ok(byCode.__other__ > 0, 'overflow labels must fold into __other__');
  assert.equal(Object.keys(byCode).some((code) => /[\s/]/.test(code)), false);
});

test('combined exposition safely escapes malicious labels from both registries', () => {
  const utilityMetrics = require('../src/utils/metrics');
  const agentMetrics = require('../src/services/agents/metrics');
  const utilityName = 'test_utility_malicious_labels_total';
  const agentName = 'test_agent_malicious_labels_total';
  const malicious = 'line1\r\ninjected_metric 1"\\tail';

  utilityMetrics.registerCounter(utilityName, { help: 'test', labels: ['value'] });
  agentMetrics.registerCounter(agentName, { help: 'test', labels: ['value'] });
  utilityMetrics.counter(utilityName, { value: malicious });
  agentMetrics.counter(agentName, { value: malicious });

  try {
    const text = loadSubject().formatMetricsExposition();
    assert.equal(text.includes('\r'), false);
    assert.equal(text.split('\n').some((line) => line.startsWith('injected_metric ')), false);
    const escapedLabels = '{value="line1\\ninjected_metric 1\\"\\\\tail"} 1';
    assert.ok(text.includes(`${utilityName}${escapedLabels}`));
    assert.ok(text.includes(`${agentName}${escapedLabels}`));
  } finally {
    utilityMetrics.registry.get(utilityName)?.series.clear();
    agentMetrics.registry.get(agentName)?.series.clear();
  }
});

test('shared path classifier excludes all metrics aliases and only those aliases', () => {
  const {
    classifyRequestClass,
    classifyStatusClass,
    isMetricsRequest,
    matchedRouteLabel,
  } = require('../src/services/observability/metrics-paths');

  for (const path of ['/metrics', '/internal/metrics', '/api/se-agents/metrics']) {
    assert.equal(isMetricsRequest({ path }), true);
    assert.equal(isMetricsRequest({ originalUrl: `${path}?scrape=1` }), true);
    assert.equal(isMetricsRequest({ path: `${path}/` }), true);
  }
  assert.equal(isMetricsRequest({ path: '/api/free-ia/metrics' }), false);
  assert.equal(isMetricsRequest({ path: '/metrics-extra' }), false);
  assert.equal(
    matchedRouteLabel({ path: '/api/users/user-123', route: undefined }),
    'unmatched',
  );
  assert.equal(
    matchedRouteLabel({ baseUrl: '/api/users', route: { path: '/:id' } }),
    '/api/users/:id',
  );

  const jsonResponse = {
    getHeader(name) {
      return String(name).toLowerCase() === 'content-type'
        ? 'application/json; charset=utf-8'
        : undefined;
    },
  };
  const sseResponse = {
    getHeader(name) {
      return String(name).toLowerCase() === 'content-type'
        ? 'Text/Event-Stream; charset=utf-8'
        : undefined;
    },
  };
  assert.equal(classifyRequestClass({ path: '/api/chats' }, jsonResponse), 'standard');
  assert.equal(classifyRequestClass({ path: '/api/ai/generate' }, sseResponse), 'streaming');
  for (const healthPath of [
    '/health',
    '/health/ready',
    '/api/health/live',
    '/healthz',
    '/livez',
    '/readyz',
    '/api/ready',
    '/internal/health/history',
  ]) {
    assert.equal(
      classifyRequestClass({ originalUrl: `${healthPath}?probe=1` }, sseResponse),
      'health',
      healthPath,
    );
  }
  assert.equal(
    classifyRequestClass({ path: '/api/provider/health-report' }, jsonResponse),
    'standard',
  );
  for (const [status, expected] of [
    [100, '1xx'],
    [204, '2xx'],
    [302, '3xx'],
    [404, '4xx'],
    [503, '5xx'],
    [99, 'other'],
    ['not-a-status', 'other'],
  ]) {
    assert.equal(classifyStatusClass(status), expected);
  }
});

test('matched route labels normalize obvious dynamic base segments only', () => {
  const {
    matchedRouteLabel,
  } = require('../src/services/observability/metrics-paths');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const cuid = `c${'a1'.repeat(12)}`;
  const cuid2 = 'a1'.repeat(12);
  const longHex = '0123456789abcdef01234567';

  for (const id of [uuid, cuid, cuid2, longHex, '123456']) {
    assert.equal(
      matchedRouteLabel({
        baseUrl: `/api/projects/${id}`,
        route: { path: '/runs/:runId' },
      }),
      '/api/projects/:id/runs/:runId',
      id,
    );
  }

  assert.equal(
    matchedRouteLabel({
      baseUrl: '/api/projects/customer-portal',
      route: { path: '/runs/:runId' },
    }),
    '/api/projects/customer-portal/runs/:runId',
  );
  assert.equal(
    matchedRouteLabel({
      baseUrl: '/api/projects/:projectId',
      route: { path: '/builds/:buildId/2024' },
    }),
    '/api/projects/:projectId/builds/:buildId/2024',
  );
});

const METRICS_PATHS = Object.freeze([
  '/metrics',
  '/internal/metrics',
  '/api/se-agents/metrics',
]);

function buildMetricsAliasApp({ render = () => '# HELP alias_metric test\n# TYPE alias_metric gauge\nalias_metric 1\n' } = {}) {
  const {
    createMetricsHandler,
    requireSessionMetricsAuth,
  } = loadSubject();
  const { requireAdmin, requireSuperAdmin } = require('../src/middleware/auth');
  const authenticate = (req, res, next) => {
    const token = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
    if (token === 'admin-session') {
      req.authMethod = 'jwt';
      req.userSession = { id: 'session-admin' };
      req.user = { id: 'admin', isAdmin: true, isSuperAdmin: false };
      return next();
    }
    if (token === 'super-session') {
      req.authMethod = 'jwt';
      req.userSession = { id: 'session-super' };
      req.user = { id: 'super', isAdmin: true, isSuperAdmin: true };
      return next();
    }
    if (token === 'super-api-key') {
      req.authMethod = 'api_key';
      req.user = { id: 'api-key-owner', isAdmin: true, isSuperAdmin: true };
      return next();
    }
    return res.status(401).json({ error: 'Access token required' });
  };
  const handler = createMetricsHandler({
    env: { METRICS_TOKEN: 'machine-scrape-token' },
    authMiddlewares: [
      authenticate,
      requireSessionMetricsAuth,
      requireAdmin,
      requireSuperAdmin,
    ],
    render,
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', {
      configurable: true,
      value: req.get('x-test-socket-peer') || '198.51.100.40',
    });
    next();
  });
  for (const path of METRICS_PATHS) app.get(path, handler);
  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: error.message });
  });
  return app;
}

async function requestEveryAlias(app, configure) {
  const responses = [];
  for (const path of METRICS_PATHS) {
    let pending = request(app).get(path).set('x-test-socket-peer', '198.51.100.40');
    pending = configure ? configure(pending) : pending;
    responses.push(await pending);
  }
  return responses;
}

function assertIdenticalResponses(responses, expectedStatus) {
  assert.equal(responses.length, METRICS_PATHS.length);
  for (const response of responses) assert.equal(response.status, expectedStatus);
  assert.equal(new Set(responses.map((response) => response.text)).size, 1);
}

test('all metrics aliases expose identical bodies for machine token and super-admin session', async () => {
  const app = buildMetricsAliasApp();
  const machine = await requestEveryAlias(
    app,
    (pending) => pending.set('authorization', 'Bearer machine-scrape-token'),
  );
  const session = await requestEveryAlias(
    app,
    (pending) => pending.set('authorization', 'Bearer super-session'),
  );

  assertIdenticalResponses(machine, 200);
  assertIdenticalResponses(session, 200);
  assert.equal(machine[0].text, session[0].text);
  for (const response of [...machine, ...session]) {
    assert.match(response.headers['content-type'], /^text\/plain;.*version=0\.0\.4/);
  }
});

test('all metrics aliases deny non-superadmin sessions and superadmin API keys identically', async () => {
  const app = buildMetricsAliasApp();
  const admin = await requestEveryAlias(
    app,
    (pending) => pending.set('authorization', 'Bearer admin-session'),
  );
  const apiKey = await requestEveryAlias(
    app,
    (pending) => pending.set('authorization', 'Bearer super-api-key'),
  );

  assertIdenticalResponses(admin, 403);
  assertIdenticalResponses(apiKey, 403);
});

test('all metrics aliases ignore spoofed proxy loopback addresses', async () => {
  const app = buildMetricsAliasApp();
  const responses = await requestEveryAlias(
    app,
    (pending) => pending.set('x-forwarded-for', '127.0.0.1'),
  );

  assertIdenticalResponses(responses, 401);
});

test('all metrics aliases fail non-200 without Prometheus Content-Type on render failure', async () => {
  const app = buildMetricsAliasApp({
    render: () => { throw new Error('exporter unavailable'); },
  });
  const responses = await requestEveryAlias(
    app,
    (pending) => pending.set('authorization', 'Bearer machine-scrape-token'),
  );

  assertIdenticalResponses(responses, 500);
  for (const response of responses) {
    assert.doesNotMatch(response.headers['content-type'] || '', /^text\/plain; version=0\.0\.4/);
  }
});
