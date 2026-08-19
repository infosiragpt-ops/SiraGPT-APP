'use strict';

const { createRunnerClient } = require('../runner-client');
const {
  PROVIDER_SCHEMA_VERSION,
  ATTESTATION_SCHEMA_VERSION,
  SandboxPolicyError,
  hasSecretRefInput,
} = require('./contract');

const PROVIDER_ID = 'shared-runner';
const PROVIDER_VERSION = '1.0.0';

/**
 * Compatibility provider for the current sidecar. It preserves the complete
 * runner-client API, while explicitly attesting that a shared container is not
 * a hostile multi-tenant isolation boundary.
 */
function createSharedRunnerProvider({ clientFactory = createRunnerClient } = {}) {
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,

    attest() {
      return {
        schemaVersion: ATTESTATION_SCHEMA_VERSION,
        provider: { id: PROVIDER_ID, version: PROVIDER_VERSION },
        isolation: {
          isolated: false,
          boundary: 'shared-container',
          tenantScope: 'shared',
        },
        capabilities: {
          publicMultiTenant: false,
          secretRefs: false,
        },
      };
    },

    createClient(options = {}) {
      if (hasSecretRefInput(options)) {
        throw new SandboxPolicyError(
          'sandbox_isolation_required',
          'the shared runner cannot receive sandbox secret refs',
        );
      }
      return clientFactory(options);
    },

    issueSecretRef() {
      throw new SandboxPolicyError('sandbox_isolation_required', 'the shared runner cannot issue sandbox secret refs');
    },

    acceptSecretRef() {
      throw new SandboxPolicyError('sandbox_isolation_required', 'the shared runner cannot accept sandbox secret refs');
    },
  };
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_VERSION,
  createSharedRunnerProvider,
};
