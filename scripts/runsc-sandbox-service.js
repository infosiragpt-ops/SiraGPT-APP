'use strict';

const {
  MANAGED_LABEL,
  PROVIDER_LABEL,
  PROVIDER_VERSION,
  SANDBOX_REF_LABEL,
  WORKSPACE_REF_LABEL,
  EXPIRES_AT_LABEL,
  RESOURCE_KIND_LABEL,
  RunscSandboxError,
  randomOpaqueRef,
  assertWorkspaceRef,
  assertSandboxRef,
  dockerName,
  desiredContainerSpec,
  verifyRuntimeConfiguration,
  verifyContainerAttestation,
  previewTargetFor,
} = require('./runsc-sandbox-controller-utils');
const { isDockerNotFound } = require('./runsc-sandbox-docker-api');
const { MemoryActivityStore } = require('./runsc-sandbox-activity-store');

function labelFilters(...values) {
  return { label: values };
}

function resourceLabels(ref, kind) {
  return labelFilters(
    `${MANAGED_LABEL}=true`,
    `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`,
    `${SANDBOX_REF_LABEL}=${ref}`,
    `${RESOURCE_KIND_LABEL}=${kind}`,
  );
}

function containerState(inspect) {
  const state = inspect?.State || {};
  return {
    running: state.Running === true,
    status: String(state.Status || (state.Running ? 'running' : 'stopped')),
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
  };
}

function publicSandboxResult({ inspect, attestation }) {
  return Object.freeze({
    sandboxRef: attestation.sandboxRef,
    workspaceRef: attestation.workspaceRef,
    state: containerState(inspect),
    previewTarget: previewTargetFor(attestation.sandboxRef),
    attestation,
  });
}

class RunscSandboxService {
  constructor({ docker, config, clock = () => Date.now(), activityStore = new MemoryActivityStore() }) {
    if (!docker || !config) throw new TypeError('docker and config are required');
    this.docker = docker;
    this.config = config;
    this.clock = clock;
    this.activityStore = activityStore;
    this.locks = new Map();
  }

  async withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  async assertRuntimeAvailable() {
    const [info, image] = await Promise.all([
      this.docker.info(),
      this.docker.inspectImage(this.config.image),
    ]);
    const runtime = verifyRuntimeConfiguration(info, this.config);
    if (image?.Id !== this.config.image) {
      throw new RunscSandboxError('worker_image_unavailable', 'pinned sandbox worker image is unavailable', {
        status: 503,
      });
    }
    return runtime;
  }

  async reconcileInterruptedExecs() {
    const executions = await this.activityStore.listExecutions();
    const recovered = [];
    for (const [ref] of executions) {
      const normalized = assertSandboxRef(ref);
      // A persisted marker means the previous controller disappeared before
      // it observed command completion. Stop the whole sandbox before
      // clearing that marker so no orphan command can overlap a new exec.
      // Any failure aborts controller boot and therefore fails closed.
      // eslint-disable-next-line no-await-in-loop
      await this.withLock(`sandbox:${normalized}`, async () => {
        const matches = await this.containersForSandbox(normalized);
        if (matches.length > 1) {
          throw new RunscSandboxError('duplicate_sandbox', 'sandbox reference is ambiguous');
        }
        if (matches.length === 1) {
          const inspect = await this.docker.inspectContainer(matches[0].Id);
          if (inspect?.State?.Running === true) {
            await this.docker.killContainer(matches[0].Id, 'SIGKILL');
          }
          await this.activityStore.set(normalized, this.clock());
        }
        await this.activityStore.endExec(normalized);
      });
      recovered.push(normalized);
    }
    return Object.freeze(recovered);
  }

  async containersForWorkspace(workspaceRef) {
    return this.docker.listContainers(labelFilters(
      `${MANAGED_LABEL}=true`,
      `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`,
      `${WORKSPACE_REF_LABEL}=${workspaceRef}`,
    ));
  }

  async containersForSandbox(sandboxRef) {
    return this.docker.listContainers(labelFilters(
      `${MANAGED_LABEL}=true`,
      `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`,
      `${SANDBOX_REF_LABEL}=${sandboxRef}`,
    ));
  }

