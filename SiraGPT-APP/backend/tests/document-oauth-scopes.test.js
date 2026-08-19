'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-oauth-scopes');
const { extractOauthScopes, buildOauthScopesForFiles, renderOauthScopesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractOauthScopes('').total, 0);
  assert.equal(extractOauthScopes(null).total, 0);
});

test('detects read:user scope', () => {
  const r = extractOauthScopes('Required: read:user permission');
  assert.ok(r.entries.some((e) => e.kind === 'verb-resource'));
});

test('detects write:org scope', () => {
  const r = extractOauthScopes('Need write:org access');
  assert.ok(r.entries.some((e) => /write:org/.test(e.value)));
});

test('detects users:read', () => {
  const r = extractOauthScopes('Slack: users:read needed');
  assert.ok(r.entries.some((e) => e.kind === 'resource-action'));
});

test('detects Google URL scope', () => {
  const r = extractOauthScopes('https://www.googleapis.com/auth/userinfo.email');
  assert.ok(r.entries.some((e) => e.kind === 'google-url'));
});

test('detects OIDC openid', () => {
  const r = extractOauthScopes('scope: openid profile email');
  assert.ok(r.entries.some((e) => e.kind === 'oidc'));
});

test('detects labeled scope', () => {
  const r = extractOauthScopes('scope: api.read');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('dedupes identical scopes', () => {
  const r = extractOauthScopes('read:user here and read:user again');
  assert.equal(r.entries.filter((e) => /read:user/.test(e.value)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `read:resource${i} `;
  const r = extractOauthScopes(text);
  assert.ok(r.entries.length <= 24);
});

test('buildOauthScopesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'read:user' },
    { name: 'b.md', extractedText: 'write:org' },
  ];
  const r = buildOauthScopesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOauthScopesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'read:user' }];
  const r = buildOauthScopesForFiles(files);
  const md = renderOauthScopesBlock(r);
  assert.match(md, /^## OAUTH SCOPES/);
});

test('renderOauthScopesBlock empty when nothing surfaces', () => {
  assert.equal(renderOauthScopesBlock({ perFile: [] }), '');
  assert.equal(renderOauthScopesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOauthScopesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'read:user' },
  ]);
  assert.equal(r.perFile.length, 1);
});
