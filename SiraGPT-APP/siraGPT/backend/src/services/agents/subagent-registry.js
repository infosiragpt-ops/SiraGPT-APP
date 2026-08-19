'use strict';

/**
 * subagent-registry — in-memory registry of spawned sub-agent sessions
 * with a configurable archive TTL. Mirrors the openclaw v2026.5.7 fix
 * that made the previously-hardcoded "archive after N minutes" honor a
 * config value (`agents.defaults.subagents.archiveAfterMinutes`).
 *
 * The registry is intentionally process-local and lock-free. Callers
 * record() a session at spawn time, complete() it when the sub-agent
 * finishes, and the GC sweep prunes completed rows older than the
 * configured TTL. Active rows are never pruned.
 *
 * Public API:
 *   const reg = createSubagentRegistry({ archiveAfterMinutes, now, gcIntervalMs })
 *   reg.record({ id, parentId, mode, model })
 *   reg.complete(id, { status, error? })
 *   reg.get(id)
 *   reg.list({ status?, parentId? })
 *   reg.size()
 *   reg.gc()                // returns number of rows pruned
 *   reg.startGcLoop()       // wires setInterval; returns stop()
 *   reg.archiveAfterMs()    // resolved TTL in ms
 *
 * The `archiveAfterMinutes` config can be:
 *   - a positive number (minutes; clamped to >= 1)
 *   - 0 / null / undefined → fall back to DEFAULT_ARCHIVE_AFTER_MINUTES
 *   - 'never' / Infinity → never archive (active + completed kept forever)
 */

const DEFAULT_ARCHIVE_AFTER_MINUTES = 60;
const DEFAULT_GC_INTERVAL_MS = 60_000;
const NEVER = Number.POSITIVE_INFINITY;

const ALLOWED_STATUSES = new Set(['pending', 'active', 'completed', 'failed', 'cancelled']);

function resolveArchiveMs(value) {
  if (value === 'never' || value === Infinity) return NEVER;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ARCHIVE_AFTER_MINUTES * 60_000;
  return Math.max(1, Math.floor(n)) * 60_000;
}

function isTerminal(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function createSubagentRegistry(opts = {}) {
  const archiveMs = resolveArchiveMs(opts.archiveAfterMinutes);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const gcIntervalMs = Number.isFinite(opts.gcIntervalMs) && opts.gcIntervalMs > 0
    ? Math.floor(opts.gcIntervalMs)
    : DEFAULT_GC_INTERVAL_MS;

  /** @type {Map<string, {id:string,parentId:string|null,mode:string,model:string|null,status:string,createdAt:number,completedAt:number|null,error:string|null}>} */
  const rows = new Map();

  function record({ id, parentId = null, mode = 'sandbox', model = null, status = 'active' } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('subagent-registry.record: id required');
    if (!ALLOWED_STATUSES.has(status)) throw new TypeError(`subagent-registry.record: invalid status ${status}`);
    const row = {
      id,
      parentId: parentId || null,
      mode: typeof mode === 'string' ? mode : 'sandbox',
      model: model || null,
      status,
      createdAt: now(),
      completedAt: isTerminal(status) ? now() : null,
      error: null,
    };
    rows.set(id, row);
    return { ...row };
  }

  function complete(id, { status = 'completed', error = null } = {}) {
    const row = rows.get(id);
    if (!row) return null;
    if (!ALLOWED_STATUSES.has(status)) throw new TypeError(`subagent-registry.complete: invalid status ${status}`);
    row.status = status;
    row.completedAt = now();
    row.error = error ? String(error) : null;
    return { ...row };
  }

  function get(id) {
    const row = rows.get(id);
    return row ? { ...row } : null;
  }

  function list({ status = null, parentId = undefined } = {}) {
    const out = [];
    for (const row of rows.values()) {
      if (status && row.status !== status) continue;
      if (parentId !== undefined && row.parentId !== parentId) continue;
      out.push({ ...row });
    }
    return out;
  }

  function size() {
    return rows.size;
  }

  function gc() {
    if (archiveMs === NEVER) return 0;
    const cutoff = now() - archiveMs;
    let pruned = 0;
    for (const [id, row] of rows) {
      if (!isTerminal(row.status)) continue;
      const ts = row.completedAt || row.createdAt;
      if (ts <= cutoff) {
        rows.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }

  function startGcLoop() {
    if (archiveMs === NEVER) return () => {};
    const handle = setInterval(() => {
      try { gc(); } catch { /* swallow — GC must never crash the host */ }
    }, gcIntervalMs);
    if (typeof handle.unref === 'function') handle.unref();
    return () => clearInterval(handle);
  }

  function archiveAfterMs() {
    return archiveMs;
  }

  return {
    record,
    complete,
    get,
    list,
    size,
    gc,
    startGcLoop,
    archiveAfterMs,
  };
}

module.exports = {
  createSubagentRegistry,
  resolveArchiveMs,
  DEFAULT_ARCHIVE_AFTER_MINUTES,
  DEFAULT_GC_INTERVAL_MS,
};
