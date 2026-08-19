'use strict';

/**
 * agent-audit-log — append-only, tamper-evident audit log for external
 * agent actions (G32, docs/code/company-os-master-plan.md).
 *
 * Every append produces an entry whose `prevHash` is
 * sha256(<prevHash of the user's previous entry> + <canonical JSON of the
 * entry payload>), forming a per-user hash chain: editing any persisted
 * entry (payload or hash) breaks recomputation from that point on, which
 * `verifyChain` reports via `brokenAt` (the `seq` of the first bad entry).
 *
 * Design notes:
 *   - Two pluggable stores: `createMemoryStore()` (tests / ephemeral) and
 *     `createJsonlStore({ filePath, maxBytes })` (sync JSONL on disk with
 *     single-generation rotation to `<filePath>.1`).
 *   - `append` is best-effort: a disk error NEVER throws — it increments
 *     the internal `errors` counter (visible via `stats()`) and leaves the
 *     chain state untouched so the persisted chain stays verifiable.
 *   - `detail` is capped at 2000 chars and obvious secrets (sk-… keys,
 *     Bearer tokens, password=…) are replaced with '[REDACTED]' BEFORE
 *     hashing, so secrets never enter the chain nor the disk.
 *   - Known limitation: the JSONL store keeps exactly one rotated
 *     generation. After a SECOND rotation the oldest entries are gone, so
 *     `verifyChain` can no longer anchor those users' chains at genesis
 *     and may report a break at the earliest surviving entry.
 *
 * Public API:
 *   createAuditLog({ store }) → { append, verifyChain, query, stats }
 *   createMemoryStore()
 *   createJsonlStore({ filePath, maxBytes = 10MB })
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DETAIL_CHARS = 2000;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 500;
const REDACTED = '[REDACTED]';
const GENESIS_HASH = '';

/** Obvious secret shapes stripped from `detail` before hashing/persisting. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{4,}/g, // OpenAI/Stripe-style secret keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, // Authorization bearer tokens
  /\bpassword\s*=\s*[^\s&"',;]+/gi, // password=... query/env style
];

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical payload of an entry (everything except `prevHash`), with a
 * fixed key order so JSON.stringify is deterministic across processes.
 */
function payloadOf(entry) {
  return {
    seq: entry.seq,
    userId: entry.userId,
    action: entry.action,
    target: entry.target,
    detail: entry.detail,
    ts: entry.ts,
  };
}

function chainHash(previousHash, payload) {
  return sha256Hex(previousHash + JSON.stringify(payload));
}

function sanitizeDetail(detail) {
  if (detail === undefined || detail === null) return undefined;
  let text;
  if (typeof detail === 'string') {
    text = detail;
  } else {
    try {
      text = JSON.stringify(detail);
    } catch {
      text = String(detail);
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  if (text.length > MAX_DETAIL_CHARS) text = text.slice(0, MAX_DETAIL_CHARS);
  return text;
}

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

/** In-memory store: fast, ephemeral, never errors. */
function createMemoryStore() {
  const entries = [];
  return {
    kind: 'memory',
    append(entry) {
      entries.push(entry);
    },
    /** Chronological. Shallow copy: array is private, objects are live. */
    list() {
      return entries.slice();
    },
  };
}

/**
 * JSONL store: synchronous append of one JSON line per entry. When the
 * active file would exceed `maxBytes` it is rotated to `<filePath>.1`,
 * REPLACING any previous `.1` (exactly one generation is kept).
 * `list()` reads `<filePath>.1` first, then the active file, skipping
 * corrupt lines, so the readable history spans both generations.
 */
function createJsonlStore({ filePath, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('createJsonlStore: filePath is required');
  }
  const boundedMax = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const rotatedPath = `${filePath}.1`;

  // Best-effort init: never throw here — a bad path surfaces (and is
  // swallowed by the log) on the first append instead.
  let size = 0;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    /* surfaced on append */
  }
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }

  function rotate() {
    try {
      fs.unlinkSync(rotatedPath); // Windows-safe replace
    } catch {
      /* no previous generation */
    }
    fs.renameSync(filePath, rotatedPath);
    size = 0;
  }

  function readLines(target) {
    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch {
      return [];
    }
    const parsed = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object') parsed.push(entry);
      } catch {
        /* skip corrupt line */
      }
    }
    return parsed;
  }

  return {
    kind: 'jsonl',
    filePath,
    rotatedPath,
    maxBytes: boundedMax,
    append(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (size > 0 && size + bytes > boundedMax) rotate();
      fs.appendFileSync(filePath, line, 'utf8');
      size += bytes;
    },
    list() {
      return [...readLines(rotatedPath), ...readLines(filePath)];
    },
  };
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

