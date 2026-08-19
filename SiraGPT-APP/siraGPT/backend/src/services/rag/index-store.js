'use strict';

// ──────────────────────────────────────────────────────────────────
// siraGPT — RAG document index cache
// ──────────────────────────────────────────────────────────────────
// Caches the (chunks + embeddings + hierarchy root) output of the RAG
// pipeline keyed by SHA-256 of the source bytes, so re-uploading the
// same file is O(1) instead of minutes-long parse + embed.
//
// Two reuse modes:
//   1) Whole-file:    same contentHash  -> reuse everything.
//   2) Incremental:   same pageHashes prefix overlap -> reuse only the
//      embeddings of pages whose hash is unchanged. The compute callback
//      receives a list of `missingPages` (their indexes + hashes) and
//      returns the embeddings for those alone.
//
// Storage backend is injected (Prisma client in production, or an
// in-memory mock in tests). The interface is:
//
//   findByHash(hash) -> row | null
//   findByPageHashes(pageHashes) -> Array<row>   (best candidates only)
//   upsert(row) -> row
//   touch(hash, accessedAt) -> void
//   deleteOlderThan(date) -> { removed: number }
//   listSummaries(opts) -> Array<{ contentHash, ... }>
//
// All metrics are kept in-process (counters reset per process). Persist
// them externally if you need long-horizon trend reporting.
// ──────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sha256(buf) {
  const h = crypto.createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

function nowDate() { return new Date(); }

function bytesOfJson(obj) {
  if (obj == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(obj), 'utf8'); } catch { return 0; }
}

function isPositiveInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

// Default in-memory store. Prisma adapter can plug into the same shape.
function createMemoryStore() {
  const rows = new Map();
  return {
    async findByHash(hash) {
      return rows.has(hash) ? cloneRow(rows.get(hash)) : null;
    },
    async findByPageHashes(pageHashes) {
      if (!Array.isArray(pageHashes) || pageHashes.length === 0) return [];
      const out = [];
      for (const row of rows.values()) {
        if (!Array.isArray(row.pageHashes) || row.pageHashes.length === 0) continue;
        const overlap = countOverlap(row.pageHashes, pageHashes);
        if (overlap > 0) out.push({ row: cloneRow(row), overlap });
      }
      out.sort((a, b) => b.overlap - a.overlap);
      return out.slice(0, 5).map((entry) => entry.row);
    },
    async upsert(row) {
      rows.set(row.contentHash, cloneRow(row));
      return cloneRow(row);
    },
    async touch(hash, accessedAt) {
      const row = rows.get(hash);
      if (row) {
        row.accessedAt = accessedAt;
        row.hitCount = (row.hitCount || 0) + 1;
      }
    },
    async deleteOlderThan(date) {
      let removed = 0;
      for (const [hash, row] of rows.entries()) {
        if (row.accessedAt instanceof Date ? row.accessedAt < date : new Date(row.accessedAt) < date) {
          rows.delete(hash);
          removed += 1;
        }
      }
      return { removed };
    },
    async listSummaries({ limit = 100 } = {}) {
      const all = Array.from(rows.values()).map((row) => ({
        contentHash: row.contentHash,
        version: row.version,
        bytesSize: row.bytesSize,
        embedTokens: row.embedTokens,
        hitCount: row.hitCount,
        createdAt: row.createdAt,
        accessedAt: row.accessedAt,
        hierarchyRootId: row.hierarchyRootId || null,
      }));
      all.sort((a, b) => b.accessedAt - a.accessedAt);
      return all.slice(0, limit);
    },
    async _size() { return rows.size; },
  };
}

function cloneRow(row) {
  return {
    contentHash: row.contentHash,
    version: row.version || 1,
    chunks: row.chunks,
    embeddings: row.embeddings,
    pageHashes: row.pageHashes ? row.pageHashes.slice() : null,
    hierarchyRootId: row.hierarchyRootId || null,
    bytesSize: row.bytesSize || 0,
    embedTokens: row.embedTokens || 0,
    metadata: row.metadata || null,
    createdAt: row.createdAt || nowDate(),
    accessedAt: row.accessedAt || nowDate(),
    hitCount: row.hitCount || 0,
  };
}

function countOverlap(a, b) {
  // Counts how many positions match by index. Used for incremental
  // detection where page order is stable. Mismatched-length arrays only
  // overlap up to the shorter length.
  const len = Math.min(a.length, b.length);
  let n = 0;
  for (let i = 0; i < len; i += 1) if (a[i] === b[i]) n += 1;
  return n;
}

