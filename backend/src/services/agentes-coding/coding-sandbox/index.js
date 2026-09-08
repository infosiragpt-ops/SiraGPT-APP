'use strict';

/**
 * coding-sandbox — AGENTES_CODING_V2 Phase 2a session adapter.
 *
 * Interface: createSession, exec, readFile, writeFile, listFiles,
 * exposePort, destroy. Default OFF. Docker/memory drivers are injectable.
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

const DEFAULT_DRIVER = 'memory';

function resolveDriverName(env = process.env, override) {
  const raw = String(override || env.AGENTES_CODING_SANDBOX_DRIVER || DEFAULT_DRIVER)
    .trim()
    .toLowerCase();
  if (raw === 'docker' || raw === 'docker-local' || raw === 'local') return 'docker';
  return 'memory';
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

  const dockerDriver = createDockerLocalDriver({
    docker: opts.docker,
    image,
  });
  const memoryDriver = createMemoryDriver();

  function pickDriver(name) {
    return name === 'docker' ? dockerDriver : memoryDriver;
  }

  const sessions = new Map();
  const defaults = resolveLimits({}, env);
  let gcTimer = null;

  function requireEnabled() {
    if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
  }

  function getLive(sessionId) {
    requireEnabled();
    const id = String(sessionId || '').trim();
    if (!id) fail('E_PARAMS', 'Falta sessionId.');
    const session = sessions.get(id);
    if (!session) fail('E_SESSION_NOT_FOUND');
    if (session.destroyed) fail('E_SESSION_DESTROYED');
    if (now() >= session.expiresAt) {
      void destroyInternal(session);
      fail('E_SESSION_EXPIRED');
    }
    session.lastTouched = now();
    session.expiresAt = session.lastTouched + session.limits.ttlMs;
    return session;
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

  async function createSession(input = {}) {
    requireEnabled();
    if (sessions.size >= defaults.maxSessions) fail('E_QUOTA');
    const limits = resolveLimits({ ...input, ttlMs: input.ttlMs }, env);
    const network = createNetworkPolicy({
      allowlist: input.networkAllowlist || input.allowlist || [],
      hook: input.networkHook || networkHook,
      composeNetwork,
    });
    const id = String(input.id || newSessionId());
    if (sessions.has(id)) fail('E_PARAMS', 'sessionId duplicado.');
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
      execImpl: typeof input.execImpl === 'function' ? input.execImpl : null,
    };
    await pickDriver(driverName).createSession(session);
    sessions.set(id, session);
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
      },
      containerName: session.containerName,
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
    const record = { port: n, published: false, url: null };
    session.exposedPorts.push(record);
    return record;
  }

  async function destroy(sessionId) {
    requireEnabled();
    const id = String(sessionId || '').trim();
    if (!id) fail('E_PARAMS', 'Falta sessionId.');
    const session = sessions.get(id);
    if (!session) fail('E_SESSION_NOT_FOUND');
    await destroyInternal(session);
    return { ok: true, id };
  }

  function sweepExpired() {
    const t = now();
    const doomed = [];
    for (const session of sessions.values()) {
      if (session.destroyed || t >= session.expiresAt) doomed.push(session);
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
    createSession,
    exec,
    readFile,
    writeFile,
    listFiles,
    exposePort,
    destroy,
    sweepExpired,
    stopGc,
    getSession: (id) => {
      const session = sessions.get(id);
      return session && !session.destroyed ? publicSession(session) : null;
    },
    _unsafeGetRaw: (id) => sessions.get(id),
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
  CodingSandboxError,
};