  async inspectAndAttest(containerId) {
    const runtimeEvidence = await this.assertRuntimeAvailable();
    const inspect = await this.docker.inspectContainer(containerId);
    const networks = Object.keys(inspect.NetworkSettings?.Networks || {});
    const workspaceMount = (inspect.Mounts || []).find((mount) => mount.Destination === '/workspace');
    if (networks.length !== 1 || !workspaceMount?.Name) {
      throw new RunscSandboxError('attestation_failed', 'sandbox resources are incomplete');
    }
    const [networkInspect, volumeInspect, volumeUsers] = await Promise.all([
      this.docker.inspectNetwork(networks[0]),
      this.docker.inspectVolume(workspaceMount.Name),
      this.docker.listContainers({ volume: [workspaceMount.Name] }),
    ]);
    const attestation = verifyContainerAttestation({
      inspect,
      networkInspect,
      volumeInspect,
      volumeUsers,
      runtimeEvidence,
      config: this.config,
      nowMs: this.clock(),
    });
    return { inspect, networkInspect, volumeInspect, volumeUsers, attestation };
  }

  async verifyWorkspaceAccess(containerId) {
    const probe = await this.docker.runExec(containerId, [
      'node',
      '-e',
      `const fs=require('node:fs');
       if(process.getuid?.()!==10001||process.getgid?.()!==10001)process.exit(11);
       fs.accessSync('/workspace',fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
       const p=fs.mkdtempSync('/workspace/.sira-ownership-probe-');
       const s=fs.lstatSync(p);
       if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==10001||s.gid!==10001||s.nlink<2)process.exit(12);
       fs.rmdirSync(p);`,
    ], { timeoutMs: 5000, maxOutputBytes: 4096 });
    if (probe.exitCode !== 0) {
      throw new RunscSandboxError('workspace_ownership_failed', 'workspace is not writable by the dedicated sandbox user');
    }
  }

  async isIdle(sandboxRef, inspect, nowMs = this.clock()) {
    const remembered = await this.activityStore.get(sandboxRef);
    const started = Date.parse(inspect?.State?.StartedAt || '');
    const baseline = Number.isFinite(remembered) ? remembered : (Number.isFinite(started) ? started : nowMs);
    return nowMs - baseline >= this.config.idleTimeoutMs;
  }

  async ensure({ workspaceRef, ttlMs } = {}) {
    const normalizedWorkspace = assertWorkspaceRef(workspaceRef);
    return this.withLock(`workspace:${normalizedWorkspace}`, async () => {
      await this.assertRuntimeAvailable();
      const existing = await this.containersForWorkspace(normalizedWorkspace);
      if (existing.length > 1) {
        throw new RunscSandboxError('duplicate_sandbox', 'multiple sandboxes claim the same workspace reference');
      }
      if (existing.length === 1) {
        try {
          let evidence = await this.inspectAndAttest(existing[0].Id);
          if (!evidence.inspect.State?.Running) {
            await this.docker.startContainer(existing[0].Id);
            evidence = await this.inspectAndAttest(existing[0].Id);
          }
          await this.verifyWorkspaceAccess(existing[0].Id);
          await this.activityStore.set(evidence.attestation.sandboxRef, this.clock());
          return publicSandboxResult(evidence);
        } catch (error) {
          if (error?.code !== 'sandbox_expired') throw error;
          const expiredRef = existing[0].Labels?.[SANDBOX_REF_LABEL];
          await this.delete(expiredRef);
        }
      }

      return this.withLock('capacity', async () => {
        const active = await this.docker.listContainers(labelFilters(
          `${MANAGED_LABEL}=true`,
          `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`,
        ));
        if (active.length >= this.config.maxActive) {
          throw new RunscSandboxError('sandbox_capacity_exhausted', 'runsc sandbox capacity is exhausted', { status: 429 });
        }

        const sandboxRef = randomOpaqueRef('sb');
        const containerName = dockerName('container');
        const networkName = dockerName('network');
        const volumeName = dockerName('volume');
        const desired = desiredContainerSpec({
          config: this.config,
          sandboxRef,
          workspaceRef: normalizedWorkspace,
          containerName,
          networkName,
          volumeName,
          nowMs: this.clock(),
          ttlMs,
        });

        let containerId = null;
        let networkId = null;
        try {
          await this.docker.createVolume(desired.volume);
          const network = await this.docker.createNetwork(desired.network);
          networkId = network?.Id || networkName;
          const container = await this.docker.createContainer(desired.create.name, desired.create.body);
          containerId = container?.Id;
          if (!containerId) throw new RunscSandboxError('create_failed', 'Docker did not return a container id');
          await this.docker.startContainer(containerId);
          const evidence = await this.inspectAndAttest(containerId);
          await this.verifyWorkspaceAccess(containerId);
          await this.activityStore.set(sandboxRef, this.clock());
          return publicSandboxResult(evidence);
        } catch (error) {
          if (containerId) await this.docker.removeContainer(containerId).catch(() => {});
          if (networkId) await this.docker.removeNetwork(networkId).catch(() => {});
          await this.docker.removeVolume(volumeName).catch(() => {});
          await this.activityStore.delete(sandboxRef).catch(() => {});
          throw error;
        }
      });
    });
  }

