'use strict';

/**
 * 3H55 — agent-loop robustness helpers (engine-only).
 *
 * Complements 3H46 without duplicating its caps/redacts/locks.
 * Pure functions + tiny in-memory maps. DeepSeek Flash/Pro only;
 * no OpenRouter generate client.
 */

const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const WAVE = '3H55';
const SUBAGENT_DEPTH_MAX = 2;
const SANDBOX_PER_SESSION_MAX = 2;
const DEFAULT_SUBAGENT_WALL_MS = 30_000;
const BACKOFF_408_BASE_MS = 120;
const TTFB_P95_DEFAULT_MS = 8_000;
const UTF8_CONT = 0b11000000;
const UTF8_LEAD2 = 0b11000000;
const UTF8_LEAD3 = 0b11100000;
const UTF8_LEAD4 = 0b11110000;

const FLAGS = Object.freeze({
  completeLoopOnlyAfterToolResultsSettle: true,
  retryIfStopReasonLength: true,
  cutLoopIfRepairDidNotChangeArgs: true,
  rejectNullToolArguments: true,
  repairPartialToolCallName: true,
  backoffOn408RequestTimeout: true,
  refuseUnknownToolAgainstManifest: true,
  repairJsonUnquotedKeysOnce: true,
  cutPlanIfStepsExceedSessionBudget: true,
  detectToolPingPongABAB: true,
  refuseSubagentDepthOver2: true,
  inheritSubagentWallClockMs: true,
  compactPinSelectedMessageIds: true,
  dropImagesBeforeTextWhenOverBudget: true,
  rejectPgvectorDimMismatch: true,
  dedupeMemoryHitsByContentHash: true,
  refuseRollbackOnCrcMismatch: true,
  rollbackRestoreSizeAndHash: true,
  validateUnifiedDiffHunkHeaders: true,
  syntaxValidateJsOrJsonAfterWrite: true,
  revertWriteOnSyntaxFail: true,
  readAfterWriteByteEqual: true,
  refuseOverlappingDiffHunks: true,
  splitUtf8SafeStreamChunk: true,
  capConcurrentSandboxPerSession: true,
  cleanupTmpEvenIfSpawnNeverStarted: true,
  heartbeatIncludesLastEventId: true,
  resumeSkipIdsLteLastEventId: true,
  rejectHeartbeatFromOtherSession: true,
  cancelDrainThenClose: true,
  rejectOutOfOrderEnqueueSeq: true,
  requireToolResultFollowsToolCall: true,
  dropEventsFromSupersededWriter: true,
  chargeOnlyBilledTokensOnError: true,
  refundHoldRemainderIfUnderReserved: true,
  neverDoubleChargeCachedPromptTokens: true,
  recordCancelPartialUsage: true,
  classifyEpipeAsClientGone: true,
  neverRetry422Unprocessable: true,
  actionableErrorHint: true,
  ttfbHintWhenOverP95: true,
  wave: WAVE,
  openrouterGenerate: false,
  interpreter: 'local',
});

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function stableJson(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function crc32OfBuffer(buf) {
  try {
    const z = require('zlib');
    if (typeof z.crc32 === 'function') return z.crc32(buf) >>> 0;
  } catch (_) { /* software */ }
  let crc = 0xFFFFFFFF;
  const poly = 0xEDB88320;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (poly & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function callIdOf(call) {
  if (!call || typeof call !== 'object') return '';
  return String(call.id || call.toolCallId || call.tool_call_id || '');
}

function argsOf(call) {
  if (!call || typeof call !== 'object') return undefined;
  if (call.arguments !== undefined) return call.arguments;
  if (call.args !== undefined) return call.args;
  if (call.function && call.function.arguments !== undefined) return call.function.arguments;
  return undefined;
}

function nameOf(call) {
  if (call == null) return '';
  if (typeof call === 'string') return call;
  return String((call.name || call.tool || (call.function && call.function.name) || '')).trim();
}

// ---------------------------------------------------------------------------
// Agent loop completion
// ---------------------------------------------------------------------------

function completeLoopOnlyAfterToolResultsSettle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let pending = [];
  const seenResults = new Set();
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      pending = m.tool_calls.map(callIdOf).filter(Boolean);
    }
    if (m.role === 'tool') {
      const id = callIdOf(m);
      if (id) seenResults.add(id);
    }
  }
  const missing = pending.filter((id) => !seenResults.has(id));
  if (missing.length) return { ok: false, pending: missing, code: 'loop_unsettle' };
  return { ok: true, pending: [], code: null };
}