function createIndexStore({
  store = null,
  ttlMs = DEFAULT_TTL_MS,
  now = nowDate,
} = {}) {
  const backend = store || createMemoryStore();

  const metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    incrementalHits: 0,
    incrementalReuseCount: 0,   // pages whose embeddings were reused
    incrementalRecomputeCount: 0,
    bytesSaved: 0,
    embedTokensSaved: 0,
    errors: 0,
    gcRuns: 0,
    gcRemoved: 0,
  };

  async function getOrCompute(contentHash, computeFn, opts = {}) {
    if (typeof contentHash !== 'string' || contentHash.length === 0) {
      throw new TypeError('contentHash must be a non-empty string');
    }
    if (typeof computeFn !== 'function') {
      throw new TypeError('computeFn must be a function');
    }
    const existing = await backend.findByHash(contentHash);
    if (existing) {
      metrics.cacheHits += 1;
      metrics.bytesSaved += existing.bytesSize || 0;
      metrics.embedTokensSaved += existing.embedTokens || 0;
      await safeTouch(contentHash);
      return { hit: true, mode: 'full', value: existing, computed: false };
    }
    metrics.cacheMisses += 1;
    let computed;
    try {
      computed = await computeFn();
    } catch (err) {
      metrics.errors += 1;
      throw err;
    }
    const row = await persistComputed(contentHash, computed, opts);
    return { hit: false, mode: 'full', value: row, computed: true };
  }

  // Incremental variant: compares page hashes against any candidate row
  // in the store. If at least one candidate has overlapping pages, we
  // reuse those embeddings and only ask `computeFn` to fill the rest.
  //
  //   computeFn({ missingPages, candidate }) ->
  //     {
  //       chunks,                // full ordered chunk array
  //       embeddings,            // full ordered embeddings array
  //       hierarchyRootId?, metadata?, embedTokens?
  //     }
  //
  // If no candidate exists or `pageHashes` is empty, falls back to the
  // standard miss path (computeFn runs from scratch).
  async function getOrComputeIncremental({ contentHash, pageHashes }, computeFn, opts = {}) {
    if (!Array.isArray(pageHashes) || pageHashes.length === 0) {
      return getOrCompute(contentHash, () => computeFn({ missingPages: [], candidate: null }), opts);
    }
    const direct = await backend.findByHash(contentHash);
    if (direct) {
      metrics.cacheHits += 1;
      metrics.bytesSaved += direct.bytesSize || 0;
      metrics.embedTokensSaved += direct.embedTokens || 0;
      await safeTouch(contentHash);
      return { hit: true, mode: 'full', value: direct, computed: false };
    }

    const candidates = await backend.findByPageHashes(pageHashes);
    const best = candidates && candidates[0];
    if (!best || !Array.isArray(best.pageHashes)) {
      metrics.cacheMisses += 1;
      const computed = await computeFn({ missingPages: pageHashes.map((h, i) => ({ index: i, hash: h })), candidate: null });
      const row = await persistComputed(contentHash, { ...computed, pageHashes }, opts);
      return { hit: false, mode: 'full', value: row, computed: true };
    }

    const reuse = []; // { index, hash, embedding, chunk }
    const missing = []; // { index, hash }
    const len = pageHashes.length;
    for (let i = 0; i < len; i += 1) {
      const h = pageHashes[i];
      if (best.pageHashes[i] === h && Array.isArray(best.embeddings) && best.embeddings[i] !== undefined) {
        reuse.push({
          index: i,
          hash: h,
          embedding: best.embeddings[i],
          chunk: Array.isArray(best.chunks) ? best.chunks[i] : null,
        });
      } else {
        missing.push({ index: i, hash: h });
      }
    }

    if (missing.length === 0) {
      // All overlap — treat as a full hit but persist under the new hash
      // so future lookups by contentHash are O(1).
      metrics.cacheHits += 1;
      metrics.incrementalHits += 1;
      metrics.incrementalReuseCount += reuse.length;
      const merged = {
        chunks: reuse.map((r) => r.chunk),
        embeddings: reuse.map((r) => r.embedding),
        embedTokens: 0,
        hierarchyRootId: best.hierarchyRootId || null,
        metadata: best.metadata || null,
        pageHashes,
      };
      const row = await persistComputed(contentHash, merged, opts);
      metrics.bytesSaved += row.bytesSize || 0;
      return { hit: true, mode: 'incremental', value: row, computed: false, reused: reuse.length, recomputed: 0 };
    }

    metrics.cacheMisses += 1;
    metrics.incrementalHits += 1;
    metrics.incrementalReuseCount += reuse.length;
    metrics.incrementalRecomputeCount += missing.length;

    const computed = await computeFn({
      missingPages: missing,
      candidate: { contentHash: best.contentHash, hierarchyRootId: best.hierarchyRootId || null },
    });
    if (!computed || typeof computed !== 'object') {
      metrics.errors += 1;
      throw new Error('computeFn must return { chunks, embeddings, ... }');
    }

    // Merge: reuse positions take precedence; computeFn provides the
    // rest. We accept either a sparse mapping keyed by index or a full
    // ordered array of length `missing.length` aligned to `missing`.
    const merged = mergeIncremental({
      pageHashes,
      reuse,
      missing,
      provided: computed,
      candidate: best,
    });

    const embedTokens = isPositiveInt(computed.embedTokens) ? computed.embedTokens : 0;
    const row = await persistComputed(contentHash, {
      chunks: merged.chunks,
      embeddings: merged.embeddings,
      hierarchyRootId: computed.hierarchyRootId || best.hierarchyRootId || null,
      metadata: computed.metadata || null,
      pageHashes,
      embedTokens,
    }, opts);

    // Bytes/tokens "saved" estimate: proportionally to reused pages.
    const reuseRatio = reuse.length / len;
    metrics.bytesSaved += Math.round((best.bytesSize || 0) * reuseRatio);
    metrics.embedTokensSaved += Math.round((best.embedTokens || 0) * reuseRatio);

    return {
      hit: false,
      mode: 'incremental',
      value: row,
      computed: true,
      reused: reuse.length,
      recomputed: missing.length,
    };
  }

  async function persistComputed(contentHash, computed, opts) {
    if (!computed || !Array.isArray(computed.chunks) || !Array.isArray(computed.embeddings)) {
      metrics.errors += 1;
      throw new Error('computed payload must include chunks[] and embeddings[]');
    }
    const bytesSize = bytesOfJson(computed.chunks) + bytesOfJson(computed.embeddings);
    const row = {
      contentHash,
      version: opts.version || 1,
      chunks: computed.chunks,
      embeddings: computed.embeddings,
      pageHashes: Array.isArray(computed.pageHashes) ? computed.pageHashes : null,
      hierarchyRootId: computed.hierarchyRootId || null,
      bytesSize,
      embedTokens: isPositiveInt(computed.embedTokens) ? computed.embedTokens : 0,
      metadata: computed.metadata || null,
      createdAt: now(),
      accessedAt: now(),
      hitCount: 0,
    };
    return backend.upsert(row);
  }

  async function safeTouch(hash) {
    try { await backend.touch(hash, now()); } catch { /* swallow */ }
  }

  async function gc({ ttlMs: overrideTtl } = {}) {
    const ttl = isPositiveInt(overrideTtl) ? overrideTtl : ttlMs;
    const cutoff = new Date(now().getTime() - ttl);
    const { removed } = await backend.deleteOlderThan(cutoff);
    metrics.gcRuns += 1;
    metrics.gcRemoved += removed;
    return { removed, cutoff };
  }

  function snapshotMetrics() {
    const total = metrics.cacheHits + metrics.cacheMisses;
    const ratio = total > 0 ? metrics.cacheHits / total : 0;
    return {
      ...metrics,
      totalLookups: total,
      cacheHitRatio: Number(ratio.toFixed(4)),
    };
  }

  async function stats({ limit = 50 } = {}) {
    const summaries = await backend.listSummaries({ limit });
    const totalBytes = summaries.reduce((acc, r) => acc + (r.bytesSize || 0), 0);
    const totalEmbedTokens = summaries.reduce((acc, r) => acc + (r.embedTokens || 0), 0);
    return {
      metrics: snapshotMetrics(),
      entries: summaries.length,
      totalBytes,
      totalEmbedTokens,
      recent: summaries.slice(0, 10),
    };
  }

  function resetMetrics() {
    for (const k of Object.keys(metrics)) metrics[k] = 0;
  }

  return {
    getOrCompute,
    getOrComputeIncremental,
    gc,
    stats,
    metrics: snapshotMetrics,
    resetMetrics,
    _backend: backend,
  };
}

