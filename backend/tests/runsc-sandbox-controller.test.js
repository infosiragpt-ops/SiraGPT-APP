'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const {
  MANAGED_LABEL,
  SANDBOX_REF_LABEL,
  WORKSPACE_REF_LABEL,
  RESOURCE_KIND_LABEL,
  parseControllerConfig,
  verifyRuntimeConfiguration,
  desiredContainerSpec,
  verifyContainerAttestation,
  randomOpaqueRef,
} = require(path.join(ROOT, 'scripts/runsc-sandbox-controller-utils'));
const { RunscSandboxService } = require(path.join(ROOT, 'scripts/runsc-sandbox-service'));
const { DockerApi, DockerApiError, decodeDockerStream } = require(path.join(ROOT, 'scripts/runsc-sandbox-docker-api'));
const { FileActivityStore } = require(path.join(ROOT, 'scripts/runsc-sandbox-activity-store'));
const { createController } = require(path.join(ROOT, 'scripts/runsc-sandbox-controller'));

const PINNED_BUN_IMAGE_ENV = Object.freeze([
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0',
  'BUN_INSTALL_BIN=/usr/local/bin',
]);

function config(overrides = {}) {
  return {
    ...parseControllerConfig({
      RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48),
      RUNSC_SANDBOX_WORKER_IMAGE: `sha256:${'a'.repeat(64)}`,
      RUNSC_SANDBOX_RUNTIME: 'runsc-systrap',
      RUNSC_SANDBOX_MEMORY_BYTES: String(256 * 1024 * 1024),
      RUNSC_SANDBOX_NANO_CPUS: '1000000000',
      RUNSC_SANDBOX_PIDS_LIMIT: '64',
      RUNSC_SANDBOX_MAX_ACTIVE: '3',
      RUNSC_SANDBOX_TTL_MS: '600000',
      RUNSC_SANDBOX_MAX_TTL_MS: '3600000',
      RUNSC_SANDBOX_IDLE_TIMEOUT_MS: '300000',
      RUNSC_SANDBOX_EXEC_TIMEOUT_MS: '5000',
    }),
    ...overrides,
  };
}

function matchesLabels(labels, filters = {}) {
  return (filters.label || []).every((filter) => {
    const [key, ...rest] = filter.split('=');
    return rest.length === 0 ? Object.hasOwn(labels, key) : labels[key] === rest.join('=');
  });
}

class FakeDocker {
  constructor(cfg) {
    this.cfg = cfg;
    this.volumes = new Map();
    this.networks = new Map();
    this.containers = new Map();
    this.execCalls = [];
    this.sequence = 0;
  }

