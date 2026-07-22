'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDER_SCHEMA_VERSION,
  ATTESTATION_SCHEMA_VERSION,
  SECRET_REF_SCHEMA_VERSION,
  SandboxContractError,
  SandboxPolicyError,
} = require('../src/services/codex/sandbox-providers/contract');
const { createSandboxProviderRegistry } = require('../src/services/codex/sandbox-providers/registry');
const { createSharedRunnerProvider } = require('../src/services/codex/sandbox-providers/shared-runner-provider');
const {
  createSandboxRuntime,
  getSandboxRuntime,
  selectedProviderId,
} = require('../src/services/codex/sandbox-provider');

function attestation({ id, isolated = true, publicMultiTenant = true, secretRefs = true } = {}) {
  return {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    provider: { id, version: '1.0.0' },
    isolation: {
      isolated,
      boundary: isolated ? 'gvisor-systrap' : 'shared-container',
      tenantScope: isolated ? 'workspace' : 'shared',
    },
    capabilities: { publicMultiTenant, secretRefs },
  };
}

function fakeProvider({
  id = 'fake-isolated',
  attest = () => attestation({ id }),
  createClient = () => ({}),
  issueSecretRef = () => ({
    schemaVersion: SECRET_REF_SCHEMA_VERSION,
    ref: 'vault:opaque',
    sandboxRef: 'sb-1',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }),
  acceptSecretRef = () => ({ accepted: true }),
} = {}) {
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id,
    version: '1.0.0',
    attest,
    createClient,
    issueSecretRef,
    acceptSecretRef,
  };
}

test('shared runner attests non-isolation and preserves runner-client behavior exactly', () => {
  const client = { initWorkspace() {}, readFile() {}, marker: Symbol('same-client') };
  const options = { baseUrl: 'http://runner.test:4097', timeoutMs: 1234 };
  let received;
  const provider = createSharedRunnerProvider({
    clientFactory(value) { received = value; return client; },
  });
  const registry = createSandboxProviderRegistry([provider]);
  const runtime = createSandboxRuntime({ env: { CODEX_SANDBOX_PROVIDER: 'shared-runner' }, registry });

  assert.equal(runtime.createClient(options), client);
  assert.equal(received, options);
  assert.deepEqual(runtime.attestation, {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    provider: { id: 'shared-runner', version: '1.0.0' },
    isolation: { isolated: false, boundary: 'shared-container', tenantScope: 'shared' },
    capabilities: { publicMultiTenant: false, secretRefs: false },
  });
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.attestation), true);
  assert.equal(Object.isFrozen(runtime.attestation.isolation), true);
});

test('registry and provider selection are immutable after construction', () => {
  const env = { CODEX_SANDBOX_PROVIDER: 'shared-runner' };
  const registry = createSandboxProviderRegistry([
    createSharedRunnerProvider({ clientFactory: () => ({ provider: 'shared' }) }),
    fakeProvider({ id: 'isolated-one', createClient: () => ({ provider: 'isolated' }) }),
  ]);
  const runtime = createSandboxRuntime({ env, registry });

  env.CODEX_SANDBOX_PROVIDER = 'isolated-one';
  assert.equal(runtime.providerId, 'shared-runner');
  assert.equal(runtime.createClient().provider, 'shared');
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.ids), true);
  assert.deepEqual(registry.ids, ['shared-runner', 'isolated-one']);
  assert.equal(selectedProviderId({}), 'shared-runner');
  assert.equal(selectedProviderId({ CODEX_SANDBOX_PROVIDER: ' ISOLATED-ONE ' }), 'isolated-one');
});

test('the process singleton keeps the provider selected when the module booted', () => {
  const boot = getSandboxRuntime();
  const previous = process.env.CODEX_SANDBOX_PROVIDER;
  process.env.CODEX_SANDBOX_PROVIDER = 'changed-after-boot';
  try {
    assert.equal(getSandboxRuntime(), boot);
    assert.equal(getSandboxRuntime().providerId, 'shared-runner');
  } finally {
    if (previous === undefined) delete process.env.CODEX_SANDBOX_PROVIDER;
    else process.env.CODEX_SANDBOX_PROVIDER = previous;
  }
});

