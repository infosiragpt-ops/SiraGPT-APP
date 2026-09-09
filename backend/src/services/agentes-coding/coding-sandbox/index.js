'use strict';

/**
 * coding-sandbox — AGENTES_CODING_V2 Phase 2a session adapter.
 *
 * Interface: createSession, recreateSession, exec, readFile, writeFile, listFiles,
 * exposePort (signed preview URL), listPorts, unexposePort,
 * resolvePreview, destroy. Default OFF. Docker/memory/volume drivers are injectable.
 * Docker + volume persist `/workspace` under AGENTES_CODING_SANDBOX_DATA_DIR (Phase 4e).
 *
 * See docs/agentes-coding-sandbox.md and docs/agentes-arquitectura.md.
 */

const crypto = require('node:crypto');
const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('./errors');
const { resolveLimits } = require('./limits');
const { createNetworkPolicy } = require('./network');
const { createMemoryDriver } = require('./memory-driver');
const { createDockerLocalDriver, DEFAULT_IMAGE } = require('./docker-local');
const { createVolumeDriver } = require('./volume-driver');
const { createSessionVolume } = require('./volume');
const {
  createPreviewBinder,
  publicExposed,
  MAX_EXPOSED_PORTS,
  parseEnvPortAllowlist,
} = require('../preview');

const DEFAULT_DRIVER = 'memory';

function resolveDriverName(env = process.env, override) {
  const raw = String(override || env.AGENTES_CODING_SANDBOX_DRIVER || DEFAULT_DRIVER)
    .trim()
    .toLowerCase();
  if (raw === 'docker' || raw === 'docker-local' || raw === 'local') return 'docker';
  if (raw === 'volume' || raw === 'disk') return 'volume';
  if (raw === 'memory') return 'memory';
  fail('E_PROVIDER', 'Driver de sandbox no reconocido.');
}

function driverPersistsFiles(name) {
  return name === 'docker' || name === 'volume';
}

function newSessionId() {
  return `csb_${crypto.randomBytes(10).toString('hex')}`;
}

