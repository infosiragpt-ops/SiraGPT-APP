'use strict';

/**
 * Boot-selected SandboxProvider facade used by /code. The selection and its
 * validated attestation are captured once at module load; changing process.env
 * later cannot silently upgrade the execution boundary.
 */

const {
  SandboxContractError,
  normalizeAttestation,
  normalizeSecretRef,
  hasSecretRefInput,
  requireCapability,
} = require('./sandbox-providers/contract');
const { createSandboxProviderRegistry } = require('./sandbox-providers/registry');
const { createSharedRunnerProvider } = require('./sandbox-providers/shared-runner-provider');

const DEFAULT_PROVIDER_ID = 'shared-runner';

function selectedProviderId(env = process.env) {
  return String(env.CODEX_SANDBOX_PROVIDER || DEFAULT_PROVIDER_ID).trim().toLowerCase();
}

function createSandboxRuntime({ env = process.env, registry } = {}) {
  if (!registry) throw new SandboxContractError('invalid_registry', 'sandbox provider registry is required');
  const provider = registry.require(selectedProviderId(env));
  const attestation = normalizeAttestation(provider.attest(), provider);

  const runtime = {
    providerId: provider.id,
    providerVersion: provider.version,
    attestation,

    createClient(options = {}) {
      if (hasSecretRefInput(options)) requireCapability(attestation, 'secretRefs', 'accepting secret refs');
      const client = provider.createClient(options);
      if (!client || typeof client !== 'object' || Array.isArray(client)) {
        throw new SandboxContractError('invalid_client', `sandbox provider ${provider.id} returned an invalid client`);
      }
      return client;
    },

    issueSecretRef(request, context) {
      requireCapability(attestation, 'secretRefs', 'issuing secret refs');
      return normalizeSecretRef(provider.issueSecretRef(request, context));
    },

    acceptSecretRef(secretRef, context) {
      requireCapability(attestation, 'secretRefs', 'accepting secret refs');
      const normalized = normalizeSecretRef(secretRef);
      return provider.acceptSecretRef(normalized, context);
    },
  };

  return Object.freeze(runtime);
}

function createDefaultRegistry() {
  return createSandboxProviderRegistry([createSharedRunnerProvider()]);
}

// Security-sensitive boot singleton. Do not rebuild this from request env.
const bootRegistry = createDefaultRegistry();
const bootRuntime = createSandboxRuntime({ env: process.env, registry: bootRegistry });

function getSandboxRuntime() {
  return bootRuntime;
}

function createSandboxClient(options) {
  return bootRuntime.createClient(options);
}

module.exports = {
  DEFAULT_PROVIDER_ID,
  selectedProviderId,
  createSandboxRuntime,
  createDefaultRegistry,
  getSandboxRuntime,
  createSandboxClient,
};
