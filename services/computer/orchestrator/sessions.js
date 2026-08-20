'use strict';

const { loadConfig } = require('./config');
const {
  UserIdError,
  normalizeUserId,
  sessionIdForUser,
  containerNameForUser,
  volumeNameForUser,
} = require('./identity');

/**
 * Caps added after CapDrop ALL. Privileged is never set.
 *
 * Chrome is started with --no-sandbox --disable-dev-shm-usage (see
 * start-chrome.sh). Even then Chrome's zygote and Xvfb need a short list
 * of capabilities on Ubuntu 22.04:
 *
 *   SYS_ADMIN   — Chrome namespace / user-ns fallback; Xvfb tty setup
 *   SYS_CHROOT  — Chrome zygote
 *   SETUID/SETGID/SETPCAP — process credential changes
 *   DAC_OVERRIDE/FOWNER/CHOWN — workspace file ops as compuser
 *   MKNOD — Xvfb /dev nodes
 *   AUDIT_WRITE/KILL — process supervision
 *
 * Do not add SYS_PTRACE or NET_ADMIN. Do not use --privileged.
 * The always-on sira-dpc-* CEO Office webtops are out of scope.
 */
const CHROME_XVFB_CAPS = Object.freeze([
  'SYS_ADMIN',
  'SYS_CHROOT',
  'SETUID',
  'SETGID',
  'SETPCAP',
  'DAC_OVERRIDE',
  'FOWNER',
  'CHOWN',
  'MKNOD',
  'AUDIT_WRITE',
  'KILL',
]);

function containerName(sessionId, prefix) {
  return `${prefix}${sessionId}`;
}

function isProtectedName(name, protectedPrefix) {
  return String(name || '').startsWith(protectedPrefix);
}

function publicUrl(base, fallbackHost, port, pathSuffix = '') {
  if (base) {
    try {
      const u = new URL(base);
      if (pathSuffix) u.pathname = pathSuffix;
      return u.toString().replace(/\/$/, '');
    } catch (_) { /* fall through */ }
  }
  return `http://${fallbackHost}:${port}${pathSuffix}`;
}

