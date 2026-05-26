'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-jwt-claims');
const { extractJwtClaims, buildJwtClaimsForFiles, renderJwtClaimsBlock, _internal } = engine;
const { classifyClaim, previewValue } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractJwtClaims('').total, 0);
  assert.equal(extractJwtClaims(null).total, 0);
});

test('classifyClaim: registered vs oidc vs common vs custom', () => {
  assert.equal(classifyClaim('iss'), 'registered');
  assert.equal(classifyClaim('email'), 'oidc');
  assert.equal(classifyClaim('scope'), 'common');
  assert.equal(classifyClaim('xyz_field'), 'custom');
});

test('previewValue truncates long values', () => {
  assert.equal(previewValue('short'), 'short');
  const long = 'a'.repeat(50);
  assert.ok(previewValue(long).includes('…'));
});

test('detects iss/sub/aud registered claims', () => {
  const r = extractJwtClaims('{"iss": "https://issuer.com", "sub": "user-123", "aud": "api"}');
  assert.ok(r.entries.some((e) => e.claim === 'iss'));
  assert.ok(r.entries.some((e) => e.claim === 'sub'));
  assert.ok(r.entries.some((e) => e.claim === 'aud'));
});

test('detects exp/iat/nbf timestamps', () => {
  const r = extractJwtClaims('{"exp": 1700000000, "iat": 1699999999, "nbf": 1699999000}');
  assert.equal(r.totals.registered, 3);
});

test('detects email / preferred_username OIDC claims', () => {
  const r = extractJwtClaims('{"email": "a@b.com", "preferred_username": "alice"}');
  assert.ok(r.entries.some((e) => e.claim === 'email'));
  assert.ok(r.entries.some((e) => e.claim === 'preferred_username'));
});

test('detects scope / roles common claims', () => {
  const r = extractJwtClaims('{"scope": "read write", "roles": ["admin"]}');
  assert.ok(r.entries.some((e) => e.claim === 'scope'));
  assert.ok(r.entries.some((e) => e.claim === 'roles'));
});

test('detects payload access patterns', () => {
  const r = extractJwtClaims('const userId = payload.sub; const role = claims.tenant_id;');
  assert.ok(r.entries.some((e) => e.claim === 'sub'));
  assert.ok(r.entries.some((e) => e.claim === 'tenant_id'));
});

test('detects JWT-shaped tokens and counts', () => {
  const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart';
  const r = extractJwtClaims(`Authorization: Bearer ${fakeJwt}`);
  assert.ok(r.totals.tokens >= 1);
});

test('dedupes identical claims', () => {
  const r = extractJwtClaims('{"iss": "a"} {"iss": "b"}');
  assert.equal(r.entries.filter((e) => e.claim === 'iss').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const names = ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'scope', 'roles', 'email', 'name', 'azp', 'amr', 'acr', 'sid', 'tenant_id', 'org_id', 'tid', 'oid', 'client_id', 'cnf', 'given_name', 'family_name', 'locale', 'picture'];
  for (const n of names) text += `"${n}": "v",`;
  const r = extractJwtClaims(text);
  assert.ok(r.entries.length <= 20);
});

test('classifies custom claims that are not registered/oidc/common', () => {
  const r = extractJwtClaims('{"my_app_id": "x"}');
  // custom would be detected by PAYLOAD_ACCESS pattern, not JSON_FIELD (whitelist)
  // but custom path also reachable via payload.X access
  const r2 = extractJwtClaims('payload.my_custom_claim');
  assert.ok(r2.entries.some((e) => e.category === 'custom'));
});

test('counts totals by category', () => {
  const r = extractJwtClaims('{"iss": "a", "email": "b@c.com", "scope": "read"}');
  assert.ok(r.totals.registered >= 1);
  assert.ok(r.totals.oidc >= 1);
  assert.ok(r.totals.common >= 1);
});

test('buildJwtClaimsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '{"iss": "x"}' },
    { name: 'b', extractedText: '{"sub": "y"}' },
  ];
  const r = buildJwtClaimsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderJwtClaimsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'token.json', extractedText: '{"iss": "x", "sub": "y"}' }];
  const r = buildJwtClaimsForFiles(files);
  const md = renderJwtClaimsBlock(r);
  assert.match(md, /^## JWT/);
});

test('renderJwtClaimsBlock empty when nothing surfaces', () => {
  assert.equal(renderJwtClaimsBlock({ perFile: [] }), '');
  assert.equal(renderJwtClaimsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildJwtClaimsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '{"iss": "x"}' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('preview values are masked, not raw', () => {
  const longVal = 'x'.repeat(100);
  const r = extractJwtClaims(`{"sub": "${longVal}"}`);
  const subEntry = r.entries.find((e) => e.claim === 'sub');
  assert.ok(subEntry.preview.length < 50);
});
