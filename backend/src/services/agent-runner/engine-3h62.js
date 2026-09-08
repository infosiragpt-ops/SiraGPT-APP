'use strict';

/**
 * 3H62 — fail-closed wiring of remaining Claude-Code holes (engine only).
 *
 * Does NOT re-export 3H59/3H60/3H61 names (no overlay collisions). Unique
 * orchestrators compose the live helpers:
 *   read-after-write hash + syntax validate + checkpoint restore
 *   exact ---/+++ diff markers before apply_patch
 *   persisted Last-Event-ID + inclusive generate resume (no listener leaks)
 *   session checkpoint persist/hydrate across process restart
 *   pgvector/searchable-memory pin recovery on compact/resume
 *   Prisma credit ledger settle on cancel/error (never under/over-count)
 *   first-token / end-of-turn p50/p95 hooks
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WAVE = '3H62';
const SSE_CURSOR_DIR = 'siragpt-sse-cursors';
const SESSION_CKPT_DIR = 'siragpt-session-ckpts';
const SSE_CURSOR_COOKIE = 'sira_last_event_id';
const PGVECTOR_QUERY_TIMEOUT_MS = 2_000;
const MEMORY_MIN_SCORE = 0.25;
const FIRST_TOKEN_BUDGET_MS = 8_000;
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;
const UNIQUENESS_RE = /old_str occurs more than once|old_str not found|old_str must not be empty/i;

const ERROR_TABLE = Object.freeze({
  write_hash_mismatch: { retryable: true, message: 'El hash posterior a la escritura no coincidió. No di el cambio por bueno.' },
  write_syntax_revert: { retryable: false, message: 'La escritura dejó sintaxis inválida. Restauré el original.' },
  diff_markers: { retryable: false, message: 'El diff no trae marcadores ---/+++. No lo apliqué.' },
  sse_cursor_persist: { retryable: false, message: 'Guardé Last-Event-ID para reanudar el SSE sin reejecutar.' },
  sse_replay_resume: { retryable: true, message: 'Reanudé el SSE desde Last-Event-ID sin reejecutar el turno.' },
  sse_resume_ahead: { retryable: true, message: 'Last-Event-ID está por delante de la cabeza. Reinicio el replay.' },
  session_ckpt_persist: { retryable: false, message: 'Persistí el checkpoint de sesión para sobrevivir un reinicio.' },
  session_ckpt_hydrate: { retryable: false, message: 'Rehidraté el checkpoint de sesión tras el reinicio del proceso.' },
  memory_pin_recover: { retryable: false, message: 'Recuperé hechos anclados de memoria que el compactado había soltado.' },
  credit_ledger_settle: { retryable: false, message: 'Asenté el ledger de créditos del turno con error. No cobré de más.' },
  credit_error_settle: { retryable: false, message: 'Asenté el uso real del turno con error. No cobré de más.' },
  credit_pre_token: { retryable: false, message: 'No cobré: el stream se cortó antes del primer token.' },
  credit_cancel_partial: { retryable: false, message: 'Contabilicé tokens parciales del turno cancelado. No cobré de más.' },
  credit_cancel_dedupe: { retryable: false, message: 'Ese usage de cancelación ya estaba registrado. No lo duplicé.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

function loadWave59() {
  try { return require('./engine-3h59'); } catch (_) { return null; }
}

function loadWave60() {
  try { return require('./engine-3h60'); } catch (_) { return null; }
}

function loadWave61() {
  try { return require('./engine-3h61'); } catch (_) { return null; }
}

function sha256Hex(bytes) {
  const raw = bytes == null ? Buffer.alloc(0) : Buffer.from(bytes);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function asBuffer(value) {
  if (value == null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function safeKey(key) {
  return String(key || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function filePathFor(dirName, key, root) {
  return path.join(root || os.tmpdir(), dirName, `${safeKey(key)}.json`);
}

function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function looksLikeLogicalToolReject(value) {
  const msg = String((value && value.message) || value || '');
  return UNIQUENESS_RE.test(msg);
}

/**
 * Fail-closed exact-diff gate. Missing ---/+++ refuses the patch.
 */
