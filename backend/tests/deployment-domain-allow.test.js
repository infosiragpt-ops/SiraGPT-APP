'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isDomainAllowed, isDomainAllowedAsync, PUBLISH_DOMAIN_RE } = require('../src/services/deployments/domain-allow');

const BASE = '/srv/sites';
const env = { PUBLISHED_SITES_DIR: BASE };

// Fake fs: only the listed index.html paths "exist".
function fakeFs(existing) {
  const set = new Set(existing.map((p) => path.resolve(p)));
  return { existsSync: (p) => set.has(path.resolve(p)) };
}

test('allows a domain that has a deployed index.html', () => {
  const fsImpl = fakeFs([`${BASE}/chatgpt66.com/index.html`]);
  assert.equal(isDomainAllowed('chatgpt66.com', { env, fsImpl }), true);
  assert.equal(isDomainAllowed('CHATGPT66.COM', { env, fsImpl }), true); // case-insensitive
});

test('denies a domain with no deployed site', () => {
  const fsImpl = fakeFs([`${BASE}/chatgpt66.com/index.html`]);
  assert.equal(isDomainAllowed('not-deployed.com', { env, fsImpl }), false);
});

test('denies path traversal / invalid hostnames', () => {
  const fsImpl = fakeFs([`${BASE}/chatgpt66.com/index.html`]);
  for (const bad of ['../etc/passwd', 'a/../../b', 'foo/bar', '..', '', 'nodot', '-bad.com', 'bad-.com', 'has space.com', 'a..b.com']) {
    assert.equal(isDomainAllowed(bad, { env, fsImpl }), false, `should deny: ${bad}`);
  }
});

test('denies an over-long hostname', () => {
  const fsImpl = fakeFs([]);
  const long = `${'a'.repeat(250)}.com`;
  assert.equal(isDomainAllowed(long, { env, fsImpl }), false);
});

test('the published-sites dir is configurable and isolated from SiraGPT', () => {
  const customEnv = { PUBLISHED_SITES_DIR: '/var/www/published-sites' };
  const fsImpl = fakeFs(['/var/www/published-sites/site.io/index.html']);
  assert.equal(isDomainAllowed('site.io', { env: customEnv, fsImpl }), true);
  // A SiraGPT-internal path is never consulted.
  assert.equal(isDomainAllowed('site.io', { env: { PUBLISHED_SITES_DIR: '/opt/siragpt/sites' }, fsImpl }), false);
});

test('the hostname regex accepts real domains and rejects junk', () => {
  for (const ok of ['chatgpt66.com', 'sub.example.co.uk', 'a1-b2.io']) assert.match(ok, PUBLISH_DOMAIN_RE);
  for (const no of ['localhost', 'no_underscore.com', '.leadingdot.com']) assert.doesNotMatch(no, PUBLISH_DOMAIN_RE);
});

// ── async gate (static fast-path OR running Node-app deployment) ────────────
test('async: static fast-path allows a deployed site without hitting the DB', async () => {
  const fsImpl = fakeFs([`${BASE}/static-site.com/index.html`]);
  let dbCalled = false;
  const lookupNodeDomain = async () => { dbCalled = true; return false; };
  assert.equal(await isDomainAllowedAsync('static-site.com', { env, fsImpl, lookupNodeDomain }), true);
  assert.equal(dbCalled, false, 'static hit short-circuits before the DB lookup');
});

test('async: a running Node-app domain is allowed via the DB lookup', async () => {
  const fsImpl = fakeFs([]); // no static folder
  const lookupNodeDomain = async (d) => d === 'app.example.com';
  assert.equal(await isDomainAllowedAsync('app.example.com', { env, fsImpl, lookupNodeDomain }), true);
  assert.equal(await isDomainAllowedAsync('unknown.com', { env, fsImpl, lookupNodeDomain }), false);
});

test('async: invalid hostnames are denied before any lookup', async () => {
  const fsImpl = fakeFs([]);
  let dbCalled = false;
  const lookupNodeDomain = async () => { dbCalled = true; return true; };
  assert.equal(await isDomainAllowedAsync('../etc', { env, fsImpl, lookupNodeDomain }), false);
  assert.equal(dbCalled, false);
});

test('async: a throwing DB lookup denies (no cert) rather than crashing', async () => {
  const fsImpl = fakeFs([]);
  const lookupNodeDomain = async () => { throw new Error('db down'); };
  assert.equal(await isDomainAllowedAsync('app.example.com', { env, fsImpl, lookupNodeDomain }), false);
});
