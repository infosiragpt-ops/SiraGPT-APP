'use strict';

/**
 * 3H27 — engine integrity layer for /chat + /code.
 *
 * Remaining holes after 3H26 (sandbox stream / SSE drain / queue lease):
 *   3  nested plan remaining-budget
 *   4  retrieve-before-generate (default pgvector/keyword) + pin hash dedup
 *   5  checkpoint CAS on durable head + auto-resume after backend recreate
 *   6  exact unique replace + syntax revert on write_file/str_replace/edit_file
 *  10  credit settle-then-release on cancel
 *  11  typed ES codes for the new failures
 *  12  real first-byte (stream/SSE), persisted so recreate hydrates (no fake Flash)
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter. DeepSeek Flash/Pro only.
 * Tests never need Redis, DeepSeek, or Fal.
 */

const crypto = require('crypto');

const REDIS_PREFIX = 'sira:engine:';
const FIRST_BYTE_TTL_SEC = 24 * 3600;
const PIN_HASH_LEN = 16;
const MAX_PINS = 12;

const realFirstByte = {
  n: 0,
  sum: 0,
  last: 0,
  sources: { sse: 0, stream: 0, loop: 0, scripted: 0 },
  hydrated: false,
};

function pinContentHash(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s) return '';
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, PIN_HASH_LEN);
}

function dedupPinsByHash(pins, { max = MAX_PINS } = {}) {
  const list = Array.isArray(pins) ? pins : [];
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const p of list) {
    const text = typeof p === 'string' ? p : String((p && (p.text || p.content || p.fact)) || '');
    const hash = (p && p.hash) || pinContentHash(text);
    if (!hash) continue;
    if (seen.has(hash)) { dropped += 1; continue; }
    seen.add(hash);
    const item = typeof p === 'string' ? { text, hash } : { ...p, text, hash };
    out.push(item);
    if (out.length >= Math.max(1, Number(max) || MAX_PINS)) break;
  }
  return { pins: out, dropped, code: dropped ? 'pin_dedup' : null };
}

function isPgvectorError(err) {
  if (!err) return false;
  const c = String(err.code || err.message || '').toLowerCase();
  return c === 'pgvector_failed' || c.includes('pgvector') || c.includes('embedding');
}

async function defaultMemoryRecall({ userId, chatId, query, store } = {}) {
  try {
    const mem = require('./memory');
    if (mem && typeof mem.recallForTurn === 'function') {
      return await mem.recallForTurn({ userId, chatId, query, store });
    }
  } catch (err) {
    if (isPgvectorError(err)) throw err;
  }
  if (store && typeof store.recall === 'function') {
    return store.recall({ userId, chatId, query, k: 5 });
  }
  return [];
}

async function retrieveBeforeGenerate({
  query,
  userId = null,
  chatId = null,
  recall = null,
  store = null,
} = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, hits: [], pins: [], skipped: true, code: null };
  let hits;
  try {
    const fn = typeof recall === 'function' ? recall : defaultMemoryRecall;
    try {
      const dur = require('./engine-durability');
      hits = await dur.retrieveMemoryForLoop({
        query: q,
        userId,
        chatId,
        store,
        recall: fn,
      });
    } catch (inner) {
      if (inner && inner.code === 'pgvector_failed') throw inner;
      hits = await fn({ userId, chatId, query: q, store });
    }
  } catch (err) {
    const code = isPgvectorError(err) ? 'pgvector_failed' : 'retrieve_before';
    const wrapped = err instanceof Error ? err : new Error(code);
    wrapped.code = code;
    return { ok: false, hits: [], pins: [], code, error: String(wrapped.message || code) };
  }
  let list = Array.isArray(hits) ? hits : [];
  try {
    const corr = require('./engine-correctness');
    const skipped = corr.retrieveSkipExpiredPins(list);
    list = skipped.hits || list;
    const acl = corr.filterMemoryAclNamespace(list, { userId, namespace: userId });
    list = acl.hits || list;
  } catch (_) { /* optional */ }
  const dedup = dedupPinsByHash(list);
  return {
    ok: true,
    hits: dedup.pins,
    pins: dedup.pins.map((p) => p.text).filter(Boolean),
    dropped: dedup.dropped,
    code: dedup.dropped ? 'pin_dedup' : 'retrieve_before',
  };
}