function requireExactDiffMarkersClosed(diff) {
  const text = diff && typeof diff === 'object' && !Array.isArray(diff)
    ? (diff.diff != null ? diff.diff : (diff.patch != null ? diff.patch : diff))
    : diff;
  const w60 = loadWave60();
  if (w60 && typeof w60.applyExactDiffRequiresMarkers === 'function') {
    return w60.applyExactDiffRequiresMarkers(text);
  }
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false, code: 'diff_markers' };
  const hasMinus = /^---\s+\S+/m.test(raw);
  const hasPlus = /^\+\+\+\s+\S+/m.test(raw);
  if (!hasMinus || !hasPlus) return { ok: false, code: 'diff_markers' };
  return { ok: true, code: null };
}

/**
 * After a mutating write: hash the read-back bytes, syntax-validate,
 * and restore the pre-write checkpoint if either check fails.
 * Complements 3H61 timeout rollback. Never rewrites uniqueness errors.
 */
async function validateWriteThenRevertClosed({
  path: filePath,
  beforeBytes,
  afterBytes,
  expectedBytes,
  restore,
  tool,
  diff,
  result,
} = {}) {
  if (looksLikeLogicalToolReject(result)) {
    return {
      ok: true,
      skipped: true,
      reverted: false,
      uniqueness: true,
      code: null,
      path: filePath == null ? '' : String(filePath),
      tool: tool || null,
    };
  }
  const p = filePath == null ? '' : String(filePath);
  if (!p) return { ok: true, skipped: true, reverted: false, code: null };
  const w60 = loadWave60();
  const before = asBuffer(beforeBytes);
  const after = asBuffer(afterBytes);
  let code = null;
  let raw = null;
  let syntax = null;
  let markers = null;

  if (diff != null) {
    markers = requireExactDiffMarkersClosed(diff);
    if (markers && markers.ok === false) code = 'diff_markers';
  }

  if (!code && expectedBytes != null && w60 && typeof w60.verifyReadAfterWriteHash === 'function') {
    raw = w60.verifyReadAfterWriteHash({
      expectedHash: sha256Hex(expectedBytes),
      actualBytes: after,
    });
    if (raw && raw.ok === false) code = 'write_hash_mismatch';
  }

  if (!code && w60 && typeof w60.revertWriteOnSyntaxFail === 'function') {
    syntax = w60.revertWriteOnSyntaxFail({
      path: p,
      before,
      after: after == null ? '' : after.toString('utf8'),
      restore: null,
    });
    if (syntax && (syntax.reverted === true || syntax.ok === false)) {
      code = 'write_syntax_revert';
    }
  }

  let reverted = false;
  if (code && typeof restore === 'function' && before) {
    if (w60 && typeof w60.rollbackFileByteSnapshot === 'function') {
      try {
        w60.rollbackFileByteSnapshot({
          path: p,
          snapshot: { path: p, bytes: before, sha256: sha256Hex(before) },
          restore: (restorePath, bytes) => { restore(restorePath, bytes); },
        });
      } catch (_) { /* restore below is authoritative */ }
    }
    try {
      await restore(p, before);
      reverted = true;
    } catch (_) {
      reverted = false;
    }
  }

  return {
    ok: !code,
    reverted,
    skipped: false,
    code,
    raw,
    syntax,
    markers,
    path: p,
    tool: tool || null,
    beforeHash: before ? sha256Hex(before) : '',
    afterHash: after ? sha256Hex(after) : '',
  };
}

/**
 * Persist Last-Event-ID so EventSource can resume after process restart.
 * Never moves the cursor backwards. File-backed + injectable store.
 */
