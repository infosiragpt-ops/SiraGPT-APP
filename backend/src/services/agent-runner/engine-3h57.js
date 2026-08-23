'use strict';

/**
 * 3H57 — agent-loop robustness helpers (engine-only).
 *
 * Complements 3H56 without duplicating its parallel-settle / 429 /
 * sibling-cap / git-header / RSS / 401 helpers. Pure functions + tiny
 * in-memory maps. DeepSeek Flash/Pro only; no OpenRouter generate client.
 */

const crypto = require('crypto');

const WAVE = '3H57';
const SUBAGENT_FANOUT_MAX = 3;
const CHECKPOINT_KEEP_LAST_N = 8;
const SANDBOX_STDERR_CAP = 64 * 1024;
const SANDBOX_OPEN_FILES_MAX = 64;
const QUEUE_DEPTH_MAX = 8;
const QUEUE_DEADLINE_WINDOW_MS = 1_500;
const TTFB_SLOW_MS = 8_000;
const LATENCY_SAMPLE_MAX = 64;
const MEMORY_PIN_SCORE = 0.85;
const REPAIR_ATTEMPTS_MAX = 3;

const FLAGS = Object.freeze({
  refuseFinishIfToolResultsPending: true,
  cutLoopIfSameObservationHashThrice: true,
  stopIfEmptyFinalAfterMaxRepairAttempts: true,
  refuseAssistantToolCallWithoutName: true,
  repairJsonDoubleEncodedOnce: true,
  coerceIsoDateStringOrRefuse: true,
  backoffOn503RetryAfterHeader: true,
  refuseToolIfArgTypeMismatchAfterCoerce: true,
  stripControlCharsFromToolName: true,
  inheritSubagentMaxOutputTokens: true,
  cutSubagentIfTokenBudgetZero: true,
  refuseSubagentIfParentFenceLost: true,
  capNestedSubagentFanout: true,
  compactKeepLastSystemAndPinnedFacts: true,
  rejectPgvectorDimZeroOrNegative: true,
  pinFactsWhenScoreAboveThreshold: true,
  dropDuplicateMemoryHitsById: true,
  refuseRollbackIfChecksumMismatch: true,
  checkpointKeepTombstonedSeqs: true,
  refuseRollbackIfTargetNewerThanHead: true,
  refuseDiffMissingIndexLine: true,
  verifyReadAfterWriteByteHash: true,
  refusePatchIfNewFileHasMinusLines: true,
  requireExactHunkHeaderCounts: true,
  capSandboxStderrBytesPerCommand: true,
  refuseSandboxOpenFilesOverCap: true,
  requireSandboxCwdUnderWorkspace: true,
  resumeReplaySkipAckedIds: true,
  rejectResumeIfSessionIdMismatch: true,
  dropPartialSseFrameOnCancel: true,
  heartbeatSkipIfClientGone: true,
  rejectEnqueueIfQueueDepthOverCap: true,
  promoteQueueIfDeadlineWithinMs: true,
  neverChargeIfPromptOnlyAndCancelled: true,
  settleCreditsOncePerRequestId: true,
  refundIfCompletionTokensNegative: true,
  classifyEconnrefusedAsUnavailable: true,
  neverRetry403Forbidden: true,
  latencyHintWhenTtfbOverBudget: true,
  recordStepLatencySampleP95: true,
  wave: WAVE,
  openrouterGenerate: false,
  interpreter: 'local',
});

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function nameOf(call) {
  if (!call || typeof call !== 'object') return '';
  const fn = call.function && typeof call.function === 'object' ? call.function : call;
  return String(fn.name || call.name || call.tool || '').trim();
}

function callIdOf(call) {
  if (!call || typeof call !== 'object') return '';
  return String(call.id || call.toolCallId || call.tool_call_id || '');
}

function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ---------------------------------------------------------------------------
// Agent multi-step loop
// ---------------------------------------------------------------------------