  async info() {
    return { Runtimes: { [this.cfg.runtime]: { path: this.cfg.runtimePath, runtimeArgs: [...this.cfg.runtimeArgs] } } };
  }
  async inspectImage() { return { Id: this.cfg.image }; }
  async createVolume(body) {
    const volume = {
      Name: body.Name,
      Driver: body.Driver || 'local',
      Scope: 'local',
      Options: body.DriverOpts || null,
      Labels: body.Labels,
    };
    this.volumes.set(body.Name, volume);
    return volume;
  }
  async inspectVolume(name) { return structuredClone(this.volumes.get(name)); }
  async listVolumes(filters) {
    return [...this.volumes.values()].filter((v) => matchesLabels(v.Labels, filters)).map((value) => structuredClone(value));
  }
  async removeVolume(name) { this.volumes.delete(name); }
  async createNetwork(body) {
    const network = { ...structuredClone(body), Id: `network-${++this.sequence}`, Containers: {} };
    this.networks.set(network.Id, network);
    this.networks.set(network.Name, network);
    return { Id: network.Id };
  }
  async inspectNetwork(id) { return structuredClone(this.networks.get(id)); }
  async listNetworks(filters) {
    return [...new Set(this.networks.values())]
      .filter((v) => matchesLabels(v.Labels, filters))
      .map((value) => structuredClone(value));
  }
  async removeNetwork(id) {
    const network = this.networks.get(id);
    if (network) {
      this.networks.delete(network.Id);
      this.networks.delete(network.Name);
    }
  }
  async createContainer(name, body) {
    const id = `container-${++this.sequence}`;
    const networkName = body.HostConfig.NetworkMode;
    const mount = body.HostConfig.Mounts[0];
    const requestedEnvNames = new Set(body.Env.map((entry) => entry.split('=', 1)[0]));
    const effectiveEnv = [
      ...body.Env,
      ...PINNED_BUN_IMAGE_ENV.filter((entry) => !requestedEnvNames.has(entry.split('=', 1)[0])),
    ];
    const inspect = {
      Id: id,
      Image: body.Image,
      Name: `/${name}`,
      Config: {
        Image: body.Image,
        User: body.User,
        // Moby merges image Config.Env entries absent from the create request.
        Env: effectiveEnv,
        Labels: body.Labels,
      },
      HostConfig: structuredClone(body.HostConfig),
      Mounts: [{ Type: 'volume', Name: mount.Source, Source: `/opaque/${mount.Source}`, Destination: mount.Target, RW: true }],
      NetworkSettings: { Networks: { [networkName]: {} }, Ports: {} },
      State: { Running: false, Status: 'created', ExitCode: 0, OOMKilled: false, StartedAt: new Date().toISOString() },
    };
    this.containers.set(id, inspect);
    return { Id: id };
  }
  async inspectContainer(id) { return structuredClone(this.containers.get(id)); }
  async listContainers(filters) {
    return [...this.containers.values()]
      .filter((value) => matchesLabels(value.Config.Labels, filters))
      .filter((value) => !filters?.volume
        || filters.volume.includes(value.Mounts.find((mount) => mount.Destination === '/workspace')?.Name))
      .map((value) => ({ Id: value.Id, Names: [value.Name], Labels: structuredClone(value.Config.Labels), State: value.State.Status }));
  }
  async startContainer(id) {
    const item = this.containers.get(id);
    item.State.Running = true;
    item.State.Status = 'running';
    item.State.StartedAt = new Date().toISOString();
    const network = this.networks.get(item.HostConfig.NetworkMode);
    network.Containers[id] = { Name: item.Name.slice(1) };
  }
  async stopContainer(id) {
    const item = this.containers.get(id);
    item.State.Running = false;
    item.State.Status = 'exited';
  }
  async killContainer(id) {
    const item = this.containers.get(id);
    item.State.Running = false;
    item.State.Status = 'exited';
    item.State.ExitCode = 137;
  }
  async removeContainer(id) {
    const item = this.containers.get(id);
    if (item) {
      const network = this.networks.get(item.HostConfig.NetworkMode);
      if (network) delete network.Containers[id];
      this.containers.delete(id);
    }
  }
  async runExec(id, argv, options) {
    this.execCalls.push({ id, argv: structuredClone(argv), options: structuredClone(options) });
    return { exitCode: 0, stdout: `${argv.join(' ')}\n`, stderr: '' };
  }
}

