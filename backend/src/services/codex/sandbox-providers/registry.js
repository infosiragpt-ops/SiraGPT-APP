'use strict';

const { SandboxContractError, normalizeProvider } = require('./contract');

/**
 * Construct-once registry. There is intentionally no register/remove API:
 * provider selection and implementation stay immutable after process boot.
 */
function createSandboxProviderRegistry(candidates = []) {
  if (!Array.isArray(candidates)) throw new SandboxContractError('invalid_registry', 'sandbox providers must be an array');
  const providers = new Map();
  for (const candidate of candidates) {
    const provider = normalizeProvider(candidate);
    if (providers.has(provider.id)) {
      throw new SandboxContractError('duplicate_provider', `duplicate sandbox provider: ${provider.id}`);
    }
    providers.set(provider.id, provider);
  }

  const ids = Object.freeze([...providers.keys()]);
  return Object.freeze({
    ids,
    get(id) {
      return providers.get(String(id || '').trim().toLowerCase()) || null;
    },
    require(id) {
      const normalized = String(id || '').trim().toLowerCase();
      const provider = providers.get(normalized);
      if (!provider) {
        throw new SandboxContractError(
          'unknown_sandbox_provider',
          `unknown sandbox provider "${normalized || '(empty)'}"; available: ${ids.join(', ') || '(none)'}`,
        );
      }
      return provider;
    },
  });
}

module.exports = { createSandboxProviderRegistry };