function wsUrl(httpUrl) {
  return String(httpUrl || '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

function isConflict(err) {
  return Number(err?.statusCode) === 409 || /already (exists|in use)/i.test(String(err?.message || ''));
}

function isNotFound(err) {
  return Number(err?.statusCode) === 404 || /no such/i.test(String(err?.message || ''));
}

class SessionManager {
  constructor({ docker, env = process.env, now = () => Date.now() } = {}) {
    this.docker = docker;
    this.env = env;
    this.now = now;
    this.cfg = loadConfig(env);
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this._reaper = null;
  }

  touch(entry) {
    entry.lastActivityAt = this.now();
    entry.expiresAt = this.cfg.idleReclaim ? this.now() + this.cfg.ttlMs : null;
    return entry;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getByUser(userId) {
    try {
      return this.sessions.get(sessionIdForUser(userId)) || null;
    } catch (_) {
      return null;
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => this.toPublic(s));
  }

  toPublic(entry) {
    return {
      sessionId: entry.sessionId,
      userId: entry.userId,
      status: entry.status,
      persistent: true,
      sharedBy: 'member-department-agents',
      workspaceRoot: '/workspace',
      volumeName: entry.volumeName || null,
      containerId: entry.containerId,
      containerName: entry.containerName,
      novncWsUrl: entry.novncWsUrl,
      novncUrl: entry.novncUrl,
      agentUrl: entry.agentUrl,
      cdpUrl: entry.cdpUrl,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      lastActivityAt: entry.lastActivityAt,
      idleReclaim: this.cfg.idleReclaim,
      ttlMs: this.cfg.idleReclaim ? this.cfg.ttlMs : null,
    };
  }

  hostPort(info, privatePort) {
    const ports = info?.NetworkSettings?.Ports || {};
    const key = `${privatePort}/tcp`;
    const bindings = ports[key];
    if (!Array.isArray(bindings) || !bindings[0]?.HostPort) return null;
    return Number(bindings[0].HostPort);
  }

  applyInspect(entry, info) {
    const novncPort = this.hostPort(info, 6080);
    const agentPort = this.hostPort(info, 8080);
    const cdpPort = this.hostPort(info, 9222);
    const host = this.cfg.publicHost;
    const novncPage = publicUrl(this.cfg.novncBaseUrl, host, novncPort, '/vnc.html');
    const novncWs = wsUrl(publicUrl(this.cfg.novncBaseUrl, host, novncPort, '/'));
    entry.containerId = info.Id;
    entry.status = info.State?.Running ? 'running' : 'stopped';
    entry.novncPort = novncPort;
    entry.agentPort = agentPort;
    entry.cdpPort = cdpPort;
    entry.novncUrl = `${novncPage}${novncPage.includes('?') ? '&' : '?'}autoconnect=1&resize=scale`;
    entry.novncWsUrl = novncWs;
    entry.agentUrl = `http://${host}:${agentPort}`;
    entry.cdpUrl = cdpPort ? `http://${host}:${cdpPort}` : undefined;
    return entry;
  }

  entryFromUser(userId) {
    const id = normalizeUserId(userId);
    const sessionId = sessionIdForUser(id);
    const name = containerNameForUser(id, this.cfg.namePrefix);
    if (isProtectedName(name, this.cfg.protectedNamePrefix)) {
      const err = new Error('refusing to create a protected webtop name');
      err.status = 500;
      throw err;
    }
    return {
      sessionId,
      userId: id,
      containerName: name,
      volumeName: this.cfg.persistWorkspace ? volumeNameForUser(id) : null,
      status: 'pending',
      createdAt: this.now(),
    };
  }

  async ensureVolume(name, userId) {
    if (!name) return;
    try {
      await this.docker.createVolume({
        Name: name,
        Labels: {
          [this.cfg.labelKey]: 'user-workspace',
          [this.cfg.userLabel]: userId,
        },
      });
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
  }

  async ensureRunning(entry) {
    const container = this.docker.getContainer(entry.containerId || entry.containerName);
    let info = await container.inspect();
    if (!info.State?.Running) {
      await container.start();
      info = await container.inspect();
    }
    this.applyInspect(entry, info);
    this.sessions.set(entry.sessionId, entry);
    return entry;
  }

  async adoptByName(userId) {
    const draft = this.entryFromUser(userId);
    try {
      const info = await this.docker.getContainer(draft.containerName).inspect();
      if (isProtectedName(String(info.Name || '').replace(/^\//, ''), this.cfg.protectedNamePrefix)) {
        return null;
      }
      const entry = this.applyInspect({ ...draft, createdAt: this.now() }, info);
      this.sessions.set(entry.sessionId, entry);
      await this.ensureRunning(entry);
      return entry;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async provision(userId) {
    const entry = this.entryFromUser(userId);
    if (this.cfg.persistWorkspace) {
      await this.ensureVolume(entry.volumeName, entry.userId);
    }

    const env = [
      'DISPLAY=:1',
      'HOME=/workspace',
      `COMPUTER_USER_ID=${entry.userId}`,
    ];
    if (this.cfg.vncPassword) env.push(`COMPUTER_VNC_PASSWORD=${this.cfg.vncPassword}`);

    const hostConfig = {
      Memory: this.cfg.memoryBytes,
      NanoCpus: this.cfg.nanoCpus,
      ShmSize: this.cfg.shmSize,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [...CHROME_XVFB_CAPS],
      SecurityOpt: ['no-new-privileges:true'],
      PortBindings: {
        '6080/tcp': [{ HostIp: '127.0.0.1' }],
        '8080/tcp': [{ HostIp: '127.0.0.1' }],
        '9222/tcp': [{ HostIp: '127.0.0.1' }],
      },
      ExtraHosts: [],
    };
    if (entry.volumeName) {
      hostConfig.Mounts = [{
        Type: 'volume',
        Source: entry.volumeName,
        Target: '/workspace',
      }];
    }

    let container;
    try {
      container = await this.docker.createContainer({
        Image: this.cfg.image,
        name: entry.containerName,
        Hostname: `computer-${entry.sessionId.slice(0, 8)}`,
        Labels: {
          [this.cfg.sessionLabel]: entry.sessionId,
          [this.cfg.userLabel]: entry.userId,
          [this.cfg.labelKey]: this.cfg.labelValue,
          'siragpt.role': 'agent-computer-desktop',
        },
        Env: env,
        HostConfig: hostConfig,
        ExposedPorts: {
          '6080/tcp': {},
          '8080/tcp': {},
          '9222/tcp': {},
        },
      });
    } catch (err) {
      if (!isConflict(err)) throw err;
      const adopted = await this.adoptByName(entry.userId);
      if (adopted) return adopted;
      throw err;
    }

    await container.start();
    const info = await container.inspect();
    this.applyInspect(entry, info);
    this.touch(entry);
    this.sessions.set(entry.sessionId, entry);
    return entry;
  }

  /**
   * Get-or-create the persistent desktop for one SiraGPT member.
   * Department is intentionally not a key.
   */
  async ensure(opts = {}) {
    const userId = typeof opts === 'string' ? opts : opts.userId;
    const id = normalizeUserId(userId);
    const sessionId = sessionIdForUser(id);

    const existing = this.sessions.get(sessionId);
    if (existing) {
      try {
        await this.ensureRunning(existing);
        this.touch(existing);
        return { ...this.toPublic(existing), created: false };
      } catch (err) {
        if (!isNotFound(err)) throw err;
        this.sessions.delete(sessionId);
      }
    }

    const adopted = await this.adoptByName(id);
    if (adopted) {
      this.touch(adopted);
      return { ...this.toPublic(adopted), created: false };
    }

    if (this.sessions.size >= this.cfg.maxSessions) {
      const err = new Error('at_capacity');
      err.status = 429;
      err.code = 'at_capacity';
      throw err;
    }

    const created = await this.provision(id);
    return { ...this.toPublic(created), created: true };
  }

  async create(opts) {
    return this.ensure(opts);
  }

  async destroy(sessionId, { removeVolume = false } = {}) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: true, destroyed: false };
    if (isProtectedName(entry.containerName, this.cfg.protectedNamePrefix)) {
      const err = new Error('refusing to destroy a protected webtop');
      err.status = 403;
      throw err;
    }
    this.sessions.delete(sessionId);
    try {
      const container = this.docker.getContainer(entry.containerId || entry.containerName);
      try { await container.stop({ t: 5 }); } catch (_) { /* already gone */ }
      try { await container.remove({ force: true }); } catch (_) { /* already gone */ }
    } catch (_) { /* inspect/get may fail if already removed */ }
    if (removeVolume && entry.volumeName) {
      try {
        await this.docker.getVolume(entry.volumeName).remove({ force: true });
      } catch (_) { /* volume may be in use or already gone */ }
    }
    return { ok: true, destroyed: true, sessionId, volumeRemoved: Boolean(removeVolume && entry.volumeName) };
  }

  renew(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    this.touch(entry);
    return this.toPublic(entry);
  }

  async reapExpired() {
    if (!this.cfg.idleReclaim) return [];
    const now = this.now();
    const expired = [...this.sessions.values()].filter((s) => s.expiresAt != null && s.expiresAt <= now);
    const results = [];
    for (const entry of expired) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.destroy(entry.sessionId, { removeVolume: false }));
    }
    return results;
  }

  startReaper() {
    if (this._reaper) return;
    this._reaper = setInterval(() => {
      this.reapExpired().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[computer-orch] reaper error', err?.message || err);
      });
    }, this.cfg.reaperMs);
    if (typeof this._reaper.unref === 'function') this._reaper.unref();
  }

  stopReaper() {
    if (this._reaper) clearInterval(this._reaper);
    this._reaper = null;
  }
}

module.exports = {
  CHROME_XVFB_CAPS,
  containerName,
  isProtectedName,
  publicUrl,
  wsUrl,
  SessionManager,
  UserIdError,
};