function createEvidence(cfg, nowMs = Date.now()) {
  const sandboxRef = randomOpaqueRef('sb');
  const workspaceRef = `ws_${'x'.repeat(43)}`;
  const names = { containerName: 'sira-sb-proof', networkName: 'sira-sbn-proof', volumeName: 'sira-sbv-proof' };
  const desired = desiredContainerSpec({
    config: cfg, sandboxRef, workspaceRef, ...names, nowMs, ttlMs: 600000,
  });
  const inspect = {
    Id: 'container-proof',
    Image: desired.create.body.Image,
    Name: `/${names.containerName}`,
    Config: {
      Image: desired.create.body.Image,
      User: desired.create.body.User,
      Env: desired.create.body.Env,
      Labels: desired.create.body.Labels,
    },
    HostConfig: desired.create.body.HostConfig,
    Mounts: [{ Type: 'volume', Name: names.volumeName, Destination: '/workspace', RW: true }],
    NetworkSettings: { Networks: { [names.networkName]: {} } },
    State: { Running: true, Status: 'running', StartedAt: new Date(nowMs).toISOString() },
  };
  const networkInspect = {
    ...desired.network,
    Containers: { 'container-proof': { Name: names.containerName } },
  };
  const volumeInspect = { ...desired.volume, Scope: 'local', Options: null };
  const volumeUsers = [{ Id: inspect.Id }];
  const runtimeEvidence = verifyRuntimeConfiguration({
    Runtimes: { [cfg.runtime]: { path: cfg.runtimePath, runtimeArgs: [...cfg.runtimeArgs] } },
  }, cfg);
  return { inspect, networkInspect, volumeInspect, volumeUsers, runtimeEvidence, sandboxRef, workspaceRef };
}

test('controller configuration is fail-closed and pins runtime and image', () => {
  assert.throws(() => parseControllerConfig({}), /TOKEN/);
  assert.throws(() => parseControllerConfig({
    RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48), RUNSC_SANDBOX_RUNTIME: 'runc',
  }), /runsc-systrap/);
  assert.throws(() => parseControllerConfig({
    RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48), RUNSC_SANDBOX_WORKER_IMAGE: 'worker:latest',
  }), /immutable Docker image id/);
  assert.throws(() => parseControllerConfig({
    RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48),
    RUNSC_SANDBOX_WORKER_IMAGE: `sha256:${'a'.repeat(64)}`,
    RUNSC_SANDBOX_DOCKER_SOCKET: '/tmp/other.sock',
  }), /exactly \/var\/run\/docker\.sock/);
  assert.throws(() => parseControllerConfig({
    RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48),
    RUNSC_SANDBOX_WORKER_IMAGE: `sha256:${'a'.repeat(64)}`,
    RUNSC_SANDBOX_EXEC_TIMEOUT_MS: '60000',
    RUNSC_SANDBOX_IDLE_TIMEOUT_MS: '60000',
  }), /must outlive/);
  assert.throws(() => parseControllerConfig({
    RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48),
    RUNSC_SANDBOX_WORKER_IMAGE: `sha256:${'a'.repeat(64)}`,
    RUNSC_SANDBOX_TTL_MS: '60000',
    RUNSC_SANDBOX_MAX_TTL_MS: '60000',
    RUNSC_SANDBOX_EXEC_TIMEOUT_MS: '600000',
    RUNSC_SANDBOX_IDLE_TIMEOUT_MS: '700000',
  }), /TTL limits must outlive/);
  const parsed = config();
  assert.equal(parsed.runtime, 'runsc-systrap');
  assert.equal(parsed.image, `sha256:${'a'.repeat(64)}`);
  assert.equal(parseControllerConfig({
    RUNSC_SANDBOX_CONTROLLER_TOKEN: 't'.repeat(48),
    RUNSC_SANDBOX_WORKER_IMAGE: `sha256:${'a'.repeat(64)}`,
  }).image, `sha256:${'a'.repeat(64)}`);
  assert.throws(() => verifyRuntimeConfiguration({
    Runtimes: { 'runsc-systrap': { path: '/usr/bin/runc', runtimeArgs: [] } },
  }, parsed), /path or arguments/);
});

