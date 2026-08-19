'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SandboxPolicyError } = require('../src/services/codex/sandbox-providers/contract');
const { createSandboxProviderRegistry } = require('../src/services/codex/sandbox-providers/registry');
const {
  createIsolatedRunnerProvider,
} = require('../src/services/codex/sandbox-providers/isolated-runner-provider');
const { createSandboxRuntime, createDefaultRegistry } = require('../src/services/codex/sandbox-provider');

test('default registry exposes both providers while preserving shared-runner as default', () => {
  const registry = createDefaultRegistry({ env: {} });
  assert.deepEqual(registry.ids, ['shared-runner', 'isolated-runner']);
});

test('isolated-runner fails closed without an explicit operator attestation', () => {
  const provider = createIsolatedRunnerProvider({ env: {} });
  const registry = createSandboxProviderRegistry([provider]);
  assert.throws(
    () => createSandboxRuntime({
      env: { CODEX_SANDBOX_PROVIDER: 'isolated-runner' },
      registry,
    }),
    (error) => error instanceof SandboxPolicyError && error.code === 'sandbox_attestation_required',
  );
});

test('isolated-runner attests a configured workspace boundary and pins its client endpoint', () => {
  const env = {
    NODE_ENV: 'production',
    CODEX_ISOLATED_RUNNER_ATTESTED: '1',
    CODEX_ISOLATED_RUNNER_URL: 'https://runner-isolated.example.com/control/',
    CODEX_ISOLATED_RUNNER_CONTROL_TOKEN: 'control-token',
    CODEX_ISOLATED_RUNNER_BOUNDARY: 'microvm',
    CODEX_ISOLATED_RUNNER_PUBLIC_MULTI_TENANT: '1',
  };
  let options;
  const provider = createIsolatedRunnerProvider({
    env,
    clientFactory: (value) => {
      options = value;
      return { ok: true };
    },
  });
  const runtime = createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'isolated-runner' },
    registry: createSandboxProviderRegistry([provider]),
  });

  assert.deepEqual(runtime.attestation.isolation, {
    isolated: true,
    boundary: 'microvm',
    tenantScope: 'workspace',
  });
  assert.equal(runtime.attestation.capabilities.publicMultiTenant, true);
  assert.deepEqual(runtime.createClient({ timeoutMs: 1234, baseUrl: 'https://attacker.invalid' }), { ok: true });
  assert.equal(options.baseUrl, 'https://runner-isolated.example.com/control');
  assert.equal(options.controlToken, 'control-token');
  assert.throws(
    () => runtime.createClient({ secretRefs: ['vault:ref'] }),
    (error) => error instanceof SandboxPolicyError && error.code === 'sandbox_isolation_required',
  );
});