function retryIfStopReasonLength(response, { retried = false } = {}) {
  const choice = response && Array.isArray(response.choices) ? response.choices[0] : response;
  const reason = String(
    (choice && (choice.finish_reason || choice.stop_reason || choice.stopReason))
    || (response && (response.finish_reason || response.stop_reason))
    || '',
  ).toLowerCase();
  if (reason === 'length' && retried !== true) {
    return { retry: true, reason: 'length', code: 'stop_length' };
  }
  return { retry: false, reason: reason || null, code: null };
}

function cutLoopIfRepairDidNotChangeArgs({ before, after, attempt = 0 } = {}) {
  const n = Number(attempt) || 0;
  if (n <= 0) return { cut: false, code: null };
  if (stableJson(before) === stableJson(after)) {
    return { cut: true, code: 'repair_noop' };
  }
  return { cut: false, code: null };
}

// ---------------------------------------------------------------------------
// Tool-call schema + retry/backoff + repair
// ---------------------------------------------------------------------------

function rejectNullToolArguments(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const kept = [];
  let dropped = 0;
  for (const c of list) {
    const args = argsOf(c);
    if (args === null) { dropped += 1; continue; }
    kept.push(c);
  }
  return { calls: kept, dropped, ok: dropped === 0, code: dropped ? 'tool_args_null' : null };
}

function repairPartialToolCallName(name) {
  let n = String(name == null ? '' : name).trim();
  if (!n) return { name: n, repaired: false, ok: false, code: 'tool_name_empty' };
  const before = n;
  n = n.replace(/[\uFFFD\u0000-\u001F]+$/g, '');
  n = n.replace(/[.(]+$/g, '');
  n = n.replace(/\s+/g, '_');
  const repaired = n !== before;
  if (!n) return { name: before, repaired: false, ok: false, code: 'tool_name_empty' };
  return { name: n, repaired, ok: true, code: repaired ? 'tool_name_repair' : null };
}

function backoffOn408RequestTimeout(err, { attempt = 0 } = {}) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || '');
  const is408 = status === 408 || code === '408' || /\b408\b|request.?timeout/i.test(msg);
  if (!is408) return { retry: false, delayMs: 0, code: null };
  const n = Math.max(0, Number(attempt) || 0);
  const delayMs = Math.min(2_500, BACKOFF_408_BASE_MS * (2 ** n));
  return { retry: true, delayMs, status: 408, code: 'http_408' };
}

function refuseUnknownToolAgainstManifest(name, manifest) {
  const n = repairPartialToolCallName(name).name;
  if (!Array.isArray(manifest) && !(manifest instanceof Set) && !manifest) {
    return { ok: true, skipped: true, name: n, code: null };
  }
  const set = manifest instanceof Set
    ? manifest
    : new Set((Array.isArray(manifest) ? manifest : []).map((x) => String(x)));
  if (!set.size) return { ok: true, skipped: true, name: n, code: null };
  if (!n || !set.has(n)) return { ok: false, name: n, code: 'tool_unknown' };
  return { ok: true, name: n, code: null };
}

function repairJsonUnquotedKeysOnce(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw);
  try { return { ok: true, value: JSON.parse(s), repaired: false, code: null }; } catch (_) { /* repair */ }
  const quoted = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  try { return { ok: true, value: JSON.parse(quoted), repaired: quoted !== s, code: quoted !== s ? 'json_unquoted_key' : null }; } catch (e) {
    return { ok: false, value: null, repaired: false, error: e.message, code: 'json_unquoted_key' };
  }
}

