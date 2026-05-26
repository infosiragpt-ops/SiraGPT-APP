'use strict';

/**
 * Presence tracker.
 *
 * Tracks `{userId, lastSeenAt}` with a 60 s TTL that is refreshed on every
 * heartbeat.  Uses ioredis if `REDIS_URL` is set (and the optional `redis`
 * client is injectable for tests), otherwise falls back to an in-process
 * `Map`.  Emits `online`/`offline` events for friend/team views.
 */

const { EventEmitter } = require('events');

const DEFAULT_TTL_MS = 60_000;

class PresenceTracker extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.redis] — ioredis-compatible client (optional)
   * @param {number} [opts.ttlMs=60000]
   * @param {() => number} [opts.now]
   * @param {string} [opts.prefix='presence:']
   */
  constructor(opts = {}) {
    super();
    this.redis = opts.redis || null;
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.prefix = opts.prefix || 'presence:';
    /** @type {Map<string, number>} */
    this._mem = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this._timers = new Map();
  }

  _key(userId) {
    return `${this.prefix}${userId}`;
  }

  /**
   * Mark `userId` online and (re)start the 60 s TTL.
   * Emits `online` the first time the user appears.
   */
  async heartbeat(userId) {
    if (!userId) throw new TypeError('presence.heartbeat: userId required');
    const wasOnline = await this.isOnline(userId);
    const ts = this.now();

    if (this.redis) {
      try {
        await this.redis.set(this._key(userId), String(ts), 'PX', this.ttlMs);
      } catch {
        // fall through to in-memory mirror
      }
    }
    this._mem.set(String(userId), ts);

    // Reset expiry timer for the in-memory fallback.
    const prevTimer = this._timers.get(String(userId));
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => this._expire(userId), this.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.set(String(userId), timer);

    if (!wasOnline) {
      this.emit('online', { userId, at: ts });
    }
  }

  async _expire(userId) {
    const key = String(userId);
    this._mem.delete(key);
    this._timers.delete(key);
    if (this.redis) {
      try { await this.redis.del(this._key(userId)); } catch { /* noop */ }
    }
    this.emit('offline', { userId, at: this.now() });
  }

  /**
   * Mark a user explicitly offline (e.g. socket disconnect).
   */
  async goOffline(userId) {
    const key = String(userId);
    const had = this._mem.has(key);
    const timer = this._timers.get(key);
    if (timer) clearTimeout(timer);
    this._timers.delete(key);
    this._mem.delete(key);
    if (this.redis) {
      try { await this.redis.del(this._key(userId)); } catch { /* noop */ }
    }
    if (had) this.emit('offline', { userId, at: this.now() });
  }

  /**
   * @returns {Promise<boolean>}
   */
  async isOnline(userId) {
    if (!userId) return false;
    if (this.redis) {
      try {
        const v = await this.redis.get(this._key(userId));
        if (v) return true;
      } catch { /* fall through */ }
    }
    return this._mem.has(String(userId));
  }

  /**
   * @returns {Promise<Array<{userId:string,lastSeenAt:number}>>}
   */
  async getOnlineUsers() {
    // In-memory snapshot is always authoritative for our process; if redis
    // is configured we union it with the locally observed keys so that
    // multi-instance deployments still expose other workers' users.
    /** @type {Map<string, number>} */
    const out = new Map();
    for (const [uid, ts] of this._mem.entries()) out.set(uid, ts);
    if (this.redis) {
      try {
        const pattern = `${this.prefix}*`;
        const keys = await this.redis.keys(pattern);
        for (const k of keys) {
          const uid = k.slice(this.prefix.length);
          if (out.has(uid)) continue;
          try {
            const v = await this.redis.get(k);
            if (v) out.set(uid, Number(v) || this.now());
          } catch { /* noop */ }
        }
      } catch { /* noop */ }
    }
    return Array.from(out.entries()).map(([userId, lastSeenAt]) => ({ userId, lastSeenAt }));
  }

  /** Drop all timers; useful in tests. */
  dispose() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this._mem.clear();
    this.removeAllListeners();
  }
}

let _singleton = null;
function getPresenceTracker(opts) {
  if (!_singleton) _singleton = new PresenceTracker(opts);
  return _singleton;
}

function _resetForTests() {
  if (_singleton) _singleton.dispose();
  _singleton = null;
}

module.exports = {
  PresenceTracker,
  getPresenceTracker,
  _resetForTests,
};
