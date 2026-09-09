'use strict';

// Pure policy/unit tests. No model, filesystem mutation, database or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeComposerTool, classifiesAsWrite } = require('../src/services/composer-permission');
const { createChatToolGate } = require('../src/services/agents/chat-tool-policy');

const MUTATIONS = ['ws_write', 'ws_edit', 'ws_move', 'ws_delete'];
const READS = ['ws_read', 'ws_glob', 'ws_grep'];
const LEVELS = ['read', 'protected', 'workspace', 'default', 'full'];

for (const tool of MUTATIONS) {
  for (const permission of LEVELS) {
    test(`${tool}: ${permission} uses the existing composer verdict and chat authorization gate`, () => {
      const auth = authorizeComposerTool(permission, tool);
      const allowed = !['read', 'protected'].includes(permission);
      const reason = permission === 'read' ? 'composer_read_only'
        : permission === 'protected' ? 'composer_approval_required' : null;
      assert.equal(classifiesAsWrite(tool), true, `${tool} is a mutation regardless of permission`);
      assert.deepEqual(auth, {
        permission, tool, writable: true, command: false,
        verdict: allowed ? 'allow' : permission === 'read' ? 'deny' : 'ask',
        allowed, denied: permission === 'read', needsPermission: permission === 'protected', reason,
      });
      const gate = createChatToolGate({ permission, env: {} });
      assert.deepEqual(gate.authorize(tool), allowed ? { ok: true } : { ok: false, reason });
    });
  }

  test(`${tool}: approval never overrides read-only`, () => {
    for (const approval of [{ approved: true }, { approvalGranted: true }, { approved: true, approvalGranted: true }]) {
      const auth = authorizeComposerTool('read', tool, approval);
      assert.equal(auth.allowed, false); assert.equal(auth.denied, true);
      assert.equal(auth.needsPermission, false); assert.equal(auth.reason, 'composer_read_only');
      assert.deepEqual(createChatToolGate({ permission: 'read', env: {} }).authorize(tool, approval),
        { ok: false, reason: 'composer_read_only' });
    }
  });

  test(`${tool}: protected requires an explicit boolean approval and preserves both approval aliases`, () => {
    const gate = createChatToolGate({ permission: 'protected', env: {} });
    for (const approval of [{}, { approved: false }, { approved: 'true' }, { approvalGranted: 1 }]) {
      assert.equal(authorizeComposerTool('protected', tool, approval).needsPermission, true);
      assert.deepEqual(gate.authorize(tool, approval), { ok: false, reason: 'composer_approval_required' });
    }
    for (const approval of [{ approved: true }, { approvalGranted: true }]) {
      const auth = authorizeComposerTool('protected', tool, approval);
      assert.equal(auth.allowed, true); assert.equal(auth.needsPermission, false); assert.equal(auth.denied, false);
      assert.deepEqual(gate.authorize(tool, approval), { ok: true });
    }
  });
}

for (const tool of READS) {
  for (const permission of LEVELS) {
    test(`${tool}: ${permission} keeps existing read/search access without approval`, () => {
      const auth = authorizeComposerTool(permission, tool);
      assert.equal(classifiesAsWrite(tool), false); assert.equal(auth.writable, false);
      assert.equal(auth.allowed, true); assert.equal(auth.denied, false); assert.equal(auth.needsPermission, false);
      assert.deepEqual(createChatToolGate({ permission, env: { SIRAGPT_HOST_TOOLS_DISABLED: '1' } }).authorize(tool), { ok: true });
    });
  }
}

test('interactive gate honors existing permission aliases and trusted per-turn permission context', () => {
  for (const key of ['permission', 'toolPermission', 'composerPermission']) {
    const gate = createChatToolGate({ [key]: 'read', env: {} });
    for (const tool of MUTATIONS) assert.deepEqual(gate.authorize(tool), { ok: false, reason: 'composer_read_only' });
  }
  const gate = createChatToolGate({ permission: 'full', env: {} });
  for (const tool of MUTATIONS) {
    assert.deepEqual(gate.authorize(tool, { permission: 'read' }), { ok: false, reason: 'composer_read_only' });
    assert.deepEqual(gate.authorize(tool, { toolPermission: 'protected' }), { ok: false, reason: 'composer_approval_required' });
  }
});

test('workspace/default/full remain compatible for Cowork but never bypass the existing host kill switch', () => {
  for (const permission of ['workspace', 'default', 'full']) {
    const gate = createChatToolGate({ permission, env: { SIRAGPT_HOST_TOOLS_DISABLED: '1' } });
    for (const tool of [...MUTATIONS, ...READS]) assert.deepEqual(gate.authorize(tool), { ok: true });
    assert.equal(gate.authorize('host_bash').ok, false);
  }
});