function casPutDurable(store, rec) {
  const st = store && typeof store === 'object' ? store : new Map();
  const id = String((rec && (rec.checkpointId || rec.id || rec.threadId)) || 'head');
  const expected = rec && rec.expectedVersion != null ? Number(rec.expectedVersion) : null;
  const cur = typeof st.get === 'function' ? st.get(id) : st[id];
  const curVer = cur && cur.version != null ? Number(cur.version) : 0;
  if (expected != null && Number(expected) !== curVer) {
    return { ok: false, code: 'ckpt_cas', version: curVer, expected: Number(expected), id };
  }
  const next = {
    id,
    checkpointId: rec && rec.checkpointId ? String(rec.checkpointId) : id,
    version: curVer + 1,
    state: rec && rec.state ? rec.state : (cur && cur.state) || null,
    metadata: rec && rec.metadata ? rec.metadata : (cur && cur.metadata) || {},
    at: Date.now(),
    ok: true,
    code: null,
  };
  if (typeof st.set === 'function') st.set(id, next);
  else st[id] = next;
  return { ok: true, code: null, version: next.version, id, rec: next };
}

function casGetDurable(store, id) {
  const st = store && typeof store === 'object' ? store : new Map();
  const key = String(id || '');
  const rec = typeof st.get === 'function' ? st.get(key) : st[key];
  if (!rec) return { ok: false, code: 'checkpoint_missing', state: null, version: 0, id: key };
  return { ok: true, code: null, state: rec.state, version: rec.version, id: rec.id || key, rec };
}

async function casSwapLatest(kv, threadId, { expectedVersion = null, nextId, state = null } = {}) {
  const tid = String(threadId || '').trim();
  if (!tid) return { ok: false, code: 'ckpt_cas', error: 'threadId vacio' };
  const key = `${REDIS_PREFIX}ckpt:${tid}:head`;
  let curVer = 0;
  let curId = null;
  if (kv && typeof kv.get === 'function') {
    try {
      const raw = await kv.get(key);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        curVer = parsed && parsed.version != null ? Number(parsed.version) : 0;
        curId = parsed && parsed.id ? String(parsed.id) : null;
      }
    } catch (_) { /* treat as empty head */ }
  }
  if (expectedVersion != null && Number(expectedVersion) !== curVer) {
    return { ok: false, code: 'ckpt_cas', version: curVer, expected: Number(expectedVersion), id: curId };
  }
  const next = {
    version: curVer + 1,
    id: String(nextId || `ckpt_${Date.now()}`),
    at: Date.now(),
    state: state || undefined,
  };
  if (kv && typeof kv.set === 'function') {
    try {
      await kv.set(key, JSON.stringify(next), 'EX', 6 * 3600);
      await kv.set(`${REDIS_PREFIX}ckpt:${tid}:latest`, next.id, 'EX', 6 * 3600);
    } catch (_) { /* fail-open: caller still has in-memory ckpt */ }
  }
  return { ok: true, code: null, version: next.version, id: next.id };
}

async function autoResumeLatest({ checkpointStore, resumeFrom = null } = {}) {
  if (resumeFrom) {
    return { ok: true, id: String(resumeFrom), source: 'explicit', skipped: false, code: null };
  }
  if (!checkpointStore || typeof checkpointStore.latest !== 'function') {
    return { ok: true, id: null, source: null, skipped: true, code: null };
  }
  let rec = null;
  try { rec = await checkpointStore.latest(); } catch (_) { rec = null; }
  if (!rec) {
    return { ok: true, id: null, source: 'recreate', skipped: true, code: 'checkpoint_missing' };
  }
  const id = rec.checkpointId || rec.id || null;
  if (rec.expired) {
    return { ok: false, id, rec, source: 'recreate', skipped: false, code: 'checkpoint_expired' };
  }
  return { ok: true, id, rec, source: 'recreate', skipped: false, code: 'resume_recreate' };
}

