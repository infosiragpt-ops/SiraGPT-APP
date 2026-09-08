'use strict';

/**
 * 3H17 — durable engine layer for AgentRunner /chat /code.
 *
 * Next layer on top of 3H16 (repair/retry/loop_cut/in-memory ckpt):
 *   4  pgvector/keyword retrieve inside the live loop (DATA, never instructions)
 *   5  persist checkpoints to redis + Postgres agent_checkpoints + real rollback restore
 *   8  SSE data-frame heartbeat + Last-Event-ID durable replay
 *  10  usage persist on cancel so accounting survives the throw
 *  12  latency observation persist/hydrate (scripted or live, never invented)
 *
 * Pure helpers + injectable kv/pg. Tests never need Redis or DeepSeek.
 */

const CKPT_TTL_SEC = 6 * 3600;
const LATENCY_TTL_SEC = 24 * 3600;
const EVENT_TTL_SEC = 30 * 60;
const USAGE_TTL_SEC = 6 * 3600;
const REDIS_PREFIX = 'sira:engine:';
const STDOUT_MAX_BYTES = 64 * 1024;
const WRITE_MAX_BYTES = 512 * 1024;
const EVENT_RING_MAX = 200;
const READONLY_TOOLS = new Set([
  'read_file', 'list_files', 'glob', 'grep', 'retrieve_memory', 'render_preview',
]);

function createMemoryKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    async set(k, v, _flag, _ttl) { m.set(String(k), String(v)); return 'OK'; },
    async setNx(k, v, _ttl) {
      if (m.has(String(k))) return null;
      m.set(String(k), String(v));
      return 'OK';
    },
    async del(k) { m.delete(String(k)); return 1; },
    _map: m,
  };
}

function runningNodeTest() {
  const args = [...(process.argv || []), ...(process.execArgv || [])];
  return args.some((a) => String(a).includes("--test"));
}

let sharedKv = null;
function getSharedKv() {
  if (sharedKv) return sharedKv;
  if (runningNodeTest()) {
    sharedKv = createMemoryKv();
    return sharedKv;
  }
  try {
    const Redis = require('ioredis');
    const url = process.env.REDIS_URL || 'redis://redis:6379';
    const c = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 2000,
    });
    const ready = new Promise((resolve) => {
      if (c.status === 'ready') return resolve(true);
      try { c.once('ready', () => resolve(true)); } catch (_) {}
      try { c.once('error', () => resolve(false)); } catch (_) {}
      setTimeout(() => resolve(c.status === 'ready'), 2000);
    });
    sharedKv = {
      async get(k) { try { await ready; return await c.get(k); } catch (_) { return null; } },
      async set(k, v, flag, ttl) {
        try {
          await ready;
          if (flag === 'EX' && ttl) return await c.set(k, v, 'EX', ttl);
          return await c.set(k, v);
        } catch (_) { return null; }
      },
      async setNx(k, v, ttl) {
        try {
          await ready;
          if (ttl) return await c.set(k, v, 'EX', ttl, 'NX');
          return await c.set(k, v, 'NX');
        } catch (_) { return null; }
      },
      async del(k) { try { await ready; return await c.del(k); } catch (_) { return 0; } },
    };
    return sharedKv;
  } catch (_) {
    sharedKv = createMemoryKv();
    return sharedKv;
  }
}

function getSharedPg() {
  try {
    const { createAgentCheckpointStore } = require('../../orchestration/agent-checkpoint-store');
    return createAgentCheckpointStore();
  } catch (_) {
    return null;
  }
}

function isCheckpointExpired(rec, { now = Date.now(), ttlSec = CKPT_TTL_SEC } = {}) {
  if (!rec || rec.at == null) return false;
  const at = Number(rec.at);
  if (!Number.isFinite(at)) return false;
  return (at + (Number(ttlSec) || CKPT_TTL_SEC) * 1000) < now;
}