test('desired sandbox has non-root ownership, hard limits, no binds, no host ports, and no secrets', () => {
  const cfg = config();
  const evidence = createEvidence(cfg);
  const host = evidence.inspect.HostConfig;
  assert.equal(evidence.inspect.Config.User, '10001:10001');
  assert.equal(host.Runtime, 'runsc-systrap');
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.Init, true);
  assert.deepEqual(host.CapDrop, ['ALL']);
  assert.deepEqual(host.CapAdd, []);
  assert.deepEqual(host.Binds, []);
  assert.deepEqual(host.PortBindings, {});
  assert.equal(host.PublishAllPorts, false);
  assert.equal(host.Privileged, false);
  assert.equal(host.MemorySwap, host.Memory);
  assert.equal(evidence.networkInspect.Internal, true);
  assert.equal(evidence.networkInspect.Attachable, false);
  assert.equal(evidence.networkInspect.Options['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated');
  assert.ok(evidence.inspect.Config.Env.every((entry) => !/(SECRET|TOKEN|DATABASE|REDIS|DOCKER)/i.test(entry)));
  assert.ok(PINNED_BUN_IMAGE_ENV.every((entry) => evidence.inspect.Config.Env.includes(entry)));
});

test('controller readiness rejects a missing or substituted worker image', async () => {
  const cfg = config();
  const docker = new FakeDocker(cfg);
  docker.inspectImage = async () => ({ Id: `sha256:${'b'.repeat(64)}` });
  const service = new RunscSandboxService({ docker, config: cfg });
  await assert.rejects(
    () => service.assertRuntimeAvailable(),
    (error) => error.code === 'worker_image_unavailable' && error.status === 503,
  );
});