function refuseFinishIfToolResultsPending({ messages, pending } = {}) {
  if (Number.isFinite(Number(pending)) && Number(pending) > 0) {
    return { ok: false, pending: Number(pending), code: 'tool_results_pending' };
  }
  const list = Array.isArray(messages) ? messages : [];
  let lastAssistant = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'assistant') { lastAssistant = list[i]; break; }
  }
  const calls = lastAssistant && Array.isArray(lastAssistant.tool_calls) ? lastAssistant.tool_calls : [];
  if (!calls.length) return { ok: true, pending: 0, code: null };
  const needed = new Set(calls.map(callIdOf).filter(Boolean));
  if (!needed.size) return { ok: true, pending: 0, code: null };
  for (const m of list) {
    if (!m || m.role !== 'tool') continue;
    const id = String(m.tool_call_id || m.toolCallId || m.id || '');
    if (id) needed.delete(id);
  }
  if (needed.size) return { ok: false, pending: needed.size, code: 'tool_results_pending' };
  return { ok: true, pending: 0, code: null };
}

function cutLoopIfSameObservationHashThrice(hashes) {
  const list = Array.isArray(hashes) ? hashes.map((h) => String(h || '')).filter(Boolean) : [];
  if (list.length < 3) return { cut: false, code: null };
  const a = list[list.length - 3];
  const b = list[list.length - 2];
  const c = list[list.length - 1];
  if (a && a === b && b === c) return { cut: true, hash: a, code: 'obs_hash_repeat' };
  return { cut: false, code: null };
}

function stopIfEmptyFinalAfterMaxRepairAttempts({ text, repairAttempts, max = REPAIR_ATTEMPTS_MAX } = {}) {
  const n = Number(repairAttempts);
  const cap = Math.max(1, Number(max) || REPAIR_ATTEMPTS_MAX);
  const body = String(text == null ? '' : text).trim();
  if (Number.isFinite(n) && n >= cap && !body) {
    return { stop: true, empty: true, attempts: n, code: 'empty_final_repairs' };
  }
  return { stop: false, empty: !body, attempts: Number.isFinite(n) ? n : 0, code: null };
}

function refuseAssistantToolCallWithoutName(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const missing = [];
  for (const c of list) {
    if (!nameOf(c)) missing.push(callIdOf(c) || '(anon)');
  }
  if (missing.length) return { ok: false, missing, code: 'tool_name_missing' };
  return { ok: true, missing: [], code: null };
}

// ---------------------------------------------------------------------------
// Strict tool schemas + retry/repair
// ---------------------------------------------------------------------------

function repairJsonDoubleEncodedOnce(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw);
  let parsed;
  try { parsed = JSON.parse(s); } catch (e) {
    return { ok: false, value: null, repaired: false, error: e.message, code: 'json_double_encoded' };
  }
  if (typeof parsed === 'string') {
    try {
      const inner = JSON.parse(parsed);
      if (inner && typeof inner === 'object') {
        return { ok: true, value: inner, repaired: true, code: 'json_double_encoded' };
      }
    } catch (_) { /* keep outer string */ }
  }
  return { ok: true, value: parsed, repaired: false, code: null };
}

function coerceIsoDateStringOrRefuse(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { ok: true, value: value.toISOString(), coerced: true, code: 'tool_iso_date' };
  }
  if (value == null || value === '') return { ok: false, value, code: 'tool_iso_date' };
  const s = String(value).trim();
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return { ok: false, value: s, code: 'tool_iso_date' };
  const iso = new Date(t).toISOString();
  return { ok: true, value: iso, coerced: iso !== s, code: iso !== s ? 'tool_iso_date' : null };
}