function mergeIncremental({ pageHashes, reuse, missing, provided, candidate }) {
  const len = pageHashes.length;
  const chunks = new Array(len);
  const embeddings = new Array(len);
  for (const r of reuse) {
    chunks[r.index] = r.chunk;
    embeddings[r.index] = r.embedding;
  }

  // Accept provided.chunks / provided.embeddings as either:
  //  (a) full-length arrays already aligned to pageHashes, or
  //  (b) arrays of length `missing.length` aligned to `missing` order.
  const pc = provided.chunks || [];
  const pe = provided.embeddings || [];
  if (pc.length === len && pe.length === len) {
    for (const m of missing) {
      chunks[m.index] = pc[m.index];
      embeddings[m.index] = pe[m.index];
    }
  } else if (pc.length === missing.length && pe.length === missing.length) {
    for (let i = 0; i < missing.length; i += 1) {
      chunks[missing[i].index] = pc[i];
      embeddings[missing[i].index] = pe[i];
    }
  } else {
    throw new Error(
      `incremental computeFn returned ${pc.length} chunks / ${pe.length} embeddings; ` +
      `expected either ${len} (full) or ${missing.length} (missing-only)`
    );
  }

  // Backfill any holes from candidate (defensive, should not be needed).
  for (let i = 0; i < len; i += 1) {
    if (chunks[i] === undefined && Array.isArray(candidate.chunks)) chunks[i] = candidate.chunks[i];
    if (embeddings[i] === undefined && Array.isArray(candidate.embeddings)) embeddings[i] = candidate.embeddings[i];
  }
  return { chunks, embeddings };
}

