'use strict';

/**
 * attribution-snapshot-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Persists per-turn attribution snapshots (graph summary + telemetry +
 * verdict labels) to disk as JSONL so the team can replay sessions
 * offline, hunt down regressions, build a labeled training corpus, or
 * point a support agent at "what did the system think on this turn?".
 *
 * Storage layout:
 *
 *   data/attribution-snapshots/
 *     <userId>/<chatId>.jsonl     ← one JSON object per line, per turn
 *     <userId>/<chatId>.index.json← compact index of (turnId, ts, file offset)
 *
 * Writes are append-only and capped at SIRAGPT_ATTRIBUTION_SNAPSHOT_MAX
 * lines per chat (default 512) — when the cap is hit the file rolls
 * over to `<chatId>.old.jsonl` and a fresh file starts.
 *
 * Reads are streaming-friendly (`readSnapshots` yields parsed records
 * line by line). When the persistence flag SIRAGPT_ATTRIBUTION_SNAPSHOT
 * is unset or `0` the module is a no-op so test / sandbox environments
 * don't accidentally touch the filesystem.
 *
 * Pure-Node — `fs` + `path` only. Hot path is non-blocking when
 * `appendSync: false` (the default uses fs.appendFile + fire-and-
 * forget Promise, with an in-memory mirror for recent reads).
 *
 * Public API:
 *   saveSnapshot({ userId, chatId, turnId?, snapshot })
 *                                          → Promise<{ ok, line?, error? }>
 *   readSnapshots({ userId, chatId, limit?, since? })
 *                                          → Promise<Snapshot[]>
 *   tail({ userId, chatId, n? })           → Promise<Snapshot[]>
 *   countSnapshots({ userId, chatId })     → Promise<number>
 *   clear({ userId, chatId? })             → Promise<{ removed }>
 *   stats()                                → { chats, totalSnapshots, baseDir }
 *
 * Tunables (env):
 *   SIRAGPT_ATTRIBUTION_SNAPSHOT             ('1' enables disk writes)
 *   SIRAGPT_ATTRIBUTION_SNAPSHOT_DIR         (default ./data/attribution-snapshots)
 *   SIRAGPT_ATTRIBUTION_SNAPSHOT_MAX         (default 512 lines per chat)
 *   SIRAGPT_ATTRIBUTION_SNAPSHOT_INMEM_CAP   (default 64 per chat)
 */

const fs = require('node:fs');
const path = require('node:path');

const ENABLED = String(process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT || '').toLowerCase() === '1';
const BASE_DIR = process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT_DIR
  || path.join(process.cwd(), 'data', 'attribution-snapshots');
const MAX_PER_CHAT = Math.max(8, Number(process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT_MAX) || 512);
const INMEM_CAP = Math.max(4, Number(process.env.SIRAGPT_ATTRIBUTION_SNAPSHOT_INMEM_CAP) || 64);

const inMemoryMirror = new Map(); // key → [snapshots, …]