function checkpointStateWithPins(state, pins) {
  const st = state && typeof state === 'object' ? { ...state } : {};
  const list = Array.isArray(pins) ? pins.slice() : [];
  st.pins = list;
  return st;
}

function restorePinsFromCheckpoint(snap) {
  const src = snap && (snap.state && snap.state.pins ? snap.state.pins : snap.pins);
  if (!Array.isArray(src)) return { pins: [], restored: 0, ok: false, code: 'checkpoint_missing' };
  const dedup = dedupPinsByHash(src);
  return { pins: dedup.pins, restored: dedup.pins.length, ok: true, code: null };
}

function uniqueOccurrenceReplace(before, oldStr, newStr) {
  const src = String(before ?? '');
  const old = String(oldStr ?? '');
  if (!old.length) {
    return { ok: false, code: 'git_hunk_ambiguous', error: 'old_string vacio', content: src };
  }
  const first = src.indexOf(old);
  if (first < 0) {
    return { ok: false, code: 'git_hunk_ambiguous', error: 'hunk no coincide', content: src };
  }
  const second = src.indexOf(old, first + old.length);
  if (second >= 0) {
    return { ok: false, code: 'git_hunk_ambiguous', error: 'hunk no es unico', content: src };
  }
  return {
    ok: true,
    content: src.slice(0, first) + String(newStr ?? '') + src.slice(first + old.length),
    code: null,
  };
}

function defaultSyntaxValidate(pathName, content) {
  try {
    return require('./engine-reliability').syntaxValidate(pathName, content);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), code: 'syntax_invalid' };
  }
}

async function writeWithSyntaxRevert({
  relPath,
  content,
  before = null,
  existed = null,
  readFile = null,
  writeFile,
  unlink = null,
  syntaxValidate = null,
} = {}) {
  const pathName = String(relPath || '');
  const body = content == null ? '' : String(content);
  const validate = typeof syntaxValidate === 'function' ? syntaxValidate : defaultSyntaxValidate;
  let original = before;
  let hadFile = existed;
  if (original == null && typeof readFile === 'function') {
    try {
      original = await readFile(pathName);
      hadFile = true;
    } catch (_) {
      original = null;
      hadFile = false;
    }
  }
  if (typeof original !== 'string' && original != null) original = String(original);
  let pre;
  try { pre = validate(pathName, body); } catch (err) {
    pre = { ok: false, error: String(err && err.message || err) };
  }
  if (pre && pre.ok === false) {
    return { ok: false, code: 'write_syntax_revert', error: pre.error || 'syntax_invalid', reverted: true, wrote: false };
  }
  if (typeof writeFile !== 'function') {
    return { ok: false, code: 'atomic_write', error: 'writeFile required' };
  }
  try { await writeFile(pathName, body); } catch (err) {
    return { ok: false, code: 'atomic_write', error: String(err && err.message || err), wrote: false };
  }
  let post;
  try { post = validate(pathName, body); } catch (err) {
    post = { ok: false, error: String(err && err.message || err) };
  }
  if (post && post.ok === false) {
    try {
      if (hadFile && original != null) await writeFile(pathName, original);
      else if (typeof unlink === 'function') await unlink(pathName);
    } catch (_) { /* best-effort revert */ }
    return { ok: false, code: 'write_syntax_revert', error: post.error || 'syntax_invalid', reverted: true, wrote: true };
  }
  let after = body;
  if (typeof readFile === 'function') {
    try { after = await readFile(pathName); } catch (_) { after = body; }
  }
  try {
    const cmp = require('./engine-correctness').readAfterWriteCompare({
      before: original == null ? '' : original,
      after,
      hunk: { old: original == null ? '' : original, new: body },
    });
    if (cmp && cmp.noop) {
      return { ok: false, code: 'write_noop', wrote: true, reverted: false, noop: true };
    }
  } catch (_) { /* optional */ }
  return { ok: true, code: null, wrote: true, reverted: false };
}

