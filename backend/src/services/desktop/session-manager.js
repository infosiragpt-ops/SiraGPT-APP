'use strict';

/**
 * DesktopSessionManager — F7.1 in-memory warm pool.
 *
 * acquire() prefers a healthy warm desktop (SLO: p50 < 800 ms when
 * pool > 0). Missing kill-switch / missing provider fail CLOSED with
 * honest Spanish copy. Never talks to the live computer orchestrator.
 *
 * human_control / agent_control are placeholders (FSM is F7.4).
 * Persistence is in-memory (Prisma DesktopSession is F7.7).
 */

const { randomUUID } = require('crypto');
const { DesktopProviderError } = require('./provider/DesktopProvider');
const { createDesktopProvider } = require('./provider');
const {
  DESKTOP_DISABLED_ES,
  PROVIDER_UNCONFIGURED_ES,
  DESKTOP_NOT_READY_ES,
  GENERIC_PROVISION_ERROR_ES,
  isGenericProvisionError,
} = require('./desktop-errors');
const { issueDesktopWsToken } = require('./ws-token');

const SESSION_STATUSES = Object.freeze([
  'starting',
  'ready',
  'human_control',
  'agent_control',
  'idle',
  'dead',
]);

function parseSwitch(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return null;
}

function isDesktopEnabled(env = process.env) {
  return parseSwitch(env.SIRAGPT_DESKTOP_ENABLED) === true;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolvePoolConfig(env = process.env) {
  return {
    poolMin: clampInt(env.DESKTOP_POOL_MIN, 2, 0, 20),
    poolMax: clampInt(env.DESKTOP_POOL_MAX, 20, 1, 100),
    ttlMin: clampInt(env.DESKTOP_SESSION_TTL_MIN, 15, 1, 24 * 60),
    readyTimeoutMs: clampInt(env.DESKTOP_READY_TIMEOUT_MS, 20_000, 500, 120_000),
  };
}

function normalizeProviderKind(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (k === 'e2b') return 'e2b';
  if (k === 'local-gvisor' || k === 'local' || k === 'gvisor') return 'local-gvisor';
  return '';
}

/**
 * Provider kind for this phase: DESKTOP_PROVIDER, else e2b when a key
 * is present. Never silently invent a backend.
 */
function resolveProviderKind(env = process.env) {
  const explicit = normalizeProviderKind(env.DESKTOP_PROVIDER);
  if (explicit) return explicit;
  if (String(env.E2B_API_KEY || '').trim()) return 'e2b';
  return '';
}

function desktopDisabledError() {
  return new DesktopProviderError(DESKTOP_DISABLED_ES, {
    code: 'desktop_disabled',
    status: 503,
  });
}

function providerUnconfiguredError() {
  return new DesktopProviderError(PROVIDER_UNCONFIGURED_ES, {
    code: 'desktop_provider_unconfigured',
    status: 503,
  });
}

class DesktopSessionManager {
  /**
   * @param {object} [opts]
   * @param {object} [opts.provider] injected DesktopProvider (tests)
   * @param {object} [opts.env]
   * @param {function} [opts.now]
   * @param {boolean} [opts.autoStart=false]
   * @param {number} [opts.reaperIntervalMs]
   */
  constructor(opts = {}) {
    this.env = opts.env || process.env;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.cfg = resolvePoolConfig(this.env);
    if (opts.poolMin != null) this.cfg.poolMin = clampInt(opts.poolMin, this.cfg.poolMin, 0, 20);
    if (opts.poolMax != null) this.cfg.poolMax = clampInt(opts.poolMax, this.cfg.poolMax, 1, 100);
    if (opts.ttlMin != null) this.cfg.ttlMin = clampInt(opts.ttlMin, this.cfg.ttlMin, 1, 24 * 60);
    if (opts.readyTimeoutMs != null) {
      this.cfg.readyTimeoutMs = clampInt(opts.readyTimeoutMs, this.cfg.readyTimeoutMs, 50, 120_000);
    }
    this._provider = opts.provider || null;
    this._createProvider = opts.createProvider || createDesktopProvider;
    /** @type {Array<{ handle: object, lastHealthAt: number, createdAt: number }>} */
    this.pool = [];
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this._refillInflight = null;
    this._reaperTimer = null;
    this.reaperIntervalMs = Number(opts.reaperIntervalMs) > 0 ? Number(opts.reaperIntervalMs) : 30_000;
    if (opts.autoStart) {
      this.start();
    }
  }

  ttlMs() {
    return this.cfg.ttlMin * 60_000;
  }

  enabled() {
    return isDesktopEnabled(this.env);
  }

  providerKind() {
    if (this._provider && this._provider.kind) return this._provider.kind;
    return resolveProviderKind(this.env);
  }

  getProvider() {
    if (this._provider) return this._provider;
    const kind = resolveProviderKind(this.env);
    if (!kind) throw providerUnconfiguredError();
    this._provider = this._createProvider(kind, { env: this.env });
    return this._provider;
  }

  poolWarm() {
    return this.pool.length;
  }

  /**
   * Public snapshot for /api/desktop/status — no secrets.
   */
  publicStatus() {
    const enabled = this.enabled();
    return {
      enabled,
      poolWarm: this.poolWarm(),
      poolMin: this.cfg.poolMin,
      poolMax: this.cfg.poolMax,
      provider: this.providerKind() || null,
      ttlMin: this.cfg.ttlMin,
    };
  }

  start() {
    if (this._reaperTimer) return;
    this._reaperTimer = setInterval(() => {
      this.reap().catch(() => undefined);
    }, this.reaperIntervalMs);
    if (typeof this._reaperTimer.unref === 'function') this._reaperTimer.unref();
    if (this.enabled()) {
      void this.refillPool().catch(() => undefined);
    }
  }

  stop() {
    if (this._reaperTimer) {
      clearInterval(this._reaperTimer);
      this._reaperTimer = null;
    }
  }

  async acquire(chatId, opts = {}) {
    if (!this.enabled()) throw desktopDisabledError();
    const provider = this.getProvider();
    const boundChat = String(chatId || opts.chatId || '').trim();

    const warm = await this._takeWarmHealthy(provider);
    let handle;
    let fromPool = false;
    if (warm) {
      handle = warm;
      fromPool = true;
    } else {
      handle = await provider.create(opts.createOpts || {});
      await this.waitHealthy(handle, { timeoutMs: this.cfg.readyTimeoutMs });
    }

    const sessionId = `desk-${randomUUID()}`;
    const acquiredAt = this.now();
    const expiresAt = new Date(acquiredAt + this.ttlMs()).toISOString();
    const userId = String(opts.userId || '').trim() || null;
    const upstreamWs = String(
      (handle && (handle.novncWsUrl || handle.wsTarget || handle.wsUrl)) || opts.wsUrl || '',
    );
    const novncPort = Number(handle && (handle.novncPort || handle.websockifyPort)) || 0;
    let viewerToken = '';
    try {
      if (userId) {
        viewerToken = issueDesktopWsToken(
          { userId, chatId: boundChat, sessionId },
          { env: this.env, secret: opts.wsSecret },
        );
      }
    } catch (_) {
      viewerToken = '';
    }
    const tokenQs = viewerToken ? `?token=${encodeURIComponent(viewerToken)}` : '';
    const record = {
      sessionId,
      chatId: boundChat || null,
      userId,
      handle,
      provider: handle.provider || provider.kind || this.providerKind(),
      status: 'ready',
      inputMode: 'agent',
      acquiredAt,
      lastHeartbeat: acquiredAt,
      expiresAt,
      upstreamWs,
      novncPort,
      viewerToken,
      wsUrl: `/ws/desktop/${sessionId}${tokenQs}`,
      fromPool,
    };
    this.sessions.set(sessionId, record);
    void this.refillPool().catch(() => undefined);

    const lease = this._toLease(record);
    if (isGenericProvisionError(lease.status) || lease.status === GENERIC_PROVISION_ERROR_ES) {
      throw new DesktopProviderError(DESKTOP_NOT_READY_ES, {
        code: 'desktop_status_invalid',
        status: 500,
      });
    }
    return lease;
  }

  async release(sessionId, { keepWarm = false } = {}) {
    const rec = this.sessions.get(String(sessionId || ''));
    if (!rec) return { released: false };
    this.sessions.delete(rec.sessionId);
    rec.status = 'idle';
    if (keepWarm && this.pool.length < this.cfg.poolMax) {
      this.pool.push({
        handle: rec.handle,
        lastHealthAt: this.now(),
        createdAt: rec.acquiredAt,
      });
      return { released: true, keepWarm: true };
    }
    rec.status = 'dead';
    try {
      await this.getProvider().destroy(rec.handle);
    } catch (_) {
      // destroy is idempotent; a missing backend must not fail release
    }
    return { released: true, keepWarm: false };
  }

  async heartbeat(sessionId) {
    const rec = this.sessions.get(String(sessionId || ''));
    if (!rec) {
      throw new DesktopProviderError('La sesión de escritorio no existe.', {
        code: 'desktop_session_not_found',
        status: 404,
      });
    }
    rec.lastHeartbeat = this.now();
    rec.expiresAt = new Date(rec.lastHeartbeat + this.ttlMs()).toISOString();
    return this._toLease(rec);
  }

  status(sessionId) {
    const rec = this.sessions.get(String(sessionId || ''));
    if (!rec) return { status: 'dead', sessionId: String(sessionId || '') };
    return { ...this._toLease(rec) };
  }

  /**
   * Reuse a live lease for this chat (F7.3 CU-loop). Newest ready session
   * wins. Does not acquire and does not talk to a provider.
   */
  findByChatId(chatId) {
    const key = String(chatId || '').trim();
    if (!key) return null;
    let best = null;
    for (const rec of this.sessions.values()) {
      if (String(rec.chatId || '') !== key) continue;
      if (rec.status === 'dead') continue;
      if (!best || Number(rec.acquiredAt) > Number(best.acquiredAt)) best = rec;
    }
    return best ? this._toLease(best) : null;
  }

  /**
   * Provider handle for DCP calls. Not a public lease shape.
   */
  getHandle(sessionId) {
    const rec = this.getRecord(sessionId);
    return rec ? rec.handle : null;
  }

  /**
   * Internal record for the WS proxy. Not a public API shape.
   */
  getRecord(sessionId) {
    return this.sessions.get(String(sessionId || '')) || null;
  }

  setInputMode(sessionId, mode) {
    const rec = this.sessions.get(String(sessionId || ''));
    if (!rec) {
      throw new DesktopProviderError('La sesión de escritorio no existe.', {
        code: 'desktop_session_not_found',
        status: 404,
      });
    }
    const next = String(mode || '').trim().toLowerCase();
    if (next !== 'agent' && next !== 'human') {
      throw new DesktopProviderError('input_mode debe ser agent o human.', {
        code: 'desktop_input_mode_invalid',
        status: 400,
      });
    }
    rec.inputMode = next;
    return this._toLease(rec);
  }

  async refillPool() {
    if (this._refillInflight) return this._refillInflight;
    this._refillInflight = this._refillPoolNow().finally(() => {
      this._refillInflight = null;
    });
    return this._refillInflight;
  }

  async _refillPoolNow() {
    if (!this.enabled()) return { added: 0 };
    const provider = this.getProvider();
    let added = 0;
    while (this.pool.length < this.cfg.poolMin) {
      const live = this.pool.length + this.sessions.size;
      if (live >= this.cfg.poolMax) break;
      const handle = await provider.create({});
      await this.waitHealthy(handle, { timeoutMs: this.cfg.readyTimeoutMs });
      this.pool.push({
        handle,
        lastHealthAt: this.now(),
        createdAt: this.now(),
      });
      added += 1;
    }
    return { added, poolWarm: this.pool.length };
  }

  async waitHealthy(handle, { timeoutMs } = {}) {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.cfg.readyTimeoutMs;
    const deadline = this.now() + limit;
    let lastErr = null;
    const provider = this.getProvider();
    while (this.now() < deadline) {
      try {
        const health = await provider.health(handle);
        if (health && health.status === 'ok') return health;
        lastErr = new Error(`health status=${health && health.status}`);
      } catch (err) {
        lastErr = err;
      }
      const wait = Math.min(250, Math.max(20, deadline - this.now()));
      await new Promise((r) => setTimeout(r, wait));
    }
    throw new DesktopProviderError(
      DESKTOP_NOT_READY_ES + (lastErr ? ` (${lastErr.message})` : ''),
      { code: 'desktop_not_ready', status: 503 },
    );
  }

  async reap() {
    const cutoff = this.now() - this.ttlMs();
    const provider = this._provider || (this.enabled() ? this.getProvider() : null);
    const destroyed = [];

    for (const [id, rec] of [...this.sessions.entries()]) {
      const idle = rec.lastHeartbeat < cutoff;
      let unhealthy = false;
      if (provider && !idle) {
        try {
          const h = await provider.health(rec.handle);
          if (!h || h.status !== 'ok') unhealthy = true;
        } catch (_) {
          unhealthy = true;
        }
      }
      if (idle || unhealthy) {
        this.sessions.delete(id);
        rec.status = 'dead';
        if (provider) {
          try { await provider.destroy(rec.handle); } catch (_) { /* idempotent */ }
        }
        destroyed.push({ sessionId: id, reason: idle ? 'ttl' : 'unhealthy' });
      }
    }

    const kept = [];
    for (const item of this.pool) {
      const idle = (item.lastHealthAt || item.createdAt || 0) < cutoff;
      let unhealthy = false;
      if (provider && !idle) {
        try {
          const h = await provider.health(item.handle);
          if (!h || h.status !== 'ok') unhealthy = true;
        } catch (_) {
          unhealthy = true;
        }
      }
      if (idle || unhealthy) {
        if (provider) {
          try { await provider.destroy(item.handle); } catch (_) { /* idempotent */ }
        }
        destroyed.push({ sessionId: item.handle && item.handle.id, reason: idle ? 'ttl' : 'unhealthy' });
      } else {
        kept.push(item);
      }
    }
    this.pool = kept;
    if (this.enabled()) void this.refillPool().catch(() => undefined);
    return { destroyed: destroyed.length, poolWarm: this.pool.length };
  }

  async _takeWarmHealthy(provider) {
    while (this.pool.length > 0) {
      const item = this.pool.shift();
      try {
        const health = await provider.health(item.handle);
        if (health && health.status === 'ok') {
          item.lastHealthAt = this.now();
          return item.handle;
        }
      } catch (_) {
        // fall through to destroy
      }
      try { await provider.destroy(item.handle); } catch (_) { /* idempotent */ }
    }
    return null;
  }

  _toLease(rec) {
    return {
      sessionId: rec.sessionId,
      wsUrl: rec.wsUrl || '',
      viewerToken: rec.viewerToken || '',
      provider: rec.provider,
      expiresAt: rec.expiresAt,
      status: rec.status,
      inputMode: rec.inputMode || 'agent',
      chatId: rec.chatId,
      userId: rec.userId || null,
      fromPool: Boolean(rec.fromPool),
    };
  }
}

let singleton = null;

function getDesktopSessionManager(opts) {
  if (opts && opts.fresh) {
    if (singleton) singleton.stop();
    singleton = new DesktopSessionManager(opts);
    return singleton;
  }
  if (!singleton) {
    singleton = new DesktopSessionManager(opts || {});
  }
  return singleton;
}

function resetDesktopSessionManager() {
  if (singleton) singleton.stop();
  singleton = null;
}

module.exports = {
  DesktopSessionManager,
  getDesktopSessionManager,
  resetDesktopSessionManager,
  isDesktopEnabled,
  resolveProviderKind,
  resolvePoolConfig,
  SESSION_STATUSES,
  parseSwitch,
};
