'use strict';

/**
 * attribution-persistence.js
 *
 * Optional disk-backed persistence for the attribution stack's in-memory
 * state (cross-turn-entity-tracker, concept-drift-monitor, attribution-
 * metrics). Without this, every backend restart loses cross-turn entity
 * registries, drift trails, and recent telemetry — fine for stateless
 * tests but painful in production.
 *
 * Storage format: per-key JSON files inside a configurable directory
 * (defaults to a sibling of the existing cowork disk-persistence dir).
 * Writes are debounced and atomic (write-temp-then-rename). Read happens
 * lazily on first access via `hydrate()`.
 *
 * No external deps. Fail-safe by design: if the disk is unavailable or
 * the data is corrupt, we silently fall back to a clean in-memory state.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let activeDir = process.env.SIRAGPT_ATTRIBUTION_PERSIST_DIR
  || path.join(process.env.HOME || '/tmp', '.siragpt-attribution');
const DEBOUNCE_MS = Number.parseInt(process.env.SIRAGPT_ATTRIBUTION_PERSIST_DEBOUNCE_MS || '400', 10);
const MAX_FILE_BYTES = Number.parseInt(process.env.SIRAGPT_ATTRIBUTION_PERSIST_MAX_BYTES || `${4 * 1024 * 1024}`, 10);

const debounceTimers = new Map();
const cache = new Map();
let ensuredDir = false;

function ensureDir() {
  if (ensuredDir) return activeDir;
  try {
    fs.mkdirSync(activeDir, { recursive: true });
    ensuredDir = true;
  } catch (_e) {
    // swallow — caller will see a "no persistence" outcome on writes
  }
  return activeDir;
}

function safeKey(key) {
  return String(key || 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 96) || 'default';
}

function filePath(namespace, key) {
  const safeNs = safeKey(namespace);
  const safeK = safeKey(key);
  return path.join(activeDir, `${safeNs}__${safeK}.json`);
}

function load(namespace, key) {
  const cacheKey = `${namespace}::${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const fp = filePath(namespace, key);
  try {
    if (!fs.existsSync(fp)) {
      cache.set(cacheKey, null);
      return null;
    }
    const stat = fs.statSync(fp);
    if (stat.size > MAX_FILE_BYTES) {
      cache.set(cacheKey, null);
      return null;
    }
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    cache.set(cacheKey, parsed);
    return parsed;
  } catch (_e) {
    cache.set(cacheKey, null);
    return null;
  }
}

function scheduleSave(namespace, key, payload) {
  ensureDir();
  const cacheKey = `${namespace}::${key}`;
  cache.set(cacheKey, payload);
  const existing = debounceTimers.get(cacheKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(cacheKey);
    const fp = filePath(namespace, key);
    const tmp = `${fp}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) {
        // refuse to persist oversized blobs; keep cached state in memory
        return;
      }
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, fp);
    } catch (_e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  debounceTimers.set(cacheKey, timer);
}

function remove(namespace, key) {
  const cacheKey = `${namespace}::${key}`;
  cache.delete(cacheKey);
  const existing = debounceTimers.get(cacheKey);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(cacheKey);
  }
  try { fs.unlinkSync(filePath(namespace, key)); } catch (_e) { /* ignore */ }
}

function listKeys(namespace) {
  try {
    const dir = ensureDir();
    const prefix = `${safeKey(namespace)}__`;
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => f.slice(prefix.length, -'.json'.length));
  } catch (_e) {
    return [];
  }
}

function flushAll() {
  // Force all debounced writes to fire synchronously. Useful in tests.
  for (const [cacheKey, timer] of debounceTimers) {
    clearTimeout(timer);
    debounceTimers.delete(cacheKey);
    const [namespace, key] = cacheKey.split('::', 2);
    const payload = cache.get(cacheKey);
    if (payload == null) continue;
    const fp = filePath(namespace, key);
    const tmp = `${fp}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, fp);
    } catch (_e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }
}

function _reset() {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  cache.clear();
  ensuredDir = false;
}

function _setDirForTests(dir) {
  // Test helper: redirect persistence to a temp dir.
  activeDir = dir;
  ensuredDir = false;
}

function getDir() { return activeDir; }

module.exports = {
  load,
  scheduleSave,
  remove,
  listKeys,
  flushAll,
  _reset,
  _setDirForTests,
  getDir,
};