test('inspect attestation passes only the exact isolated topology', () => {
  const cfg = config();
  const valid = createEvidence(cfg);
  const attested = verifyContainerAttestation({ ...valid, config: cfg });
  assert.equal(attested.runtime.verifiedBy, 'docker-info+docker-inspect');
  assert.equal(attested.network.exclusive, true);
  assert.equal(attested.filesystem.hostBinds, false);
  assert.equal(attested.capabilities.publicMultiTenant, false);
  assert.equal(attested.capabilities.secretRefs, false);

  const mutations = [
    (copy) => { copy.inspect.Image = `sha256:${'b'.repeat(64)}`; },
    (copy) => { copy.inspect.HostConfig.Runtime = 'runc'; },
    (copy) => { copy.inspect.Config.User = '0:0'; },
    (copy) => { copy.inspect.HostConfig.CapAdd = ['SYS_ADMIN']; },
    (copy) => { copy.inspect.HostConfig.Binds = ['/host:/workspace']; },
    (copy) => { copy.inspect.HostConfig.PortBindings = { '5173/tcp': [{ HostPort: '5173' }] }; },
    (copy) => { copy.inspect.Mounts.push({ Type: 'bind', Destination: '/host', RW: true }); },
    (copy) => { copy.networkInspect.Internal = false; },
    (copy) => { copy.networkInspect.Containers.two = { Name: 'other-sandbox' }; },
    (copy) => { copy.inspect.Config.Env.push('DATABASE_URL=postgresql://secret'); },
    (copy) => { copy.inspect.Config.Env.push('SIRA_API_KEY=topsecret'); },
    (copy) => { copy.volumeInspect.Options = { type: 'none', device: '/host', o: 'bind' }; },
    (copy) => { copy.volumeUsers.push({ Id: 'other-container' }); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(valid);
    mutate(copy);
    assert.throws(() => verifyContainerAttestation({ ...copy, config: cfg }), /attestation|sandbox/i);
  }
});

test('service lifecycle is idempotent, isolated per workspace, bounded, and cleans every resource', async () => {
  const cfg = config();
  const docker = new FakeDocker(cfg);
  const service = new RunscSandboxService({ docker, config: cfg });
  const workspaceA = `ws_${'a'.repeat(43)}`;
  const workspaceB = `ws_${'b'.repeat(43)}`;
  const firstA = await service.ensure({ workspaceRef: workspaceA });
  const secondA = await service.ensure({ workspaceRef: workspaceA });
  const firstB = await service.ensure({ workspaceRef: workspaceB });
  assert.equal(secondA.sandboxRef, firstA.sandboxRef);
  assert.notEqual(firstB.sandboxRef, firstA.sandboxRef);
  assert.notEqual(firstB.previewTarget.ref, firstA.previewTarget.ref);
  assert.equal(docker.containers.size, 2);
  assert.equal(new Set(docker.volumes.keys()).size, 2);
  assert.equal(new Set(docker.networks.values()).size, 2);

  const activityBeforeStatus = await service.activityStore.get(firstA.sandboxRef);
  const readOnlyStatus = await service.statusWorkspace(workspaceA);
  assert.equal(readOnlyStatus.sandboxRef, firstA.sandboxRef);
  assert.equal(await service.activityStore.get(firstA.sandboxRef), activityBeforeStatus);

  const executed = await service.exec(firstA.sandboxRef, { argv: ['node', '-e', 'console.log(1)'], timeoutMs: 90000 });
  assert.equal(executed.exitCode, 0);
  const userCommand = docker.execCalls.find((call) => call.argv[2] === 'console.log(1)');
  assert.equal(userCommand.options.timeoutMs, cfg.execTimeoutMs, 'request timeout cannot exceed policy');
  assert.deepEqual(userCommand.argv, ['node', '-e', 'console.log(1)']);
  assert.rejects(() => service.exec(firstA.sandboxRef, { argv: ['/bin/sh', '-c', '\0'] }), /argv/);

  await service.stop(firstA.sandboxRef);
  await service.stop(firstA.sandboxRef);
  assert.equal((await service.status(firstA.sandboxRef)).state.running, false);
  await service.delete(firstA.sandboxRef);
  await service.delete(firstA.sandboxRef);
  assert.equal(docker.containers.size, 1);
  assert.equal(new Set(docker.volumes.keys()).size, 1);
  assert.equal(new Set(docker.networks.values()).size, 1);
  const beforeAbsentDelete = docker.containers.size;
  const absentDelete = await service.deleteWorkspace(`ws_${'x'.repeat(43)}`);
  assert.equal(absentDelete.absent, true);
  assert.equal(docker.containers.size, beforeAbsentDelete, 'deleteWorkspace must never create a sandbox');

  const workspaceRace = `ws_${'r'.repeat(43)}`;
  await Promise.all([
    service.ensure({ workspaceRef: workspaceRace }),
    service.deleteWorkspace(workspaceRace),
  ]);
  assert.equal((await docker.listContainers({ label: [`${WORKSPACE_REF_LABEL}=${workspaceRace}`] })).length, 0,
    'workspace lifecycle lock must serialize create and delete');
});

test('activity survives controller restart and prevents premature idle collection', async (t) => {
  let now = Date.now();
  const cfg = config();
  const docker = new FakeDocker(cfg);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-runsc-activity-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const firstStore = new FileActivityStore({ directory: stateDir });
  await firstStore.initialize();
  const first = new RunscSandboxService({ docker, config: cfg, clock: () => now, activityStore: firstStore });
  const sandbox = await first.ensure({ workspaceRef: `ws_${'u'.repeat(43)}`, ttlMs: 3_600_000 });
  now += 250_000;
  await first.exec(sandbox.sandboxRef, { argv: ['node', '--version'], timeoutMs: 1000 });
  now += 100_000;

  const secondStore = new FileActivityStore({ directory: stateDir });
  await secondStore.initialize();
  const restarted = new RunscSandboxService({ docker, config: cfg, clock: () => now, activityStore: secondStore });
  const kept = await restarted.gc();
  assert.deepEqual(kept.deleted, [], 'durable recent activity must survive controller restart');
  assert.equal(docker.containers.size, 1);

  now += cfg.idleTimeoutMs + 1;
  const expired = await restarted.gc();
  assert.deepEqual(expired.deleted, [sandbox.sandboxRef]);
  assert.equal(docker.containers.size, 0);
});

test('controller restart kills a sandbox with an unresolved durable exec marker', async (t) => {
  let now = Date.now();
  const cfg = config();
  const docker = new FakeDocker(cfg);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-runsc-exec-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const firstStore = new FileActivityStore({ directory: stateDir });
  await firstStore.initialize();
  const first = new RunscSandboxService({ docker, config: cfg, clock: () => now, activityStore: firstStore });
  const sandbox = await first.ensure({ workspaceRef: `ws_${'e'.repeat(43)}` });
  await firstStore.beginExec(sandbox.sandboxRef, now + 5000);

  now += 100;
  const secondStore = new FileActivityStore({ directory: stateDir });
  await secondStore.initialize();
  const restarted = new RunscSandboxService({ docker, config: cfg, clock: () => now, activityStore: secondStore });
  assert.deepEqual(await restarted.reconcileInterruptedExecs(), [sandbox.sandboxRef]);
  assert.deepEqual(await secondStore.listExecutions(), []);
  assert.equal((await restarted.statusWorkspace(`ws_${'e'.repeat(43)}`)).state.running, false);
});

test('GC rechecks durable activity after waiting for an in-flight sandbox lock', async () => {
  let now = Date.now();
  const cfg = config({ idleTimeoutMs: 10_000, execTimeoutMs: 1000 });
  const docker = new FakeDocker(cfg);
  const service = new RunscSandboxService({ docker, config: cfg, clock: () => now });
  const sandbox = await service.ensure({ workspaceRef: `ws_${'l'.repeat(43)}`, ttlMs: 600_000 });
  now += cfg.idleTimeoutMs + 1;

  let releaseLock;
  let lockReady;
  const ready = new Promise((resolve) => { lockReady = resolve; });
  const hold = service.withLock(`sandbox:${sandbox.sandboxRef}`, async () => {
    lockReady();
    await new Promise((resolve) => { releaseLock = resolve; });
  });
  await ready;

  const collection = service.gc();
  await new Promise((resolve) => setImmediate(resolve));
  await service.activityStore.set(sandbox.sandboxRef, now);
  releaseLock();
  await hold;

  const result = await collection;
  assert.deepEqual(result.deleted, []);
  assert.equal(docker.containers.size, 1, 'fresh activity must cancel stale GC deletion');
});

test('resuming an existing sandbox is atomic with GC and refreshes activity before collection', async () => {
  let now = Date.now();
  const cfg = config({ idleTimeoutMs: 10_000, execTimeoutMs: 1000 });
  const docker = new FakeDocker(cfg);
  const service = new RunscSandboxService({ docker, config: cfg, clock: () => now });
  const workspaceRef = `ws_${'m'.repeat(43)}`;
  const sandbox = await service.ensure({ workspaceRef, ttlMs: 600_000 });
  now += cfg.idleTimeoutMs + 1;

  let releaseProbe;
  let probeReady;
  const ready = new Promise((resolve) => { probeReady = resolve; });
  const originalProbe = service.verifyWorkspaceAccess.bind(service);
  service.verifyWorkspaceAccess = async (containerId) => {
    probeReady();
    await new Promise((resolve) => { releaseProbe = resolve; });
    return originalProbe(containerId);
  };

  const resumedPromise = service.ensure({ workspaceRef });
  await ready;
  const collectionPromise = service.gc();
  await new Promise((resolve) => setImmediate(resolve));
  releaseProbe();

  const [resumed, collection] = await Promise.all([resumedPromise, collectionPromise]);
  assert.equal(resumed.sandboxRef, sandbox.sandboxRef);
  assert.deepEqual(collection.deleted, []);
  assert.equal(docker.containers.size, 1);
});

test('startup GC deletes expired containers and orphaned labeled resources after restart', async () => {
  let now = Date.now();
  const cfg = config({ idleTimeoutMs: 10_000_000 });
  const docker = new FakeDocker(cfg);
  const first = new RunscSandboxService({ docker, config: cfg, clock: () => now });
  const sandbox = await first.ensure({ workspaceRef: `ws_${'g'.repeat(43)}`, ttlMs: 60000 });
  now += 60001;
  const restarted = new RunscSandboxService({ docker, config: cfg, clock: () => now });
  const result = await restarted.gc();
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.deleted, [sandbox.sandboxRef]);
  assert.equal(docker.containers.size, 0);
  assert.equal(docker.volumes.size, 0);
  assert.equal(docker.networks.size, 0);
});