// ---------------------------------------------------------------------------
// Plan / subagent budget + infinite-loop cut
// ---------------------------------------------------------------------------

function cutPlanIfStepsExceedSessionBudget({ steps, remaining } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const left = Number(remaining);
  if (!Number.isFinite(left)) return { cut: false, steps: list.length, code: null };
  if (list.length > left) return { cut: true, steps: list.length, remaining: left, code: 'plan_budget' };
  return { cut: false, steps: list.length, remaining: left, code: null };
}

function detectToolPingPongABAB(names) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (list.length < 4) return { cut: false, code: null };
  const a = list[list.length - 4];
  const b = list[list.length - 3];
  const c = list[list.length - 2];
  const d = list[list.length - 1];
  if (a && b && a !== b && a === c && b === d) {
    return { cut: true, pair: [a, b], code: 'tool_ping_pong' };
  }
  return { cut: false, code: null };
}

function refuseSubagentDepthOver2(depth) {
  const n = Number(depth);
  const d = Number.isFinite(n) ? n : 0;
  if (d > SUBAGENT_DEPTH_MAX) return { ok: false, depth: d, max: SUBAGENT_DEPTH_MAX, code: 'subagent_depth' };
  return { ok: true, depth: d, max: SUBAGENT_DEPTH_MAX, code: null };
}

function inheritSubagentWallClockMs({ parentRemainingMs, childRequestedMs } = {}) {
  const parent = Number(parentRemainingMs);
  const child = Number(childRequestedMs);
  const p = Number.isFinite(parent) && parent > 0 ? parent : DEFAULT_SUBAGENT_WALL_MS;
  const c = Number.isFinite(child) && child > 0 ? child : p;
  const ms = Math.max(1, Math.min(p, c));
  return { timeoutMs: ms, inherited: Number.isFinite(parent), code: 'subagent_wall' };
}

// ---------------------------------------------------------------------------
// Long-context compact / prune / pin + pgvector
// ---------------------------------------------------------------------------

function compactPinSelectedMessageIds(messages, pinIds) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const pins = new Set((Array.isArray(pinIds) ? pinIds : []).map(String));
  if (!pins.size) return { messages: list, pinned: 0, restored: false, code: null };
  const keptIds = new Set(list.map((m) => (m && m.id != null ? String(m.id) : '')));
  let restored = 0;
  const missing = [];
  for (const id of pins) {
    if (!keptIds.has(id)) missing.push(id);
  }
  if (missing.length) restored = missing.length;
  const pinned = list.filter((m) => m && pins.has(String(m.id))).length;
  return { messages: list, pinned, restored: restored > 0, missing, code: restored ? 'compact_pin' : null };
}

function dropImagesBeforeTextWhenOverBudget(messages, { maxBytes = 32 * 1024 } = {}) {
  const list = Array.isArray(messages) ? messages.map((m) => (m && typeof m === 'object' ? { ...m } : m)) : [];
  const cap = Math.max(256, Number(maxBytes) || 32 * 1024);
  const sizeOf = (m) => Buffer.byteLength(typeof m === 'string' ? m : stableJson(m), 'utf8');
  let bytes = list.reduce((n, m) => n + sizeOf(m), 0);
  let dropped = 0;
  if (bytes <= cap) return { messages: list, dropped: 0, bytes, code: null };
  for (let i = 0; i < list.length && bytes > cap; i += 1) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;
    const content = m.content;
    const isImage = m.type === 'image'
      || m.image_url
      || (Array.isArray(content) && content.some((p) => p && (p.type === 'image_url' || p.type === 'image')));
    if (!isImage) continue;
    const before = sizeOf(m);
    if (Array.isArray(content)) {
      m.content = content.filter((p) => !(p && (p.type === 'image_url' || p.type === 'image')));
    } else {
      m.content = '';
      delete m.image_url;
    }
    dropped += 1;
    bytes -= before - sizeOf(m);
  }
  return { messages: list, dropped, bytes, code: dropped ? 'compact_drop_image' : null };
}