function createCodingSandbox(opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const driverName = resolveDriverName(env, opts.driver);
  const image = String(opts.image || env.AGENTES_CODING_SANDBOX_IMAGE || DEFAULT_IMAGE).trim()
    || DEFAULT_IMAGE;
  const networkHook = opts.networkHook || null;
  const composeNetwork = env.AGENTES_CODING_SANDBOX_NETWORK || undefined;
  const preview = opts.previewBinder || createPreviewBinder({
    env,
    now,
    secret: opts.previewSecret,
    mapPort: opts.mapPort,
    ttlMs: opts.previewTtlMs,
    publicBase: opts.previewPublicBase,
  });

  const volume = createSessionVolume({
    env,
    fs: opts.fs,
    dataDir: opts.dataDir,
  });
  const dockerDriver = createDockerLocalDriver({
    docker: opts.docker,
    image,
    volume: driverName === 'docker' ? volume : null,
  });
  const volumeDriver = createVolumeDriver({ volume });
  const memoryDriver = createMemoryDriver();

  function pickDriver(name) {
    if (name === 'docker') return dockerDriver;
    if (name === 'volume') return volumeDriver;
    return memoryDriver;
  }

  const sessions = new Map();
  const pendingSessions = new Set();
  const defaults = resolveLimits({}, env);
  let gcTimer = null;

  function requireEnabled() {
    if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
  }

  function persistEnabled() {
    return driverPersistsFiles(driverName);
  }

  function hydrateFromMeta(meta) {
    const limits = resolveLimits({
      ...meta.limits,
      ttlMs: meta.limits && meta.limits.ttlMs,
    }, env);
    const network = createNetworkPolicy({
      allowlist: (meta.network && meta.network.allowlist) || [],
      portAllowlist: (meta.network && meta.network.portAllowlist) || parseEnvPortAllowlist(env),
      hook: networkHook,
      composeNetwork,
    });
    return {
      id: meta.id,
      userId: meta.userId || null,
      driver: meta.driver || driverName,
      image: meta.image || image,
      createdAt: meta.createdAt || now(),
      lastTouched: meta.lastTouched || meta.createdAt || now(),
      expiresAt: meta.expiresAt,
      limits,
      network,
      destroyed: false,
      exposedPorts: [],
      files: null,
      containerName: null,
      volumePath: persistEnabled() ? volume.workspacePath(meta.id) : null,
      execImpl: null,
    };
  }

  function reattachFromVolume(sessionId) {
    if (!persistEnabled()) return null;
    const id = String(sessionId || '').trim();
    if (!id || !volume.exists(id)) return null;
    const meta = volume.readMeta(id);
    if (!meta) return null;
    if (now() >= (Number(meta.expiresAt) || 0)) {
      try { volume.remove(id); } catch (_) { /* expired leftover */ }
      return 'expired';
    }
    const session = hydrateFromMeta(meta);
    sessions.set(id, session);
    return session;
  }

  function lookupSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const live = sessions.get(id);
    if (live) return live;
    const attached = reattachFromVolume(id);
    return attached === 'expired' ? attached : attached;
  }

  function getLive(sessionId) {
    requireEnabled();
    const id = String(sessionId || '').trim();
    if (!id) fail('E_PARAMS', 'Falta sessionId.');
    const session = lookupSession(id);
    if (session === 'expired') fail('E_SESSION_EXPIRED');
    if (!session) fail('E_SESSION_NOT_FOUND');
    if (session.destroyed) fail('E_SESSION_DESTROYED');
    if (now() >= session.expiresAt) {
      void destroyInternal(session);
      fail('E_SESSION_EXPIRED');
    }
    session.lastTouched = now();
    session.expiresAt = session.lastTouched + session.limits.ttlMs;
    if (persistEnabled()) {
      try { volume.saveMeta(session); } catch (_) { /* best-effort lease */ }
    }
    return session;
  }

  // Call before any untrusted HTTP/WS operation. Does not renew the lease
  // or reveal whether another user's session exists.
  function assertSessionOwner(sessionId, userId) {
    requireEnabled();
    const session = lookupSession(sessionId);
    if (session === 'expired') fail('E_SESSION_EXPIRED');
    if (typeof userId !== 'string' || !userId.trim() || !session
      || session.userId !== userId || session.destroyed) fail('E_SESSION_NOT_FOUND');
    if (now() >= session.expiresAt) fail('E_SESSION_EXPIRED');
    return publicSession(session);
  }

  async function destroyInternal(session) {
    if (!session || session.destroyed) return false;
    session.destroyed = true;
    try {
      await pickDriver(session.driver).destroy(session);
    } catch (_) { /* best-effort */ }
    sessions.delete(session.id);
    return true;
  }

  function countedSessionIds() {
    const ids = new Set(sessions.keys());
    if (persistEnabled()) {
      for (const id of volume.listIds()) ids.add(id);
    }
    return ids;
  }

  async function createSession(input = {}) {
    requireEnabled();
    const id = String(input.id || newSessionId());
    if (sessions.has(id) || pendingSessions.has(id)) fail('E_PARAMS', 'sessionId duplicado.');
    if (persistEnabled() && volume.exists(id)) {
      const meta = volume.readMeta(id);
      if (meta && now() < (Number(meta.expiresAt) || 0)) {
        return recreateSession({ ...input, id });
      }
      try { volume.remove(id); } catch (_) { /* stale leftover */ }
    }
    if (countedSessionIds().size + pendingSessions.size >= defaults.maxSessions) fail('E_QUOTA');
    const limits = resolveLimits({ ...input, ttlMs: input.ttlMs }, env);
    const network = createNetworkPolicy({
      allowlist: input.networkAllowlist || input.allowlist || [],
      portAllowlist: input.previewPorts || input.portAllowlist || parseEnvPortAllowlist(env),
      hook: input.networkHook || networkHook,
      composeNetwork,
    });
    const createdAt = now();
    const session = {
      id,
      userId: input.userId || null,
      driver: driverName,
      image,
      createdAt,
      lastTouched: createdAt,
      expiresAt: createdAt + limits.ttlMs,
      limits,
      network,
      destroyed: false,
      exposedPorts: [],
      files: null,
      containerName: null,
      volumePath: null,
      execImpl: typeof input.execImpl === 'function' ? input.execImpl : null,
    };
    pendingSessions.add(id);
    try {
      await pickDriver(driverName).createSession(session);
      sessions.set(id, session);
    } catch (err) {
      if (persistEnabled()) {
        try { volume.remove(id); } catch (_) { /* release quota */ }
      }
      throw err;
    } finally {
      pendingSessions.delete(id);
    }
    return publicSession(session);
  }

  async function recreateSession(input = {}) {
    requireEnabled();
    if (!persistEnabled()) fail('E_SESSION_NOT_FOUND');
    const id = String(input.id || input.sessionId || '').trim();
    if (!id) fail('E_PARAMS', 'Falta sessionId.');
    let session = sessions.get(id);
    if (!session || session.destroyed) {
      const attached = reattachFromVolume(id);
      if (attached === 'expired') fail('E_SESSION_EXPIRED');
      if (!attached) fail('E_SESSION_NOT_FOUND');
      session = attached;
    }
    if (input.userId && session.userId && session.userId !== input.userId) {
      fail('E_SESSION_NOT_FOUND');
    }
    if (typeof input.execImpl === 'function') session.execImpl = input.execImpl;
    const driver = pickDriver(session.driver || driverName);
    if (typeof driver.ensureContainer === 'function') {
      await driver.ensureContainer(session);
    } else if (typeof driver.createSession === 'function' && !session.volumePath) {
      await driver.createSession(session);
    }
    session.lastTouched = now();
    session.expiresAt = session.lastTouched + session.limits.ttlMs;
    try { volume.saveMeta(session); } catch (_) { /* best-effort */ }
    return publicSession(session);
  }

  function publicSession(session) {
    return {
      id: session.id,
      userId: session.userId,
      driver: session.driver,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      limits: {
        cpus: session.limits.cpus,
        memory: session.limits.memory,
        pids: session.limits.pids,
        timeoutMs: session.limits.timeoutMs,
        ttlMs: session.limits.ttlMs,
      },
      network: {
        mode: session.network.mode,
        allowlist: [...session.network.allowlist],
        previewPorts: [...(session.network.portAllowlist || [])],
      },
      containerName: session.containerName,
      exposedPorts: (session.exposedPorts || []).map(publicExposed),
    };
  }

  async function exec(sessionId, command, execOpts = {}) {
    const session = getLive(sessionId);
    return pickDriver(session.driver).exec(session, command, execOpts);
  }

  async function readFile(sessionId, relPath) {
    const session = getLive(sessionId);
    const buf = await pickDriver(session.driver).readFile(session, relPath);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  }

  async function writeFile(sessionId, relPath, content) {
    const session = getLive(sessionId);
    return pickDriver(session.driver).writeFile(session, relPath, content);
  }

  async function listFiles(sessionId, relDir) {
    const session = getLive(sessionId);
    return pickDriver(session.driver).listFiles(session, relDir);
  }

  async function exposePort(sessionId, port) {
    const session = getLive(sessionId);
    const n = Number.parseInt(port, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) fail('E_PARAMS', 'Puerto inválido.');
    const verdict = session.network.decide({ action: 'exposePort', port: n, host: '127.0.0.1' });
    if (!verdict.allowed) fail('E_PORT_DENIED');
    const existing = session.exposedPorts.findIndex((row) => row.port === n);
    if (existing < 0 && session.exposedPorts.length >= MAX_EXPOSED_PORTS) fail('E_QUOTA');
    const record = await preview.bind(session, n);
    if (existing >= 0) session.exposedPorts.splice(existing, 1, record);
    else session.exposedPorts.push(record);
    return publicExposed(record);
  }

  function listPorts(sessionId) {
    const session = getLive(sessionId);
    const t = now();
    session.exposedPorts = session.exposedPorts.filter((row) => !row.expiresAt || row.expiresAt > t);
    return session.exposedPorts.map(publicExposed);
  }

  function unexposePort(sessionId, port) {
    const session = getLive(sessionId);
    const n = Number.parseInt(port, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) fail('E_PARAMS', 'Puerto inválido.');
    const before = session.exposedPorts.length;
    session.exposedPorts = session.exposedPorts.filter((row) => row.port !== n);
    if (session.exposedPorts.length === before) fail('E_PORT_DENIED', 'El puerto no está expuesto.');
    return { ok: true, port: n };
  }

  function resolvePreview(sessionId, token) {
    const session = getLive(sessionId);
    const claims = preview.verify(token, session.id);
    const record = session.exposedPorts.find((row) => row.port === claims.port && row.token === token);
    if (!record) fail('E_PORT_DENIED', 'El puerto ya no está expuesto.');
    if (record.expiresAt && now() >= record.expiresAt) fail('E_PREVIEW_EXPIRED');
    return publicExposed(record);
  }

  async function destroy(sessionId) {
    requireEnabled();
    const id = String(sessionId || '').trim();
    if (!id) fail('E_PARAMS', 'Falta sessionId.');
    let session = sessions.get(id);
    if (!session && persistEnabled()) {
      const attached = reattachFromVolume(id);
      if (attached && attached !== 'expired') session = attached;
    }
    if (!session) {
      if (persistEnabled() && volume.exists(id)) {
        volume.remove(id);
        return { ok: true, id };
      }
      fail('E_SESSION_NOT_FOUND');
    }
    await destroyInternal(session);
    return { ok: true, id };
  }

  function sweepExpired() {
    const t = now();
    const doomed = [];
    const seen = new Set();
    for (const session of sessions.values()) {
      if (session.destroyed || t >= session.expiresAt) {
        doomed.push(session);
        seen.add(session.id);
      }
    }
    if (persistEnabled()) {
      for (const id of volume.listIds()) {
        if (seen.has(id) || sessions.has(id)) continue;
        const meta = volume.readMeta(id);
        if (!meta || t >= (Number(meta.expiresAt) || 0)) {
          if (meta) doomed.push(hydrateFromMeta(meta));
          else {
            try { volume.remove(id); } catch (_) { /* orphan dir */ }
          }
        }
      }
    }
    return Promise.all(doomed.map((s) => destroyInternal(s)));
  }

  function startGc() {
    if (gcTimer || opts.autoGc === false) return;
    gcTimer = setInterval(() => { void sweepExpired(); }, 30_000);
    if (typeof gcTimer.unref === 'function') gcTimer.unref();
  }

  function stopGc() {
    if (gcTimer) clearInterval(gcTimer);
    gcTimer = null;
  }

  startGc();

  return {
    isEnabled: () => isAgentesCodingV2Enabled(env),
    driverKind: () => driverName,
    assertSessionOwner,
    createSession,
    recreateSession,
    exec,
    readFile,
    writeFile,
    listFiles,
    exposePort,
    listPorts,
    unexposePort,
    resolvePreview,
    destroy,
    sweepExpired,
    stopGc,
    getSession: (id) => {
      const session = lookupSession(id);
      if (!session || session === 'expired' || session.destroyed) return null;
      return publicSession(session);
    },
    _unsafeGetRaw: (id) => {
      const session = lookupSession(id);
      return session && session !== 'expired' ? session : undefined;
    },
  };
}

let defaultInstance = null;

function getDefaultSandbox() {
  if (!defaultInstance) defaultInstance = createCodingSandbox();
  return defaultInstance;
}

function resetDefaultSandbox() {
  if (defaultInstance && typeof defaultInstance.stopGc === 'function') {
    defaultInstance.stopGc();
  }
  defaultInstance = null;
}

module.exports = {
  createCodingSandbox,
  getDefaultSandbox,
  resetDefaultSandbox,
  resolveDriverName,
  driverPersistsFiles,
  CodingSandboxError,
};
