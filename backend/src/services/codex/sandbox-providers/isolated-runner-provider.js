'use strict';

const { createRunnerClient } = require('../runner-client');
const {
  PROVIDER_SCHEMA_VERSION,
  ATTESTATION_SCHEMA_VERSION,
  SandboxPolicyError,
  hasSecretRefInput,
} = require('./contract');

const PROVIDER_ID = 'isolated-runner';
const PROVIDER_VERSION = '1.0.0';
const ALLOWED_BOUNDARIES = new Set(['gvisor-systrap', 'microvm', 'container-per-workspace']);

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
}

function resolveIsolatedRunnerConfig(env = process.env) {
  if (String(env.CODEX_ISOLATED_RUNNER_ATTESTED || '').trim() !== '1') {
    throw new SandboxPolicyError(
      'sandbox_attestation_required',
      'CODEX_ISOLATED_RUNNER_ATTESTED=1 is required before selecting isolated-runner',
    );
  }
  const rawUrl = String(env.CODEX_ISOLATED_RUNNER_URL || '').trim();
  const token = String(env.CODEX_ISOLATED_RUNNER_CONTROL_TOKEN || '').trim();
  if (!rawUrl || !token) {
    throw new SandboxPolicyError(
      'sandbox_configuration_invalid',
      'isolated-runner requires CODEX_ISOLATED_RUNNER_URL and CODEX_ISOLATED_RUNNER_CONTROL_TOKEN',
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SandboxPolicyError('sandbox_configuration_invalid', 'CODEX_ISOLATED_RUNNER_URL is invalid');
  }
  const localDevelopment = env.NODE_ENV !== 'production' && url.protocol === 'http:' && isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !localDevelopment) {
    throw new SandboxPolicyError('sandbox_configuration_invalid', 'isolated-runner requires HTTPS outside local development');
  }
  if (url.username || url.password || url.hash) {
    throw new SandboxPolicyError('sandbox_configuration_invalid', 'isolated-runner URL cannot contain credentials or a fragment');
  }

  const boundary = String(env.CODEX_ISOLATED_RUNNER_BOUNDARY || 'gvisor-systrap').trim().toLowerCase();
  if (!ALLOWED_BOUNDARIES.has(boundary)) {
    throw new SandboxPolicyError('sandbox_configuration_invalid', 'isolated-runner boundary is not supported');
  }
  return Object.freeze({
    url: url.toString().replace(/\/+$/, ''),
    token,
    boundary,
    publicMultiTenant: String(env.CODEX_ISOLATED_RUNNER_PUBLIC_MULTI_TENANT || '').trim() === '1',
  });
}

function createIsolatedRunnerProvider({
  env = process.env,
  clientFactory = createRunnerClient,
} = {}) {
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,

    attest() {
      const config = resolveIsolatedRunnerConfig(env);
      return {
        schemaVersion: ATTESTATION_SCHEMA_VERSION,
        provider: { id: PROVIDER_ID, version: PROVIDER_VERSION },
        isolation: {
          isolated: true,
          boundary: config.boundary,
          tenantScope: 'workspace',
        },
        capabilities: {
          publicMultiTenant: config.publicMultiTenant,
          secretRefs: false,
        },
      };
    },

    createClient(options = {}) {
      if (hasSecretRefInput(options)) {
        throw new SandboxPolicyError(
          'sandbox_secret_refs_unsupported',
          'isolated-runner does not support secret refs until a vault broker is configured',
        );
      }
      const config = resolveIsolatedRunnerConfig(env);
      return clientFactory({
        ...options,
        baseUrl: config.url,
        controlToken: config.token,
      });
    },

    issueSecretRef() {
      throw new SandboxPolicyError('sandbox_secret_refs_unsupported', 'isolated-runner secret refs are not configured');
    },

    acceptSecretRef() {
      throw new SandboxPolicyError('sandbox_secret_refs_unsupported', 'isolated-runner secret refs are not configured');
    },
  };
}

module.exports = {
  ALLOWED_BOUNDARIES,
  PROVIDER_ID,
  PROVIDER_VERSION,
  createIsolatedRunnerProvider,
  resolveIsolatedRunnerConfig,
};