function rejectPgvectorDimMismatch(query, hit) {
  const q = Array.isArray(query) ? query : (query && query.embedding);
  const h = Array.isArray(hit) ? hit : (hit && (hit.embedding || hit.vector));
  if (!Array.isArray(q) || !Array.isArray(h)) return { ok: true, skipped: true, code: null };
  if (q.length !== h.length) {
    return { ok: false, queryDim: q.length, hitDim: h.length, code: 'pgvector_dim' };
  }
  return { ok: true, dim: q.length, code: null };
}

function dedupeMemoryHitsByContentHash(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const h of list) {
    const text = h == null ? '' : (typeof h === 'string' ? h : (h.content || h.text || h.chunk || stableJson(h)));
    const hash = sha256Hex(text);
    if (seen.has(hash)) { dropped += 1; continue; }
    seen.add(hash);
    kept.push(h);
  }
  return { hits: kept, dropped, code: dropped ? 'memory_dedupe' : null };
}

// ---------------------------------------------------------------------------
// Checkpoints + real rollback
// ---------------------------------------------------------------------------

function refuseRollbackOnCrcMismatch({ payload, expectedCrc, crc } = {}) {
  let raw;
  if (Buffer.isBuffer(payload)) raw = payload;
  else if (typeof payload === 'string') raw = Buffer.from(payload, 'utf8');
  else {
    try { raw = Buffer.from(JSON.stringify(payload == null ? {} : payload), 'utf8'); } catch (_) {
      raw = Buffer.from(String(payload), 'utf8');
    }
  }
  const got = crc32OfBuffer(raw);
  const expRaw = expectedCrc != null ? expectedCrc : crc;
  if (expRaw == null) return { ok: true, crc: got, skipped: true, code: null };
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: true, crc: got, skipped: true, code: null };
  if ((got >>> 0) !== (exp >>> 0)) return { ok: false, crc: got, expected: exp >>> 0, code: 'ckpt_crc_mismatch' };
  return { ok: true, crc: got, expected: exp >>> 0, code: null };
}

function rollbackRestoreSizeAndHash({ before, after, expectedSize, expectedHash } = {}) {
  const a = after == null ? '' : (Buffer.isBuffer(after) ? after : Buffer.from(String(after), 'utf8'));
  const b = before == null ? null : (Buffer.isBuffer(before) ? before : Buffer.from(String(before), 'utf8'));
  const size = a.length;
  const hash = sha256Hex(a);
  const wantSize = expectedSize != null ? Number(expectedSize) : (b ? b.length : null);
  const wantHash = expectedHash != null ? String(expectedHash) : (b ? sha256Hex(b) : null);
  const sizeOk = wantSize == null || size === wantSize;
  const hashOk = wantHash == null || hash === wantHash;
  if (!sizeOk || !hashOk) return { ok: false, size, hash, code: 'ckpt_rollback_mismatch' };
  return { ok: true, size, hash, code: null };
}

// ---------------------------------------------------------------------------
// Exact diff file edits
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/m;

function validateUnifiedDiffHunkHeaders(diff) {
  const s = String(diff == null ? '' : diff);
  if (!s.trim()) return { ok: false, hunks: 0, code: 'diff_empty' };
  const hunks = [];
  const re = new RegExp(HUNK_RE.source, 'gm');
  let m;
  while ((m = re.exec(s))) {
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: Number(m[2] != null ? m[2] : 1),
      newStart: Number(m[3]),
      newLines: Number(m[4] != null ? m[4] : 1),
    });
  }
  if (!hunks.length) return { ok: false, hunks: 0, code: 'diff_hunk' };
  return { ok: true, hunks: hunks.length, parsed: hunks, code: null };
}

