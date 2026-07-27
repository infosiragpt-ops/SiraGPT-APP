'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentAdapterConfigurationError,
  AgentAdapterRegistry,
  configuredImplementerAdapterId,
  getDefaultAgentAdapterRegistry,
} = require('../src/services/codex/agent-adapters/registry');
const { nativeCodexAdapter } = require('../src/services/codex/agent-adapters/native-codex-adapter');

test('registry defaults to native and resolves an explicitly configured native adapter', () => {
  const registry = getDefaultAgentAdapterRegistry();
  assert.equal(configuredImplementerAdapterId({}), 'native');
  assert.equal(registry.resolveImplementer({ env: {} }), nativeCodexAdapter);
  assert.equal(registry.resolveImplementer({ env: { CODEX_IMPLEMENTER_ADAPTER: ' NATIVE ' } }), nativeCodexAdapter);
});

test('registry fails closed for unknown implementer ids', () => {
  const registry = new AgentAdapterRegistry([nativeCodexAdapter]);
  assert.throws(
    () => registry.resolveImplementer({ env: { CODEX_IMPLEMENTER_ADAPTER: 'opencode' } }),
    (err) => err instanceof AgentAdapterConfigurationError
      && err.code === 'CODEX_IMPLEMENTER_ADAPTER_UNSUPPORTED'
      && /available adapters: native/.test(err.message),
  );
});

test('registry rejects duplicate adapter ids', () => {
  const registry = new AgentAdapterRegistry([nativeCodexAdapter]);
  assert.throws(() => registry.register(nativeCodexAdapter), /duplicate AgentAdapter id/);
});

test('registry snapshots a mutable adapter interface at registration', () => {
  const mutable = {
    id: 'mutable',
    version: '1.0.0',
    capabilities() {
      return {
        schemaVersion: 'sira.agent-capabilities.v1',
        roles: ['implementer'],
        modes: ['build'],
        workspaceAccess: 'rw',
      };
    },
    health() { return { ok: true }; },
    execute() { return { status: 'done' }; },
  };
  const originalExecute = mutable.execute;
  const registry = new AgentAdapterRegistry([mutable]);
  mutable.id = 'swapped';
  mutable.execute = null;

  const registered = registry.resolveImplementer({ env: { CODEX_IMPLEMENTER_ADAPTER: 'mutable' } });
  assert.equal(registered.id, 'mutable');
  assert.equal(typeof registered.execute, 'function');
  assert.notEqual(registered.execute, originalExecute); // immutable bound facade
  assert.equal(Object.isFrozen(registered), true);
});