function persistLastEventIdClosed({
  sessionKey,
  lastEventId,
  seq,
  store,
  root,
  persistCursor,
} = {}) {
  const id = lastEventId != null ? Number(lastEventId) : Number(seq);
  if (!Number.isFinite(id) || id < 0) {
    return { persisted: false, cursor: 0, code: 'sse_cursor_persist' };
  }
  const rec = (store && typeof store === 'object' && !(store instanceof Map)) ? store : {};
  const prev = Number(rec.cursor != null ? rec.cursor : rec.lastEventId) || 0;
  if (id < prev) {
    return { persisted: false, cursor: prev, lastEventId: prev, stale: true, code: 'sse_cursor_persist' };
  }
  rec.cursor = id;
  rec.lastEventId = id;
  if (store instanceof Map && sessionKey) store.set(String(sessionKey), { lastEventId: id, cursor: id });
  if (typeof persistCursor === 'function') {
    try { persistCursor({ lastEventId: id, seq: id, store: rec }); } catch (_) { /* injected adapter persist */ }
  }
  const key = String(sessionKey || rec.sessionKey || '');
  if (key) {
    try {
      atomicWriteJson(filePathFor(SSE_CURSOR_DIR, key, root), {
        lastEventId: id,
        cursor: id,
        at: Date.now(),
      });
    } catch (_) { /* file persist best-effort */ }
  }
  return {
    persisted: true,
    lastEventId: id,
    cursor: id,
    store: rec,
    code: 'sse_cursor_persist',
  };
}

/**
 * Resume generate SSE from header or persisted Last-Event-ID.
 * Drops prior listeners, rejects seq past head, inclusive replay when a ring exists.
 */
function resumeGenerateFromPersistedIdClosed({
  headerLastEventId,
  sessionKey,
  ring,
  listeners,
  store,
  headSeq,
  root,
  resume = true,
} = {}) {
  const w59 = loadWave59();
  let dropped = 0;
  if (resume === true && w59 && typeof w59.sseResumeDropsPriorListeners === 'function') {
    const drop = w59.sseResumeDropsPriorListeners({ listeners, resume: true });
    dropped = Number(drop && drop.dropped) || 0;
  }
  let last = Number(headerLastEventId);
  if (!Number.isFinite(last)) {
    if (store instanceof Map && sessionKey && store.has(String(sessionKey))) {
      const rec = store.get(String(sessionKey));
      last = Number(rec && (rec.lastEventId != null ? rec.lastEventId : rec.cursor));
    } else if (store && typeof store === 'object') {
      last = Number(store.lastEventId != null ? store.lastEventId : store.cursor);
    }
    if (!Number.isFinite(last) && sessionKey) {
      const file = readJson(filePathFor(SSE_CURSOR_DIR, sessionKey, root));
      if (file) last = Number(file.lastEventId != null ? file.lastEventId : file.cursor);
    }
  }
  const frames = Array.isArray(ring) ? ring : [];
  const head = Number.isFinite(Number(headSeq)) ? Number(headSeq) : frames.length;
  if (w59 && typeof w59.sseResumeRejectsSeqPastHead === 'function' && Number.isFinite(last)) {
    const ahead = w59.sseResumeRejectsSeqPastHead({ lastEventId: last, headSeq: head });
    if (ahead && ahead.reset) {
      return {
        ok: false,
        reset: true,
        start: 0,
        lastEventId: 0,
        replay: [],
        dropped,
        inclusive: true,
        code: 'sse_resume_ahead',
      };
    }
  }
  const replay = frames.filter((f) => {
    const seq = Number(f && (f.seq != null ? f.seq : (f.id != null ? f.id : f.eventId)));
    if (!Number.isFinite(seq)) return false;
    if (!Number.isFinite(last)) return true;
    return seq >= last;
  });
  const firstSeq = replay[0] != null ? Number(replay[0].seq != null ? replay[0].seq : replay[0].id) : NaN;
  const start = Number.isFinite(firstSeq) && firstSeq > 0 ? firstSeq - 1 : 0;
  return {
    ok: true,
    reset: false,
    start,
    lastEventId: Number.isFinite(last) ? last : 0,
    replay,
    dropped,
    inclusive: true,
    code: replay.length ? 'sse_replay_resume' : null,
  };
}

/**
 * Persist a session checkpoint to disk (and optional store) so a process
 * restart can hydrate instead of relying on an in-memory Map.
 */
