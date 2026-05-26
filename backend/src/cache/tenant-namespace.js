'use strict';

/**
 * cache/tenant-namespace — wraps any KV-shaped cache with a stable
 * per-tenant key prefix so a multi-tenant install cannot leak entries
 * across orgs through coincidental key collisions. Goes beyond
 * openclaw v2026.5.7 (which keeps caches global) and matches the
 * isolation posture an enterprise deployment expects.
 *
 * Usage:
 *   const ns = createTenantNamespacedCache(rawCache, {
 *     tenantId,
 *     normalize,        // optional (id) => string normalizer
 *     separator,        // default ':'
 *     prefixVersion,    // default 'v1'
 *   })
 *   await ns.get(key); ns.set(key, value); ns.del(key); ns.has(key);
 *   ns.tenantId; ns.prefix();
 *
 * Wrap once per tenant. The wrapper does not own the underlying cache
 * lifecycle — `clear()` only clears the *tenant's* keys when the
 * underlying cache exposes `keys()` or `entries()`; otherwise it
 * surfaces a typed error so callers cannot accidentally wipe a peer's
 * data.
 */

const DEFAULT_SEPARATOR = ':';
const DEFAULT_PREFIX_VERSION = 'v1';

function defaultNormalize(id) {
  if (id == null) throw new TypeError('tenant-namespace: tenantId required');
  const s = String(id).trim();
  if (!s) throw new TypeError('tenant-namespace: tenantId must be non-empty');
  // Keep keys filesystem/redis-safe: collapse anything outside [a-z0-9-_].
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function createTenantNamespacedCache(cache, opts = {}) {
  if (!cache || typeof cache.get !== 'function') {
    throw new TypeError('tenant-namespace: cache with .get() required');
  }
  const normalize = typeof opts.normalize === 'function' ? opts.normalize : defaultNormalize;
  const separator = typeof opts.separator === 'string' && opts.separator ? opts.separator : DEFAULT_SEPARATOR;
  const version = typeof opts.prefixVersion === 'string' && opts.prefixVersion
    ? opts.prefixVersion
    : DEFAULT_PREFIX_VERSION;
  const tenantId = normalize(opts.tenantId);
  if (!tenantId) throw new TypeError('tenant-namespace: tenantId normalized to empty');

  const prefix = `${version}${separator}t${separator}${tenantId}${separator}`;

  function wrap(key) {
    if (typeof key !== 'string' || key === '') {
      throw new TypeError('tenant-namespace: key must be a non-empty string');
    }
    return prefix + key;
  }

  function unwrap(key) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
    return key.slice(prefix.length);
  }

  const wrapped = {
    tenantId,
    prefix: () => prefix,
    get: (k, ...rest) => cache.get(wrap(k), ...rest),
    has: typeof cache.has === 'function' ? (k) => cache.has(wrap(k)) : undefined,
    set: typeof cache.set === 'function' ? (k, v, ...rest) => cache.set(wrap(k), v, ...rest) : undefined,
    del: typeof cache.del === 'function'
      ? (k) => cache.del(wrap(k))
      : (typeof cache.delete === 'function' ? (k) => cache.delete(wrap(k)) : undefined),
    raw: cache,
  };

  // Tenant-scoped clear: enumerate-and-delete so we never wipe peers.
  wrapped.clearTenant = function clearTenant() {
    let keys;
    if (typeof cache.keys === 'function') {
      keys = cache.keys();
    } else if (typeof cache.entries === 'function') {
      keys = [...cache.entries()].map(([k]) => k);
    } else {
      const err = new Error('tenant-namespace: underlying cache does not expose keys()/entries()');
      err.code = 'E_NO_ENUMERATION';
      throw err;
    }
    let deleted = 0;
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      if (wrapped.del) {
        const inner = unwrap(key);
        if (inner != null) {
          wrapped.del(inner);
          deleted += 1;
        }
      }
    }
    return deleted;
  };

  return wrapped;
}

module.exports = {
  createTenantNamespacedCache,
  defaultNormalize,
  DEFAULT_SEPARATOR,
  DEFAULT_PREFIX_VERSION,
};