function applyExactDiffOrRevert({
  relPath, diff, before, writeFile, unlink, syntaxValidate, root = '/workspace',
} = {}) {
  let parsed;
  try { parsed = require('./engine-advance').parseUnifiedDiff(diff); } catch (err) {
    return { ok: false, used: true, code: 'git_hunk_ambiguous', error: String(err && err.message || err) };
  }
  if (!parsed || !parsed.ok) {
    return { ok: false, used: Boolean(parsed), code: (parsed && parsed.code) || 'git_hunk_ambiguous', error: parsed && parsed.error };
  }
  let applied;
  try { applied = require('./engine-advance').applyHunksExact(before, parsed.hunks); } catch (err) {
    return { ok: false, used: true, code: 'git_hunk_ambiguous', error: String(err && err.message || err) };
  }
  if (!applied || !applied.ok) {
    return { ok: false, used: true, code: (applied && applied.code) || 'git_hunk_ambiguous', error: applied && applied.error };
  }
  return {
    ok: true,
    used: true,
    content: applied.content,
    hunks: parsed.hunks.length,
    code: null,
    relPath,
    root,
  };
}

function accountCreditsOnCancel({ hold = null, usage = null, aborted = true } = {}) {
  const snap = usage && typeof usage.snapshot === 'function'
    ? usage.snapshot()
    : (usage && typeof usage === 'object' ? usage : {});
  const used = Number(snap.totalTokens) || ((Number(snap.promptTokens) || 0) + (Number(snap.completionTokens) || 0));
  if (!hold) return { ok: true, skipped: true, used, code: null };
  let settled = null;
  let released = null;
  if (aborted && typeof hold.settle === 'function') {
    try { settled = hold.settle(used); } catch (_) { settled = { ok: false }; }
  }
  if (typeof hold.release === 'function') {
    try { released = hold.release(); } catch (_) { released = { ok: false }; }
  }
  return { ok: true, used, settled, released, code: 'credit_cancel' };
}

function remainingPlanBudget({ parentRemaining = 0, childUsed = 0, childCap = null } = {}) {
  const parent = Math.max(0, Number(parentRemaining) || 0);
  const used = Math.max(0, Number(childUsed) || 0);
  let rem = Math.max(0, parent - used);
  if (childCap != null) {
    const cap = Math.max(0, Number(childCap) || 0);
    rem = Math.min(rem, cap);
  }
  if (parent <= 0 || rem <= 0) {
    return { ok: false, remaining: 0, parent, used, code: 'plan_budget' };
  }
  return { ok: true, remaining: rem, parent, used, code: null };
}

function snapshotRealFirstByte() {
  return {
    count: realFirstByte.n,
    last: realFirstByte.last,
    mean: realFirstByte.n ? realFirstByte.sum / realFirstByte.n : 0,
    sources: { ...realFirstByte.sources },
    hydrated: realFirstByte.hydrated,
    p50: null,
    p95: null,
    note: 'stream/sse/loop samples; never invented Flash numbers',
  };
}

function observeRealFirstByte(ms, { source = 'stream' } = {}) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return snapshotRealFirstByte();
  const src = ['sse', 'stream', 'loop', 'scripted'].includes(String(source)) ? String(source) : 'stream';
  realFirstByte.n += 1;
  realFirstByte.sum += n;
  realFirstByte.last = n;
  realFirstByte.sources[src] = (realFirstByte.sources[src] || 0) + 1;
  try { require('./engine-parity').observeFirstByte(n); } catch (_) { /* optional */ }
  try { require('./engine-reliability').observeFirstToken(n); } catch (_) { /* optional */ }
  return snapshotRealFirstByte();
}

function resetRealFirstByte() {
  realFirstByte.n = 0;
  realFirstByte.sum = 0;
  realFirstByte.last = 0;
  realFirstByte.sources = { sse: 0, stream: 0, loop: 0, scripted: 0 };
  realFirstByte.hydrated = false;
  return snapshotRealFirstByte();
}

