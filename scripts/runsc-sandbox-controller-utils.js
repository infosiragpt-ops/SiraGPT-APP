'use strict';

const crypto = require('node:crypto');

const MANAGED_LABEL = 'com.siragpt.runsc-sandbox.managed';
const PROVIDER_LABEL = 'com.siragpt.runsc-sandbox.provider';
const SANDBOX_REF_LABEL = 'com.siragpt.runsc-sandbox.ref';
const WORKSPACE_REF_LABEL = 'com.siragpt.runsc-sandbox.workspace';
const EXPIRES_AT_LABEL = 'com.siragpt.runsc-sandbox.expires-at';
const CREATED_AT_LABEL = 'com.siragpt.runsc-sandbox.created-at';
const RESOURCE_KIND_LABEL = 'com.siragpt.runsc-sandbox.resource-kind';

const PROVIDER_ID = 'runsc-workspace';
const PROVIDER_VERSION = '0.1.0';
const INSTANCE_ATTESTATION_SCHEMA_VERSION = 'sira.sandbox-instance-attestation.v1';
const PREVIEW_TARGET_SCHEMA_VERSION = 'sira.preview-target.v1';
const RUNSC_RUNTIME_PATH = '/usr/local/bin/runsc';
const RUNSC_RUNTIME_ARGS = Object.freeze(['--platform=systrap', '--network=sandbox']);
const SANDBOX_ENV = Object.freeze([
  'NODE_ENV=production',
  'HOME=/home/sandbox',
  'TMPDIR=/tmp',
  'XDG_CACHE_HOME=/cache',
]);

