'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  COMPOSER_PERMISSIONS,
  normalizeComposerPermission,
  resolveComposerPermission,
  authorizeComposerTool,
} = require('../src/services/composer-permission');
const { authorizeTool } = require('../src/services/sira-code/permissions');
const { createChatToolGate } = require('../src/services/agents/chat-tool-policy');

describe('composer permission policy', () => {
  it('keeps the five #513 / #519 ids and never remaps full', () => {
    assert.deepEqual([...COMPOSER_PERMISSIONS], [
      'default',
      'read',
      'protected',
      'workspace',
      'full',
    ]);
    assert.equal(normalizeComposerPermission('full'), 'full');
    assert.equal(normalizeComposerPermission('FULL'), 'full');
    assert.equal(normalizeComposerPermission('admin'), 'default');
    assert.equal(resolveComposerPermission({ permission: 'full' }), 'full');
    assert.equal(resolveComposerPermission({ toolPermission: 'read' }), 'read');
    assert.equal(resolveComposerPermission({}), 'default');
  });

  it('rejects writes and commands on Solo lectura', () => {
    for (const tool of ['write', 'write_file', 'edit', 'host_file', 'computer_write_file', 'bash', 'host_bash']) {
      const auth = authorizeComposerTool('read', tool);
      assert.equal(auth.denied, true, tool);
      assert.equal(auth.reason, 'composer_read_only');
    }
    assert.equal(authorizeComposerTool('read', 'read').denied, false);
    assert.equal(authorizeComposerTool('read', 'computer_read_file').denied, false);

    const sira = authorizeTool('construir', 'write', { permission: 'read' });
    assert.equal(sira.denied, true);
    assert.equal(sira.reason, 'composer_read_only');

    const gate = createChatToolGate({ permission: 'read', env: {} });
    assert.equal(gate.authorize('host_bash', {}).ok, false);
    assert.equal(gate.authorize('host_bash', {}).reason, 'composer_read_only');
    assert.equal(gate.authorize('web_search', {}).ok, true);
  });

  it('holds write tools on Protegido until a reviewer approves', () => {
    const pending = authorizeComposerTool('protected', 'write');
    assert.equal(pending.needsPermission, true);
    assert.equal(pending.allowed, false);
    assert.equal(pending.reason, 'composer_approval_required');
    const approved = authorizeComposerTool('protected', 'write', { approved: true });
    assert.equal(approved.allowed, true);
    assert.equal(authorizeComposerTool('protected', 'bash').allowed, true);
  });

  it('scopes Workspace away from host escape tools', () => {
    assert.equal(authorizeComposerTool('workspace', 'host_bash').denied, true);
    assert.equal(authorizeComposerTool('workspace', 'computer_write_file').allowed, true);
    assert.equal(authorizeComposerTool('workspace', 'write').allowed, true);
  });

  it('does not silently restrict Acceso completo', () => {
    for (const tool of ['write', 'bash', 'host_bash', 'computer_write_file']) {
      const auth = authorizeComposerTool('full', tool);
      assert.equal(auth.permission, 'full');
      assert.equal(auth.allowed, true, tool);
      assert.equal(auth.denied, false);
      assert.equal(auth.needsPermission, false);
    }
    const sira = authorizeTool('planificar', 'write', { permission: 'full' });
    assert.equal(sira.allowed, true);
    assert.equal(sira.denied, false);
    assert.equal(sira.needsPermission, false);

    const gate = createChatToolGate({ permission: 'full', env: {} });
    assert.equal(gate.authorize('host_bash', {}).ok, true);
  });

  it('Default follows agent policy with no extra composer reviewer', () => {
    const construir = authorizeTool('construir', 'write', { permission: 'default' });
    assert.equal(construir.allowed, true);
    const plan = authorizeTool('planificar', 'write', { permission: 'default' });
    assert.equal(plan.denied, true);
  });
});
