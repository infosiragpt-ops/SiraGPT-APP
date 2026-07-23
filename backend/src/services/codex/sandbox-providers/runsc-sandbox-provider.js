'use strict';

const {
  PROVIDER_SCHEMA_VERSION,
  ATTESTATION_SCHEMA_VERSION,
  SandboxPolicyError,
  hasSecretRefInput,
} = require('./contract');
const {
  createRunscSandboxClient,
  controllerUrl,
  controllerToken,
  workspaceKey,
  controllerExecTimeout,
} = require('./runsc-sandbox-client');

const PROVIDER_ID = 'runsc-workspace';
const PROVIDER_VERSION = '0.1.0';

function enabled(env = process.env) {
  return ['1', 'true', 'on'].includes(String(env.CODEX_RUNSC_SANDBOX_ENABLED || '').trim().toLowerCase());
}

function createRunscSandboxProvider({ env = process.env, clientFactory = createRunscSandboxClient } = {}) {
  const configuredEnabled = enabled(env);
  const clientEnv = Object.freeze({
    CODEX_RUNSC_CONTROLLER_URL: env.CODEX_RUNSC_CONTROLLER_URL,
    // Compose maps the shared controller credential into the CODEX-prefixed
    // name for the optional Docker backend. PM2 reads the production env
    // directly, so accept the controller's canonical external secret name as
    // a host-runtime fallback without copying it anywhere else.
    CODEX_RUNSC_CONTROLLER_TOKEN:
      env.CODEX_RUNSC_CONTROLLER_TOKEN || env.RUNSC_SANDBOX_CONTROLLER_TOKEN,
    CODEX_RUNSC_WORKSPACE_KEY: env.CODEX_RUNSC_WORKSPACE_KEY,
    CODEX_RUNSC_EXEC_TIMEOUT_MS:
      env.CODEX_RUNSC_EXEC_TIMEOUT_MS || env.RUNSC_SANDBOX_EXEC_TIMEOUT_MS,
  });

  function validateControlPlaneConfig() {
    return Object.freeze({
      baseUrl: controllerUrl(clientEnv),
      token: controllerToken(clientEnv),
      key: workspaceKey(clientEnv),
      execTimeoutMs: controllerExecTimeout(clientEnv),
    });
  }
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,

    attest() {
      if (!configuredEnabled) {
        throw new SandboxPolicyError('sandbox_provider_disabled', 'runsc workspace provider is disabled');
      }
      validateControlPlaneConfig();
      // This boot posture is deliberately conservative. Concrete isolation is
      // re-attested from Docker inspect for every sandbox operation, while
      // public access and secret refs remain disabled in this foundation.
      return {
        schemaVersion: ATTESTATION_SCHEMA_VERSION,
        provider: { id: PROVIDER_ID, version: PROVIDER_VERSION },
        isolation: { isolated: true, boundary: 'gvisor-systrap', tenantScope: 'workspace' },
        capabilities: { publicMultiTenant: false, secretRefs: false },
      };
    },

    createClient(options = {}) {
      if (!configuredEnabled) throw new SandboxPolicyError('sandbox_provider_disabled', 'runsc workspace provider is disabled');
      if (hasSecretRefInput(options)) {
        throw new SandboxPolicyError('sandbox_secret_refs_disabled', 'runsc workspace secret refs are not implemented');
      }
      const validated = validateControlPlaneConfig();
      return clientFactory({ ...options, ...validated, env: clientEnv });
    },

    issueSecretRef() {
      throw new SandboxPolicyError('sandbox_secret_refs_disabled', 'runsc workspace secret refs are not implemented');
    },

    acceptSecretRef() {
      throw new SandboxPolicyError('sandbox_secret_refs_disabled', 'runsc workspace secret refs are not implemented');
    },
  };
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_VERSION,
  enabled,
  createRunscSandboxProvider,
};