class RunscSandboxError extends Error {
  constructor(code, message, { status = 500, details = null } = {}) {
    super(message);
    this.name = 'RunscSandboxError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, options) {
  throw new RunscSandboxError(code, message, options);
}

function parseInteger(value, fallback, { min, max, field }) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail('invalid_configuration', `${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function parseControllerConfig(env = process.env) {
  const token = String(env.RUNSC_SANDBOX_CONTROLLER_TOKEN || '').trim();
  if (!token || token.length < 32) {
    fail('invalid_configuration', 'RUNSC_SANDBOX_CONTROLLER_TOKEN must contain at least 32 characters');
  }
  const runtime = String(env.RUNSC_SANDBOX_RUNTIME || 'runsc-systrap').trim();
  if (runtime !== 'runsc-systrap') {
    fail('invalid_configuration', 'RUNSC_SANDBOX_RUNTIME must be exactly runsc-systrap');
  }
  const image = String(env.RUNSC_SANDBOX_WORKER_IMAGE || '').trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
    fail('invalid_configuration', 'RUNSC_SANDBOX_WORKER_IMAGE must be an immutable Docker image id (sha256:<64 hex>)');
  }
  const socketPath = String(env.RUNSC_SANDBOX_DOCKER_SOCKET || '/var/run/docker.sock');
  if (socketPath !== '/var/run/docker.sock') {
    fail('invalid_configuration', 'RUNSC_SANDBOX_DOCKER_SOCKET must be exactly /var/run/docker.sock');
  }
  const stateDir = String(env.RUNSC_SANDBOX_STATE_DIR || '/var/lib/sira-runsc-controller');
  if (stateDir !== '/var/lib/sira-runsc-controller') {
    fail('invalid_configuration', 'RUNSC_SANDBOX_STATE_DIR must be exactly /var/lib/sira-runsc-controller');
  }

  const parsed = {
    token,
    runtime,
    runtimePath: RUNSC_RUNTIME_PATH,
    runtimeArgs: RUNSC_RUNTIME_ARGS,
    image,
    socketPath,
    stateDir,
    port: parseInteger(env.RUNSC_SANDBOX_CONTROLLER_PORT, 4098, {
      min: 1, max: 65535, field: 'RUNSC_SANDBOX_CONTROLLER_PORT',
    }),
    memoryBytes: parseInteger(env.RUNSC_SANDBOX_MEMORY_BYTES, 4 * 1024 ** 3, {
      min: 128 * 1024 ** 2, max: 32 * 1024 ** 3, field: 'RUNSC_SANDBOX_MEMORY_BYTES',
    }),
    nanoCpus: parseInteger(env.RUNSC_SANDBOX_NANO_CPUS, 2_000_000_000, {
      min: 100_000_000, max: 16_000_000_000, field: 'RUNSC_SANDBOX_NANO_CPUS',
    }),
    pidsLimit: parseInteger(env.RUNSC_SANDBOX_PIDS_LIMIT, 256, {
      min: 16, max: 4096, field: 'RUNSC_SANDBOX_PIDS_LIMIT',
    }),
    maxActive: parseInteger(env.RUNSC_SANDBOX_MAX_ACTIVE, 2, {
      min: 1, max: 64, field: 'RUNSC_SANDBOX_MAX_ACTIVE',
    }),
    defaultTtlMs: parseInteger(env.RUNSC_SANDBOX_TTL_MS, 4 * 60 * 60 * 1000, {
      min: 60_000, max: 24 * 60 * 60 * 1000, field: 'RUNSC_SANDBOX_TTL_MS',
    }),
    maxTtlMs: parseInteger(env.RUNSC_SANDBOX_MAX_TTL_MS, 8 * 60 * 60 * 1000, {
      min: 60_000, max: 7 * 24 * 60 * 60 * 1000, field: 'RUNSC_SANDBOX_MAX_TTL_MS',
    }),
    idleTimeoutMs: parseInteger(env.RUNSC_SANDBOX_IDLE_TIMEOUT_MS, 30 * 60 * 1000, {
      min: 60_000, max: 24 * 60 * 60 * 1000, field: 'RUNSC_SANDBOX_IDLE_TIMEOUT_MS',
    }),
    execTimeoutMs: parseInteger(env.RUNSC_SANDBOX_EXEC_TIMEOUT_MS, 10 * 60 * 1000, {
      min: 1000, max: 30 * 60 * 1000, field: 'RUNSC_SANDBOX_EXEC_TIMEOUT_MS',
    }),
    maxOutputBytes: parseInteger(env.RUNSC_SANDBOX_MAX_OUTPUT_BYTES, 2 * 1024 * 1024, {
      min: 4096, max: 16 * 1024 * 1024, field: 'RUNSC_SANDBOX_MAX_OUTPUT_BYTES',
    }),
    gcIntervalMs: parseInteger(env.RUNSC_SANDBOX_GC_INTERVAL_MS, 60_000, {
      min: 10_000, max: 60 * 60 * 1000, field: 'RUNSC_SANDBOX_GC_INTERVAL_MS',
    }),
  };
  if (parsed.defaultTtlMs > parsed.maxTtlMs) {
    fail('invalid_configuration', 'RUNSC_SANDBOX_TTL_MS cannot exceed RUNSC_SANDBOX_MAX_TTL_MS');
  }
  if (parsed.defaultTtlMs < parsed.execTimeoutMs + 5000
    || parsed.maxTtlMs < parsed.execTimeoutMs + 5000) {
    fail('invalid_configuration', 'sandbox TTL limits must outlive the maximum exec timeout');
  }
  if (parsed.idleTimeoutMs < parsed.execTimeoutMs + 5000) {
    fail('invalid_configuration', 'RUNSC_SANDBOX_IDLE_TIMEOUT_MS must outlive the maximum exec timeout');
  }
  return Object.freeze(parsed);
}

function verifyRuntimeConfiguration(info, config) {
  const runtime = info?.Runtimes?.[config.runtime];
  const runtimePath = String(runtime?.path || runtime?.Path || '');
  const runtimeArgs = stringArray(runtime?.runtimeArgs || runtime?.Args || runtime?.args);
  if (runtimePath !== config.runtimePath
    || runtimeArgs.length !== config.runtimeArgs.length
    || runtimeArgs.some((value, index) => value !== config.runtimeArgs[index])) {
    fail('runtime_unavailable', 'Docker runsc-systrap runtime path or arguments do not match pinned policy', {
      status: 503,
    });
  }
  return Object.freeze({ name: config.runtime, path: runtimePath, args: Object.freeze([...runtimeArgs]) });
}

function randomOpaqueRef(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

function assertWorkspaceRef(value) {
  const ref = String(value || '').trim();
  if (!/^ws_[A-Za-z0-9_-]{43}$/.test(ref)) {
    fail('invalid_workspace_ref', 'workspaceRef must be an opaque Sira workspace reference', { status: 400 });
  }
  return ref;
}

function assertSandboxRef(value) {
  const ref = String(value || '').trim();
  if (!/^sb_[A-Za-z0-9_-]{32}$/.test(ref)) {
    fail('invalid_sandbox_ref', 'sandboxRef is invalid', { status: 400 });
  }
  return ref;
}

function dockerName(kind) {
  if (!['container', 'network', 'volume'].includes(kind)) fail('invalid_resource_kind', 'invalid resource kind');
  return `sira-${kind === 'container' ? 'sb' : kind === 'network' ? 'sbn' : 'sbv'}-${crypto.randomBytes(12).toString('hex')}`;
}

function safeLabels({ sandboxRef, workspaceRef, expiresAt, createdAt, resourceKind }) {
  return {
    [MANAGED_LABEL]: 'true',
    [PROVIDER_LABEL]: `${PROVIDER_ID}@${PROVIDER_VERSION}`,
    [SANDBOX_REF_LABEL]: assertSandboxRef(sandboxRef),
    [WORKSPACE_REF_LABEL]: assertWorkspaceRef(workspaceRef),
    [EXPIRES_AT_LABEL]: new Date(expiresAt).toISOString(),
    [CREATED_AT_LABEL]: new Date(createdAt).toISOString(),
    [RESOURCE_KIND_LABEL]: resourceKind,
  };
}

function desiredContainerSpec({ config, sandboxRef, workspaceRef, containerName, networkName, volumeName, nowMs, ttlMs }) {
  const effectiveTtlMs = Math.min(
    parseInteger(ttlMs, config.defaultTtlMs, {
      min: Math.max(60_000, config.execTimeoutMs + 5000), max: config.maxTtlMs, field: 'ttlMs',
    }),
    config.maxTtlMs,
  );
  const expiresAt = nowMs + effectiveTtlMs;
  const labels = safeLabels({
    sandboxRef, workspaceRef, expiresAt, createdAt: nowMs, resourceKind: 'container',
  });

  return {
    expiresAt,
    create: {
      name: containerName,
      body: {
        Image: config.image,
        Cmd: ['node', '/opt/sira-sandbox/idle-worker.js'],
        WorkingDir: '/workspace',
        User: '10001:10001',
        Env: [...SANDBOX_ENV],
        Labels: labels,
        NetworkDisabled: false,
        HostConfig: {
          Runtime: config.runtime,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: [],
          SecurityOpt: ['no-new-privileges:true'],
          PidsLimit: config.pidsLimit,
          NanoCpus: config.nanoCpus,
          Memory: config.memoryBytes,
          MemorySwap: config.memoryBytes,
          OomKillDisable: false,
          NetworkMode: networkName,
          PortBindings: {},
          PublishAllPorts: false,
          Privileged: false,
          Init: true,
          AutoRemove: false,
          Binds: [],
          Mounts: [{ Type: 'volume', Source: volumeName, Target: '/workspace', ReadOnly: false, VolumeOptions: { NoCopy: false } }],
          Tmpfs: {
            '/tmp': 'rw,nosuid,nodev,noexec,size=268435456,mode=1777',
            '/home/sandbox': 'rw,nosuid,nodev,size=134217728,mode=0700,uid=10001,gid=10001',
            '/cache': 'rw,nosuid,nodev,size=536870912,mode=0700,uid=10001,gid=10001',
          },
          Ulimits: [
            { Name: 'nofile', Soft: 1024, Hard: 1024 },
            { Name: 'nproc', Soft: Math.min(config.pidsLimit, 256), Hard: Math.min(config.pidsLimit, 256) },
            { Name: 'fsize', Soft: 1_073_741_824, Hard: 1_073_741_824 },
          ],
          LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
        },
        NetworkingConfig: {
          EndpointsConfig: { [networkName]: {} },
        },
      },
    },
    volume: {
      Name: volumeName,
      Driver: 'local',
      Labels: safeLabels({ sandboxRef, workspaceRef, expiresAt, createdAt: nowMs, resourceKind: 'volume' }),
    },
    network: {
      Name: networkName,
      Driver: 'bridge',
      Internal: true,
      Attachable: false,
      CheckDuplicate: true,
      EnableIPv6: false,
      Labels: safeLabels({ sandboxRef, workspaceRef, expiresAt, createdAt: nowMs, resourceKind: 'network' }),
      Options: {
        'com.docker.network.bridge.enable_ip_masquerade': 'false',
        'com.docker.network.bridge.enable_icc': 'false',
        'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
      },
    },
  };
}

function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function capName(value) {
  return String(value || '').replace(/^CAP_/, '').toUpperCase();
}

function verifyContainerAttestation({ inspect, networkInspect, volumeInspect, volumeUsers, runtimeEvidence, config, nowMs = Date.now() }) {
  if (!inspect || !networkInspect || !volumeInspect || !Array.isArray(volumeUsers)) {
    fail('attestation_failed', 'Docker inspect evidence is incomplete');
  }
  const labels = inspect.Config?.Labels || {};
  const sandboxRef = assertSandboxRef(labels[SANDBOX_REF_LABEL]);
  const workspaceRef = assertWorkspaceRef(labels[WORKSPACE_REF_LABEL]);
  const expiresAtMs = Date.parse(labels[EXPIRES_AT_LABEL]);
  if (labels[MANAGED_LABEL] !== 'true' || labels[PROVIDER_LABEL] !== `${PROVIDER_ID}@${PROVIDER_VERSION}`) {
    fail('attestation_failed', 'container is not owned by this provider');
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) fail('sandbox_expired', 'sandbox lease has expired', { status: 410 });
  if (inspect.Config?.Image !== config.image || inspect.Image !== config.image) {
    fail('attestation_failed', 'worker image bytes do not match the pinned image id');
  }
  if (inspect.HostConfig?.Runtime !== config.runtime) fail('attestation_failed', 'sandbox is not running with runsc-systrap');
  if (runtimeEvidence?.name !== config.runtime
    || runtimeEvidence?.path !== config.runtimePath
    || !Array.isArray(runtimeEvidence?.args)
    || runtimeEvidence.args.length !== config.runtimeArgs.length
    || runtimeEvidence.args.some((value, index) => value !== config.runtimeArgs[index])) {
    fail('attestation_failed', 'runsc-systrap daemon runtime evidence is missing or invalid');
  }
  if (inspect.Config?.User !== '10001:10001') fail('attestation_failed', 'sandbox process is not the dedicated non-root user');
  if (inspect.HostConfig?.ReadonlyRootfs !== true || inspect.HostConfig?.Privileged === true) {
    fail('attestation_failed', 'sandbox root filesystem policy is unsafe');
  }
  if (inspect.HostConfig?.Init !== true) fail('attestation_failed', 'sandbox init/reaper is missing');
  const capDrop = stringArray(inspect.HostConfig?.CapDrop).map(capName);
  const capAdd = stringArray(inspect.HostConfig?.CapAdd).map(capName);
  if (!capDrop.includes('ALL') || capAdd.length > 0) fail('attestation_failed', 'sandbox Linux capabilities are unsafe');
  if (!stringArray(inspect.HostConfig?.SecurityOpt).includes('no-new-privileges:true')) {
    fail('attestation_failed', 'no-new-privileges is missing');
  }
  if (inspect.HostConfig?.PidsLimit !== config.pidsLimit
    || inspect.HostConfig?.NanoCpus !== config.nanoCpus
    || inspect.HostConfig?.Memory !== config.memoryBytes
    || inspect.HostConfig?.MemorySwap !== config.memoryBytes) {
    fail('attestation_failed', 'sandbox resource limits differ from policy');
  }
  if (inspect.HostConfig?.PublishAllPorts === true
    || Object.keys(inspect.HostConfig?.PortBindings || {}).length > 0
    || Object.keys(inspect.Config?.ExposedPorts || {}).length > 0) {
    fail('attestation_failed', 'sandbox publishes host ports');
  }
  if (stringArray(inspect.HostConfig?.Binds).length > 0) fail('attestation_failed', 'sandbox has a host bind mount');
  for (const mode of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode']) {
    if (String(inspect.HostConfig?.[mode] || '').toLowerCase() === 'host') {
      fail('attestation_failed', `sandbox ${mode} shares a host namespace`);
    }
  }
  if ((inspect.HostConfig?.Devices || []).length > 0 || (inspect.HostConfig?.DeviceRequests || []).length > 0) {
    fail('attestation_failed', 'sandbox exposes a host device');
  }

  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];
  const workspaceMounts = mounts.filter((mount) => mount.Destination === '/workspace');
  if (workspaceMounts.length !== 1 || workspaceMounts[0].Type !== 'volume' || workspaceMounts[0].RW !== true) {
    fail('attestation_failed', 'workspace is not an exclusive writable Docker volume');
  }
  if (mounts.some((mount) => mount.Type === 'bind' || mount.Destination === '/var/run/docker.sock')) {
    fail('attestation_failed', 'sandbox exposes a host bind or Docker socket');
  }
  if (mounts.filter((mount) => mount.Type === 'volume').length !== 1) {
    fail('attestation_failed', 'sandbox has an unexpected Docker volume');
  }
  if (workspaceMounts[0].Name !== volumeInspect.Name
    || volumeInspect.Driver !== 'local'
    || volumeInspect.Scope !== 'local'
    || Object.keys(volumeInspect.Options || {}).length !== 0
    || volumeInspect.Labels?.[MANAGED_LABEL] !== 'true'
    || volumeInspect.Labels?.[PROVIDER_LABEL] !== `${PROVIDER_ID}@${PROVIDER_VERSION}`
    || volumeInspect.Labels?.[SANDBOX_REF_LABEL] !== sandboxRef
    || volumeInspect.Labels?.[WORKSPACE_REF_LABEL] !== workspaceRef
    || volumeInspect.Labels?.[EXPIRES_AT_LABEL] !== labels[EXPIRES_AT_LABEL]
    || volumeInspect.Labels?.[RESOURCE_KIND_LABEL] !== 'volume') {
    fail('attestation_failed', 'workspace volume ownership does not match the sandbox');
  }
  if (volumeUsers.length !== 1 || volumeUsers[0]?.Id !== inspect.Id) {
    fail('attestation_failed', 'workspace volume is attached to another container');
  }

  const networkName = networkInspect.Name;
  const attachedNetworks = Object.keys(inspect.NetworkSettings?.Networks || {});
  if (networkInspect.Driver !== 'bridge'
    || networkInspect.Internal !== true || networkInspect.Attachable === true
    || networkInspect.EnableIPv6 === true
    || networkInspect.Options?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false'
    || networkInspect.Options?.['com.docker.network.bridge.enable_icc'] !== 'false'
    || networkInspect.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated'
    || networkInspect.Labels?.[MANAGED_LABEL] !== 'true'
    || networkInspect.Labels?.[PROVIDER_LABEL] !== `${PROVIDER_ID}@${PROVIDER_VERSION}`
    || networkInspect.Labels?.[SANDBOX_REF_LABEL] !== sandboxRef
    || networkInspect.Labels?.[WORKSPACE_REF_LABEL] !== workspaceRef
    || networkInspect.Labels?.[EXPIRES_AT_LABEL] !== labels[EXPIRES_AT_LABEL]
    || networkInspect.Labels?.[RESOURCE_KIND_LABEL] !== 'network'
    || attachedNetworks.length !== 1 || attachedNetworks[0] !== networkName
    || inspect.HostConfig?.NetworkMode !== networkName) {
    fail('attestation_failed', 'sandbox network is not exclusive and internal');
  }
  const networkContainers = Object.entries(networkInspect.Containers || {});
  if (networkContainers.length !== 1
    || networkContainers[0][0] !== inspect.Id
    || networkContainers[0][1]?.Name !== inspect.Name?.replace(/^\//, '')) {
    fail('attestation_failed', 'sandbox network contains another workload');
  }

  const observedEnv = stringArray(inspect.Config?.Env);
  const allowedEnv = new Set(SANDBOX_ENV);
  if (observedEnv.length !== SANDBOX_ENV.length
    || new Set(observedEnv).size !== SANDBOX_ENV.length
    || observedEnv.some((entry) => !allowedEnv.has(entry))) {
    fail('attestation_failed', 'sandbox environment differs from the exact worker allowlist');
  }

  return Object.freeze({
    schemaVersion: INSTANCE_ATTESTATION_SCHEMA_VERSION,
    provider: { id: PROVIDER_ID, version: PROVIDER_VERSION },
    sandboxRef,
    workspaceRef,
    observedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    isolation: { isolated: true, boundary: 'gvisor-systrap', tenantScope: 'workspace' },
    runtime: { name: config.runtime, verifiedBy: 'docker-info+docker-inspect' },
    filesystem: { rootReadonly: true, workspaceVolumeExclusive: true, hostBinds: false },
    network: { internal: true, exclusive: true, publishedPorts: false },
    process: { user: '10001:10001', capDropAll: true, noNewPrivileges: true },
    resources: {
      memoryBytes: config.memoryBytes,
      nanoCpus: config.nanoCpus,
      pidsLimit: config.pidsLimit,
      idleTimeoutMs: config.idleTimeoutMs,
    },
    capabilities: { publicMultiTenant: false, secretRefs: false },
  });
}

function previewTargetFor(sandboxRef) {
  const digest = crypto.createHash('sha256').update(`preview:${assertSandboxRef(sandboxRef)}`).digest('base64url');
  return Object.freeze({ schemaVersion: PREVIEW_TARGET_SCHEMA_VERSION, ref: `preview_${digest}` });
}

module.exports = {
  MANAGED_LABEL,
  PROVIDER_LABEL,
  SANDBOX_REF_LABEL,
  WORKSPACE_REF_LABEL,
  EXPIRES_AT_LABEL,
  CREATED_AT_LABEL,
  RESOURCE_KIND_LABEL,
  PROVIDER_ID,
  PROVIDER_VERSION,
  INSTANCE_ATTESTATION_SCHEMA_VERSION,
  PREVIEW_TARGET_SCHEMA_VERSION,
  SANDBOX_ENV,
  RunscSandboxError,
  parseControllerConfig,
  verifyRuntimeConfiguration,
  randomOpaqueRef,
  assertWorkspaceRef,
  assertSandboxRef,
  dockerName,
  desiredContainerSpec,
  verifyContainerAttestation,
  previewTargetFor,
};
