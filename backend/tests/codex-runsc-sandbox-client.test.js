'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SandboxContractError,
  SandboxPolicyError,
  normalizeInstanceAttestation,
} = require('../src/services/codex/sandbox-providers/contract');
const {
  RunscSandboxClientError,
  controllerUrl,
  opaqueWorkspaceRef,
  createRunscSandboxClient,
} = require('../src/services/codex/sandbox-providers/runsc-sandbox-client');
const {
  createRunscSandboxProvider,
} = require('../src/services/codex/sandbox-providers/runsc-sandbox-provider');
const { createSandboxProviderRegistry } = require('../src/services/codex/sandbox-providers/registry');
const { createSandboxRuntime, createDefaultRegistry } = require('../src/services/codex/sandbox-provider');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function instanceAttestation(workspaceRef, sandboxRef = `sb_${'s'.repeat(32)}`, overrides = {}) {
  return {
    schemaVersion: 'sira.sandbox-instance-attestation.v1',
    provider: { id: 'runsc-workspace', version: '0.1.0' },
    sandboxRef,
    workspaceRef,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isolation: { isolated: true, boundary: 'gvisor-systrap', tenantScope: 'workspace' },
    runtime: { name: 'runsc-systrap', verifiedBy: 'docker-info+docker-inspect' },
    filesystem: { rootReadonly: true, workspaceVolumeExclusive: true, hostBinds: false },
    network: { internal: true, exclusive: true, publishedPorts: false },
    process: { user: '10001:10001', capDropAll: true, noNewPrivileges: true },
    resources: { memoryBytes: 268435456, nanoCpus: 1000000000, pidsLimit: 64, idleTimeoutMs: 300000 },
    capabilities: { publicMultiTenant: false, secretRefs: false },
    ...overrides,
  };
}

test('opaque workspace references are stable, keyed, and never contain project ids', () => {
  const project = 'cm123456789-project';
  const one = opaqueWorkspaceRef(project, 'a'.repeat(32));
  const same = opaqueWorkspaceRef(project, 'a'.repeat(32));
  const otherKey = opaqueWorkspaceRef(project, 'b'.repeat(32));
  assert.match(one, /^ws_[A-Za-z0-9_-]{43}$/);
  assert.equal(one, same);
  assert.notEqual(one, otherKey);
  assert.equal(one.includes(project), false);
  assert.throws(() => opaqueWorkspaceRef('../host', 'a'.repeat(32)), /project id/);
});

test('host backend defaults to the loopback-only controller endpoint', () => {
  assert.equal(controllerUrl({}), 'http://127.0.0.1:4098');
  assert.equal(
    controllerUrl({ CODEX_RUNSC_CONTROLLER_URL: 'http://runsc-sandbox-controller:4098/' }),
    'http://runsc-sandbox-controller:4098',
  );
});

test('client authenticates every control call, validates inspect evidence, and exposes only opaque refs', async () => {
  const calls = [];
  const key = 'k'.repeat(48);
  const token = 't'.repeat(48);
  const project = 'cm123456789-project';
  const workspaceRef = opaqueWorkspaceRef(project, key);
  const sandboxRef = `sb_${'s'.repeat(32)}`;
  const attestation = instanceAttestation(workspaceRef, sandboxRef);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (options.method === 'POST' && url.endsWith('/v1/sandboxes')) {
      assert.deepEqual(JSON.parse(options.body), { workspaceRef });
      return response(201, { sandboxRef, state: { running: true }, previewTarget: { ref: 'preview_opaque' }, attestation });
    }
    if (options.method === 'POST' && url.endsWith('/exec')) {
      assert.deepEqual(JSON.parse(options.body), { argv: ['node', '--version'], timeoutMs: 600000 });
      return response(200, { sandboxRef, exitCode: 0, stdout: 'v22', stderr: '' });
    }
    if (options.method === 'GET' && url.includes('/v1/workspaces/')) {
      return response(200, { sandboxRef, state: { running: true }, previewTarget: { ref: 'preview_opaque' }, attestation });
    }
    if (options.method === 'DELETE') return response(200, { sandboxRef, deleted: true });
    return response(200, { sandboxRef, stopped: true });
  };
  const client = createRunscSandboxClient({
    fetchImpl,
    baseUrl: 'http://controller.test',
    token,
    key,
  });
  const created = await client.initWorkspace(project);
  assert.equal(created.sandboxRef, sandboxRef);
  assert.equal(created.attestation.runtime.verifiedBy, 'docker-info+docker-inspect');
  assert.deepEqual(await client.exec(project, ['node', '--version']), {
    sandboxRef, exitCode: 0, stdout: 'v22', stderr: '',
  });
  const status = await client.sandboxStatus(project);
  assert.equal(status.attestation.workspaceRef, workspaceRef);
  assert.equal((await client.devStatus(project)).ready, false, 'foundation must not claim preview readiness');
  await client.stopSandbox(project);
  await client.deleteSandbox(project);
  assert.ok(calls.length >= 6);
  assert.ok(calls.every((call) => !call.url.includes(project)));
  assert.ok(calls.some((call) => call.options.method === 'DELETE' && call.url.includes('/v1/workspaces/')));
  assert.throws(() => client.writeFiles(project, []), (error) => (
    error instanceof SandboxPolicyError && error.code === 'sandbox_operation_unavailable'
  ));
});

