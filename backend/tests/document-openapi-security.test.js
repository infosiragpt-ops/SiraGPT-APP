'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-openapi-security');
const { extractOpenapiSecurity, buildOpenapiSecurityForFiles, renderOpenapiSecurityBlock, _internal } = engine;
const { isOpenapiLike } = _internal;

const OPENAPI_FIXTURE = `openapi: 3.0.3
info:
  title: My API
  version: 1.0.0
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    apiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
    oauth2:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://auth.example.com/authorize
          tokenUrl: https://auth.example.com/token
          scopes:
            read:users: "Read user data"
            write:posts: "Create or update posts"
            admin:settings: "Manage settings"
    openId:
      type: openIdConnect
      openIdConnectUrl: https://auth.example.com/.well-known/openid-configuration

security:
  - bearerAuth: []
  - apiKeyAuth: []

paths:
  /users:
    get:
      security:
        - oauth2:
            - read:users
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractOpenapiSecurity('').total, 0);
  assert.equal(extractOpenapiSecurity(null).total, 0);
});

test('non-OpenAPI text returns empty', () => {
  const r = extractOpenapiSecurity('Just regular text without OpenAPI markers');
  assert.equal(r.total, 0);
});

test('isOpenapiLike heuristic', () => {
  assert.ok(isOpenapiLike('openapi: 3.0.0\nsecuritySchemes:'));
  assert.ok(!isOpenapiLike('plain text'));
});

test('detects http / apiKey / oauth2 / openIdConnect types', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'http'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'apiKey'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'oauth2'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'openIdConnect'));
});

test('detects HTTP bearer scheme', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'httpScheme' && e.name === 'bearer'));
});

test('detects bearerFormat JWT', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'bearerFormat' && e.name === 'JWT'));
});

test('detects apiKey location (in/name)', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'apiKey' && e.name === 'header/X-API-Key'));
});

test('detects oauth2 flows', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'flow' && e.name === 'authorizationCode'));
});

test('detects authorizationUrl / tokenUrl', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'url' && e.name === 'authorizationUrl' && /auth\.example\.com\/authorize/.test(e.detail)));
  assert.ok(r.entries.some((e) => e.kind === 'url' && e.name === 'tokenUrl'));
});

test('detects openIdConnectUrl', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'url' && e.name === 'openIdConnectUrl'));
});

test('detects oauth2 scopes', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'scope' && e.name === 'read:users'));
  assert.ok(r.entries.some((e) => e.kind === 'scope' && e.name === 'write:posts'));
  assert.ok(r.entries.some((e) => e.kind === 'scope' && e.name === 'admin:settings'));
});

test('counts security requirement blocks', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.totals.securityReq >= 1);
});

test('dedupes identical types', () => {
  const r = extractOpenapiSecurity('openapi: 3.0\nsecuritySchemes:\n  a:\n    type: http\n  b:\n    type: http');
  assert.equal(r.entries.filter((e) => e.kind === 'type' && e.name === 'http').length, 1);
});

test('caps entries per file', () => {
  let text = 'openapi: 3.0\nsecuritySchemes:\n';
  for (let i = 0; i < 30; i++) text += `  s${i}:\n    type: http\n    scheme: bearer\n    bearerFormat: JWT-${i}\n`;
  const r = extractOpenapiSecurity(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractOpenapiSecurity(OPENAPI_FIXTURE);
  assert.ok(r.totals.type >= 4);
  assert.ok(r.totals.scope >= 3);
  assert.ok(r.totals.url >= 2);
});

test('buildOpenapiSecurityForFiles aggregates across batch', () => {
  const files = [
    { name: 'api1.yaml', extractedText: 'openapi: 3.0\nsecuritySchemes:\n  x:\n    type: http\n    scheme: bearer' },
    { name: 'api2.yaml', extractedText: 'openapi: 3.0\nsecuritySchemes:\n  y:\n    type: apiKey\n    in: header\n    name: X-Key' },
  ];
  const r = buildOpenapiSecurityForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOpenapiSecurityBlock returns markdown when entries exist', () => {
  const files = [{ name: 'api.yaml', extractedText: OPENAPI_FIXTURE }];
  const r = buildOpenapiSecurityForFiles(files);
  const md = renderOpenapiSecurityBlock(r);
  assert.match(md, /^## OPENAPI SECURITY/);
});

test('renderOpenapiSecurityBlock empty when nothing surfaces', () => {
  assert.equal(renderOpenapiSecurityBlock({ perFile: [] }), '');
  assert.equal(renderOpenapiSecurityBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOpenapiSecurityForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: OPENAPI_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