function backoffOn503RetryAfterHeader(err, { attempt = 0 } = {}) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const headers = (err && (err.headers || (err.response && err.response.headers))) || {};
  const retryAfter = headers['retry-after'] || headers['Retry-After'] || (err && err.retryAfter);
  const msg = String((err && err.message) || '');
  const is503 = status === 503 || /\b503\b|service unavailable|overloaded/i.test(msg);
  if (!is503) return { retry: false, delayMs: 0, code: null };
  const n = Math.max(0, Number(attempt) || 0);
  let delayMs = Math.min(8_000, 300 * (2 ** n));
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra >= 0) delayMs = Math.min(30_000, ra > 100 ? ra : ra * 1000);
  return { retry: true, delayMs, status: 503, code: 'http_503_retry_after' };
}

function refuseToolIfArgTypeMismatchAfterCoerce({ args, schema, coerced } = {}) {
  if (!schema || typeof schema !== 'object') return { ok: true, skipped: true, code: null };
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const mismatches = [];
  for (const [key, spec] of Object.entries(props)) {
    if (!spec || !spec.type || !Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const actual = typeOfValue(obj[key]);
    const want = String(spec.type);
    if (want === 'integer') {
      if (!Number.isInteger(Number(obj[key])) || actual === 'boolean') mismatches.push(key);
      continue;
    }
    if (want === 'number') {
      if (!Number.isFinite(Number(obj[key])) || actual === 'boolean' || actual === 'string') mismatches.push(key);
      continue;
    }
    if (actual !== want) mismatches.push(key);
  }
  if (mismatches.length && coerced === true) {
    return { ok: false, mismatches, code: 'tool_type_mismatch' };
  }
  if (mismatches.length) return { ok: false, mismatches, code: 'tool_type_mismatch' };
  return { ok: true, mismatches: [], code: null };
}

function stripControlCharsFromToolName(name) {
  const raw = String(name == null ? '' : name);
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '');
  if (!cleaned) return { ok: false, name: cleaned, stripped: raw !== cleaned, code: 'tool_name_ctrl' };
  return { ok: true, name: cleaned, stripped: raw !== cleaned, code: raw !== cleaned ? 'tool_name_ctrl' : null };
}

// ---------------------------------------------------------------------------
// Subagent budget
// ---------------------------------------------------------------------------

function inheritSubagentMaxOutputTokens({ parentRemaining, childRequested, hardCap = 8192 } = {}) {
  const cap = Math.max(256, Number(hardCap) || 8192);
  const parent = Number(parentRemaining);
  const child = Number(childRequested);
  const p = Number.isFinite(parent) && parent > 0 ? parent : cap;
  const c = Number.isFinite(child) && child > 0 ? child : p;
  const tokens = Math.max(1, Math.min(cap, p, c));
  return { tokens, inherited: Number.isFinite(parent), code: 'subagent_out_tokens' };
}

function cutSubagentIfTokenBudgetZero({ remaining } = {}) {
  const n = Number(remaining);
  if (Number.isFinite(n) && n <= 0) return { cut: true, remaining: n, code: 'subagent_tokens_zero' };
  return { cut: false, remaining: Number.isFinite(n) ? n : null, code: null };
}

function refuseSubagentIfParentFenceLost({ parentFenceOk, fenceToken } = {}) {
  if (parentFenceOk === false) return { ok: false, code: 'subagent_fence_lost' };
  if (fenceToken === '') return { ok: false, code: 'subagent_fence_lost' };
  return { ok: true, code: null };
}

function capNestedSubagentFanout({ active, max = SUBAGENT_FANOUT_MAX } = {}) {
  const n = Math.max(0, Number(active) || 0);
  const cap = Math.max(1, Number(max) || SUBAGENT_FANOUT_MAX);
  if (n >= cap) return { ok: false, active: n, max: cap, code: 'subagent_fanout' };
  return { ok: true, active: n, max: cap, code: null };
}

// ---------------------------------------------------------------------------
// Compact / pgvector
// ---------------------------------------------------------------------------

