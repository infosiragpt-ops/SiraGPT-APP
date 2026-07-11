'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const samlIngress = require('../src/middleware/saml-acs-ingress');

function requireIngressApi(name) {
  assert.equal(
    typeof samlIngress[name],
    'function',
    `saml-acs-ingress must export ${name}`,
  );
  return samlIngress[name];
}

function buildApp({ store, env, onParser, onTelemetry } = {}) {
  const createSamlAcsRateLimit = requireIngressApi('createSamlAcsRateLimit');
  const createSamlAcsBodyParser = requireIngressApi('createSamlAcsBodyParser');
  const app = express();
  app.use(createSamlAcsRateLimit({ store, env }));
  const parser = createSamlAcsBodyParser({ env });
  app.use((req, res, next) => {
    onParser?.();
    return parser(req, res, next);
  });
  app.use((req, _res, next) => {
    onTelemetry?.();
    next();
  });
  app.post('/api/auth/sso/:orgSlug/callback', (req, res) => {
    res.status(200).json({ parsed: typeof req.body?.SAMLResponse === 'string' });
  });
  app.post('/api/auth/other', (_req, res) => res.status(204).end());
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ code: 'saml_acs_body_too_large' });
    }
    return res.status(500).json({ code: 'unexpected_error' });
  });
  return app;
}

test('ACS limiter returns 429 before reading an oversized assertion or starting telemetry', async () => {
  let parserCalls = 0;
  let telemetryCalls = 0;
  const consumeCalls = [];
  const store = {
    async consume(key, limit, windowMs, options) {
      consumeCalls.push({ key, limit, windowMs, options });
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 30_000),
      };
    },
  };
  const response = await request(buildApp({
    store,
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
      SAML_ACS_RATE_LIMIT_MAX: '7',
      SAML_ACS_RATE_LIMIT_WINDOW_MS: '60000',
    },
    onParser: () => { parserCalls += 1; },
    onTelemetry: () => { telemetryCalls += 1; },
  }))
    .post('/api/auth/sso/acme/callback')
    .type('form')
    .send({ SAMLResponse: 'A'.repeat(400_000), RelayState: 'state' });

  assert.equal(response.status, 429);
  assert.equal(response.body.code, 'saml_acs_rate_limited');
  assert.equal(parserCalls, 0);
  assert.equal(telemetryCalls, 0);
  assert.equal(consumeCalls.length, 1);
  assert.equal(consumeCalls[0].limit, 7);
  assert.equal(consumeCalls[0].windowMs, 60_000);
  assert.equal(consumeCalls[0].options.requireDistributed, true);
  assert.match(consumeCalls[0].key, /^saml-acs:/);
});

test('ACS limiter fails closed with 503 before parser and telemetry on Redis outage', async () => {
  let parserCalls = 0;
  let telemetryCalls = 0;
  const response = await request(buildApp({
    store: {
      async consume() {
        const error = new Error('redis down');
        error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
        throw error;
      },
    },
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
    },
    onParser: () => { parserCalls += 1; },
    onTelemetry: () => { telemetryCalls += 1; },
  }))
    .post('/api/auth/sso/acme/callback')
    .type('form')
    .send({ SAMLResponse: 'assertion', RelayState: 'state' });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(parserCalls, 0);
  assert.equal(telemetryCalls, 0);
});

test('ACS parser uses a reduced configurable clamp and rejects oversized form bodies', async () => {
  const resolveSamlAcsBodyLimit = requireIngressApi('resolveSamlAcsBodyLimit');
  assert.equal(resolveSamlAcsBodyLimit({}), 256 * 1024);
  assert.equal(resolveSamlAcsBodyLimit({ SAML_ACS_BODY_LIMIT_BYTES: '1' }), 64 * 1024);
  assert.equal(
    resolveSamlAcsBodyLimit({ SAML_ACS_BODY_LIMIT_BYTES: String(8 * 1024 * 1024) }),
    512 * 1024,
  );

  const limit = resolveSamlAcsBodyLimit({ SAML_ACS_BODY_LIMIT_BYTES: '65536' });
  const response = await request(buildApp({
    store: {
      async consume() {
        return {
          allowed: true,
          remaining: 10,
          resetAt: new Date(Date.now() + 60_000),
        };
      },
    },
    env: {
      NODE_ENV: 'test',
      RATE_LIMIT_STORE: 'memory',
      SAML_ACS_BODY_LIMIT_BYTES: String(limit),
    },
  }))
    .post('/api/auth/sso/acme/callback')
    .type('form')
    .send({ SAMLResponse: 'A'.repeat(limit + 1), RelayState: 'state' });

  assert.equal(response.status, 413);
  assert.equal(response.body.code, 'saml_acs_body_too_large');
});

test('dedicated limiter ignores non-ACS routes without touching its store', async () => {
  let consumeCalls = 0;
  const response = await request(buildApp({
    store: {
      async consume() {
        consumeCalls += 1;
        return {
          allowed: true,
          remaining: 1,
          resetAt: new Date(Date.now() + 60_000),
        };
      },
    },
    env: { NODE_ENV: 'test', RATE_LIMIT_STORE: 'memory' },
  }))
    .post('/api/auth/other')
    .send('not-saml');

  assert.equal(response.status, 204);
  assert.equal(consumeCalls, 0);
});

test('global ACS limiter is mounted before body parsing and request telemetry', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const limiterMount = source.indexOf('app.use(createSamlAcsRateLimit())');
  const parserMount = source.indexOf('app.use(createSamlAcsBodyParser())');
  const telemetryMount = source.indexOf('app.use(requestLogger)');

  assert.ok(limiterMount >= 0, 'global exact-ACS limiter must be mounted');
  assert.ok(parserMount > limiterMount, 'ACS limiter must run before its body parser');
  assert.ok(telemetryMount > parserMount, 'ACS limiter and parser must run before request telemetry');
});