function syntaxValidateJsOrJsonAfterWrite({ path: filePath, content } = {}) {
  const p = String(filePath || '');
  const text = content == null ? '' : String(content);
  try {
    if (/\.json$/i.test(p)) {
      JSON.parse(text);
      return { ok: true, kind: 'json', code: null };
    }
    if (/\.(js|mjs|cjs|ts)$/i.test(p)) {
      // Compile only — never run.
      // eslint-disable-next-line no-new
      new vm.Script(text, { filename: p });
      return { ok: true, kind: 'js', code: null };
    }
    return { ok: true, kind: 'skip', code: null };
  } catch (err) {
    return { ok: false, kind: /\.json$/i.test(p) ? 'json' : 'js', error: err.message, code: 'syntax_invalid' };
  }
}

function revertWriteOnSyntaxFail({ ok, before, apply } = {}) {
  if (ok !== false) return { reverted: false, code: null };
  if (typeof apply === 'function') {
    apply(before);
    return { reverted: true, code: 'write_reverted' };
  }
  return { reverted: false, pending: true, code: 'write_reverted' };
}

function readAfterWriteByteEqual({ expected, actual } = {}) {
  const e = expected == null ? Buffer.alloc(0) : (Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), 'utf8'));
  const a = actual == null ? Buffer.alloc(0) : (Buffer.isBuffer(actual) ? actual : Buffer.from(String(actual), 'utf8'));
  if (e.length === a.length && e.equals(a)) return { ok: true, equal: true, code: null };
  return { ok: false, equal: false, expectedBytes: e.length, actualBytes: a.length, code: 'raw_mismatch' };
}

function refuseOverlappingDiffHunks(hunks) {
  const list = Array.isArray(hunks) ? hunks.slice() : [];
  const ranges = list.map((h) => {
    const start = Number(h && (h.oldStart != null ? h.oldStart : h.start));
    const lines = Number(h && (h.oldLines != null ? h.oldLines : h.lines));
    const lo = Number.isFinite(start) ? start : 0;
    const hi = lo + (Number.isFinite(lines) ? Math.max(0, lines) : 0);
    return { lo, hi };
  }).sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i].lo < ranges[i - 1].hi) {
      return { ok: false, overlap: true, code: 'diff_overlap' };
    }
  }
  return { ok: true, overlap: false, hunks: ranges.length, code: null };
}

// ---------------------------------------------------------------------------
// Sandbox stdout/stderr stream + limits + cleanup
// ---------------------------------------------------------------------------

function splitUtf8SafeStreamChunk(chunk, leftover) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk == null ? '' : String(chunk), 'utf8');
  const prev = Buffer.isBuffer(leftover) ? leftover : Buffer.alloc(0);
  const combined = prev.length ? Buffer.concat([prev, buf]) : buf;
  let cut = combined.length;
  // Walk back incomplete trailing UTF-8 sequence (max 3 continuation bytes).
  for (let i = 0; i < 3 && cut > 0; i += 1) {
    const b = combined[cut - 1];
    if ((b & UTF8_CONT) !== 0x80) break;
    cut -= 1;
  }
  if (cut > 0) {
    const lead = combined[cut - 1];
    const need = (lead & UTF8_LEAD4) === UTF8_LEAD4 ? 4
      : (lead & UTF8_LEAD3) === UTF8_LEAD3 ? 3
        : (lead & UTF8_LEAD2) === UTF8_LEAD2 ? 2
          : 1;
    if (combined.length - (cut - 1) < need) cut -= 1;
  }
  const ready = combined.subarray(0, Math.max(0, cut));
  const rest = combined.subarray(Math.max(0, cut));
  return { text: ready.toString('utf8'), leftover: rest, split: rest.length > 0, code: rest.length ? 'utf8_split' : null };
}

function capConcurrentSandboxPerSession({ active, max = SANDBOX_PER_SESSION_MAX } = {}) {
  const n = Number(active) || 0;
  const cap = Math.max(1, Number(max) || SANDBOX_PER_SESSION_MAX);
  if (n >= cap) return { ok: false, active: n, max: cap, code: 'sandbox_session_cap' };
  return { ok: true, active: n, max: cap, code: null };
}