function compactKeepLastSystemAndPinnedFacts(messages, pinIds) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const pins = new Set(Array.isArray(pinIds) ? pinIds.map(String) : []);
  const kept = [];
  let lastUser = -1;
  let lastAssistant = -1;
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (!m) continue;
    if (m.role === 'system') { kept.push(m); continue; }
    const id = String((m && (m.id || m.messageId)) || i);
    if (pins.has(id) || m.pin === true || (m.fact && m.pin === true)) { kept.push(m); continue; }
    if (m.role === 'user') lastUser = i;
    if (m.role === 'assistant') lastAssistant = i;
  }
  const extras = new Set(kept);
  if (lastUser >= 0 && !extras.has(list[lastUser])) kept.push(list[lastUser]);
  if (lastAssistant >= 0 && !extras.has(list[lastAssistant])) kept.push(list[lastAssistant]);
  kept.sort((a, b) => list.indexOf(a) - list.indexOf(b));
  return { messages: kept, dropped: Math.max(0, list.length - kept.length), code: 'compact_sys_pin' };
}

function rejectPgvectorDimZeroOrNegative(dim) {
  const n = Number(dim);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, dim: n, code: 'pgvector_dim' };
  return { ok: true, dim: n, code: null };
}

function pinFactsWhenScoreAboveThreshold(facts, { threshold = MEMORY_PIN_SCORE } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  const cap = Number(threshold);
  const min = Number.isFinite(cap) ? cap : MEMORY_PIN_SCORE;
  const pinned = [];
  const out = list.map((f) => {
    if (!f || typeof f !== 'object') return f;
    const score = Number(f.score != null ? f.score : f.similarity);
    if (Number.isFinite(score) && score >= min) {
      const next = { ...f, pin: true };
      pinned.push(next);
      return next;
    }
    return f;
  });
  return { facts: out, pinned: pinned.length, code: pinned.length ? 'memory_pin_score' : null };
}

function dropDuplicateMemoryHitsById(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const h of list) {
    const id = h && (h.id || h.hitId || h.factId);
    if (id == null || id === '') { kept.push(h); continue; }
    const key = String(id);
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    kept.push(h);
  }
  return { hits: kept, dropped, code: dropped ? 'memory_id_dup' : null };
}

// ---------------------------------------------------------------------------
// Checkpoint rollback
// ---------------------------------------------------------------------------

function refuseRollbackIfChecksumMismatch({ expected, actual } = {}) {
  const a = String(expected == null ? '' : expected);
  const b = String(actual == null ? '' : actual);
  if (!a) return { ok: true, skipped: true, code: null };
  if (a !== b) return { ok: false, expected: a, actual: b, code: 'ckpt_checksum' };
  return { ok: true, code: null };
}

function checkpointKeepTombstonedSeqs(list, { keep = CHECKPOINT_KEEP_LAST_N } = {}) {
  const items = Array.isArray(list) ? list.slice() : [];
  const cap = Math.max(1, Number(keep) || CHECKPOINT_KEEP_LAST_N);
  const tomb = items.filter((c) => c && (c.tombstone === true || c.deleted === true));
  const live = items.filter((c) => !(c && (c.tombstone === true || c.deleted === true)));
  const keptLive = live.slice(-cap);
  const kept = tomb.concat(keptLive);
  return { checkpoints: kept, dropped: Math.max(0, items.length - kept.length), code: 'ckpt_tombstone_keep' };
}

function refuseRollbackIfTargetNewerThanHead({ targetSeq, headSeq } = {}) {
  const t = Number(targetSeq);
  const h = Number(headSeq);
  if (!Number.isFinite(t) || !Number.isFinite(h)) return { ok: true, skipped: true, code: null };
  if (t > h) return { ok: false, targetSeq: t, headSeq: h, code: 'ckpt_future' };
  return { ok: true, targetSeq: t, headSeq: h, code: null };
}

// ---------------------------------------------------------------------------
// Exact diffs
// ---------------------------------------------------------------------------

function refuseDiffMissingIndexLine(diff) {
  const s = String(diff == null ? '' : diff);
  if (!s.trim()) return { ok: false, code: 'diff_index' };
  if (/^diff --git /m.test(s) && /^index /m.test(s)) return { ok: true, code: null };
  return { ok: false, code: 'diff_index' };
}