function createDurableCheckpointStore({ kv = null, pg = null, threadId = 'anon' } = {}) {
  const mem = new Map();
  const tid = String(threadId || 'anon');
  let lastId = null;

  return {
    threadId: tid,
    async put({ checkpointId, parentCheckpointId = null, state = {}, metadata = {}, at = null, expectedVersion = null } = {}) {
      const id = String(checkpointId || `ckpt_${Date.now()}_${mem.size}`);
      let stateOut = state && typeof state === 'object' ? state : {};
      let metaOut = metadata && typeof metadata === 'object' ? metadata : {};
      try {
        const w67ckpt = require('./engine-3h67');
        const adCkpt = require('./engine-adapter');
        if (typeof w67ckpt.applyWriteRefuseClosed === 'function') {
          const tooBig = w67ckpt.applyWriteRefuseClosed({
            payload: stateOut,
            refuseWriteIfDestDirMissing: adCkpt.refuseWriteIfDestDirMissing,
            refuseWriteToEtcProcSys: adCkpt.refuseWriteToEtcProcSys,
            refuseWriteToDevBoot: adCkpt.refuseWriteToDevBoot,
            refuseWriteToRootMnt: adCkpt.refuseWriteToRootMnt,
            refuseCheckpointOver1MiBUncompressed: adCkpt.refuseCheckpointOver1MiBUncompressed,
          });
          if (tooBig && tooBig.ok === false && tooBig.code === 'ckpt_too_large') {
            return { ok: false, code: 'ckpt_too_large', checkpointId: id };
          }
        }
      } catch (ckptErr) {
        if (ckptErr && ckptErr.code === 'ckpt_too_large') return { ok: false, code: 'ckpt_too_large', checkpointId: id };
      }
      try {
        const packed = require('./engine-next').compactCheckpointBlobs(stateOut);
        stateOut = packed.state;
        if (packed.compacted) metaOut = { ...metaOut, blobCompacted: true, droppedBytes: packed.droppedBytes };
      } catch (_) { /* keep raw state */ }
      try {
        let gz;
        try { gz = require('./engine-ops').gzipCheckpointBlobVersioned(stateOut); }
        catch (_) { gz = require('./engine-layer').gzipCheckpointBlob(stateOut); }
        if (gz.gzip) {
          stateOut = gz.packed;
          metaOut = { ...metaOut, blobGzip: true, gzipBytes: gz.bytes, rawBytes: gz.rawBytes, gzipVersion: gz.version || 1 };
        }
      } catch (_) { /* keep compacted/raw state */ }
      let curVer = 0;
      try {
        const integ = require('./engine-integrity');
        const cas = integ.casPutDurable(mem, {
          checkpointId: `${tid}:head`,
          expectedVersion,
          state: { checkpointId: id },
        });
        if (!cas.ok) return { ok: false, code: cas.code, version: cas.version, expected: cas.expected, checkpointId: id };
        curVer = cas.version;
      } catch (_) { /* integrity optional */ }
      const rec = {
        threadId: tid,
        checkpointId: id,
        parentCheckpointId: parentCheckpointId || lastId,
        state: stateOut,
        metadata: metaOut,
        at: Number(at) || Date.now(),
        version: curVer,
        ok: true,
      };
      try {
        const corr = require('./engine-correctness');
        const filePath = (metaOut && (metaOut.filePath || metaOut.path)) || null;
        if (filePath) {
          const wrote = corr.atomicCheckpointWrite(filePath, rec);
          if (!wrote.ok) return { ok: false, code: wrote.code || 'ckpt_cas', checkpointId: id };
        }
      } catch (_) { /* fs checkpoint optional */ }
      mem.set(id, rec);
      lastId = id;
      if (kv && typeof kv.set === 'function') {
        try {
          await kv.set(`${REDIS_PREFIX}ckpt:${tid}:${id}`, JSON.stringify(rec), 'EX', CKPT_TTL_SEC);
          await kv.set(`${REDIS_PREFIX}ckpt:${tid}:latest`, id, 'EX', CKPT_TTL_SEC);
          try {
            const integ = require('./engine-integrity');
            await integ.casSwapLatest(kv, tid, { expectedVersion, nextId: id });
          } catch (_) { /* head CAS optional once body is written */ }
        } catch (_) { /* fail-open */ }
      }
      if (pg && typeof pg.put === 'function') {
        try {
          await pg.put({
            threadId: tid,
            checkpointId: id,
            parentCheckpointId: rec.parentCheckpointId,
            state: rec.state,
            metadata: rec.metadata,
          });
        } catch (_) { /* fail-open: redis/memory still hold it */ }
      }
      return rec;
    },
    async get(checkpointId) {
      const id = String(checkpointId || '');
      if (!id) return null;
      if (mem.has(id)) {
        const rec = mem.get(id);
        let out = rec;
        try {
          let inflated = rec && rec.state;
          try {
            const ver = require('./engine-ops').gunzipCheckpointBlobVersioned(rec && rec.state);
            if (ver && ver.ok && ver.state && ver.state !== (rec && rec.state)) inflated = ver.state;
            else if (ver && ver.ok === false && ver.code === 'gzip_version') {
              return { ...rec, expired: true, code: 'gzip_version' };
            } else if (ver && ver.ok && ver.gzip) inflated = ver.state;
          } catch (_) {
            inflated = require('./engine-layer').gunzipCheckpointBlob(rec && rec.state);
          }
          if (inflated !== (rec && rec.state)) out = { ...rec, state: inflated };
        } catch (_) { out = rec; }
        if (isCheckpointExpired(out)) return { ...out, expired: true };
        return out;
      }
      if (kv && typeof kv.get === 'function') {
        try {
          const raw = await kv.get(`${REDIS_PREFIX}ckpt:${tid}:${id}`);
          if (raw) {
            const parsed = JSON.parse(raw);
            mem.set(id, parsed);
            let out = parsed;
            try {
              const inflated = require('./engine-layer').gunzipCheckpointBlob(parsed && parsed.state);
              if (inflated !== (parsed && parsed.state)) out = { ...parsed, state: inflated };
            } catch (_) { out = parsed; }
            if (isCheckpointExpired(out)) return { ...out, expired: true };
            return out;
          }
        } catch (_) { /* next */ }
      }
      if (pg && typeof pg.get === 'function') {
        try {
          const row = await pg.get(tid, id);
          if (row) {
            mem.set(id, row);
            if (isCheckpointExpired(row)) return { ...row, expired: true };
            return row;
          }
        } catch (_) { /* miss */ }
      }
      return null;
    },
    async latest() {
      if (lastId && mem.has(lastId)) return mem.get(lastId);
      if (kv && typeof kv.get === 'function') {
        try {
          const id = await kv.get(`${REDIS_PREFIX}ckpt:${tid}:latest`);
          if (id) return this.get(id);
        } catch (_) { /* next */ }
      }
      if (pg && typeof pg.latest === 'function') {
        try { return await pg.latest(tid); } catch (_) { /* miss */ }
      }
      return null;
    },
    size() { return mem.size; },
  };
}