test('status from a fresh client is read-only and never provisions or restarts a sandbox', async () => {
  const calls = [];
  const client = createRunscSandboxClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(404, { error: 'sandbox_not_found', message: 'sandbox does not exist' });
    },
    baseUrl: 'http://controller.test',
    token: 't'.repeat(48),
    key: 'k'.repeat(48),
  });
  assert.deepEqual(await client.devStatus('cm123456789-project'), {
    running: false,
    ready: false,
    sandboxRunning: false,
    absent: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.match(calls[0].url, /\/v1\/workspaces\/ws_/);
  assert.doesNotMatch(calls[0].url, /\/v1\/sandboxes$/);
});

test('exec reprovisions once only after a controller response proving it did not start', async () => {
  const key = 'k'.repeat(48);
  const project = 'cm123456789-project';
  const workspaceRef = opaqueWorkspaceRef(project, key);
  const staleRef = `sb_${'a'.repeat(32)}`;
  const freshRef = `sb_${'b'.repeat(32)}`;
  const posts = [];
  let provisionCount = 0;
  let staleResponse = response(409, { error: 'sandbox_not_running' });
  const client = createRunscSandboxClient({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/sandboxes')) {
        provisionCount += 1;
        const sandboxRef = provisionCount === 1 ? staleRef : freshRef;
        return response(201, {
          sandboxRef,
          state: { running: true },
          previewTarget: { ref: 'preview_opaque' },
          attestation: instanceAttestation(workspaceRef, sandboxRef),
        });
      }
      if (url.endsWith('/exec')) {
        posts.push(url);
        if (url.includes(staleRef)) return staleResponse;
        return response(200, { sandboxRef: freshRef, exitCode: 0, stdout: 'ok', stderr: '' });
      }
      throw new Error(`unexpected call ${options.method} ${url}`);
    },
    baseUrl: 'http://controller.test', token: 't'.repeat(48), key,
  });
  assert.equal((await client.exec(project, ['node', '--version'])).stdout, 'ok');
  assert.equal(provisionCount, 2);
  assert.equal(posts.length, 2);

  for (const [status, code] of [
    [409, 'other_conflict'],
    [404, 'docker_api_error'],
    [410, 'docker_api_error'],
  ]) {
    let execCalls = 0;
    const ambiguous = createRunscSandboxClient({
      fetchImpl: async (url) => {
        if (url.endsWith('/v1/sandboxes')) {
          return response(201, {
            sandboxRef: staleRef,
            state: { running: true },
            previewTarget: { ref: 'preview_opaque' },
            attestation: instanceAttestation(workspaceRef, staleRef),
          });
        }
        execCalls += 1;
        return response(status, { error: code });
      },
      baseUrl: 'http://controller.test', token: 't'.repeat(48), key,
    });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => ambiguous.exec(project, ['node', '--version']),
      (error) => error instanceof RunscSandboxClientError
        && error.status === status
        && error.code === code,
    );
    assert.equal(execCalls, 1, `${status}/${code} must never replay an ambiguous command`);
  }
});