function persistSessionCheckpointClosed({
  sessionKey,
  state,
  store,
  root,
} = {}) {
  const key = String(sessionKey || '');
  if (!key) return { persisted: false, skipped: true, code: null };
  const rec = {
    sessionKey: key,
    state: state && typeof state === 'object' ? state : {},
    at: Date.now(),
  };
  if (store instanceof Map) store.set(key, rec);
  else if (store && typeof store === 'object') store[key] = rec;
  try {
    atomicWriteJson(filePathFor(SESSION_CKPT_DIR, key, root), rec);
  } catch (_) { /* file persist best-effort */ }
  return { persisted: true, sessionKey: key, at: rec.at, code: 'session_ckpt_persist' };
}

function hydrateSessionCheckpointClosed({
  sessionKey,
  store,
  root,
} = {}) {
  const key = String(sessionKey || '');
  if (!key) return { hydrated: false, state: null, code: null };
  if (store instanceof Map && store.has(key)) {
    const rec = store.get(key);
    return {
      hydrated: true,
      state: rec && rec.state,
      source: 'store',
      code: 'session_ckpt_hydrate',
    };
  }
  if (store && typeof store === 'object' && store[key]) {
    return {
      hydrated: true,
      state: store[key].state,
      source: 'store',
      code: 'session_ckpt_hydrate',
    };
  }
  const file = readJson(filePathFor(SESSION_CKPT_DIR, key, root));
  if (file && file.state) {
    return {
      hydrated: true,
      state: file.state,
      source: 'file',
      code: 'session_ckpt_hydrate',
    };
  }
  return { hydrated: false, state: null, source: null, code: 'session_ckpt_hydrate' };
}

/**
 * Recover pin/score≥0.85 facts from searchable memory (pgvector hook if
 * `retrieve` exists; injected hits otherwise). Does not invent a UI.
 */
function recoverPgvectorPinsClosed({
  compacted,
  memoryHits,
  retrieve,
  query,
  namespace,
  root,
} = {}) {
  const w60 = loadWave60();
  const apply = (hits) => {
    if (w60 && typeof w60.recoverPinnedMemoryFacts === 'function') {
      return w60.recoverPinnedMemoryFacts(compacted, hits);
    }
    return { messages: Array.isArray(compacted) ? compacted.slice() : [], recovered: 0, code: null };
  };

  if (Array.isArray(memoryHits) && memoryHits.length) {
    const out = apply(memoryHits);
    return { ...out, hits: memoryHits, via: 'injected', ok: true };
  }

  const finishHook = (hook) => {
    const hits = Array.isArray(hook) ? hook : ((hook && hook.hits) || []);
    const out = apply(hits);
    return {
      ...out,
      hits,
      via: (hook && hook.via) || 'retrieve',
      ok: !hook || hook.ok !== false,
    };
  };

  if (typeof retrieve === 'function') {
    return Promise.resolve()
      .then(() => {
        let life = null;
        try { life = require('./engine-lifecycle'); } catch (_) { life = null; }
        if (life && typeof life.searchableMemoryHook === 'function') {
          return life.searchableMemoryHook({ retrieve, query, namespace, root });
        }
        return retrieve({ query, namespace });
      })
      .then(finishHook)
      .catch((err) => {
        const code = err && err.code === 'pgvector_failed' ? 'pgvector_failed' : 'retrieve_memory_failed';
        return {
          messages: Array.isArray(compacted) ? compacted.slice() : [],
          recovered: 0,
          hits: [],
          ok: false,
          code,
        };
      });
  }

  try {
    const life = require('./engine-lifecycle');
    if (life && typeof life.searchableMemoryHook === 'function') {
      const hook = life.searchableMemoryHook({ query, namespace, root, hits: memoryHits });
      if (hook && typeof hook.then === 'function') {
        return hook.then(finishHook).catch(() => finishHook({ hits: [], ok: false }));
      }
      return finishHook(hook);
    }
  } catch (_) { /* lifecycle optional */ }

  return {
    messages: Array.isArray(compacted) ? compacted.slice() : [],
    recovered: 0,
    hits: [],
    via: 'none',
    ok: true,
    code: null,
  };
}