function restoreMessagesFromCheckpoint(messages, snap) {
  const src = snap && (snap.state && snap.state.messages ? snap.state.messages : snap.messages);
  if (!Array.isArray(messages) || !Array.isArray(src)) return { restored: 0, ok: false };
  messages.splice(0, messages.length, ...src.map((m) => (m && typeof m === 'object' ? { ...m } : m)));
  return { restored: messages.length, ok: true, checkpointId: snap.checkpointId || snap.id || null };
}

function memoryHitsToPins(hits) {
  return (Array.isArray(hits) ? hits : [])
    .map((h) => String((h && (h.text || h.content)) || h || '').trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => t.slice(0, 400));
}

function apply3h66MemoryHits(list) {
  const seed = Array.isArray(list) ? list : [];
  try {
    const w66 = require('./engine-3h66');
    const ad = require('./engine-adapter');
    if (w66 && typeof w66.applyMemoryRetrieveClosed === 'function') {
      const out = w66.applyMemoryRetrieveClosed({
        facts: seed,
        hits: seed,
        skipEmptyWhitespaceMemoryFacts: ad.skipEmptyWhitespaceMemoryFacts,
        skipMemoryIfVectorAllZeros: ad.skipMemoryIfVectorAllZeros,
        skipEmptyEmbeddingUpsert: ad.skipEmptyEmbeddingUpsert,
        memoryRetrieveDedupeByHash: ad.memoryRetrieveDedupeByHash,
        sortMemoryHitsByScoreDesc: ad.sortMemoryHitsByScoreDesc,
        capMemoryHitsReturned8: ad.capMemoryHitsReturned8,
      });
      if (out && Array.isArray(out.hits)) return out.hits;
    }
  } catch (_) { /* 3H66 memory retrieve fail-open */ }
  return seed;
}