test('client rejects malformed or mismatched controller attestation fail-closed', async () => {
  const key = 'k'.repeat(48);
  const project = 'cm123456789-project';
  const workspaceRef = opaqueWorkspaceRef(project, key);
  for (const result of [
    { sandboxRef: `sb_${'s'.repeat(32)}`, attestation: { ok: true } },
    {
      sandboxRef: `sb_${'s'.repeat(32)}`,
      attestation: instanceAttestation(`ws_${'x'.repeat(43)}`),
    },
  ]) {
    const client = createRunscSandboxClient({
      fetchImpl: async () => response(201, result),
      baseUrl: 'http://controller.test', token: 't'.repeat(48), key,
    });
    await assert.rejects(() => client.initWorkspace(project), SandboxContractError);
  }
  assert.doesNotThrow(() => normalizeInstanceAttestation(instanceAttestation(workspaceRef)));
  assert.throws(() => normalizeInstanceAttestation(instanceAttestation(workspaceRef, undefined, {
    capabilities: { publicMultiTenant: true, secretRefs: false },
  })), /does not satisfy/);
});

test('client request deadline outlives the configured default controller exec budget', async () => {
  const key = 'k'.repeat(48);
  const token = 't'.repeat(48);
  const project = 'cm123456789-project';
  const workspaceRef = opaqueWorkspaceRef(project, key);
  const sandboxRef = `sb_${'e'.repeat(32)}`;
  const attestation = instanceAttestation(workspaceRef, sandboxRef);
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/v1/sandboxes')) {
      return response(201, { sandboxRef, state: { running: true }, previewTarget: { ref: 'preview_opaque' }, attestation });
    }
    assert.deepEqual(JSON.parse(options.body), { argv: ['node', '--version'], timeoutMs: 1000 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 20);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
    return response(200, { sandboxRef, exitCode: 0, stdout: 'v22', stderr: '' });
  };
  const client = createRunscSandboxClient({
    fetchImpl, baseUrl: 'http://controller.test', token, key, timeoutMs: 5, execTimeoutMs: 1000,
  });
  await client.initWorkspace(project);
  assert.equal((await client.exec(project, ['node', '--version'])).exitCode, 0);
});

test('runsc provider is disabled by default and remains non-public and secretless when selected', () => {
  const disabled = createRunscSandboxProvider({ env: {} });
  const disabledRuntime = () => createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'runsc-workspace' },
    registry: createSandboxProviderRegistry([disabled]),
  });
  assert.throws(disabledRuntime, (error) => (
    error instanceof SandboxPolicyError && error.code === 'sandbox_provider_disabled'
  ));

  const incomplete = createRunscSandboxProvider({ env: { CODEX_RUNSC_SANDBOX_ENABLED: 'true' } });
  assert.throws(() => createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'runsc-workspace' },
    registry: createSandboxProviderRegistry([incomplete]),
  }), /controller token is required/);

  const env = {
    CODEX_RUNSC_SANDBOX_ENABLED: 'true',
    CODEX_RUNSC_CONTROLLER_URL: 'http://controller.test:4098',
    RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48),
    CODEX_RUNSC_WORKSPACE_KEY: 'k'.repeat(48),
    RUNSC_SANDBOX_EXEC_TIMEOUT_MS: '600000',
  };
  const marker = {};
  const provider = createRunscSandboxProvider({ env, clientFactory: () => marker });
  const runtime = createSandboxRuntime({
    env: { CODEX_SANDBOX_PROVIDER: 'runsc-workspace' },
    registry: createSandboxProviderRegistry([provider]),
  });
  assert.equal(runtime.createClient(), marker);
  assert.equal(runtime.attestation.capabilities.publicMultiTenant, false);
  assert.equal(runtime.attestation.capabilities.secretRefs, false);
  assert.throws(() => runtime.issueSecretRef({ name: 'DATABASE_URL' }), /requires an isolated workspace sandbox/);
  assert.deepEqual(createDefaultRegistry({}).ids, ['shared-runner', 'runsc-workspace']);
});