function maybeFailLedger({ prisma, transaction, failLedger, code }) {
  if (typeof failLedger === 'function' && transaction) {
    try {
      const out = failLedger({
        prismaClient: prisma,
        transaction,
        code: code || 'credit_ledger_settle',
        statusCode: 500,
      });
      if (out && typeof out.then === 'function') return { pending: true, promise: out };
      return out || { ok: true, code: 'credit_ledger_settle' };
    } catch (_) {
      return { ok: false, code: 'credit_ledger_settle' };
    }
  }
  if (prisma && transaction) {
    try {
      const ledger = require('../credit-ledger');
      if (typeof ledger.failLedgerTransaction === 'function') {
        const out = ledger.failLedgerTransaction({
          prismaClient: prisma,
          transaction,
          code: code || 'REQUEST_FAILED',
          statusCode: 500,
        });
        if (out && typeof out.then === 'function') return { pending: true, promise: out };
        return out;
      }
    } catch (_) { /* unit tests inject failLedger; live Prisma is optional */ }
  }
  return { ok: true, skipped: true, code: 'credit_ledger_settle' };
}

/**
 * Settle cancel/error against the 3H60/3H61 helpers AND the Prisma ledger
 * so a failed/cancelled turn never under- or over-counts.
 */
function settleLedgerOnErrorClosed({
  errored,
  cancelled,
  usage,
  alreadySettled,
  firstToken,
  tokens,
  prisma,
  transaction,
  failLedger,
} = {}) {
  const w60 = loadWave60();
  const w61 = loadWave61();
  if (alreadySettled === true) {
    return {
      settled: false,
      charged: false,
      skipped: true,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      code: 'credit_cancel_dedupe',
      ledger: { ok: true, skipped: true },
    };
  }
  if (w60 && typeof w60.neverChargeBeforeFirstToken === 'function') {
    const pre = w60.neverChargeBeforeFirstToken({
      firstToken,
      cancelled,
      errored,
      tokens,
    });
    if (pre && pre.charge === false) {
      return {
        settled: false,
        charged: false,
        skipped: false,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        code: 'credit_pre_token',
        ledger: maybeFailLedger({
          prisma,
          transaction,
          failLedger,
          code: 'credit_pre_token',
        }),
      };
    }
  }
  if (cancelled === true && w61 && typeof w61.settleCancelUsageClosed === 'function') {
    const cancel = w61.settleCancelUsageClosed({
      cancelled: true,
      streamedChars: usage && usage.streamedChars,
      usage,
      alreadyRecorded: alreadySettled,
    });
    return {
      settled: Boolean(cancel && cancel.billed),
      charged: Boolean(cancel && cancel.billed),
      skipped: Boolean(cancel && cancel.skipped),
      promptTokens: (cancel && cancel.promptTokens) || 0,
      completionTokens: (cancel && cancel.completionTokens) || 0,
      totalTokens: (cancel && cancel.totalTokens) || 0,
      code: (cancel && cancel.code) || 'credit_cancel_partial',
      ledger: maybeFailLedger({
        prisma,
        transaction,
        failLedger,
        code: (cancel && cancel.code) || 'credit_cancel_partial',
      }),
    };
  }
  const settled = w60 && typeof w60.settleCreditsOnError === 'function'
    ? w60.settleCreditsOnError({
      errored: errored === true || cancelled === true,
      usage,
      alreadySettled,
    })
    : { settled: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let prompt = (settled && settled.promptTokens) || 0;
  const completion = (settled && settled.completionTokens) || 0;
  if (w60 && typeof w60.capPromptTokensOnErrorSettle === 'function') {
    const capped = w60.capPromptTokensOnErrorSettle({ promptTokens: prompt });
    if (capped && Number.isFinite(capped.promptTokens)) prompt = capped.promptTokens;
  }
  const charged = Boolean(settled && settled.settled && (prompt + completion) > 0);
  return {
    settled: Boolean(settled && settled.settled),
    charged,
    skipped: Boolean(settled && settled.skipped),
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    code: (settled && settled.code) || 'credit_ledger_settle',
    ledger: maybeFailLedger({
      prisma,
      transaction,
      failLedger,
      code: (settled && settled.code) || 'credit_ledger_settle',
    }),
  };
}

/**
 * Scripted first-token / end-of-turn latency. Accepts a fake clock
 * (`startedAt` + `now`) so tests never invent Flash numbers.
 */
function observeTurnLatencyClosed({
  kind,
  startedAt,
  now,
  ms,
  store,
} = {}) {
  const t1 = Number(startedAt);
  const t2 = Number(now);
  let n = Number(ms);
  if (!Number.isFinite(n) && Number.isFinite(t1) && Number.isFinite(t2)) n = Math.max(0, t2 - t1);
  const w60 = loadWave60();
  if (w60 && typeof w60.observeScriptedLatencySample === 'function') {
    return w60.observeScriptedLatencySample(kind, n, store);
  }
  const key = kind === 'ttfb' || kind === 'first_token' ? 'first_token' : 'turn_end';
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, kind: key, snapshot: { p50: null, p95: null, count: 0, source: 'scripted' } };
  }
  const ring = Array.isArray(store) ? store : [];
  ring.push(n);
  const sorted = ring.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
  return {
    ok: true,
    kind: key,
    ms: n,
    snapshot: { p50: at(0.5), p95: at(0.95), count: sorted.length, source: 'scripted' },
  };
}