async function retrieveMemoryForLoop({
  query,
  userId,
  chatId = null,
  store = null,
  recall = null,
} = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (typeof recall === 'function') {
    try {
      const hits = await recall({ userId, chatId, query: q, store });
      const list = Array.isArray(hits) ? hits : [];
      try {
        const acl = require('./engine-hardening').aclMemoryHits(list, userId);
        try {
          const corr = require('./engine-correctness');
          const skipped = corr.retrieveSkipExpiredPins(acl);
          const namespaced = corr.filterMemoryAclNamespace(skipped.hits || acl, { userId, namespace: userId });
          const filtered = namespaced.hits || skipped.hits || acl;
          try { return apply3h66MemoryHits(require('./engine-next').filterMemoryByScore(filtered)); } catch (_) { return apply3h66MemoryHits(filtered); }
        } catch (_) {
          try { return apply3h66MemoryHits(require('./engine-next').filterMemoryByScore(acl)); } catch (_) { return apply3h66MemoryHits(acl); }
        }
      } catch (_) { return apply3h66MemoryHits(list); }
    } catch (err) {
      try {
        if (require('./engine-layer').isPgvectorError(err)) {
          const wrapped = err instanceof Error ? err : new Error('pgvector_failed');
          wrapped.code = 'pgvector_failed';
          throw wrapped;
        }
      } catch (inner) {
        if (inner && inner.code === 'pgvector_failed') throw inner;
      }
      return [];
    }
  }
  if (store && typeof store.recall === 'function') {
    try {
      const hits = await store.recall({ userId, chatId, query: q, k: 5 });
      const list = Array.isArray(hits) ? hits : [];
      try {
        const acl = require('./engine-hardening').aclMemoryHits(list, userId);
        try {
          const corr = require('./engine-correctness');
          const skipped = corr.retrieveSkipExpiredPins(acl);
          const namespaced = corr.filterMemoryAclNamespace(skipped.hits || acl, { userId, namespace: userId });
          const filtered = namespaced.hits || skipped.hits || acl;
          try { return apply3h66MemoryHits(require('./engine-next').filterMemoryByScore(filtered)); } catch (_) { return apply3h66MemoryHits(filtered); }
        } catch (_) {
          try { return apply3h66MemoryHits(require('./engine-next').filterMemoryByScore(acl)); } catch (_) { return apply3h66MemoryHits(acl); }
        }
      } catch (_) { return apply3h66MemoryHits(list); }
    } catch (err) {
      try {
        if (require('./engine-layer').isPgvectorError(err)) {
          const wrapped = err instanceof Error ? err : new Error('pgvector_failed');
          wrapped.code = 'pgvector_failed';
          throw wrapped;
        }
      } catch (inner) {
        if (inner && inner.code === 'pgvector_failed') throw inner;
      }
      return [];
    }
  }
  // Default hybrid recall (pgvector/keyword) so retrieve-before-generate
  // works even when the caller forgot to pass `recall`. Fail-closed on pgvector.
  try {
    const mem = require('./memory');
    if (mem && typeof mem.recallForTurn === 'function') {
      const hits = await mem.recallForTurn({ userId, chatId, query: q, store });
      const list = Array.isArray(hits) ? hits : [];
      try {
        const acl = require('./engine-hardening').aclMemoryHits(list, userId);
        try {
          const corr = require('./engine-correctness');
          const skipped = corr.retrieveSkipExpiredPins(acl);
          const namespaced = corr.filterMemoryAclNamespace(skipped.hits || acl, { userId, namespace: userId });
          const filtered = namespaced.hits || skipped.hits || acl;
          try { return apply3h66MemoryHits(require('./engine-next').filterMemoryByScore(filtered)); } catch (_) { return apply3h66MemoryHits(filtered); }
        } catch (_) {
          try { return apply3h66MemoryHits(require('./engine-next').filterMemoryByScore(acl)); } catch (_) { return apply3h66MemoryHits(acl); }
        }
      } catch (_) { return apply3h66MemoryHits(list); }
    }
  } catch (err) {
    try {
      if (require('./engine-layer').isPgvectorError(err)) {
        const wrapped = err instanceof Error ? err : new Error('pgvector_failed');
        wrapped.code = 'pgvector_failed';
        throw wrapped;
      }
    } catch (inner) {
      if (inner && inner.code === 'pgvector_failed') throw inner;
    }
  }
  // Keyword-only fallback — never calls paid embedding APIs.
  return [];
}