function createAuditLog({ store } = {}) {
  const backing = store || createMemoryStore();
  const lastHashByUser = new Map();
  const counters = { appended: 0, errors: 0, lastError: null };
  let seq = 0;

  // Rebuild chain state from whatever the store already holds so a
  // process restart over a JSONL file continues the same chains.
  try {
    for (const entry of backing.list()) {
      if (Number.isFinite(entry.seq) && entry.seq > seq) seq = entry.seq;
      if (typeof entry.userId === 'string' && typeof entry.prevHash === 'string') {
        lastHashByUser.set(entry.userId, entry.prevHash);
      }
    }
  } catch (err) {
    counters.errors += 1;
    counters.lastError = err && err.message ? err.message : String(err);
  }

  function recordError(err) {
    counters.errors += 1;
    counters.lastError = err && err.message ? err.message : String(err);
  }

  /**
   * Append one entry. Throws only on caller bugs (missing fields);
   * storage failures are swallowed and counted in `stats().errors`.
   * Returns the built entry either way (`persisted: false` on failure).
   */
  function append({ userId, action, target, detail, ts } = {}) {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError('agent-audit-log.append: userId is required');
    }
    if (typeof action !== 'string' || action.length === 0) {
      throw new TypeError('agent-audit-log.append: action is required');
    }
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('agent-audit-log.append: target is required');
    }

    const payload = {
      seq: seq + 1,
      userId,
      action,
      target,
      detail: sanitizeDetail(detail),
      ts: Number.isFinite(ts) ? ts : Date.now(),
    };
    const previous = lastHashByUser.get(userId) ?? GENESIS_HASH;
    const prevHash = chainHash(previous, payload);
    const entry = { ...payload, prevHash };

    try {
      backing.append(entry);
    } catch (err) {
      // Best-effort: do NOT advance seq/chain, so the persisted chain
      // stays verifiable after transient disk failures.
      recordError(err);
      return { ...entry, persisted: false };
    }

    seq = payload.seq;
    lastHashByUser.set(userId, prevHash);
    counters.appended += 1;
    return entry;
  }

  /**
   * Recompute every (or one user's) hash chain from genesis over the
   * entries the store can currently read.
   * → { ok: true } | { ok: false, brokenAt: <seq of first bad entry> }
   */
  function verifyChain({ userId } = {}) {
    let entries;
    try {
      entries = backing.list();
    } catch (err) {
      recordError(err);
      return { ok: false, brokenAt: null, error: counters.lastError };
    }

    const ordered = entries
      .slice()
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const running = new Map();
    for (const entry of ordered) {
      if (userId && entry.userId !== userId) continue;
      const previous = running.get(entry.userId) ?? GENESIS_HASH;
      const expected = chainHash(previous, payloadOf(entry));
      if (expected !== entry.prevHash) {
        return { ok: false, brokenAt: entry.seq ?? null };
      }
      running.set(entry.userId, entry.prevHash);
    }
    return { ok: true };
  }

  /**
   * Most-recent-first slice of the log, optionally filtered by user
   * and/or action. Read failures return [] (best-effort, counted).
   */
  function query({ userId, action, limit = DEFAULT_QUERY_LIMIT } = {}) {
    let entries;
    try {
      entries = backing.list();
    } catch (err) {
      recordError(err);
      return [];
    }
    const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));
    return entries
      .filter(
        (entry) =>
          (!userId || entry.userId === userId) &&
          (!action || entry.action === action),
      )
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, capped);
  }

  function stats() {
    return {
      appended: counters.appended,
      errors: counters.errors,
      lastError: counters.lastError,
      seq,
      users: lastHashByUser.size,
      store: backing.kind || 'custom',
    };
  }

  return { append, verifyChain, query, stats };
}

module.exports = {
  createAuditLog,
  createMemoryStore,
  createJsonlStore,
  DEFAULT_MAX_BYTES,
  MAX_DETAIL_CHARS,
  REDACTED,
};
