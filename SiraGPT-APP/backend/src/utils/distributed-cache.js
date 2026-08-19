/**
 * distributed-cache.js
 *
 * Distributed caching layer for SiraGPT using Redis with local fallback.
 * Supports: cache-aside, write-through, TTL, invalidation patterns.
 */

class DistributedCache {
  constructor(redisClient = null, opts = {}) {
    this.redis = redisClient;
    this.localCache = new Map();
    this.opts = {
      defaultTtlMs: opts.defaultTtlMs || 3600000, // 1 hour
      localOnlyFallback: opts.localOnlyFallback !== false,
      maxLocalItems: opts.maxLocalItems || 1000,
      ...opts,
    };
  }

  /**
   * Get value from cache (Redis first, then local)
   */
  async get(key) {
    // Try Redis first
    if (this.redis) {
      try {
        const value = await this.redis.get(key);
        if (value) return JSON.parse(value);
      } catch (e) {
        console.error(`[cache] Redis get failed for ${key}:`, e.message);
      }
    }

    // Fallback to local cache
    const local = this.localCache.get(key);
    if (local && (!local.expiresAt || local.expiresAt > Date.now())) {
      return local.value;
    }

    return null;
  }

  /**
   * Set value in cache (Redis and/or local)
   */
  async set(key, value, ttlMs = null) {
    ttlMs = ttlMs || this.opts.defaultTtlMs;
    const serialized = JSON.stringify(value);

    // Set in Redis
    if (this.redis) {
      try {
        await this.redis.setex(key, Math.ceil(ttlMs / 1000), serialized);
      } catch (e) {
        console.error(`[cache] Redis set failed for ${key}:`, e.message);
      }
    }

    // Also set in local cache
    if (this.opts.localOnlyFallback) {
      if (this.localCache.size >= this.opts.maxLocalItems) {
        // Evict oldest
        const first = this.localCache.keys().next().value;
        this.localCache.delete(first);
      }

      this.localCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key) {
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch (e) {
        console.error(`[cache] Redis delete failed for ${key}:`, e.message);
      }
    }

    this.localCache.delete(key);
  }

  /**
   * Invalidate pattern (key prefix or regex)
   */
  async invalidate(pattern) {
    if (this.redis) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (e) {
        console.error(`[cache] Redis pattern delete failed:`, e.message);
      }
    }

    // Local invalidation
    for (const key of this.localCache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.localCache.delete(key);
      }
    }
  }

  /**
   * Cache-aside pattern: get or compute
   */
  async getOrCompute(key, computeFn, ttlMs = null) {
    const cached = await this.get(key);
    if (cached) return cached;

    const value = await computeFn();
    await this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Write-through pattern: update and cache
   */
  async writeThrough(key, updateFn, ttlMs = null) {
    const result = await updateFn();
    await this.set(key, result, ttlMs);
    return result;
  }

  /**
   * Get multiple keys
   */
  async mget(keys) {
    const results = {};

    for (const key of keys) {
      results[key] = await this.get(key);
    }

    return results;
  }

  /**
   * Set multiple keys
   */
  async mset(keyValues, ttlMs = null) {
    const promises = [];

    for (const [key, value] of Object.entries(keyValues)) {
      promises.push(this.set(key, value, ttlMs));
    }

    await Promise.all(promises);
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      localCacheSize: this.localCache.size,
      localCacheMaxSize: this.opts.maxLocalItems,
      redisConnected: !!this.redis,
      defaultTtlMs: this.opts.defaultTtlMs,
    };
  }

  /**
   * Pattern matching
   */
  matchPattern(key, pattern) {
    // Support * wildcard
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    return regex.test(key);
  }

  /**
   * Clear all caches
   */
  async clear() {
    this.localCache.clear();

    if (this.redis) {
      try {
        await this.redis.flushdb();
      } catch (e) {
        console.error('[cache] Redis flush failed:', e.message);
      }
    }
  }
}

module.exports = DistributedCache;
