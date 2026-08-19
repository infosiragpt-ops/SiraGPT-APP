'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — Feature flag service
// ──────────────────────────────────────────────────────────────
// Runtime-evaluated feature flags with:
//   - boolean / percentage-rollout / allowlist / variant strategies
//   - per-user overrides (transient or persisted via setUserOverride)
//   - environment variable seeding (FLAG_<KEY>=value)
//   - change listeners (for cache invalidation)
//   - HTTP exposure via /internal/flags router
// ──────────────────────────────────────────────────────────────

const crypto = require('node:crypto');
const express = require('express');

class FlagError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FlagError';
    this.code = code || 'FLAG_ERROR';
  }
}

const VALID_STRATEGIES = new Set(['boolean', 'percentage', 'allowlist', 'variant']);

function hashUserKey(flagKey, userId) {
  // Stable bucket in [0, 100). Uses sha1 for speed and determinism.
  const h = crypto.createHash('sha1').update(`${flagKey}:${userId}`).digest();
  // First 4 bytes → unsigned int → % 10000 → divide by 100 for two-decimal precision.
  const n = h.readUInt32BE(0) % 10000;
  return n / 100;
}

function normalizeFlagDefinition(key, def) {
  if (!key || typeof key !== 'string') {
    throw new FlagError('flag key must be a non-empty string', 'FLAG_INVALID_KEY');
  }
  if (!def || typeof def !== 'object') {
    throw new FlagError(`flag "${key}" definition must be an object`, 'FLAG_INVALID_DEFINITION');
  }
  const strategy = def.strategy || 'boolean';
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new FlagError(`flag "${key}" has unknown strategy "${strategy}"`, 'FLAG_INVALID_STRATEGY');
  }
  const normalized = {
    key,
    strategy,
    description: typeof def.description === 'string' ? def.description : '',
    enabled: def.enabled !== false,
    default: def.default !== undefined ? def.default : (strategy === 'boolean' ? false : null),
    percentage: typeof def.percentage === 'number' ? Math.max(0, Math.min(100, def.percentage)) : 0,
    allowlist: Array.isArray(def.allowlist) ? def.allowlist.map(String) : [],
    denylist: Array.isArray(def.denylist) ? def.denylist.map(String) : [],
    variants: def.variants && typeof def.variants === 'object' ? { ...def.variants } : null,
    tags: Array.isArray(def.tags) ? def.tags.map(String) : [],
    updatedAt: Date.now(),
  };
  if (strategy === 'variant' && (!normalized.variants || Object.keys(normalized.variants).length === 0)) {
    throw new FlagError(`flag "${key}" with strategy=variant requires non-empty variants map`, 'FLAG_INVALID_VARIANTS');
  }
  return normalized;
}

function parseEnvValue(raw) {
  if (raw == null) return undefined;
  const lower = String(raw).trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'off') return false;
  const n = Number(raw);
  if (!Number.isNaN(n) && String(raw).trim() !== '') return n;
  return String(raw);
}

class FlagService {
  constructor(opts = {}) {
    this._flags = new Map();
    this._userOverrides = new Map(); // userId → Map<flagKey, value>
    this._globalOverrides = new Map(); // flagKey → value (kill-switch / forced-on)
    this._listeners = new Set();
    this._env = opts.env || process.env;
    this._envPrefix = opts.envPrefix || 'FLAG_';
    this._now = opts.now || (() => Date.now());

    if (Array.isArray(opts.flags)) {
      for (const def of opts.flags) {
        if (def && def.key) this.register(def.key, def);
      }
    } else if (opts.flags && typeof opts.flags === 'object') {
      for (const [key, def] of Object.entries(opts.flags)) {
        this.register(key, def);
      }
    }
  }

  register(key, definition) {
    const normalized = normalizeFlagDefinition(key, definition);
    normalized.updatedAt = this._now();
    this._flags.set(key, normalized);
    this._notify({ type: 'register', key, flag: normalized });
    return normalized;
  }

  unregister(key) {
    const existed = this._flags.delete(key);
    this._globalOverrides.delete(key);
    for (const map of this._userOverrides.values()) map.delete(key);
    if (existed) this._notify({ type: 'unregister', key });
    return existed;
  }

  has(key) { return this._flags.has(key); }

  get(key) {
    const f = this._flags.get(key);
    return f ? { ...f } : null;
  }

  list() {
    return Array.from(this._flags.values()).map((f) => ({ ...f }));
  }

  update(key, patch) {
    const existing = this._flags.get(key);
    if (!existing) throw new FlagError(`flag "${key}" not registered`, 'FLAG_UNKNOWN');
    const merged = normalizeFlagDefinition(key, { ...existing, ...patch });
    merged.updatedAt = this._now();
    this._flags.set(key, merged);
    this._notify({ type: 'update', key, flag: merged });
    return merged;
  }