function verifyReadAfterWriteByteHash({ expected, actual } = {}) {
  const a = expected == null ? '' : expected;
  const b = actual == null ? '' : actual;
  const ha = typeof a === 'string' && /^[a-f0-9]{64}$/i.test(a) ? a.toLowerCase() : sha256Hex(a);
  const hb = typeof b === 'string' && /^[a-f0-9]{64}$/i.test(b) ? b.toLowerCase() : sha256Hex(b);
  if (ha !== hb) return { ok: false, expected: ha, actual: hb, code: 'raw_byte_hash' };
  return { ok: true, hash: ha, code: null };
}

function refusePatchIfNewFileHasMinusLines(diff) {
  const s = String(diff == null ? '' : diff);
  const isNew = /new file mode/i.test(s) || /^--- \/dev\/null/m.test(s);
  if (!isNew) return { ok: true, code: null };
  const minus = s.split(/\r?\n/).filter((line) => line.startsWith('-') && !line.startsWith('---'));
  if (minus.length) return { ok: false, minus: minus.length, code: 'diff_new_minus' };
  return { ok: true, code: null };
}

function requireExactHunkHeaderCounts(hunk) {
  const s = String(hunk == null ? '' : hunk);
  const m = s.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/m);
  if (!m) return { ok: false, code: 'diff_hunk_count' };
  const oldCount = Number(m[2] != null ? m[2] : 1);
  const newCount = Number(m[4] != null ? m[4] : 1);
  const body = s.replace(/^@@[^\n]*\n?/, '').split(/\r?\n/).filter((line) => line.length > 0);
  let oldSeen = 0;
  let newSeen = 0;
  for (const line of body) {
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) oldSeen += 1;
    else if (line.startsWith('+')) newSeen += 1;
    else { oldSeen += 1; newSeen += 1; }
  }
  if (oldSeen !== oldCount || newSeen !== newCount) {
    return { ok: false, oldCount, newCount, oldSeen, newSeen, code: 'diff_hunk_count' };
  }
  return { ok: true, oldCount, newCount, code: null };
}

// ---------------------------------------------------------------------------
// Sandbox limits
// ---------------------------------------------------------------------------

function capSandboxStderrBytesPerCommand({ bytes, max = SANDBOX_STDERR_CAP } = {}) {
  const n = Number(bytes);
  const cap = Math.max(1024, Number(max) || SANDBOX_STDERR_CAP);
  if (Number.isFinite(n) && n > cap) return { ok: false, bytes: n, max: cap, truncated: true, code: 'sandbox_stderr_cap' };
  return { ok: true, bytes: Number.isFinite(n) ? n : 0, max: cap, truncated: false, code: null };
}

function refuseSandboxOpenFilesOverCap({ openFiles, max = SANDBOX_OPEN_FILES_MAX } = {}) {
  const n = Number(openFiles);
  const cap = Math.max(1, Number(max) || SANDBOX_OPEN_FILES_MAX);
  if (Number.isFinite(n) && n > cap) return { ok: false, openFiles: n, max: cap, code: 'sandbox_nfiles' };
  return { ok: true, openFiles: Number.isFinite(n) ? n : 0, max: cap, code: null };
}

function requireSandboxCwdUnderWorkspace(cwd, workspace) {
  const c = String(cwd == null ? '' : cwd);
  const w = String(workspace == null ? '' : workspace);
  if (!c || !w) return { ok: true, skipped: true, code: null };
  const path = require('path');
  let resolvedC;
  let resolvedW;
  try {
    resolvedC = path.resolve(c);
    resolvedW = path.resolve(w);
  } catch (_) {
    return { ok: false, code: 'sandbox_cwd' };
  }
  const prefix = resolvedW.endsWith(path.sep) ? resolvedW : resolvedW + path.sep;
  if (resolvedC === resolvedW || resolvedC.startsWith(prefix)) {
    return { ok: true, cwd: resolvedC, workspace: resolvedW, code: null };
  }
  return { ok: false, cwd: resolvedC, workspace: resolvedW, code: 'sandbox_cwd' };
}

