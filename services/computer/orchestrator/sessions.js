'use strict';

const crypto = require('crypto');
const { loadConfig } = require('./config');

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

function newSessionId() {
  return crypto.randomUUID();
}

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
    entry.expiresAt = this.now() + this.cfg.ttlMs;
    entry.lastActivityAt = this.now();
    return entry;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  list() {
    return [...this.sessions.values()].map((s) => this.toPublic(s));
  }

  toPublic(entry) {
    return {
      sessionId: entry.sessionId,
      status: entry.status,
      containerId: entry.containerId,
      containerName: entry.containerName,
      novncWsUrl: entry.novncWsUrl,
      novncUrl: entry.novncUrl,
      agentUrl: entry.agentUrl,
      cdpUrl: entry.cdpUrl,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      lastActivityAt: entry.lastActivityAt,
      ttlMs: this.cfg.ttlMs,
    };
  }

  hostPort(info, privatePort) {
    const ports = info?.NetworkSettings?.Ports || {};
    const key = `${privatePort}/tcp`;
    const bindings = ports[key];
    if (!Array.isArray(bindings) || !bindings[0]?.HostPort) return null;
    return Number(bindings[0].HostPort);
  }

  async create() {
    if (this.sessions.size >= this.cfg.maxSessions) {
      const err = new Error('at_capacity');
      err.status = 429;
      err.code = 'at_capacity';
      throw err;
    }
    const sessionId = newSessionId();
    const name = containerName(sessionId, this.cfg.namePrefix);
    if (isProtectedName(name, this.cfg.protectedNamePrefix)) {
      const err = new Error('refusing to create a protected webtop name');
      err.status = 500;
      throw err;
    }

    const env = [
      `DISPLAY=:1`,
      `HOME=/workspace`,
    ];
    if (this.cfg.vncPassword) env.push(`COMPUTER_VNC_PASSWORD=${this.cfg.vncPassword}`);

    const container = await this.docker.createContainer({
      Image: this.cfg.image,
      name,
      Hostname: `computer-${sessionId.slice(0, 8)}`,
      Labels: {
        [this.cfg.sessionLabel]: sessionId,
        [this.cfg.labelKey]: this.cfg.labelValue,
        'siragpt.role': 'agent-computer-session',
      },
      Env: env,
      HostConfig: {
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
      },
      ExposedPorts: {
        '6080/tcp': {},
        '8080/tcp': {},
        '9222/tcp': {},
      },
    });

    await container.start();
    const info = await container.inspect();
    const novncPort = this.hostPort(info, 6080);
    const agentPort = this.hostPort(info, 8080);
    const cdpPort = this.hostPort(info, 9222);
    const host = this.cfg.publicHost;
    const novncPage = publicUrl(this.cfg.novncBaseUrl, host, novncPort, '/vnc.html');
    const novncWs = wsUrl(publicUrl(this.cfg.novncBaseUrl, host, novncPort, '/'));

    const entry = this.touch({
      sessionId,
      status: 'running',
      containerId: info.Id,
      containerName: name,
      novncPort,
      agentPort,
      cdpPort,
      novncUrl: `${novncPage}${novncPage.includes('?') ? '&' : '?'}autoconnect=1&resize=scale`,
      novncWsUrl: novncWs,
      agentUrl: `http://${host}:${agentPort}`,
      cdpUrl: cdpPort ? `http://${host}:${cdpPort}` : undefined,
      createdAt: this.now(),
    });
    this.sessions.set(sessionId, entry);
    return this.toPublic(entry);
  }

  async destroy(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: true, destroyed: false };
    if (isProtectedName(entry.containerName, this.cfg.protectedNamePrefix)) {
      const err = new Error('refusing to destroy a protected webtop');
      err.status = 403;
      throw err;
    }
    this.sessions.delete(sessionId);
    try {
      const container = this.docker.getContainer(entry.containerId);
      try { await container.stop({ t: 5 }); } catch (_) { /* already gone */ }
      try { await container.remove({ force: true }); } catch (_) { /* already gone */ }
    } catch (_) { /* inspect/get may fail if already removed */ }
    return { ok: true, destroyed: true, sessionId };
  }

  renew(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    this.touch(entry);
    return this.toPublic(entry);
  }

  async reapExpired() {
    const now = this.now();
    const expired = [...this.sessions.values()].filter((s) => s.expiresAt <= now);
    const results = [];
    for (const entry of expired) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.destroy(entry.sessionId));
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
  newSessionId,
  containerName,
  isProtectedName,
  publicUrl,
  wsUrl,
  SessionManager,
};