test('controller enforces a global active-sandbox capacity ceiling', async () => {
  const cfg = config({ maxActive: 1 });
  const docker = new FakeDocker(cfg);
  const service = new RunscSandboxService({ docker, config: cfg });
  const outcomes = await Promise.allSettled([
    service.ensure({ workspaceRef: `ws_${'q'.repeat(43)}` }),
    service.ensure({ workspaceRef: `ws_${'r'.repeat(43)}` }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'sandbox_capacity_exhausted');
  assert.equal(rejected.reason.status, 429);
  assert.equal(docker.containers.size, 1);
});

test('Docker raw-stream demultiplexing keeps stdout and stderr separate and bounded', () => {
  const frame = (stream, text) => {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  assert.deepEqual(
    decodeDockerStream(Buffer.concat([frame(1, 'out'), frame(2, 'err')]), 100),
    { stdout: 'out', stderr: 'err' },
  );
  assert.throws(() => decodeDockerStream(frame(1, 'too-large'), 2), /output exceeded/);
});

test('Docker exec timeout wins the race and waits until the sandbox is killed', async () => {
  const api = new DockerApi();
  let killed = false;
  api.createExec = async () => ({ Id: 'exec-1' });
  api.request = async () => new Promise((resolve) => setTimeout(() => resolve(Buffer.alloc(0)), 100));
  api.killContainer = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    killed = true;
  };
  await assert.rejects(
    () => api.runExec('container-1', ['node', '--version'], { timeoutMs: 10, maxOutputBytes: 4096 }),
    (error) => error.code === 'exec_timeout' && error.status === 408,
  );
  assert.equal(killed, true);
});

test('Docker exec output overflow kills the sandbox before returning 413', async () => {
  for (const responseError of [
    new DockerApiError('response too large', { code: 'docker_response_limit', statusCode: 413 }),
    null,
  ]) {
    const api = new DockerApi();
    let killed = false;
    api.createExec = async () => ({ Id: 'exec-output' });
    api.request = async () => {
      if (responseError) throw responseError;
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(8192, 4);
      return Buffer.concat([header, Buffer.alloc(8192)]);
    };
    api.killContainer = async () => { killed = true; };
    await assert.rejects(
      () => api.runExec('container-output', ['node', '--version'], { timeoutMs: 1000, maxOutputBytes: 4096 }),
      (error) => error.code === 'exec_output_limit' && error.status === 413,
    );
    assert.equal(killed, true);
  }
});

test('controller API requires bearer authentication for every lifecycle endpoint', async (t) => {
  const cfg = config();
  const calls = [];
  const service = {
    assertRuntimeAvailable: async () => {},
    ensure: async (body) => { calls.push(['ensure', body]); return { sandboxRef: `sb_${'z'.repeat(32)}` }; },
    gc: async () => ({ deleted: [], failed: [] }),
    status: async (ref) => ({ sandboxRef: ref }),
    statusWorkspace: async (ref) => ({ workspaceRef: ref }),
    exec: async (ref, body) => ({ sandboxRef: ref, ...body }),
    stop: async (ref) => ({ sandboxRef: ref, stopped: true }),
    delete: async (ref) => ({ sandboxRef: ref, deleted: true }),
  };
  const server = createController({ service, config: cfg, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const unauthorized = await fetch(`${base}/v1/sandboxes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0);

  const authorized = await fetch(`${base}/v1/sandboxes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceRef: `ws_${'a'.repeat(43)}` }),
  });
  assert.equal(authorized.status, 201);
  assert.equal(calls.length, 1);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
});
