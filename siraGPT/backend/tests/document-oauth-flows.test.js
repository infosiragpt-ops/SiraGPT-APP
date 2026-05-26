'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-oauth-flows');
const { extractOauthFlows, buildOauthFlowsForFiles, renderOauthFlowsBlock, _internal } = engine;
const { maskClientId, isOauthLike } = _internal;

const OAUTH_FIXTURE = `// Authorization request
const authUrl = new URL('https://auth.example.com/oauth2/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', 'abcdef1234567890clientid');
authUrl.searchParams.set('redirect_uri', 'https://myapp.com/callback');
authUrl.searchParams.set('scope', 'openid profile email offline_access');
authUrl.searchParams.set('state', 'randomStateValue1234');
authUrl.searchParams.set('nonce', 'randomNonceValue4567');
authUrl.searchParams.set('code_challenge', 'someBase64UrlEncodedChallengeValue');
authUrl.searchParams.set('code_challenge_method', 'S256');

// Token exchange
const tokenResponse = await fetch('https://auth.example.com/oauth2/token', {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: 'https://myapp.com/callback',
    client_id: 'abcdef1234567890clientid',
    code_verifier: codeVerifier,
  }),
});

// Refresh token flow
await fetch('/oauth2/token', {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rt,
  }),
});

// Client credentials flow (M2M)
await fetch('/oauth2/token', {
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'api:read api:write',
  }),
});

// Other endpoints
const introspect = '/oauth2/introspect';
const revoke = '/oauth2/revoke';
const userinfo = '/oauth2/userinfo';
const discovery = '/.well-known/openid-configuration';

// Use token
fetch('/api/me', { headers: { authorization: 'Bearer ' + token } });

// Error responses
if (err.error === 'invalid_grant') {
  throw new Error('Token expired');
}
if (err.error === 'access_denied') {
  redirectToLogin();
}
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractOauthFlows('').total, 0);
  assert.equal(extractOauthFlows(null).total, 0);
});

test('non-OAuth text returns empty', () => {
  const r = extractOauthFlows('Just regular text without OAuth markers');
  assert.equal(r.total, 0);
});

test('maskClientId truncates long IDs', () => {
  assert.equal(maskClientId('short'), 'short');
  const long = 'abcdef1234567890clientid';
  const masked = maskClientId(long);
  assert.ok(masked.includes('…'));
  assert.ok(masked.length < 15);
});

test('isOauthLike heuristic', () => {
  assert.ok(isOauthLike('grant_type=authorization_code'));
  assert.ok(isOauthLike('response_type: "code"'));
  assert.ok(!isOauthLike('plain text'));
});

test('detects grant_types', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'grantType' && e.name === 'authorization_code'));
  assert.ok(r.entries.some((e) => e.kind === 'grantType' && e.name === 'refresh_token'));
  assert.ok(r.entries.some((e) => e.kind === 'grantType' && e.name === 'client_credentials'));
});

test('detects response_type', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'responseType' && e.name === 'code'));
});

test('detects PKCE challenge method', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'pkce' && /S256/.test(e.name)));
});

test('detects redirect_uri', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'redirectUri' && /myapp\.com\/callback/.test(e.name)));
});

test('detects + masks client_id', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  const cid = r.entries.find((e) => e.kind === 'clientId');
  assert.ok(cid);
  assert.ok(/…/.test(cid.detail));
  // Full client_id should not appear
  const allText = JSON.stringify(r.entries);
  assert.ok(!/abcdef1234567890clientid/.test(allText));
});

test('detects state / nonce (masked)', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'state' && e.name === 'state'));
  assert.ok(r.entries.some((e) => e.kind === 'nonce' && e.name === 'nonce'));
});

test('detects scopes', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'scope' && /openid|api:read/.test(e.detail)));
});

test('detects endpoints (/authorize / /token / /revoke / .well-known)', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'endpoint' && /\/token/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'endpoint' && /\/revoke/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'endpoint' && /\.well-known/.test(e.name)));
});

test('detects token_type Bearer', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'tokenType' && e.name === 'Bearer'));
});

test('detects OAuth errors (invalid_grant / access_denied)', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'error' && e.name === 'invalid_grant'));
  assert.ok(r.entries.some((e) => e.kind === 'error' && e.name === 'access_denied'));
});

test('dedupes identical entries', () => {
  const r = extractOauthFlows('grant_type=authorization_code grant_type=authorization_code');
  assert.equal(r.entries.filter((e) => e.kind === 'grantType' && e.name === 'authorization_code').length, 1);
});

test('caps entries per file', () => {
  let text = 'grant_type=authorization_code\n';
  for (let i = 0; i < 30; i++) text += `state=val${i} `;
  const r = extractOauthFlows(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractOauthFlows(OAUTH_FIXTURE);
  assert.ok(r.totals.grantType >= 3);
  assert.ok(r.totals.endpoint >= 2);
});

test('buildOauthFlowsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'grant_type=authorization_code, code_challenge=x' },
    { name: 'b.ts', extractedText: 'grant_type=client_credentials, scope=api:read' },
  ];
  const r = buildOauthFlowsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOauthFlowsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'auth.ts', extractedText: OAUTH_FIXTURE }];
  const r = buildOauthFlowsForFiles(files);
  const md = renderOauthFlowsBlock(r);
  assert.match(md, /^## OAUTH/);
});

test('renderOauthFlowsBlock empty when nothing surfaces', () => {
  assert.equal(renderOauthFlowsBlock({ perFile: [] }), '');
  assert.equal(renderOauthFlowsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOauthFlowsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: OAUTH_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