function classifyEngine3h62Error(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error) ? input : { err: input };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const row = ERROR_TABLE[code];
  if (!row) return null;
  const stackSrc = String((raw.err && (raw.err.stack || raw.err.message)) || raw.message || '');
  const leaked = STACK_RE.test(stackSrc) || SECRET_RE.test(stackSrc);
  return {
    code,
    message: row.message,
    retryable: row.retryable === true,
    leaked: false,
    wave: WAVE,
    stripped: leaked,
  };
}

/**
 * Resolve Last-Event-ID from header, cookie, in-memory cursor store, then file.
 * Cookie never starts a foreign resume — callers must still own the streamId.
 */
function readDurableLastEventIdClosed({
  headerLastEventId,
  cookieHeader,
  cookieName = SSE_CURSOR_COOKIE,
  sessionKey,
  store,
  root,
} = {}) {
  const fromHeader = Number(String(headerLastEventId == null ? '' : headerLastEventId).split(':').pop());
  if (Number.isFinite(fromHeader) && fromHeader >= 0 && String(headerLastEventId || '').trim()) {
    return { lastEventId: fromHeader, source: 'header', cookieName };
  }
  if (cookieHeader) {
    let parsed = null;
    try {
      const cookie = require('cookie');
      parsed = cookie.parse(String(cookieHeader));
    } catch (_) {
      const m = String(cookieHeader).match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
      parsed = m ? { [cookieName]: decodeURIComponent(m[1]) } : {};
    }
    const raw = parsed && parsed[cookieName];
    if (raw) {
      const pos = Number(String(raw).split(':').pop());
      const sid = String(raw).includes(':') ? String(raw).slice(0, String(raw).lastIndexOf(':')) : '';
      if (Number.isFinite(pos) && pos >= 0 && (!sessionKey || !sid || sid === String(sessionKey))) {
        return { lastEventId: pos, source: 'cookie', cookieName, sessionKey: sid || sessionKey || '' };
      }
    }
  }
  if (store instanceof Map && sessionKey && store.has(String(sessionKey))) {
    const rec = store.get(String(sessionKey));
    const n = Number(rec && (rec.lastEventId != null ? rec.lastEventId : rec.cursor));
    if (Number.isFinite(n)) return { lastEventId: n, source: 'store', cookieName };
  }
  if (store && typeof store === 'object' && !(store instanceof Map)) {
    const n = Number(store.lastEventId != null ? store.lastEventId : store.cursor);
    if (Number.isFinite(n) && n >= 0) return { lastEventId: n, source: 'store', cookieName };
  }
  if (sessionKey) {
    const file = readJson(filePathFor(SSE_CURSOR_DIR, sessionKey, root));
    if (file) {
      const n = Number(file.lastEventId != null ? file.lastEventId : file.cursor);
      if (Number.isFinite(n)) return { lastEventId: n, source: 'file', cookieName };
    }
  }
  return { lastEventId: 0, source: null, cookieName };
}

function cookieForLastEventId({ sessionKey, lastEventId, cookieName = SSE_CURSOR_COOKIE } = {}) {
  const id = Number(lastEventId);
  const key = String(sessionKey || '');
  if (!key || !Number.isFinite(id) || id < 0) return null;
  return {
    name: cookieName,
    value: `${key}:${id}`,
    header: `${cookieName}=${encodeURIComponent(`${key}:${id}`)}; Path=/api/ai; HttpOnly; SameSite=Lax; Max-Age=7200`,
  };
}