  setGlobalOverride(key, value) {
    this._globalOverrides.set(key, value);
    this._notify({ type: 'global_override', key, value });
  }

  clearGlobalOverride(key) {
    const existed = this._globalOverrides.delete(key);
    if (existed) this._notify({ type: 'clear_global_override', key });
    return existed;
  }

  setUserOverride(userId, key, value) {
    if (!userId) throw new FlagError('userId required', 'FLAG_INVALID_USER');
    if (!this._flags.has(key)) throw new FlagError(`flag "${key}" not registered`, 'FLAG_UNKNOWN');
    let map = this._userOverrides.get(String(userId));
    if (!map) {
      map = new Map();
      this._userOverrides.set(String(userId), map);
    }
    map.set(key, value);
    this._notify({ type: 'user_override', key, userId: String(userId), value });
  }

  clearUserOverride(userId, key) {
    const map = this._userOverrides.get(String(userId));
    if (!map) return false;
    const ok = map.delete(key);
    if (map.size === 0) this._userOverrides.delete(String(userId));
    if (ok) this._notify({ type: 'clear_user_override', key, userId: String(userId) });
    return ok;
  }

  clearAllUserOverrides(userId) {
    return this._userOverrides.delete(String(userId));
  }

  getUserOverrides(userId) {
    const map = this._userOverrides.get(String(userId));
    if (!map) return {};
    return Object.fromEntries(map);
  }

  on(eventListener) {
    if (typeof eventListener !== 'function') return () => {};
    this._listeners.add(eventListener);
    return () => this._listeners.delete(eventListener);
  }

  _notify(evt) {
    for (const fn of this._listeners) {
      try { fn(evt); } catch { /* ignore listener errors */ }
    }
  }

