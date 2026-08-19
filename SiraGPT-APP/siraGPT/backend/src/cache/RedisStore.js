'use strict';

/**
 * RedisStore — L2 cache backed by Redis (ioredis-compatible).
 *
 * The constructor accepts an injected client so tests can pass a fake; in
 * production, callers either pass an existing ioredis instance or call the
 * `createRedisStore(env)` factory which lazily requires ioredis.
 *
 * Failure policy: every Redis call is best-effort. Errors are swallowed and
 * surfaced as `null` from get / no-op from set. The cache must never bring
 * down the request path — a Redis blip becomes a cache miss, nothing more.
 */

const DEFAULT_PREFIX = 'sira:cache:';
const DEFAULT_TTL_SECONDS = 5 * 60;

class RedisStore {
  constructor({
    redis,
    prefix = DEFAULT_PREFIX,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    onError = null,
  } = {}) {
    if (!redis || typeof redis.get !== 'function' || typeof redis.set !== 'function') {
      throw new TypeError('RedisStore: redis client with get/set is required');
    }
    this._redis = redis;
    this._prefix = String(prefix);
    this._ttl = ttlSeconds;
    this._onError = typeof onError === 'function' ? onError : null;
  }

  _k(key) {
    return `${this._prefix}${key}`;
  }

  _emitErr(op, err) {
    if (this._onError) {
      try { this._onError(op, err); } catch (_e) { /* swallow */ }
    }
  }

  async get(key) {
    try {
      const raw = await this._redis.get(this._k(key));
      if (raw == null) return undefined;
      return JSON.parse(raw);
    } catch (err) {
      this._emitErr('get', err);
      return undefined;
    }
  }

  async set(key, value, ttlMs) {
    let ttl = this._ttl;
    if (Number.isFinite(ttlMs) && ttlMs > 0) {
      ttl = Math.max(1, Math.round(ttlMs / 1000));
    }
    const payload = JSON.stringify(value);
    try {
      await this._redis.set(this._k(key), payload, 'EX', ttl);
      return true;
    } catch (err) {
      this._emitErr('set', err);
      return false;
    }
  }

  async delete(key) {
    try {
      const n = await this._redis.del(this._k(key));
      return Number(n) > 0;
    } catch (err) {
      this._emitErr('del', err);
      return false;
    }
  }
}

/**
 * Lazily build a RedisStore from env. Returns null when REDIS_URL is unset
 * or ioredis can't be loaded — callers fall back to L1-only.
 */
function createRedisStore(env = process.env, options = {}) {
  if (options.redis) {
    return new RedisStore({
      redis: options.redis,
      prefix: options.prefix,
      ttlSeconds: options.ttlSeconds,
      onError: options.onError,
    });
  }
  if (!env.REDIS_URL) return null;
  let IORedis;
  try {
    IORedis = require('ioredis');
  } catch (_err) {
    return null;
  }
  const client = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 2000,
  });
  client.on('error', () => { /* surfaced via onError on calls */ });
  return new RedisStore({
    redis: client,
    prefix: options.prefix,
    ttlSeconds: options.ttlSeconds,
    onError: options.onError,
  });
}

module.exports = { RedisStore, createRedisStore, DEFAULT_PREFIX, DEFAULT_TTL_SECONDS };
