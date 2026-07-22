'use strict';

const { assertAgentAdapter, assertAgentCapabilities } = require('./contract');
const { nativeCodexAdapter } = require('./native-codex-adapter');

const IMPLEMENTER_ADAPTER_ENV = 'CODEX_IMPLEMENTER_ADAPTER';
const DEFAULT_IMPLEMENTER_ADAPTER = 'native';

class AgentAdapterConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentAdapterConfigurationError';
    this.code = 'CODEX_IMPLEMENTER_ADAPTER_UNSUPPORTED';
  }
}

function configuredImplementerAdapterId(env = process.env) {
  const raw = env?.[IMPLEMENTER_ADAPTER_ENV];
  return String(raw === undefined || raw === null || raw === '' ? DEFAULT_IMPLEMENTER_ADAPTER : raw)
    .trim()
    .toLowerCase();
}

class AgentAdapterRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    const valid = assertAgentAdapter(adapter);
    if (this.adapters.has(valid.id)) {
      throw new AgentAdapterConfigurationError(`duplicate AgentAdapter id: ${valid.id}`);
    }
    // Retain an already immutable trusted adapter (the built-in native one),
    // otherwise store an immutable facade with methods bound to the validated
    // implementation. Mutating the caller's object after registration cannot
    // swap execute/health/id/version underneath the registry.
    const registered = Object.isFrozen(valid)
      ? valid
      : Object.freeze({
          id: valid.id,
          version: valid.version,
          capabilities: valid.capabilities.bind(valid),
          health: valid.health.bind(valid),
          execute: valid.execute.bind(valid),
        });
    this.adapters.set(registered.id, registered);
    return registered;
  }

  get(id) {
    return this.adapters.get(String(id || '').trim().toLowerCase()) || null;
  }

  listIds() {
    return [...this.adapters.keys()].sort();
  }

  resolveImplementer({ env = process.env } = {}) {
    const id = configuredImplementerAdapterId(env);
    const adapter = this.get(id);
    if (!adapter) {
      const available = this.listIds().join(', ') || 'none';
      throw new AgentAdapterConfigurationError(
        `${IMPLEMENTER_ADAPTER_ENV}=${id || '(empty)'} is unsupported; available adapters: ${available}`,
      );
    }
    assertAgentAdapter(adapter);
    const capabilities = assertAgentCapabilities(adapter.capabilities(), { adapterId: adapter.id });
    if (!capabilities.roles.includes('implementer')) {
      throw new AgentAdapterConfigurationError(`AgentAdapter ${adapter.id} does not support the implementer role`);
    }
    return adapter;
  }
}

let defaultRegistry;

function getDefaultAgentAdapterRegistry() {
  if (!defaultRegistry) defaultRegistry = new AgentAdapterRegistry([nativeCodexAdapter]);
  return defaultRegistry;
}

function assertImplementerAdapterConfigured(env = process.env) {
  return getDefaultAgentAdapterRegistry().resolveImplementer({ env });
}

module.exports = {
  IMPLEMENTER_ADAPTER_ENV,
  DEFAULT_IMPLEMENTER_ADAPTER,
  AgentAdapterConfigurationError,
  AgentAdapterRegistry,
  configuredImplementerAdapterId,
  getDefaultAgentAdapterRegistry,
  assertImplementerAdapterConfigured,
};