  async requireSandbox(sandboxRef, { allowStopped = true, enforceIdle = true } = {}) {
    const normalized = assertSandboxRef(sandboxRef);
    const matches = await this.containersForSandbox(normalized);
    if (matches.length === 0) throw new RunscSandboxError('sandbox_not_found', 'sandbox does not exist', { status: 404 });
    if (matches.length > 1) throw new RunscSandboxError('duplicate_sandbox', 'sandbox reference is ambiguous');
    const evidence = await this.inspectAndAttest(matches[0].Id);
    if (enforceIdle && await this.isIdle(normalized, evidence.inspect)) {
      await this.delete(normalized);
      throw new RunscSandboxError('sandbox_idle_expired', 'sandbox idle lease has expired', { status: 410 });
    }
    if (!allowStopped && !evidence.inspect.State?.Running) {
      throw new RunscSandboxError('sandbox_not_running', 'sandbox is not running', { status: 409 });
    }
    return { containerId: matches[0].Id, ...evidence };
  }

  async status(sandboxRef) {
    const evidence = await this.requireSandbox(sandboxRef, { allowStopped: true, enforceIdle: false });
    if (await this.isIdle(evidence.attestation.sandboxRef, evidence.inspect)) {
      throw new RunscSandboxError('sandbox_idle_expired', 'sandbox idle lease has expired', { status: 410 });
    }
    return publicSandboxResult(evidence);
  }

  async statusWorkspace(workspaceRef) {
    const normalized = assertWorkspaceRef(workspaceRef);
    const matches = await this.containersForWorkspace(normalized);
    if (matches.length === 0) {
      throw new RunscSandboxError('sandbox_not_found', 'sandbox does not exist', { status: 404 });
    }
    if (matches.length > 1) {
      throw new RunscSandboxError('duplicate_sandbox', 'multiple sandboxes claim the same workspace reference');
    }
    const evidence = await this.inspectAndAttest(matches[0].Id);
    if (await this.isIdle(evidence.attestation.sandboxRef, evidence.inspect)) {
      throw new RunscSandboxError('sandbox_idle_expired', 'sandbox idle lease has expired', { status: 410 });
    }
    // Status is deliberately read-only: it never starts a stopped container,
    // creates a replacement, or refreshes durable activity.
    return publicSandboxResult(evidence);
  }