function cleanupTmpEvenIfSpawnNeverStarted(dirs, { rm = fs.rmSync } = {}) {
  const list = Array.isArray(dirs) ? dirs : (dirs ? [dirs] : []);
  let cleaned = 0;
  for (const d of list) {
    if (!d) continue;
    try {
      rm(String(d), { recursive: true, force: true });
      cleaned += 1;
    } catch (_) { /* best-effort */ }
  }
  return { cleaned, code: cleaned ? 'sandbox_tmp_cleanup' : null };
}

// ---------------------------------------------------------------------------
// SSE heartbeats + resume + cancel
// ---------------------------------------------------------------------------

function heartbeatIncludesLastEventId({ lastEventId, seq } = {}) {
  const id = lastEventId != null ? lastEventId : seq;
  const n = Number(id);
  const sid = Number.isFinite(n) && n >= 0 ? String(n) : '0';
  return { frame: `: hb id=${sid}\n\n`, id: sid, code: 'sse_hb_id' };
}

function resumeSkipIdsLteLastEventId(events, lastEventId) {
  const list = Array.isArray(events) ? events : [];
  const cursor = Number(lastEventId);
  if (!Number.isFinite(cursor)) return { events: list, skipped: 0, code: null };
  const kept = [];
  let skipped = 0;
  for (const e of list) {
    const id = Number(e && (e.id != null ? e.id : e.eventId));
    if (Number.isFinite(id) && id <= cursor) { skipped += 1; continue; }
    kept.push(e);
  }
  return { events: kept, skipped, cursor, code: skipped ? 'sse_resume_skip' : null };
}

function rejectHeartbeatFromOtherSession({ sessionKey, hbSessionKey } = {}) {
  const a = String(sessionKey == null ? '' : sessionKey);
  const b = String(hbSessionKey == null ? '' : hbSessionKey);
  if (!a || !b) return { ok: true, skipped: true, code: null };
  if (a !== b) return { ok: false, code: 'sse_hb_session' };
  return { ok: true, code: null };
}

function cancelDrainThenClose({ closed, drained, aborted } = {}) {
  if (closed) return { close: false, drain: false, code: null };
  if (aborted === true && drained !== true) {
    return { close: true, drain: true, code: 'sse_cancel_drain' };
  }
  return { close: true, drain: drained === true, code: aborted ? 'sse_cancel_drain' : null };
}

// ---------------------------------------------------------------------------
// Per-session queue + strict event order
// ---------------------------------------------------------------------------

function rejectOutOfOrderEnqueueSeq({ lastSeq, nextSeq } = {}) {
  const last = Number(lastSeq);
  const next = Number(nextSeq);
  if (!Number.isFinite(next)) return { ok: false, code: 'queue_seq' };
  if (!Number.isFinite(last)) return { ok: true, seq: next, code: null };
  if (next <= last) return { ok: false, lastSeq: last, nextSeq: next, code: 'queue_seq' };
  return { ok: true, seq: next, code: null };
}

function requireToolResultFollowsToolCall(events) {
  const list = Array.isArray(events) ? events : [];
  const open = new Set();
  const kept = [];
  let dropped = 0;
  for (const e of list) {
    const typ = String((e && (e.type || e.event || e.kind)) || '').toLowerCase();
    const id = callIdOf(e);
    if (typ === 'tool_call' || typ === 'tool_call_start') {
      if (id) open.add(id);
      kept.push(e);
      continue;
    }
    if (typ === 'tool_result' || typ === 'tool_call_end') {
      if (id && !open.has(id)) { dropped += 1; continue; }
      if (id) open.delete(id);
      kept.push(e);
      continue;
    }
    kept.push(e);
  }
  return { events: kept, dropped, ok: dropped === 0, code: dropped ? 'event_order' : null };
}