test('unknown selection and duplicate providers fail closed', () => {
  const provider = createSharedRunnerProvider({ clientFactory: () => ({}) });
  const registry = createSandboxProviderRegistry([provider]);
  assert.throws(
    () => createSandboxRuntime({ env: { CODEX_SANDBOX_PROVIDER: 'does-not-exist' }, registry }),
    (error) => error instanceof SandboxContractError && error.code === 'unknown_sandbox_provider',
  );
  assert.throws(
    () => createSandboxProviderRegistry([provider, provider]),
    (error) => error instanceof SandboxContractError && error.code === 'duplicate_provider',
  );
});

test('malformed attestation and malformed client result never pass the boundary', () => {
  const malformedAttestation = fakeProvider({ id: 'bad-attestation', attest: () => ({ ok: true }) });
  assert.throws(
    () => createSandboxRuntime({
      env: { CODEX_SANDBOX_PROVIDER: 'bad-attestation' },
      registry: createSandboxProviderRegistry([malformedAttestation]),
    }),
    (error) => error instanceof SandboxContractError && error.code === 'unsupported_attestation_schema',
  );

  const malformedClient = fakeProvider({ id: 'bad-client', createClient: () => null });
  const runtime = createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'bad-client' },
    registry: createSandboxProviderRegistry([malformedClient]),
  });
  assert.throws(
    () => runtime.createClient(),
    (error) => error instanceof SandboxContractError && error.code === 'invalid_client',
  );
});

test('false attestation blocks issuing, accepting, and injecting secret refs before provider code runs', () => {
  const calls = [];
  const provider = fakeProvider({
    id: 'honest-shared',
    attest: () => attestation({ id: 'honest-shared', isolated: false, publicMultiTenant: false, secretRefs: false }),
    createClient: () => { calls.push('client'); return {}; },
    issueSecretRef: () => { calls.push('issue'); return {}; },
    acceptSecretRef: () => { calls.push('accept'); return {}; },
  });
  const runtime = createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'honest-shared' },
    registry: createSandboxProviderRegistry([provider]),
  });

  for (const operation of [
    () => runtime.issueSecretRef({ name: 'DATABASE_URL' }),
    () => runtime.acceptSecretRef({ schemaVersion: SECRET_REF_SCHEMA_VERSION }),
    () => runtime.createClient({ secretRefs: ['vault:opaque'] }),
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof SandboxPolicyError && error.code === 'sandbox_isolation_required',
    );
  }
  assert.deepEqual(calls, []);
});

test('contradictory non-isolated capability claims are rejected as unsafe', () => {
  const provider = fakeProvider({
    id: 'false-claim',
    attest: () => attestation({ id: 'false-claim', isolated: false, publicMultiTenant: true, secretRefs: true }),
  });
  assert.throws(
    () => createSandboxRuntime({
      env: { CODEX_SANDBOX_PROVIDER: 'false-claim' },
      registry: createSandboxProviderRegistry([provider]),
    }),
    (error) => error instanceof SandboxContractError && error.code === 'unsafe_attestation',
  );
});

test('isolated provider secret refs are normalized and validated before acceptance', () => {
  let accepted;
  const provider = fakeProvider({
    acceptSecretRef: (ref) => { accepted = ref; return { accepted: true }; },
  });
  const runtime = createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'fake-isolated' },
    registry: createSandboxProviderRegistry([provider]),
  });
  const issued = runtime.issueSecretRef({ name: 'DATABASE_URL' });
  assert.equal(issued.ref, 'vault:opaque');
  assert.equal(Object.isFrozen(issued), true);
  assert.deepEqual(runtime.acceptSecretRef(issued), { accepted: true });
  assert.deepEqual(accepted, issued);
  assert.equal(Object.isFrozen(accepted), true);
});

test('expired secret refs fail closed before provider acceptance', () => {
  let accepted = false;
  const provider = fakeProvider({
    acceptSecretRef: () => { accepted = true; return { accepted: true }; },
  });
  const runtime = createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'fake-isolated' },
    registry: createSandboxProviderRegistry([provider]),
  });

  assert.throws(
    () => runtime.acceptSecretRef({
      schemaVersion: SECRET_REF_SCHEMA_VERSION,
      ref: 'vault:expired',
      sandboxRef: 'sb-1',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }),
    (error) => error instanceof SandboxContractError && error.code === 'expired_secret_ref',
  );
  assert.equal(accepted, false);
});