  validateArgv(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
      throw new RunscSandboxError('invalid_argv', 'argv must contain between 1 and 128 arguments', { status: 400 });
    }
    const argv = value.map((entry) => String(entry));
    if (argv.some((entry) => entry.length === 0 || entry.length > 16_384 || entry.includes('\0'))
      || argv.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0) > 128 * 1024) {
      throw new RunscSandboxError('invalid_argv', 'argv exceeds the sandbox command limits', { status: 400 });
    }
    return argv;
  }

  async exec(sandboxRef, { argv, timeoutMs } = {}) {
    const normalized = assertSandboxRef(sandboxRef);
    return this.withLock(`sandbox:${normalized}`, async () => {
      const evidence = await this.requireSandbox(normalized, {
        allowStopped: false,
        // This operation already owns the sandbox lock. Perform idle cleanup
        // through deleteUnlocked below to avoid a re-entrant lock and to make
        // the activity decision atomic with execution.
        enforceIdle: false,
      });
      if (await this.isIdle(normalized, evidence.inspect)) {
        await this.deleteUnlocked(normalized);
        throw new RunscSandboxError('sandbox_idle_expired', 'sandbox idle lease has expired', { status: 410 });
      }
      const command = this.validateArgv(argv);
      const remainingLeaseMs = Date.parse(evidence.attestation.expiresAt) - this.clock() - 1000;
      const budget = Math.max(1000, Math.min(
        Number.isFinite(Number(timeoutMs)) ? Math.trunc(Number(timeoutMs)) : this.config.execTimeoutMs,
        this.config.execTimeoutMs,
        remainingLeaseMs,
      ));
      if (remainingLeaseMs < 1000) {
        throw new RunscSandboxError('sandbox_expired', 'sandbox lease cannot cover another command', { status: 410 });
      }
      await this.activityStore.set(normalized, this.clock());
      await this.activityStore.beginExec(normalized, this.clock() + budget);
      try {
        const result = await this.docker.runExec(evidence.containerId, command, {
          timeoutMs: budget,
          maxOutputBytes: this.config.maxOutputBytes,
        });
        await this.activityStore.set(normalized, this.clock());
        return Object.freeze({
          sandboxRef: normalized,
          exitCode: result.exitCode,
          stdout: String(result.stdout || ''),
          stderr: String(result.stderr || ''),
        });
      } catch (error) {
        await this.activityStore.set(normalized, this.clock());
        throw error;
      } finally {
        await this.activityStore.endExec(normalized);
      }
    });
  }

  async stop(sandboxRef) {
    const normalized = assertSandboxRef(sandboxRef);
    return this.withLock(`sandbox:${normalized}`, async () => {
      const matches = await this.containersForSandbox(normalized);
      if (matches.length === 0) return Object.freeze({ sandboxRef: normalized, stopped: true, absent: true });
      if (matches.length > 1) throw new RunscSandboxError('duplicate_sandbox', 'sandbox reference is ambiguous');
      const evidence = await this.inspectAndAttest(matches[0].Id);
      if (evidence.inspect.State?.Running) {
        await this.docker.stopContainer(matches[0].Id, 10).catch(async (error) => {
          if (!isDockerNotFound(error)) throw error;
        });
      }
      await this.activityStore.set(normalized, this.clock());
      return Object.freeze({ sandboxRef: normalized, stopped: true, absent: false });
    });
  }

  async stopWorkspace(workspaceRef) {
    const normalized = assertWorkspaceRef(workspaceRef);
    return this.withLock(`workspace:${normalized}`, async () => {
      const matches = await this.containersForWorkspace(normalized);
      if (matches.length === 0) return Object.freeze({ workspaceRef: normalized, stopped: true, absent: true });
      if (matches.length > 1) throw new RunscSandboxError('duplicate_sandbox', 'workspace reference is ambiguous');
      const ref = matches[0].Labels?.[SANDBOX_REF_LABEL];
      return this.stop(ref);
    });
  }

  async ownedResources(sandboxRef) {
    const [networks, volumes] = await Promise.all([
      this.docker.listNetworks(resourceLabels(sandboxRef, 'network')),
      this.docker.listVolumes(resourceLabels(sandboxRef, 'volume')),
    ]);
    return { networks, volumes };
  }

  async deleteUnlocked(normalized, { collectAtMs = null } = {}) {
    const matches = await this.containersForSandbox(normalized);
    if (matches.length > 1) throw new RunscSandboxError('duplicate_sandbox', 'sandbox reference is ambiguous');
    if (matches.length === 1) {
      const labels = matches[0].Labels || {};
      if (labels[MANAGED_LABEL] !== 'true' || labels[SANDBOX_REF_LABEL] !== normalized) {
        throw new RunscSandboxError('ownership_mismatch', 'refusing to delete an unmanaged container');
      }
      if (Number.isFinite(collectAtMs)) {
        const expiresAt = Date.parse(labels[EXPIRES_AT_LABEL] || '');
        if (Number.isFinite(expiresAt) && expiresAt > collectAtMs) {
          const inspect = await this.docker.inspectContainer(matches[0].Id);
          if (!await this.isIdle(normalized, inspect, collectAtMs)) {
            return Object.freeze({ sandboxRef: normalized, deleted: false, skipped: true });
          }
        }
      }
      await this.docker.removeContainer(matches[0].Id).catch((error) => {
        if (!isDockerNotFound(error)) throw error;
      });
    }
    const resources = await this.ownedResources(normalized);
    for (const network of resources.networks || []) {
      const id = network.Id || network.Name;
      if (id) await this.docker.removeNetwork(id).catch((error) => {
        if (!isDockerNotFound(error)) throw error;
      });
    }
    for (const volume of resources.volumes || []) {
      if (volume.Name) await this.docker.removeVolume(volume.Name).catch((error) => {
        if (!isDockerNotFound(error)) throw error;
      });
    }
    await this.activityStore.delete(normalized);
    return Object.freeze({ sandboxRef: normalized, deleted: true });
  }

  async delete(sandboxRef, options = {}) {
    const normalized = assertSandboxRef(sandboxRef);
    return this.withLock(`sandbox:${normalized}`, () => this.deleteUnlocked(normalized, options));
  }

  async deleteWorkspace(workspaceRef) {
    const normalized = assertWorkspaceRef(workspaceRef);
    return this.withLock(`workspace:${normalized}`, async () => {
      const matches = await this.containersForWorkspace(normalized);
      if (matches.length > 1) throw new RunscSandboxError('duplicate_sandbox', 'workspace reference is ambiguous');
      if (matches.length === 1) {
        const ref = matches[0].Labels?.[SANDBOX_REF_LABEL];
        await this.delete(ref);
        return Object.freeze({ workspaceRef: normalized, deleted: true, absent: false });
      }

      const [networks, volumes] = await Promise.all([
        this.docker.listNetworks(labelFilters(
          `${MANAGED_LABEL}=true`,
          `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`,
          `${WORKSPACE_REF_LABEL}=${normalized}`,
        )),
        this.docker.listVolumes(labelFilters(
          `${MANAGED_LABEL}=true`,
          `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`,
          `${WORKSPACE_REF_LABEL}=${normalized}`,
        )),
      ]);
      const orphanRefs = new Set([...networks, ...volumes]
        .map((resource) => resource.Labels?.[SANDBOX_REF_LABEL])
        .filter((ref) => /^sb_[A-Za-z0-9_-]{32}$/.test(String(ref || ''))));
      for (const ref of orphanRefs) await this.delete(ref);
      return Object.freeze({
        workspaceRef: normalized,
        deleted: true,
        absent: networks.length === 0 && volumes.length === 0,
      });
    });
  }

  async gc() {
    return this.withLock('capacity', () => this.gcUnlocked());
  }

  async gcUnlocked() {
    const nowMs = this.clock();
    const containers = await this.docker.listContainers(labelFilters(
      `${MANAGED_LABEL}=true`,
      `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`,
    ));
    const kept = new Set();
    const deleted = [];
    const failed = [];
    let orphaned = 0;
    for (const summary of containers) {
      const ref = summary.Labels?.[SANDBOX_REF_LABEL];
      if (!/^sb_[A-Za-z0-9_-]{32}$/.test(String(ref || ''))) {
        try {
          await this.docker.removeContainer(summary.Id);
          orphaned += 1;
        } catch (error) {
          if (!isDockerNotFound(error)) failed.push({ sandboxRef: null, code: error.code || 'cleanup_failed' });
        }
        continue;
      }
      try {
        const expiresAt = Date.parse(summary.Labels?.[EXPIRES_AT_LABEL] || '');
        if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
          const result = await this.delete(ref, { collectAtMs: nowMs });
          if (result.deleted) deleted.push(ref);
          else kept.add(ref);
          continue;
        }
        const evidence = await this.inspectAndAttest(summary.Id);
        if (await this.isIdle(ref, evidence.inspect, nowMs)) {
          const result = await this.delete(ref, { collectAtMs: nowMs });
          if (result.deleted) deleted.push(ref);
          else kept.add(ref);
          continue;
        }
        kept.add(ref);
      } catch (error) {
        try {
          await this.delete(ref);
          deleted.push(ref);
        } catch (cleanupError) {
          failed.push({ sandboxRef: ref, code: cleanupError.code || 'cleanup_failed' });
        }
      }
    }

    for (const kind of ['network', 'volume']) {
      const resources = kind === 'network'
        ? await this.docker.listNetworks(labelFilters(
          `${MANAGED_LABEL}=true`, `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`, `${RESOURCE_KIND_LABEL}=${kind}`,
        ))
        : await this.docker.listVolumes(labelFilters(
          `${MANAGED_LABEL}=true`, `${PROVIDER_LABEL}=runsc-workspace@${PROVIDER_VERSION}`, `${RESOURCE_KIND_LABEL}=${kind}`,
        ));
      for (const resource of resources || []) {
        const ref = resource.Labels?.[SANDBOX_REF_LABEL];
        if (ref && kept.has(ref)) continue;
        try {
          if (kind === 'network') await this.docker.removeNetwork(resource.Id || resource.Name);
          else await this.docker.removeVolume(resource.Name);
        } catch (error) {
          if (!isDockerNotFound(error)) failed.push({ sandboxRef: ref || null, code: error.code || 'cleanup_failed' });
        }
      }
    }
    return Object.freeze({ deleted: Object.freeze([...new Set(deleted)]), orphaned, failed: Object.freeze(failed) });
  }
}

module.exports = {
  RunscSandboxService,
  publicSandboxResult,
  containerState,
  labelFilters,
};