function planSubtasks(goal, { max = 8 } = {}) {
  const text = String(goal || '').trim();
  if (!text) return { subtasks: [], budget: 0 };
  const parts = text
    .split(/\n+|;\s+|,\s+(?:luego|después|then|and then)\s+|^\s*\d+[.)]\s+/gim)
    .map((s) => s.replace(/^\s*[-*]\s+/, '').trim())
    .filter((s) => s.length >= 3);
  const unique = [];
  const seen = new Set();
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
    if (unique.length >= max) break;
  }
  if (!unique.length) unique.push(text.slice(0, 240));
  return {
    subtasks: unique.map((title, i) => ({ id: `sub_${i + 1}`, title, index: i + 1 })),
    budget: Math.min(40, Math.max(4, unique.length * 5)),
  };
}

function canRunToolsInParallel(calls) {
  if (!Array.isArray(calls) || calls.length < 2) return false;
  return calls.every((c) => {
    const name = String(
      (c && c.function && c.function.name) || c.name || c.tool || '',
    );
    const mapped = name === 'bash' ? 'execute_bash' : name;
    return READONLY_TOOLS.has(mapped);
  });
}

function capStdout(text, maxBytes = STDOUT_MAX_BYTES) {
  const s = String(text == null ? '' : text);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= maxBytes) return { text: s, truncated: false, bytes };
  let cut = s;
  while (Buffer.byteLength(cut, 'utf8') > maxBytes && cut.length) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return { text: `${cut}\n[truncated ${bytes - maxBytes} bytes]`, truncated: true, bytes };
}

function assertWriteSize(content, maxBytes = WRITE_MAX_BYTES) {
  const n = Buffer.byteLength(String(content == null ? '' : content), 'utf8');
  if (n > maxBytes) {
    const err = new Error(`file_too_large: ${n} bytes`);
    err.code = 'file_too_large';
    throw err;
  }
  return { ok: true, bytes: n };
}

/**
 * Apply a unified diff to `original`. Each hunk's old block must match
 * exactly once (Claude-Code-style unique context). Rejects on mismatch.
 */