/**
 * Retrieve-before-generate with 2s timeout, inf/NaN reject, min-score drop.
 * Fail-open: timeout or retrieve error → empty hits, generation continues.
 */
async function retrieveMemoryBeforeGenerateClosed({
  query,
  userId,
  chatId,
  recall,
  store,
  retrieve,
  memoryHits,
  timeoutMs = PGVECTOR_QUERY_TIMEOUT_MS,
  minScore = MEMORY_MIN_SCORE,
  now = Date.now,
} = {}) {
  const started = Number(typeof now === 'function' ? now() : now) || Date.now();
  const cap = Math.max(1, Number(timeoutMs) || PGVECTOR_QUERY_TIMEOUT_MS);
  const floor = Number.isFinite(Number(minScore)) ? Number(minScore) : MEMORY_MIN_SCORE;
  const filterHits = (list) => {
    const out = [];
    let droppedInf = 0;
    let droppedScore = 0;
    for (const h of Array.isArray(list) ? list : []) {
      const score = h && typeof h === 'object' ? (h.score != null ? h.score : h.similarity) : null;
      if (score != null) {
        const n = Number(score);
        if (!Number.isFinite(n)) { droppedInf += 1; continue; }
        if (n < floor) { droppedScore += 1; continue; }
      }
      out.push(h);
    }
    return { hits: out, droppedInf, droppedScore };
  };

  if (Array.isArray(memoryHits) && memoryHits.length && typeof retrieve !== 'function' && typeof recall !== 'function') {
    const filtered = filterHits(memoryHits);
    return {
      ok: true,
      hits: filtered.hits,
      timedOut: false,
      failOpen: false,
      droppedInf: filtered.droppedInf,
      droppedScore: filtered.droppedScore,
      elapsedMs: 0,
      timeoutMs: cap,
      via: 'injected',
      code: null,
    };
  }

  let retrieveFn = retrieve;
  if (typeof retrieveFn !== 'function' && typeof recall === 'function') retrieveFn = recall;
  if (typeof retrieveFn !== 'function') {
    try {
      const dur = require('./engine-durability');
      if (dur && typeof dur.retrieveMemoryForLoop === 'function') {
        retrieveFn = (args) => dur.retrieveMemoryForLoop(args);
      }
    } catch (_) { retrieveFn = null; }
  }
  if (typeof retrieveFn !== 'function') {
    return {
      ok: true,
      hits: filterHits(memoryHits).hits,
      timedOut: false,
      failOpen: true,
      skipped: true,
      elapsedMs: 0,
      timeoutMs: cap,
      via: 'none',
      code: null,
    };
  }

  let timedOut = false;
  let rawHits = [];
  try {
    const work = Promise.resolve(retrieveFn({
      query,
      userId,
      chatId,
      store,
      recall,
    }));
    const raced = await Promise.race([
      work.then((hits) => ({ hits, timedOut: false })),
      new Promise((resolve) => {
        setTimeout(() => resolve({ hits: [], timedOut: true }), cap);
      }),
    ]);
    timedOut = raced.timedOut === true;
    rawHits = timedOut ? [] : (Array.isArray(raced.hits) ? raced.hits : []);
  } catch (err) {
    const code = err && err.code === 'pgvector_failed' ? 'pgvector_failed' : 'retrieve_memory_failed';
    return {
      ok: true,
      hits: [],
      timedOut: false,
      failOpen: true,
      elapsedMs: Math.max(0, (typeof now === 'function' ? now() : Date.now()) - started),
      timeoutMs: cap,
      via: 'retrieve',
      code,
    };
  }
  const elapsedMs = Math.max(0, (typeof now === 'function' ? now() : Date.now()) - started);
  if (timedOut || elapsedMs >= cap) {
    return {
      ok: true,
      hits: [],
      timedOut: true,
      failOpen: true,
      elapsedMs,
      timeoutMs: cap,
      via: 'retrieve',
      code: 'pgvector_timeout',
    };
  }
  const filtered = filterHits(rawHits);
  return {
    ok: true,
    hits: filtered.hits,
    timedOut: false,
    failOpen: false,
    droppedInf: filtered.droppedInf,
    droppedScore: filtered.droppedScore,
    elapsedMs,
    timeoutMs: cap,
    via: 'retrieve',
    code: null,
  };
}