function keyFor(userId, chatId) {
  const u = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const c = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${u}::${c}`;
}

function pathsFor(userId, chatId) {
  const u = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const c = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const dir = path.join(BASE_DIR, u);
  return {
    dir,
    file: path.join(dir, `${c}.jsonl`),
    oldFile: path.join(dir, `${c}.old.jsonl`),
  };
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
}

function pushInMemory(userId, chatId, snapshot) {
  const k = keyFor(userId, chatId);
  let list = inMemoryMirror.get(k);
  if (!list) { list = []; inMemoryMirror.set(k, list); }
  list.push(snapshot);
  if (list.length > INMEM_CAP) list.shift();
}

async function rollOverIfNeeded(file, oldFile) {
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size === 0) return;
    // count lines lazily — for the cap check use stat.size as a proxy
    // for "definitely over"; we still want the exact line count when
    // near the cap.
    // Use a single read so we don't open the file twice.
    const data = await fs.promises.readFile(file, 'utf8');
    const lines = data.split('\n').filter(Boolean);
    if (lines.length < MAX_PER_CHAT) return;
    await fs.promises.rename(file, oldFile);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function saveSnapshot({ userId, chatId, turnId = null, snapshot = null } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, error: 'snapshot object required' };
  }
  const enriched = {
    userId: userId || null,
    chatId: chatId || null,
    turnId: turnId || `t_${Date.now().toString(36)}`,
    ts: Date.now(),
    ...snapshot,
  };
  pushInMemory(userId, chatId, enriched);
  if (!ENABLED) return { ok: true, line: null, persisted: false };
  const { dir, file, oldFile } = pathsFor(userId, chatId);
  try {
    ensureDir(dir);
    await rollOverIfNeeded(file, oldFile);
    const line = `${JSON.stringify(enriched)}\n`;
    await fs.promises.appendFile(file, line, 'utf8');
    return { ok: true, line, persisted: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function readSnapshots({ userId, chatId, limit = 128, since = null } = {}) {
  const inMem = inMemoryMirror.get(keyFor(userId, chatId)) || [];
  let combined = [...inMem];
  if (ENABLED) {
    const { file, oldFile } = pathsFor(userId, chatId);
    // Read the rolled-over archive (.old.jsonl) FIRST, then the live file. The
    // rollover renames the full current file to .old.jsonl, so everything
    // written before the most recent rollover lived there — reading only the
    // live file made up to MAX_PER_CHAT older snapshots invisible to
    // readSnapshots/tail/countSnapshots.
    const fileSnaps = [];
    for (const f of [oldFile, file]) {
      try {
        const data = await fs.promises.readFile(f, 'utf8');
        for (const line of data.split('\n')) {
          if (!line) continue;
          try { fileSnaps.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    // de-dup by turnId, prefer in-memory/earlier order
    const seen = new Set(combined.map((s) => s.turnId).filter(Boolean));
    for (const s of fileSnaps) {
      if (s.turnId && seen.has(s.turnId)) continue;
      combined.push(s);
      if (s.turnId) seen.add(s.turnId);
    }
  }
  if (since) combined = combined.filter((s) => Number(s.ts) >= Number(since));
  combined.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  if (limit && combined.length > limit) return combined.slice(-limit);
  return combined;
}

async function tail({ userId, chatId, n = 8 } = {}) {
  const list = await readSnapshots({ userId, chatId, limit: 4096 });
  const k = Math.max(1, Math.min(list.length, n));
  return list.slice(-k);
}

async function countSnapshots({ userId, chatId } = {}) {
  const list = await readSnapshots({ userId, chatId, limit: 1_000_000 });
  return list.length;
}

async function clear({ userId, chatId } = {}) {
  let removed = 0;
  if (userId && chatId) {
    inMemoryMirror.delete(keyFor(userId, chatId));
    if (ENABLED) {
      const { file, oldFile } = pathsFor(userId, chatId);
      for (const p of [file, oldFile]) {
        try { await fs.promises.unlink(p); removed += 1; }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
    }
    return { removed };
  }
  if (userId) {
    const prefix = `${userId}::`;
    for (const k of inMemoryMirror.keys()) if (k.startsWith(prefix)) inMemoryMirror.delete(k);
    return { removed };
  }
  inMemoryMirror.clear();
  return { removed };
}

function stats() {
  let totalSnapshots = 0;
  for (const list of inMemoryMirror.values()) totalSnapshots += list.length;
  return { chats: inMemoryMirror.size, totalSnapshots, baseDir: BASE_DIR, enabled: ENABLED };
}

const __resetForTests = () => inMemoryMirror.clear();

module.exports = {
  saveSnapshot,
  readSnapshots,
  tail,
  countSnapshots,
  clear,
  stats,
  __resetForTests,
  MAX_PER_CHAT,
  INMEM_CAP,
  BASE_DIR,
  ENABLED,
};
