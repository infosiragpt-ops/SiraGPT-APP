'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canUseCodexAgent, parseAllowlist, publicAccess } = require('../src/services/codex/access-control');

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