function dropEventsFromSupersededWriter({ writerId, activeWriterId, events } = {}) {
  const active = String(activeWriterId == null ? '' : activeWriterId);
  const writer = String(writerId == null ? '' : writerId);
  if (active && writer && active !== writer) {
    return { drop: true, events: [], code: 'writer_superseded' };
  }
  return { drop: false, events: Array.isArray(events) ? events : [], code: null };
}

// ---------------------------------------------------------------------------
// Exact credit / token accounting
// ---------------------------------------------------------------------------

function chargeOnlyBilledTokensOnError({ billed, estimated, error } = {}) {
  const b = Number(billed);
  const e = Number(estimated);
  const billedOk = Number.isFinite(b) && b >= 0;
  const tokens = billedOk ? b : 0;
  return {
    charge: Boolean(error) && tokens > 0,
    tokens,
    ignoredEstimate: Number.isFinite(e) && e !== tokens,
    code: error ? 'credit_billed_only' : null,
  };
}

function refundHoldRemainderIfUnderReserved({ reserved, used } = {}) {
  const r = Number(reserved);
  const u = Number(used);
  const reservedN = Number.isFinite(r) && r > 0 ? r : 0;
  const usedN = Number.isFinite(u) && u > 0 ? u : 0;
  const refund = Math.max(0, reservedN - usedN);
  return { refund, reserved: reservedN, used: usedN, code: refund > 0 ? 'credit_refund_remainder' : null };
}

function neverDoubleChargeCachedPromptTokens({ promptTokens, cachedTokens, chargedCached } = {}) {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const cached = Math.max(0, Number(cachedTokens) || 0);
  if (chargedCached === true && cached > 0) {
    return { tokens: Math.max(0, prompt - cached), subtracted: cached, code: 'credit_cached_once' };
  }
  return { tokens: prompt, subtracted: 0, code: null };
}

function recordCancelPartialUsage({ cancelled, promptTokens, completionTokens } = {}) {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const completion = Math.max(0, Number(completionTokens) || 0);
  if (cancelled !== true) return { record: false, promptTokens: prompt, completionTokens: completion, code: null };
  return {
    record: true,
    promptTokens: prompt,
    completionTokens: completion,
    tokens: prompt + completion,
    code: 'credit_cancel_partial',
  };
}

// ---------------------------------------------------------------------------
// Classified actionable errors + latency hints
// ---------------------------------------------------------------------------

function classifyEpipeAsClientGone(err) {
  if (err == null) return { gone: false, retryable: false, code: null };
  const blob = `${(err && (err.code || err.errno || err.name)) || ''} ${(err && err.message) || ''}`.toUpperCase();
  if (blob.indexOf('EPIPE') >= 0) return { gone: true, retryable: false, code: 'client_gone' };
  return { gone: false, retryable: false, code: null };
}

function neverRetry422Unprocessable(err) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || '');
  const is422 = status === 422 || code === '422' || /\b422\b|unprocessable/i.test(msg);
  if (is422) return { retry: false, status: 422, code: 'unprocessable' };
  return { retry: null, status: Number.isFinite(status) ? status : null, code: null };
}