function applyUnifiedDiff(original, diff) {
  const src = String(original == null ? '' : original);
  const patch = String(diff == null ? '' : diff);
  if (!patch.trim()) return { ok: false, error: 'empty_diff' };
  const hunks = patch.split(/(?=^@@)/m).filter((h) => /^@@/.test(h));
  if (!hunks.length) {
    // Treat a raw old/new pair as a single unique replace.
    return { ok: false, error: 'no_hunks' };
  }
  let out = src;
  for (const hunk of hunks) {
    const lines = hunk.split('\n');
    const oldLines = [];
    const newLines = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('-')) oldLines.push(line.slice(1));
      else if (line.startsWith('+')) newLines.push(line.slice(1));
      else if (line.startsWith('\\')) continue;
      else if (line.startsWith('@@')) continue;
      else {
        const body = line.startsWith(' ') ? line.slice(1) : line;
        oldLines.push(body);
        newLines.push(body);
      }
    }
    const oldBlock = oldLines.join('\n');
    const newBlock = newLines.join('\n');
    if (!oldBlock) {
      out = out ? `${out}\n${newBlock}` : newBlock;
      continue;
    }
    const first = out.indexOf(oldBlock);
    if (first === -1) return { ok: false, error: 'hunk_not_found' };
    const second = out.indexOf(oldBlock, first + 1);
    if (second !== -1) return { ok: false, error: 'hunk_not_unique' };
    out = out.slice(0, first) + newBlock + out.slice(first + oldBlock.length);
  }
  return { ok: true, content: out };
}

function createSseHeartbeat({
  write,
  intervalMs = 25_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
} = {}) {
  if (typeof write !== 'function') return { stop() {}, beat() { return null; }, stopped: true };
  let stopped = false;
  let seq = 0;
  const beat = () => {
    if (stopped) return null;
    seq += 1;
    const frame = { type: 'heartbeat', at: now(), seq };
    try { write(frame); } catch (_) { stop(); return null; }
    return frame;
  };
  const handle = setIntervalFn(beat, Math.max(1000, Number(intervalMs) || 25_000));
  if (handle && typeof handle.unref === 'function') handle.unref();
  function stop() {
    if (stopped) return;
    stopped = true;
    try { clearIntervalFn(handle); } catch (_) { /* ignore */ }
  }
  return { stop, beat, get stopped() { return stopped; }, get seq() { return seq; } };
}

async function persistEventFrame(kv, sessionKey, frame) {
  if (!kv || !sessionKey || !frame) return 0;
  const key = `${REDIS_PREFIX}sse:${sessionKey}`;
  try {
    const raw = await kv.get(key);
    const list = raw ? JSON.parse(raw) : [];
    const lastSeq = list.length ? Number(list[list.length - 1].seq) || 0 : 0;
    const stamped = {
      ...frame,
      seq: frame.seq != null ? Number(frame.seq) : lastSeq + 1,
      at: frame.at || Date.now(),
    };
    const last = list.length ? list[list.length - 1] : null;
    if (last && Number(last.seq) === Number(stamped.seq) && String(last.type || '') === String(stamped.type || '')) {
      return stamped.seq;
    }
    try {
      const nxt = require('./engine-next');
      const seen = new Set(list.map((f) => nxt.eventContentHash(sessionKey, f)));
      const dup = nxt.dropDuplicateByHash(seen, sessionKey, stamped);
      if (dup.duplicate) return stamped.seq;
      const capped = nxt.capSseReplayWindow([...list, stamped]);
      try { require('./engine-layer').replayWindowMetrics(capped); } catch (_) { /* metrics only */ }
      await kv.set(key, JSON.stringify(capped.frames), 'EX', EVENT_TTL_SEC);
      return stamped.seq;
    } catch (_) { /* fall through to ring */ }
    list.push(stamped);
    while (list.length > EVENT_RING_MAX) list.shift();
    await kv.set(key, JSON.stringify(list), 'EX', EVENT_TTL_SEC);
    return stamped.seq;
  } catch (_) {
    return 0;
  }
}