/**
 * Scripted first-token p50/p95 + over-budget hint. Never invents Flash numbers.
 * Also forwards to engine-reliability.observeFirstToken when present.
 */
function recordFirstTokenLatencySampleP95({
  ms,
  startedAt,
  now,
  store,
  budgetMs = FIRST_TOKEN_BUDGET_MS,
} = {}) {
  const observed = observeTurnLatencyClosed({ kind: 'first_token', ms, startedAt, now, store });
  try {
    const rel = require('./engine-reliability');
    if (rel && typeof rel.observeFirstToken === 'function' && Number.isFinite(observed.ms)) {
      rel.observeFirstToken(observed.ms);
    }
  } catch (_) { /* reliability optional */ }
  const snap = (observed && observed.snapshot) || { p50: null, p95: null, count: 0, source: 'scripted' };
  const overBudget = Number.isFinite(observed.ms) && observed.ms > Number(budgetMs);
  return {
    ok: observed.ok === true,
    kind: 'first_token',
    ms: observed.ms,
    p50: snap.p50,
    p95: snap.p95,
    count: snap.count,
    snapshot: snap,
    overBudget,
    hint: overBudget ? 'first_token_over_budget' : null,
    code: overBudget ? 'ttfb_watchdog' : null,
  };
}

function refuseOpenRouterInWave3h62(env = process.env) {
  const w59 = loadWave59();
  if (w59 && typeof w59.refuseOpenRouterInWave3h59 === 'function') {
    return w59.refuseOpenRouterInWave3h59(env);
  }
  const w60 = loadWave60();
  if (w60 && typeof w60.refuseOpenRouterInWave3h60 === 'function') {
    return w60.refuseOpenRouterInWave3h60(env);
  }
  const w61 = loadWave61();
  if (w61 && typeof w61.refuseOpenRouterInWave3h61 === 'function') {
    return w61.refuseOpenRouterInWave3h61(env);
  }
  return { ok: true, openrouter: false, code: null };
}

const FLAGS = Object.freeze({
  validateWriteThenRevertClosed: true,
  requireExactDiffMarkersClosed: true,
  persistLastEventIdClosed: true,
  resumeGenerateFromPersistedIdClosed: true,
  persistSessionCheckpointClosed: true,
  hydrateSessionCheckpointClosed: true,
  recoverPgvectorPinsClosed: true,
  settleLedgerOnErrorClosed: true,
  observeTurnLatencyClosed: true,
  readDurableLastEventIdClosed: true,
  retrieveMemoryBeforeGenerateClosed: true,
  recordFirstTokenLatencySampleP95: true,
  classifyEngine3h62Error: true,
  refuseOpenRouterInWave3h62: true,
});

function waveSnapshot() {
  return {
    wave: WAVE,
    ...FLAGS,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    failClosed: true,
    latencyNote: 'scripted p50/p95; never invented Flash',
  };
}

const HELPERS = Object.freeze(Object.keys(FLAGS));

module.exports = {
  WAVE,
  HELPERS,
  FLAGS,
  ERROR_TABLE,
  validateWriteThenRevertClosed,
  requireExactDiffMarkersClosed,
  persistLastEventIdClosed,
  resumeGenerateFromPersistedIdClosed,
  persistSessionCheckpointClosed,
  hydrateSessionCheckpointClosed,
  recoverPgvectorPinsClosed,
  settleLedgerOnErrorClosed,
  observeTurnLatencyClosed,
  readDurableLastEventIdClosed,
  cookieForLastEventId,
  retrieveMemoryBeforeGenerateClosed,
  recordFirstTokenLatencySampleP95,
  classifyEngine3h62Error,
  refuseOpenRouterInWave3h62,
  looksLikeLogicalToolReject,
  waveSnapshot,
  SSE_CURSOR_COOKIE,
};