const HINTS = Object.freeze({
  loop_unsettle: 'Espera a que terminen las herramientas antes de cerrar el turno.',
  stop_length: 'La respuesta se cortó. Reintenta con menos contexto.',
  repair_noop: 'La reparación no cambió los argumentos. No reintento en bucle.',
  tool_args_null: 'La herramienta llegó sin argumentos. Pide de nuevo el JSON.',
  tool_unknown: 'Esa herramienta no está en el manifiesto de este turno.',
  http_408: 'El proveedor tardó demasiado (408). Reintento con backoff.',
  tool_ping_pong: 'Dos herramientas se llaman en ping-pong. Corté el bucle.',
  plan_budget: 'El plan pide más pasos de los que quedan en el presupuesto.',
  subagent_depth: 'No anides más de dos subagentes.',
  pgvector_dim: 'El embedding no coincide en dimensión. No recupero memoria.',
  ckpt_crc_mismatch: 'El checkpoint está corrupto. No hago rollback.',
  syntax_invalid: 'El archivo quedó con sintaxis inválida. Revertí el write.',
  raw_mismatch: 'Lo escrito no coincide con lo leído. Revertí el cambio.',
  diff_overlap: 'Los hunks del diff se solapan. Pide un patch limpio.',
  sandbox_session_cap: 'Esta sesión ya tiene sandboxes al tope. Espera.',
  sse_hb_session: 'El heartbeat pertenece a otra sesión. Ignóralo.',
  queue_seq: 'El evento llegó fuera de orden. Rechacé el enqueue.',
  event_order: 'Un tool_result llegó sin su tool_call. Lo descarté.',
  writer_superseded: 'Otro writer reclamó la sesión. Descarté eventos viejos.',
  credit_billed_only: 'Solo cobro tokens facturados, no la estimación.',
  credit_refund_remainder: 'Devuelvo la reserva no usada.',
  credit_cached_once: 'Los prompt tokens cacheados no se cobran dos veces.',
  credit_cancel_partial: 'Cancelación: registré el uso parcial y no inventé tokens.',
  client_gone: 'El cliente cerró el socket (EPIPE). No reintento.',
  unprocessable: '422: el payload no es reparable. No reintento.',
  ttfb_slow: 'El primer token tardó más que el p95. Avisa latencia.',
});

function actionableErrorHint(code) {
  const c = String(code || '');
  const hint = HINTS[c] || null;
  return { hint, actionable: Boolean(hint), code: hint ? c : null };
}

function ttfbHintWhenOverP95({ ttfbMs, p95 = TTFB_P95_DEFAULT_MS } = {}) {
  const t = Number(ttfbMs);
  const cap = Math.max(1, Number(p95) || TTFB_P95_DEFAULT_MS);
  if (!Number.isFinite(t)) return { hint: false, code: null };
  if (t > cap) return { hint: true, ttfbMs: t, p95: cap, code: 'ttfb_slow' };
  return { hint: false, ttfbMs: t, p95: cap, code: null };
}

function snapshotFlags() {
  return { ...FLAGS };
}

module.exports = {
  WAVE,
  FLAGS,
  snapshotFlags,
  completeLoopOnlyAfterToolResultsSettle,
  retryIfStopReasonLength,
  cutLoopIfRepairDidNotChangeArgs,
  rejectNullToolArguments,
  repairPartialToolCallName,
  backoffOn408RequestTimeout,
  refuseUnknownToolAgainstManifest,
  repairJsonUnquotedKeysOnce,
  cutPlanIfStepsExceedSessionBudget,
  detectToolPingPongABAB,
  refuseSubagentDepthOver2,
  inheritSubagentWallClockMs,
  compactPinSelectedMessageIds,
  dropImagesBeforeTextWhenOverBudget,
  rejectPgvectorDimMismatch,
  dedupeMemoryHitsByContentHash,
  refuseRollbackOnCrcMismatch,
  rollbackRestoreSizeAndHash,
  validateUnifiedDiffHunkHeaders,
  syntaxValidateJsOrJsonAfterWrite,
  revertWriteOnSyntaxFail,
  readAfterWriteByteEqual,
  refuseOverlappingDiffHunks,
  splitUtf8SafeStreamChunk,
  capConcurrentSandboxPerSession,
  cleanupTmpEvenIfSpawnNeverStarted,
  heartbeatIncludesLastEventId,
  resumeSkipIdsLteLastEventId,
  rejectHeartbeatFromOtherSession,
  cancelDrainThenClose,
  rejectOutOfOrderEnqueueSeq,
  requireToolResultFollowsToolCall,
  dropEventsFromSupersededWriter,
  chargeOnlyBilledTokensOnError,
  refundHoldRemainderIfUnderReserved,
  neverDoubleChargeCachedPromptTokens,
  recordCancelPartialUsage,
  classifyEpipeAsClientGone,
  neverRetry422Unprocessable,
  actionableErrorHint,
  ttfbHintWhenOverP95,
};
