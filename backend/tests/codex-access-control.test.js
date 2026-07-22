'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  canUseCodexAgent,
  parseAllowlist,
  publicAccess,
  openToAll,
  openToAllRequested,
  multiTenantIsolationReady,
} = require('../src/services/codex/access-control');

test('codex access allows admins and superadmins', () => {
  assert.equal(canUseCodexAgent({ id: 'u-1', isAdmin: true }, {}), true);
  assert.equal(canUseCodexAgent({ id: 'u-2', isSuperAdmin: true }, {}), true);
});

test('codex access allows explicit user ids from env allowlist', () => {
  const env = { CODEX_AGENT_ALLOWED_USER_IDS: 'u-1, 42 ,u-3' };
  assert.deepEqual(parseAllowlist(env), ['u-1', '42', 'u-3']);
  assert.equal(canUseCodexAgent({ id: '42' }, env), true);
  assert.equal(canUseCodexAgent({ id: 42 }, env), true);
  assert.equal(canUseCodexAgent({ id: 'other' }, env), false);
});

test('CODEX_AGENT_OPEN_TO_ALL lets any authenticated user through (but not anonymous)', () => {
  const env = { CODEX_AGENT_OPEN_TO_ALL: '1' };
  assert.equal(canUseCodexAgent({ id: 'anyone' }, env), true);
  assert.equal(canUseCodexAgent(null, env), false); // still needs a user
  assert.equal(canUseCodexAgent({ id: 'x' }, { CODEX_AGENT_OPEN_TO_ALL: 'true' }), true);
  assert.equal(canUseCodexAgent({ id: 'x' }, { CODEX_AGENT_OPEN_TO_ALL: 'off' }), false);
  assert.equal(canUseCodexAgent({ id: 'x' }, {}), false); // default off
  assert.equal(publicAccess({ id: 'u' }, env).canRun, true);
  assert.equal(publicAccess({ id: 'u' }, env).allowlistConfigured, true);
});

test('production public access fails closed on a shared runner', () => {
  const shared = {
    NODE_ENV: 'production',
    CODEX_AGENT_OPEN_TO_ALL: '1',
    CODEX_RUNNER_ISOLATION_MODE: 'shared-container',
  };
  assert.equal(openToAllRequested(shared), true);
  assert.equal(multiTenantIsolationReady(shared), false);
  assert.equal(openToAll(shared), false);
  assert.equal(canUseCodexAgent({ id: 'ordinary-user' }, shared), false);
  // Trusted operators/canaries remain available while migration is underway.
  assert.equal(canUseCodexAgent({ id: 'admin', isAdmin: true }, shared), true);
  assert.equal(canUseCodexAgent({ id: 'canary' }, { ...shared, CODEX_AGENT_ALLOWED_USER_IDS: 'canary' }), true);
});

test('production public access requires an isolated sandbox mode', () => {
  for (const mode of ['opensandbox', 'gvisor', 'kata', 'microvm', 'e2b']) {
    const env = { NODE_ENV: 'production', CODEX_AGENT_OPEN_TO_ALL: 'true', CODEX_RUNNER_ISOLATION_MODE: mode };
    assert.equal(multiTenantIsolationReady(env), true, mode);
    assert.equal(openToAll(env), true, mode);
    assert.equal(canUseCodexAgent({ id: 'u' }, env), true, mode);
  }
});

test('publicAccess exposes only coarse gate state', () => {
  assert.deepEqual(publicAccess({ id: 'u-1' }, { CODEX_AGENT_ALLOWED_USER_IDS: '' }), {
    canRun: false,
    allowlistConfigured: false,
  });
  assert.deepEqual(publicAccess({ id: 'u-1' }, { CODEX_AGENT_ALLOWED_USER_IDS: 'u-1' }), {
    canRun: true,
    allowlistConfigured: true,
  });
});