  _envOverrideFor(key) {
    const envName = `${this._envPrefix}${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    if (Object.prototype.hasOwnProperty.call(this._env, envName)) {
      return parseEnvValue(this._env[envName]);
    }
    return undefined;
  }

  evaluate(key, context = {}) {
    const flag = this._flags.get(key);
    if (!flag) {
      return {
        key,
        value: context.fallback !== undefined ? context.fallback : false,
        reason: 'unknown',
      };
    }
    if (!flag.enabled) {
      return { key, value: flag.default, reason: 'disabled' };
    }

    // Highest priority: user-specific override.
    const userId = context.userId != null ? String(context.userId) : null;
    if (userId) {
      const userMap = this._userOverrides.get(userId);
      if (userMap && userMap.has(key)) {
        return { key, value: userMap.get(key), reason: 'user_override', userId };
      }
    }

    // Then: global runtime override (kill-switch).
    if (this._globalOverrides.has(key)) {
      return { key, value: this._globalOverrides.get(key), reason: 'global_override' };
    }

    // Then: environment variable.
    const envVal = this._envOverrideFor(key);
    if (envVal !== undefined) {
      return { key, value: envVal, reason: 'env' };
    }

    // Denylist short-circuits.
    if (userId && flag.denylist.includes(userId)) {
      return { key, value: flag.default, reason: 'denylist' };
    }

    switch (flag.strategy) {
      case 'boolean':
        return { key, value: flag.default !== false ? !!flag.default : false, reason: 'default' };

      case 'allowlist': {
        if (userId && flag.allowlist.includes(userId)) {
          return { key, value: true, reason: 'allowlist' };
        }
        return { key, value: false, reason: 'not_allowlisted' };
      }

      case 'percentage': {
        if (userId && flag.allowlist.includes(userId)) {
          return { key, value: true, reason: 'allowlist' };
        }
        if (!userId) {
          return { key, value: false, reason: 'no_user' };
        }
        const bucket = hashUserKey(key, userId);
        const inRollout = bucket < flag.percentage;
        return {
          key,
          value: inRollout,
          reason: inRollout ? 'percentage_in' : 'percentage_out',
          bucket,
          percentage: flag.percentage,
        };
      }

      case 'variant': {
        if (!userId) {
          return { key, value: flag.default, reason: 'no_user' };
        }
        const variants = flag.variants || {};
        const total = Object.values(variants).reduce((s, w) => s + (Number(w) > 0 ? Number(w) : 0), 0);
        if (total <= 0) {
          return { key, value: flag.default, reason: 'no_weights' };
        }
        const bucket = hashUserKey(key, userId);
        const scaled = (bucket / 100) * total;
        let cumulative = 0;
        for (const [name, weight] of Object.entries(variants)) {
          const w = Number(weight) > 0 ? Number(weight) : 0;
          cumulative += w;
          if (scaled < cumulative) {
            return { key, value: name, reason: 'variant', bucket };
          }
        }
        const last = Object.keys(variants).pop();
        return { key, value: last, reason: 'variant', bucket };
      }

      default:
        return { key, value: flag.default, reason: 'default' };
    }
  }

  isEnabled(key, context = {}) {
    return !!this.evaluate(key, context).value;
  }

  variant(key, context = {}) {
    return this.evaluate(key, context).value;
  }

  snapshot(context = {}) {
    const out = {};
    for (const key of this._flags.keys()) {
      out[key] = this.evaluate(key, context);
    }
    return out;
  }
}

// ──────────────────────────────────────────────────────────────
// HTTP router
// ──────────────────────────────────────────────────────────────

function isLoopback(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authorize(req, res, next) {
  const token = process.env.FLAGS_INTERNAL_TOKEN || process.env.DB_INTERNAL_TOKEN;
  if (token) {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== token) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  }
  if (!isLoopback(req)) return res.status(403).json({ error: 'forbidden' });
  return next();
}

function createFlagsRouter(service, opts = {}) {
  if (!(service instanceof FlagService)) {
    throw new FlagError('createFlagsRouter requires a FlagService instance', 'FLAG_INVALID_SERVICE');
  }
  const router = express.Router();
  const json = express.json({ limit: opts.bodyLimit || '32kb' });
  const auth = opts.authorize || authorize;

  router.get('/', auth, (req, res) => {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
    const flags = service.list().map((flag) => {
      const evaluation = service.evaluate(flag.key, { userId });
      return { ...flag, evaluation };
    });
    res.json({ count: flags.length, userId, flags });
  });

  router.get('/:key', auth, (req, res) => {
    const { key } = req.params;
    if (!service.has(key)) return res.status(404).json({ error: 'unknown_flag', key });
    const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
    const flag = service.get(key);
    const evaluation = service.evaluate(key, { userId });
    res.json({ ...flag, evaluation });
  });

  router.post('/:key/evaluate', auth, json, (req, res) => {
    const { key } = req.params;
    if (!service.has(key)) return res.status(404).json({ error: 'unknown_flag', key });
    const context = (req.body && typeof req.body === 'object') ? req.body : {};
    res.json(service.evaluate(key, context));
  });

  router.put('/:key', auth, json, (req, res) => {
    const { key } = req.params;
    try {
      const result = service.has(key)
        ? service.update(key, req.body || {})
        : service.register(key, req.body || {});
      res.json(result);
    } catch (err) {
      if (err instanceof FlagError) return res.status(400).json({ error: err.code, message: err.message });
      res.status(500).json({ error: 'flag_update_failed', message: String(err && err.message || err) });
    }
  });

  router.delete('/:key', auth, (req, res) => {
    const { key } = req.params;
    const ok = service.unregister(key);
    if (!ok) return res.status(404).json({ error: 'unknown_flag', key });
    res.json({ ok: true, key });
  });

  router.post('/:key/override', auth, json, (req, res) => {
    const { key } = req.params;
    if (!service.has(key)) return res.status(404).json({ error: 'unknown_flag', key });
    const { userId, value, scope } = req.body || {};
    try {
      if (scope === 'global') {
        service.setGlobalOverride(key, value);
        return res.json({ ok: true, scope: 'global', key, value });
      }
      if (!userId) return res.status(400).json({ error: 'userId_required' });
      service.setUserOverride(userId, key, value);
      res.json({ ok: true, scope: 'user', userId: String(userId), key, value });
    } catch (err) {
      if (err instanceof FlagError) return res.status(400).json({ error: err.code, message: err.message });
      res.status(500).json({ error: 'override_failed', message: String(err && err.message || err) });
    }
  });

  router.delete('/:key/override', auth, (req, res) => {
    const { key } = req.params;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
    const scope = typeof req.query.scope === 'string' ? req.query.scope : null;
    if (scope === 'global') {
      const ok = service.clearGlobalOverride(key);
      return res.json({ ok, scope: 'global', key });
    }
    if (!userId) return res.status(400).json({ error: 'userId_required' });
    const ok = service.clearUserOverride(userId, key);
    res.json({ ok, scope: 'user', userId, key });
  });

  return router;
}

// Lazy default singleton — convenience for places that only need one shared registry.
let _defaultService = null;
function getDefaultService() {
  if (!_defaultService) _defaultService = new FlagService();
  return _defaultService;
}
function resetDefaultService() { _defaultService = null; }

module.exports = {
  FlagService,
  FlagError,
  createFlagsRouter,
  getDefaultService,
  resetDefaultService,
  hashUserKey,
};