async function persistFirstByteSamples(kv, snap = null) {
  if (!kv || typeof kv.set !== 'function') return { ok: false, skipped: true, code: 'first_byte_real' };
  const body = snap || snapshotRealFirstByte();
  try {
    await kv.set(`${REDIS_PREFIX}first-byte`, JSON.stringify(body), 'EX', FIRST_BYTE_TTL_SEC);
    return { ok: true, code: 'first_byte_real', count: body.count };
  } catch (_) {
    return { ok: false, code: 'first_byte_real' };
  }
}

async function hydrateFirstByteSamples(kv) {
  if (!kv || typeof kv.get !== 'function') return { ok: true, hydrated: false, skipped: true, code: 'first_byte_real' };
  if (realFirstByte.hydrated) return { ok: true, hydrated: true, skipped: true, code: 'first_byte_real' };
  try {
    const raw = await kv.get(`${REDIS_PREFIX}first-byte`);
    if (!raw) return { ok: true, hydrated: false, code: 'first_byte_real' };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const count = Number(parsed && parsed.count) || 0;
    const last = Number(parsed && parsed.last) || 0;
    const mean = Number(parsed && parsed.mean) || 0;
    if (count > 0 && realFirstByte.n === 0) {
      realFirstByte.n = count;
      realFirstByte.last = last;
      realFirstByte.sum = mean * count;
      if (parsed.sources && typeof parsed.sources === 'object') {
        realFirstByte.sources = { ...realFirstByte.sources, ...parsed.sources };
      }
    }
    realFirstByte.hydrated = true;
    return { ok: true, hydrated: true, count: realFirstByte.n, code: 'first_byte_real' };
  } catch (_) {
    return { ok: false, hydrated: false, code: 'first_byte_real' };
  }
}

async function consumeStreamUntilFirstByte(iterator, { startedAt = null, onChunk = null } = {}) {
  const start = startedAt != null ? Number(startedAt) : Date.now();
  let first = null;
  if (!iterator || typeof iterator[Symbol.asyncIterator] !== 'function' && typeof iterator[Symbol.iterator] !== 'function') {
    return { ok: false, firstByteMs: null, code: 'first_byte_real' };
  }
  for await (const chunk of iterator) {
    if (first == null) {
      first = Date.now() - start;
      observeRealFirstByte(first, { source: 'stream' });
    }
    if (typeof onChunk === 'function') {
      try { onChunk(chunk); } catch (_) { /* UI must never fail the stream */ }
    }
  }
  return { ok: true, firstByteMs: first, code: 'first_byte_real' };
}

function integritySnapshot() {
  return {
    retrieveBeforeGenerate: true,
    pinHashDedup: true,
    ckptCasDurable: true,
    resumeAfterRecreate: true,
    uniqueReplace: true,
    writeSyntaxRevert: true,
    creditCancelSettle: true,
    planBudgetNested: true,
    firstByteReal: true,
    firstByteHydrate: true,
    openrouterGenerate: false,
    interpreter: 'local',
    firstByte: snapshotRealFirstByte(),
  };
}

module.exports = {
  REDIS_PREFIX,
  pinContentHash,
  dedupPinsByHash,
  defaultMemoryRecall,
  retrieveBeforeGenerate,
  casPutDurable,
  casGetDurable,
  casSwapLatest,
  autoResumeLatest,
  checkpointStateWithPins,
  restorePinsFromCheckpoint,
  uniqueOccurrenceReplace,
  writeWithSyntaxRevert,
  applyExactDiffOrRevert,
  accountCreditsOnCancel,
  remainingPlanBudget,
  observeRealFirstByte,
  snapshotRealFirstByte,
  resetRealFirstByte,
  persistFirstByteSamples,
  hydrateFirstByteSamples,
  consumeStreamUntilFirstByte,
  integritySnapshot,
  isPgvectorError,
};