// ---------------------------------------------------------------------------
// SSE resume / cancel
// ---------------------------------------------------------------------------

function resumeReplaySkipAckedIds(events, lastAckedId) {
  const list = Array.isArray(events) ? events : [];
  const ack = lastAckedId == null || lastAckedId === '' ? null : Number(lastAckedId);
  if (!Number.isFinite(ack)) return { events: list, skipped: 0, code: null };
  const kept = [];
  let skipped = 0;
  for (const ev of list) {
    const id = Number(ev && (ev.id != null ? ev.id : ev.eventId));
    if (Number.isFinite(id) && id <= ack) { skipped += 1; continue; }
    kept.push(ev);
  }
  return { events: kept, skipped, code: skipped ? 'sse_skip_acked' : null };
}

function rejectResumeIfSessionIdMismatch({ sessionId, resumeSessionId } = {}) {
  const a = String(sessionId == null ? '' : sessionId);
  const b = String(resumeSessionId == null ? '' : resumeSessionId);
  if (!a || !b) return { ok: true, skipped: true, code: null };
  if (a !== b) return { ok: false, code: 'sse_session_mismatch' };
  return { ok: true, code: null };
}

function dropPartialSseFrameOnCancel({ cancelled, partial, dropped } = {}) {
  if (cancelled && partial && !dropped) return { drop: true, code: 'sse_drop_partial' };
  return { drop: false, code: null };
}

function heartbeatSkipIfClientGone({ clientGone, writableEnded, destroyed } = {}) {
  if (clientGone === true || writableEnded === true || destroyed === true) {
    return { skip: true, code: 'sse_hb_gone' };
  }
  return { skip: false, code: null };
}

// ---------------------------------------------------------------------------
// Session queue
// ---------------------------------------------------------------------------

function rejectEnqueueIfQueueDepthOverCap({ depth, max = QUEUE_DEPTH_MAX } = {}) {
  const n = Number(depth);
  const cap = Math.max(1, Number(max) || QUEUE_DEPTH_MAX);
  if (Number.isFinite(n) && n >= cap) return { ok: false, depth: n, max: cap, code: 'queue_depth' };
  return { ok: true, depth: Number.isFinite(n) ? n : 0, max: cap, code: null };
}

function promoteQueueIfDeadlineWithinMs({ remainingMs, windowMs = QUEUE_DEADLINE_WINDOW_MS } = {}) {
  const rem = Number(remainingMs);
  const win = Math.max(1, Number(windowMs) || QUEUE_DEADLINE_WINDOW_MS);
  if (Number.isFinite(rem) && rem >= 0 && rem <= win) {
    return { promote: true, remainingMs: rem, windowMs: win, code: 'queue_deadline' };
  }
  return { promote: false, remainingMs: Number.isFinite(rem) ? rem : null, windowMs: win, code: null };
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

const settledRequestIds = new Set();

function neverChargeIfPromptOnlyAndCancelled({ cancelled, promptTokens, completionTokens } = {}) {
  const prompt = Number(promptTokens);
  const completion = Number(completionTokens);
  if (cancelled === true && (completion === 0 || !Number.isFinite(completion)) && Number.isFinite(prompt) && prompt >= 0) {
    return { charge: false, code: 'credit_prompt_cancel' };
  }
  return { charge: true, code: null };
}

function settleCreditsOncePerRequestId({ requestId, terminal, settled } = {}) {
  const id = String(requestId == null ? '' : requestId);
  if (!id || terminal !== true) return { settle: false, code: null };
  if (settled === true || settledRequestIds.has(id)) {
    return { settle: false, already: true, code: 'credit_settle_req' };
  }
  settledRequestIds.add(id);
  return { settle: true, already: false, code: 'credit_settle_req' };
}

function resetSettledRequestIdsForTests() {
  settledRequestIds.clear();
}

function refundIfCompletionTokensNegative({ completionTokens } = {}) {
  const n = Number(completionTokens);
  if (Number.isFinite(n) && n < 0) return { refund: true, tokens: 0, code: 'credit_neg_completion' };
  return { refund: false, tokens: Number.isFinite(n) ? n : 0, code: null };
}

// ---------------------------------------------------------------------------
// Classified errors + latency
// ---------------------------------------------------------------------------

function classifyEconnrefusedAsUnavailable(err) {
  const blob = `${String((err && (err.code || err.errno || err.name)) || '')} ${String((err && err.message) || '')}`.toUpperCase();
  if (blob.includes('ECONNREFUSED')) {
    return { unavailable: true, retryable: true, code: 'net_econnrefused' };
  }
  return { unavailable: false, retryable: false, code: null };
}

function neverRetry403Forbidden(err) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const msg = String((err && (err.code || err.message)) || '');
  if (status === 403 || /\b403\b|forbidden/i.test(msg)) {
    return { retry: false, status: 403, code: 'http_403' };
  }
  return { retry: true, code: null };
}

