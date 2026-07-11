'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cors = require('cors');
const express = require('express');
const request = require('supertest');

const { createCredentialedCorsOptions } = require('../src/middleware/cors-policy');
const {
  SAML_ACS_BODY_LIMIT_BYTES,
  createSamlAcsBodyParser,
  createSamlAcsCorsMiddleware,
  isExactSamlAcsPath,
} = require('../src/middleware/saml-acs-ingress');

const TRUSTED_APP_ORIGIN = 'https://app.example.com';
const IDP_ORIGIN = 'https://idp.example.com';

function buildApp() {
  const app = express();
  app.use(createSamlAcsBodyParser());

  const globalCors = cors(createCredentialedCorsOptions([TRUSTED_APP_ORIGIN]));
  app.use(createSamlAcsCorsMiddleware(globalCors));

  app.post('/api/auth/sso/:orgSlug/callback', (req, res) => {
    res.status(204).end();
  });
  app.get('/api/auth/sso/:orgSlug/callback', (_req, res) => {
    res.status(204).end();
  });
  app.post('/api/auth/sso/:orgSlug/callback/child', (_req, res) => {
    res.status(204).end();
  });
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ code: 'saml_acs_body_too_large' });
    }
    return res.status(403).json({ code: 'cors_origin_not_allowed' });
  });
  return app;
}

test('SAML ACS path predicate accepts only the exact POST callback route', () => {
  assert.equal(isExactSamlAcsPath({
    method: 'POST',
    originalUrl: '/api/auth/sso/acme/callback?binding=post',
  }), true);

  for (const req of [
    { method: 'GET', originalUrl: '/api/auth/sso/acme/callback' },
    { method: 'OPTIONS', originalUrl: '/api/auth/sso/acme/callback' },
    { method: 'POST', originalUrl: '/api/auth/sso/acme/callback/child' },
    { method: 'POST', originalUrl: '/api/auth/sso/acme/oidc/callback' },
    { method: 'POST', originalUrl: '/api/auth/sso/-bad/callback' },
  ]) {
    assert.equal(isExactSamlAcsPath(req), false, `${req.method} ${req.originalUrl}`);
  }
});

test('exact form-posted SAML ACS bypasses credentialed CORS without emitting headers', async () => {
  const response = await request(buildApp())
    .post('/api/auth/sso/acme/callback')
    .set('Origin', IDP_ORIGIN)
    .type('form')
    .send({ SAMLResponse: 'signed-assertion', RelayState: 'bound-state' });

  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

test('trusted-origin SAML ACS also omits credentialed CORS headers', async () => {
  const response = await request(buildApp())
    .post('/api/auth/sso/acme/callback')
    .set('Origin', TRUSTED_APP_ORIGIN)
    .type('form')
    .send({ SAMLResponse: 'signed-assertion', RelayState: 'bound-state' });

  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

test('OIDC GET callback keeps the existing credentialed CORS policy', async () => {
  const trusted = await request(buildApp())
    .get('/api/auth/sso/acme/callback?code=oidc-code')
    .set('Origin', TRUSTED_APP_ORIGIN);

  assert.equal(trusted.status, 204);
  assert.equal(trusted.headers['access-control-allow-origin'], TRUSTED_APP_ORIGIN);
  assert.equal(trusted.headers['access-control-allow-credentials'], 'true');

  const untrusted = await request(buildApp())
    .get('/api/auth/sso/acme/callback?code=oidc-code')
    .set('Origin', IDP_ORIGIN);

  assert.equal(untrusted.status, 403);
  assert.equal(untrusted.headers['access-control-allow-origin'], undefined);
});

test('non-ACS auth requests and malformed ACS bodies do not bypass CORS', async () => {
  const cases = [
    request(buildApp())
      .post('/api/auth/sso/acme/callback/child')
      .set('Origin', IDP_ORIGIN)
      .type('form')
      .send({ SAMLResponse: 'signed-assertion' }),
    request(buildApp())
      .post('/api/auth/sso/acme/callback')
      .set('Origin', IDP_ORIGIN)
      .type('form')
      .send({ samlResponse: 'wrong-field-name' }),
    request(buildApp())
      .post('/api/auth/sso/acme/callback')
      .set('Origin', IDP_ORIGIN)
      .send({ SAMLResponse: 'json-is-not-the-acs-form-binding' }),
    request(buildApp())
      .options('/api/auth/sso/acme/callback')
      .set('Origin', IDP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST'),
  ];

  const responses = await Promise.all(cases);
  for (const response of responses) {
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  }
});

test('dedicated ACS parser retains a bounded raw-body limit', async () => {
  assert.ok(SAML_ACS_BODY_LIMIT_BYTES > 0);
  assert.ok(SAML_ACS_BODY_LIMIT_BYTES <= 1024 * 1024);

  const response = await request(buildApp())
    .post('/api/auth/sso/acme/callback')
    .set('Origin', IDP_ORIGIN)
    .type('form')
    .send({
      SAMLResponse: 'A'.repeat(SAML_ACS_BODY_LIMIT_BYTES + 1),
      RelayState: 'bound-state',
    });

  assert.equal(response.status, 413);
  assert.equal(response.body.code, 'saml_acs_body_too_large');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

test('global server parses exact ACS form bodies before applying CORS bypass policy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const parserMount = source.indexOf('app.use(createSamlAcsBodyParser())');
  const corsMount = source.indexOf('app.use(createSamlAcsCorsMiddleware(globalCors))');
  const jsonParserMount = source.indexOf("app.use(express.json({ limit: '50mb' }))");

  assert.ok(parserMount >= 0, 'exact ACS parser must be mounted globally');
  assert.ok(corsMount > parserMount, 'ACS body must be parsed before the CORS selector');
  assert.ok(jsonParserMount > corsMount, 'ordinary body parsers must remain downstream');
});
