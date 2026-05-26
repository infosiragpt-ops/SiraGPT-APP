'use strict';

/**
 * credential-resolver — chained credential resolution with TTL cache
 * and hot-rotation. Plugs into the tool-authorization gate (#4) as
 * the `resolveCredential` implementation: the gate asks for a name,
 * the resolver walks the source chain (env → file → custom fetcher),
 * caches the answer for `ttlMs`, and surfaces null when nothing
 * resolves so the gate denies with `missing_credentials`.
 *
 * Hot-rotation: callers (operator endpoint, file-watcher, vault
 * webhook) call `rotate(name)` to evict a single key, or `rotateAll()`
 * to drop the whole cache. The next resolve() rebuilds from the
 * source chain so a freshly-rotated key takes effect immediately.
 *
 * Public API:
 *   const r = createCredentialResolver({
 *     sources,         // ordered array of (name) => string|null|Promise
 *     ttlMs,           // default 5 * 60_000
 *     now,             // clock injector
 *     onResolve,       // ({ name, source, hit }) sink
 *     onMiss,          // ({ name }) sink
 *   })
 *   await r.resolve(name)        → string | null
 *   r.resolveSync(name)          → string | null  (sync variant; only walks sync sources)
 *   r.rotate(name)               → boolean (true if there was a cached value)
 *   r.rotateAll()                → integer (number of evicted keys)
 *   r.snapshot()                 → { entries, hits, misses, sources }
 *
 * Built-in source helpers (exported for composition):
 *   envSource(envObject)         → name => env[name] || null
 *   mapSource(map)               → name => map[name] || null
 *   functionSource(fn, label)    → wraps an arbitrary fetcher with a label
 */

const DEFAULT_TTL_MS = 5 * 60_000;

function envSource(env = process.env) {
  const fn = (name) => {
    if (typeof name !== 'string' || !name) return null;
    const v = env[name];
    return v == null || v === '' ? null : String(v);
  };
  fn._sourceLabel = 'env';
  return fn;
}

function mapSource(map = {}) {
  const fn = (name) => {
    if (typeof name !== 'string' || !name) return null;
    const v = map[name];
    return v == null || v === '' ? null : String(v);
  };
  fn._sourceLabel = 'map';
  return fn;
}

function functionSource(fn, label = 'custom') {
  if (typeof fn !== 'function') throw new TypeError('functionSource: fn required');
  const wrapped = (name) => fn(name);
  wrapped._sourceLabel = label;
  return wrapped;
}

function createCredentialResolver(opts = {}) {
  const sources = Array.isArray(opts.sources)
    ? opts.sources.filter((s) => typeof s === 'function')
    : [];
  if (sources.length === 0) throw new TypeError('credential-resolver: at least one source required');
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : DEFAULT_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const onResolve = typeof opts.onResolve === 'function' ? opts.onResolve : null;
  const onMiss = typeof opts.onMiss === 'function' ? opts.onMiss : null;

  /** @type {Map<string, {value:string, expiresAt:number, source:string}>} */
  const cache = new Map();
  let hits = 0;
  let misses = 0;

  function fresh(entry, t) {
    return entry && entry.expiresAt > t;
  }

  function fireResolve(name, source, hit) {
    if (!onResolve) return;
    try { onResolve({ name, source, hit }); } catch { /* swallow */ }
  }

  function fireMiss(name) {
    if (!onMiss) return;
    try { onMiss({ name }); } catch { /* swallow */ }
  }

  async function resolve(name) {
    if (typeof name !== 'string' || !name) return null;
    const t = now();
    const entry = cache.get(name);
    if (fresh(entry, t)) {
      hits += 1;
      fireResolve(name, entry.source, true);
      return entry.value;
    }
    if (entry) cache.delete(name); // expired

    for (const src of sources) {
      let value;
      try { value = await src(name); }
      catch { value = null; }
      if (value != null && value !== '') {
        const v = String(value);
        cache.set(name, { value: v, expiresAt: t + ttlMs, source: src._sourceLabel || 'unknown' });
        misses += 1;
        fireResolve(name, src._sourceLabel || 'unknown', false);
        return v;
      }
    }
    misses += 1;
    fireMiss(name);
    return null;
  }

  function resolveSync(name) {
    if (typeof name !== 'string' || !name) return null;
    const t = now();
    const entry = cache.get(name);
    if (fresh(entry, t)) {
      hits += 1;
      fireResolve(name, entry.source, true);
      return entry.value;
    }
    if (entry) cache.delete(name);

    for (const src of sources) {
      let value;
      try { value = src(name); } catch { value = null; }
      // Skip sources that returned a promise — they are async-only.
      if (value && typeof value.then === 'function') continue;
      if (value != null && value !== '') {
        const v = String(value);
        cache.set(name, { value: v, expiresAt: t + ttlMs, source: src._sourceLabel || 'unknown' });
        misses += 1;
        fireResolve(name, src._sourceLabel || 'unknown', false);
        return v;
      }
    }
    misses += 1;
    fireMiss(name);
    return null;
  }

  function rotate(name) {
    if (typeof name !== 'string' || !name) return false;
    return cache.delete(name);
  }

  function rotateAll() {
    const n = cache.size;
    cache.clear();
    return n;
  }

  function snapshot() {
    return {
      entries: cache.size,
      hits,
      misses,
      sources: sources.map((s) => s._sourceLabel || 'unknown'),
      ttlMs,
    };
  }

  return { resolve, resolveSync, rotate, rotateAll, snapshot };
}

module.exports = {
  createCredentialResolver,
  envSource,
  mapSource,
  functionSource,
  DEFAULT_TTL_MS,
};