function latencyHintWhenTtfbOverBudget({ ttfbMs, budgetMs = TTFB_SLOW_MS } = {}) {
  const t = Number(ttfbMs);
  const cap = Math.max(1, Number(budgetMs) || TTFB_SLOW_MS);
  if (!Number.isFinite(t)) return { hint: false, code: null };
  if (t > cap) return { hint: true, ttfbMs: t, budgetMs: cap, code: 'ttfb_slow' };
  return { hint: false, ttfbMs: t, budgetMs: cap, code: null };
}

const latencySamples = [];

function recordStepLatencySampleP95(elapsedMs) {
  const n = Number(elapsedMs);
  if (!Number.isFinite(n) || n < 0) return { recorded: false, p95: null, code: null };
  latencySamples.push(n);
  if (latencySamples.length > LATENCY_SAMPLE_MAX) latencySamples.splice(0, latencySamples.length - LATENCY_SAMPLE_MAX);
  const sorted = latencySamples.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[idx];
  return { recorded: true, p95, samples: sorted.length, code: 'step_p95' };
}

function resetLatencySamplesForTests() {
  latencySamples.length = 0;
}

const HINTS = Object.freeze({
  tool_results_pending: 'Hay tool_results pendientes. No cierro el turno.',
  obs_hash_repeat: 'La misma observación se repitió tres veces. Corté el bucle.',
  empty_final_repairs: 'Tras reparar, el final sigue vacío. Paro.',
  tool_name_missing: 'Hay una tool_call sin nombre. La rechazo.',
  json_double_encoded: 'Reparé JSON doble-encoded de la herramienta.',
  tool_iso_date: 'La fecha no es ISO-8601 válida.',
  http_503_retry_after: '503: reintento respetando Retry-After.',
  tool_type_mismatch: 'Tras coercer, el tipo del argumento no coincide.',
  tool_name_ctrl: 'Quité caracteres de control del nombre de la herramienta.',
  subagent_out_tokens: 'El subagente hereda el tope de tokens de salida del padre.',
  subagent_tokens_zero: 'El subagente no tiene tokens restantes. Corté.',
  subagent_fence_lost: 'El padre perdió el fence. No lanzo el subagente.',
  subagent_fanout: 'Este padre ya tiene el máximo de subagentes anidados.',
  compact_sys_pin: 'Compacté: system + pines + último par.',
  pgvector_dim: 'La dimensión del embedding es 0 o negativa.',
  memory_pin_score: 'Marqué pin:true los facts por encima del umbral.',
  memory_id_dup: 'Solté hits de memoria duplicados por id.',
  ckpt_checksum: 'El checksum del checkpoint no coincide. Rechacé el rollback.',
  ckpt_tombstone_keep: 'Conservé tombstones + últimos N checkpoints.',
  ckpt_future: 'El seq destino es más nuevo que el head. No hago rollback.',
  diff_index: 'El patch no trae línea index / diff --git.',
  raw_byte_hash: 'Tras el write, el hash de bytes no coincide.',
  diff_new_minus: 'Un archivo nuevo no puede tener líneas minus en el patch.',
  diff_hunk_count: 'Los conteos del hunk no coinciden con el cuerpo.',
  sandbox_stderr_cap: 'stderr del sandbox superó el tope por comando.',
  sandbox_nfiles: 'El sandbox abrió más archivos de los permitidos.',
  sandbox_cwd: 'El cwd del sandbox está fuera del workspace.',
  sse_skip_acked: 'Salté eventos SSE ya acked en el resume.',
  sse_session_mismatch: 'Last-Event-ID es de otra sesión. Rechacé el resume.',
  sse_drop_partial: 'Cancelación: solté el frame SSE parcial.',
  sse_hb_gone: 'El cliente se fue. No mando heartbeat.',
  queue_depth: 'La cola de la sesión está llena.',
  queue_deadline: 'El deadline está cerca. Subí prioridad.',
  credit_prompt_cancel: 'Cancelado con solo prompt tokens: no cobro.',
  credit_settle_req: 'El hold se liquida una sola vez por requestId.',
  credit_neg_completion: 'completion_tokens negativo: no cobro / reembolso.',
  net_econnrefused: 'ECONNREFUSED. Reintento como unavailable.',
  http_403: '403: no reintento. Permiso denegado.',
  ttfb_slow: 'El primer token tardó más que el presupuesto.',
  step_p95: 'Registré la latencia del paso para p95.',
});