async function replayEventFrames(kv, sessionKey, lastId) {
  if (!kv || !sessionKey) return [];
  try {
    const raw = await kv.get(`${REDIS_PREFIX}sse:${sessionKey}`);
    const list = raw ? JSON.parse(raw) : [];
    const n = Number(lastId) || 0;
    const filtered = list.filter((f) => Number(f && (f.seq != null ? f.seq : f.id)) > n);
    try {
      const { fillSseGaps } = require('./engine-hardening');
      const filled = fillSseGaps(filtered, n).frames;
      try {
        return require('./engine-next').capSseReplayWindow(filled).frames;
      } catch (_) {
        return filled;
      }
    } catch (_) {
      return filtered;
    }
  } catch (_) {
    return [];
  }
}

async function persistLatencyObservation(kv, kind, ms) {
  if (!kv) return 0;
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  const key = `${REDIS_PREFIX}lat:${kind === 'ttfb' ? 'ttfb' : 'turn'}`;
  try {
    const raw = await kv.get(key);
    const list = raw ? JSON.parse(raw) : [];
    list.push({ ms: n, at: Date.now() });
    while (list.length > 64) list.shift();
    await kv.set(key, JSON.stringify(list), 'EX', LATENCY_TTL_SEC);
    return list.length;
  } catch (_) {
    return 0;
  }
}

async function loadLatencyObservations(kv, kind) {
  if (!kv) return [];
  try {
    const raw = await kv.get(`${REDIS_PREFIX}lat:${kind === 'ttfb' ? 'ttfb' : 'turn'}`);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

async function persistUsage(kv, streamId, usage) {
  if (!kv || !streamId) return false;
  try {
    const key = `${REDIS_PREFIX}usage:${streamId}`;
    let prev = null;
    try {
      const raw = await kv.get(key);
      prev = raw ? JSON.parse(raw) : null;
    } catch (_) { prev = null; }
    const merged = {
      promptTokens: Math.max(Number(prev && prev.promptTokens) || 0, Number(usage && usage.promptTokens) || 0),
      completionTokens: Math.max(Number(prev && prev.completionTokens) || 0, Number(usage && usage.completionTokens) || 0),
      at: Date.now(),
    };
    await kv.set(key, JSON.stringify(merged), 'EX', USAGE_TTL_SEC);
    try { require('./engine-next').auditUsage({ streamId, ...merged, action: 'persist' }); } catch (_) { /* optional */ }
    return true;
  } catch (_) {
    return false;
  }
}

async function loadUsage(kv, streamId) {
  if (!kv || !streamId) return null;
  try {
    const raw = await kv.get(`${REDIS_PREFIX}usage:${streamId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function snapshotMsList(items) {
  const vals = (Array.isArray(items) ? items : [])
    .map((x) => Number(x && x.ms != null ? x.ms : x))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  return {
    p50: percentile(vals, 0.5),
    p95: percentile(vals, 0.95),
    count: vals.length,
  };
}

const cleanupFns = [];
function registerSandboxCleanup(fn) {
  if (typeof fn === 'function') cleanupFns.push(fn);
  return cleanupFns.length;
}
async function runSandboxCleanup() {
  const fns = cleanupFns.splice(0, cleanupFns.length);
  let ran = 0;
  for (const fn of fns) {
    try { await fn(); ran += 1; } catch (_) { /* guaranteed attempt */ }
  }
  return ran;
}

module.exports = {
  CKPT_TTL_SEC,
  STDOUT_MAX_BYTES,
  WRITE_MAX_BYTES,
  READONLY_TOOLS,
  REDIS_PREFIX,
  createMemoryKv,
  getSharedKv,
  getSharedPg,
  isCheckpointExpired,
  createDurableCheckpointStore,
  restoreMessagesFromCheckpoint,
  memoryHitsToPins,
  retrieveMemoryForLoop,
  planSubtasks,
  canRunToolsInParallel,
  capStdout,
  assertWriteSize,
  applyUnifiedDiff,
  createSseHeartbeat,
  persistEventFrame,
  replayEventFrames,
  persistLatencyObservation,
  loadLatencyObservations,
  persistUsage,
  loadUsage,
  snapshotMsList,
  registerSandboxCleanup,
  runSandboxCleanup,
};
