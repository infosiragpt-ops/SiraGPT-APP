'use strict';

/**
 * Batch Context Store — persistent cross-document context for batch uploads.
 *
 * Problem: `global.__siraBatchContext` is a plain Map, lost on process restart,
 * capped at 20 entries, and shared across all users.
 *
 * Solution: File-based persistent store with per-user namespacing, TTL-based
 * expiration, and LRU eviction. Falls back to in-memory Map if filesystem is
 * unwritable.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('../utils/atomic-json-write');

const STORE_DIR = path.join(
  process.env.SIRAGPT_DATA_DIR || path.join(require('os').tmpdir(), 'siragpt-data'),
  'batch-context'
);

const MAX_ENTRIES = Number.parseInt(process.env.SIRAGPT_BATCH_CONTEXT_MAX || '50', 10);
const TTL_MS = Number.parseInt(process.env.SIRAGPT_BATCH_CONTEXT_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10);
const CLEANUP_INTERVAL_MS = Number.parseInt(process.env.SIRAGPT_BATCH_CLEANUP_MS || '600000', 10); // 10 min

let storeReady = false;
let memoryFallback = null;
let cleanupTimer = null;

function memoryFallbackStore() {
  if (!memoryFallback) {
    memoryFallback = new Map();
    console.warn('[batch-context] Using in-memory fallback (filesystem store unavailable)');
  }
  return memoryFallback;
}

async function ensureStoreDir() {
  if (storeReady) return;
  try {
    await fs.promises.mkdir(STORE_DIR, { recursive: true });
    // Test write
    const testPath = path.join(STORE_DIR, '.write-test');
    await fs.promises.writeFile(testPath, 'ok');
    await fs.promises.unlink(testPath);
    storeReady = true;
  } catch (err) {
    storeReady = false;
    console.warn(`[batch-context] Filesystem store unavailable (${err.message}), using in-memory fallback`);
  }
}

function entryKey(userId, batchId) {
  return `${userId || 'anon'}::${batchId}`;
}

function entryPath(userId, batchId) {
  const key = entryKey(userId, batchId);
  const hash = crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
  return path.join(STORE_DIR, `${hash}.json`);
}

async function storeEntry(userId, batchId, data) {
  await ensureStoreDir();

  if (!storeReady) {
    const mem = memoryFallbackStore();
    const entry = { userId, batchId, data, createdAt: Date.now(), updatedAt: Date.now() };
    mem.set(entryKey(userId, batchId), entry);
    // Evict oldest if over capacity
    if (mem.size > MAX_ENTRIES) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of mem) {
        if (v.createdAt < oldestTime) { oldestTime = v.createdAt; oldestKey = k; }
      }
      if (oldestKey) mem.delete(oldestKey);
    }
    return;
  }

  const entry = {
    userId,
    batchId,
    data,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const filePath = entryPath(userId, batchId);
  // Atomic temp+rename write: a crash or concurrent write must never leave a
  // partial JSON file that getEntry() would then silently parse to null and
  // drop cross-document batch context.
  await writeJsonAtomic(filePath, entry, { ensureDir: true });
}

async function getEntry(userId, batchId) {
  await ensureStoreDir();

  if (!storeReady) {
    const mem = memoryFallbackStore();
    const entry = mem.get(entryKey(userId, batchId));
    if (!entry) return null;
    if (Date.now() - entry.createdAt > TTL_MS) {
      mem.delete(entryKey(userId, batchId));
      return null;
    }
    return entry.data;
  }

  const filePath = entryPath(userId, batchId);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const entry = JSON.parse(raw);
    if (Date.now() - entry.createdAt > TTL_MS) {
      await fs.promises.unlink(filePath).catch(() => {});
      return null;
    }
    return entry.data;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[batch-context] Read error: ${err.message}`);
    return null;
  }
}

async function deleteEntry(userId, batchId) {
  await ensureStoreDir();

  if (!storeReady) {
    memoryFallbackStore().delete(entryKey(userId, batchId));
    return;
  }

  const filePath = entryPath(userId, batchId);
  await fs.promises.unlink(filePath).catch(() => {});
}

async function listEntries(userId) {
  await ensureStoreDir();

  if (!storeReady) {
    const mem = memoryFallbackStore();
    const entries = [];
    for (const [key, entry] of mem) {
      if (entry.userId === userId) {
        entries.push({
          batchId: entry.batchId,
          createdAt: entry.createdAt,
          fileCount: Array.isArray(entry.data?.files) ? entry.data.files.length : 0,
        });
      }
    }
    return entries;
  }

  try {
    const files = await fs.promises.readdir(STORE_DIR);
    const entries = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.promises.readFile(path.join(STORE_DIR, f), 'utf8');
        const entry = JSON.parse(raw);
        if (entry.userId === userId && Date.now() - entry.createdAt <= TTL_MS) {
          entries.push({
            batchId: entry.batchId,
            createdAt: entry.createdAt,
            fileCount: Array.isArray(entry.data?.files) ? entry.data.files.length : 0,
          });
        }
      } catch { /* skip corrupt files */ }
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.warn(`[batch-context] List error: ${err.message}`);
    return [];
  }
}

async function cleanup() {
  const now = Date.now();

  if (!storeReady) {
    const mem = memoryFallback;
    if (!mem) return;
    for (const [key, entry] of mem) {
      if (now - entry.createdAt > TTL_MS) mem.delete(key);
    }
    return;
  }

  try {
    const files = await fs.promises.readdir(STORE_DIR);
    let cleaned = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const filePath = path.join(STORE_DIR, f);
      try {
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > TTL_MS) {
          await fs.promises.unlink(filePath);
          cleaned++;
        }
      } catch { /* skip */ }
    }
    if (cleaned > 0) {
      console.log(`[batch-context] Cleaned ${cleaned} expired entries`);
    }
  } catch (err) {
    // Quiet — cleanup is best-effort
  }
}

// Start periodic cleanup
async function startCleanup() {
  await ensureStoreDir();
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref && cleanupTimer.unref();
  // Run initial cleanup
  cleanup().catch(() => {});
}

// Hook into existing global store for backward compat
function bridgeGlobalStore() {
  if (!global.__siraBatchContext) {
    global.__siraBatchContext = new Map();
  }

  const originalSet = global.__siraBatchContext.set.bind(global.__siraBatchContext);
  const originalGet = global.__siraBatchContext.get.bind(global.__siraBatchContext);

  global.__siraBatchContext.set = async function (key, value) {
    // Persist alongside in-memory for backward compat
    originalSet(key, value);
    const [userId, batchId] = String(key).split('::');
    if (userId && batchId) {
      await storeEntry(userId, batchId, value).catch(() => {});
    }
  };

  global.__siraBatchContext.get = async function (key) {
    const memVal = originalGet(key);
    if (memVal) return memVal;

    // Try persistent store for resilience
    const [userId, batchId] = String(key).split('::');
    if (userId && batchId) {
      const persisted = await getEntry(userId, batchId).catch(() => null);
      if (persisted) {
        originalSet(key, persisted);
        return persisted;
      }
    }
    return null;
  };
}

module.exports = {
  storeEntry,
  getEntry,
  deleteEntry,
  listEntries,
  cleanup,
  startCleanup,
  bridgeGlobalStore,
};