// Prisma adapter — wraps a `prisma.documentIndex` delegate to the shape
// expected by createIndexStore. Use only when the migration has been
// applied.
function createPrismaStore(prisma) {
  if (!prisma || !prisma.documentIndex) {
    throw new Error('createPrismaStore: prisma.documentIndex delegate not available');
  }
  const di = prisma.documentIndex;
  return {
    async findByHash(hash) {
      return di.findUnique({ where: { contentHash: hash } });
    },
    async findByPageHashes(pageHashes) {
      // Postgres can't index-scan a JSON array overlap cheaply without
      // pgvector / GIN setup; we fetch a recent slice and rank in JS.
      const rows = await di.findMany({
        where: { pageHashes: { not: null } },
        orderBy: { accessedAt: 'desc' },
        take: 50,
      });
      const ranked = [];
      for (const row of rows) {
        const ph = row.pageHashes;
        if (!Array.isArray(ph)) continue;
        const overlap = countOverlap(ph, pageHashes);
        if (overlap > 0) ranked.push({ row, overlap });
      }
      ranked.sort((a, b) => b.overlap - a.overlap);
      return ranked.slice(0, 5).map((entry) => entry.row);
    },
    async upsert(row) {
      const data = {
        version: row.version,
        chunks: row.chunks,
        embeddings: row.embeddings,
        pageHashes: row.pageHashes,
        hierarchyRootId: row.hierarchyRootId,
        bytesSize: row.bytesSize,
        embedTokens: row.embedTokens,
        metadata: row.metadata,
        accessedAt: row.accessedAt,
      };
      return di.upsert({
        where: { contentHash: row.contentHash },
        create: { contentHash: row.contentHash, createdAt: row.createdAt, hitCount: 0, ...data },
        update: data,
      });
    },
    async touch(hash, accessedAt) {
      await di.update({
        where: { contentHash: hash },
        data: { accessedAt, hitCount: { increment: 1 } },
      });
    },
    async deleteOlderThan(date) {
      const result = await di.deleteMany({ where: { accessedAt: { lt: date } } });
      return { removed: result.count || 0 };
    },
    async listSummaries({ limit = 100 } = {}) {
      return di.findMany({
        select: {
          contentHash: true,
          version: true,
          bytesSize: true,
          embedTokens: true,
          hitCount: true,
          createdAt: true,
          accessedAt: true,
          hierarchyRootId: true,
        },
        orderBy: { accessedAt: 'desc' },
        take: limit,
      });
    },
  };
}

module.exports = {
  createIndexStore,
  createMemoryStore,
  createPrismaStore,
  sha256,
  countOverlap,
  DEFAULT_TTL_MS,
};