function actionableErrorHint(code) {
  const c = String(code || '');
  const hint = HINTS[c] || null;
  return { hint, actionable: Boolean(hint), code: hint ? c : null };
}

function snapshotFlags() {
  return { ...FLAGS };
}

module.exports = {
  WAVE,
  FLAGS,
  snapshotFlags,
  refuseFinishIfToolResultsPending,
  cutLoopIfSameObservationHashThrice,
  stopIfEmptyFinalAfterMaxRepairAttempts,
  refuseAssistantToolCallWithoutName,
  repairJsonDoubleEncodedOnce,
  coerceIsoDateStringOrRefuse,
  backoffOn503RetryAfterHeader,
  refuseToolIfArgTypeMismatchAfterCoerce,
  stripControlCharsFromToolName,
  inheritSubagentMaxOutputTokens,
  cutSubagentIfTokenBudgetZero,
  refuseSubagentIfParentFenceLost,
  capNestedSubagentFanout,
  compactKeepLastSystemAndPinnedFacts,
  rejectPgvectorDimZeroOrNegative,
  pinFactsWhenScoreAboveThreshold,
  dropDuplicateMemoryHitsById,
  refuseRollbackIfChecksumMismatch,
  checkpointKeepTombstonedSeqs,
  refuseRollbackIfTargetNewerThanHead,
  refuseDiffMissingIndexLine,
  verifyReadAfterWriteByteHash,
  refusePatchIfNewFileHasMinusLines,
  requireExactHunkHeaderCounts,
  capSandboxStderrBytesPerCommand,
  refuseSandboxOpenFilesOverCap,
  requireSandboxCwdUnderWorkspace,
  resumeReplaySkipAckedIds,
  rejectResumeIfSessionIdMismatch,
  dropPartialSseFrameOnCancel,
  heartbeatSkipIfClientGone,
  rejectEnqueueIfQueueDepthOverCap,
  promoteQueueIfDeadlineWithinMs,
  neverChargeIfPromptOnlyAndCancelled,
  settleCreditsOncePerRequestId,
  resetSettledRequestIdsForTests,
  refundIfCompletionTokensNegative,
  classifyEconnrefusedAsUnavailable,
  neverRetry403Forbidden,
  latencyHintWhenTtfbOverBudget,
  recordStepLatencySampleP95,
  resetLatencySamplesForTests,
  actionableErrorHint,
};
