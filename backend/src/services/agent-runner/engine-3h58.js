'use strict';

/**
 * 3H58 — agent-loop robustness helpers (engine-only).
 *
 * Complements 3H57 without duplicating its pending-settle / 503 /
 * fence-fanout / exact-hunk / cwd-jail / 403 helpers. Pure functions +
 * tiny in-memory maps. DeepSeek Flash/Pro only; no OpenRouter generate client.
 */

const crypto = require('crypto');

const WAVE = '3H58';
const EMPTY_ASSISTANT_MAX = 3;
const SUBAGENT_STDOUT_CAP = 16 * 1024;
const SANDBOX_COMBINED_CAP = 96 * 1024;
const QUEUE_HARD_WAIT_MS = 90_000;
const PROMPT_TOKEN_HARD_CAP = 128_000;
const STEP_P99_SLOW_MS = 20_000;
const LATENCY_SAMPLE_MAX = 64;
const CHECKPOINT_FAILED_KEEP = 4;
const MEMORY_ACCESS_PIN = 3;
const SSE_RING_WINDOW = 64;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_PATH_RE = /(?:^|[:=])(\/(?:etc|root|home|var\/lib|usr\/local)\/|\b[A-Za-z]:\\)/i;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060]/g;

const FLAGS = Object.freeze({
  refuseFinishIfPlanHasOpenTodos: true,
  cutLoopIfSameAssistantContentHashTwice: true,
  stopIfMaxEmptyAssistantTurns: true,
  refuseToolCallIfMissingCallIdAndName: true,
  repairJsonPlusPrefixedOnce: true,
  coerceEmailStringOrRefuse: true,
  backoffOn504GatewayTimeout: true,
  refuseToolIfUnknownEnumAfterRepair: true,
  stripZeroWidthFromToolName: true,
  inheritSubagentMaxStepsFromParent: true,
  cutSubagentIfParentDeadlinePassed: true,
  refuseSubagentIfParentTokensExhausted: true,
  capSubagentStdoutBytes16KiB: true,
  compactDropOrphanToolMessages: true,
  rejectPgvectorNonFiniteNorm: true,
  pinFactsWhenAccessCountAtLeast: true,
  dropMemoryHitsWithEmptyVector: true,
  refuseRollbackIfByteLengthMismatch: true,
  checkpointKeepFailedAttemptsLastN: true,
  refuseRollbackIfUnrelatedDirtyPaths: true,
  refuseDiffMissingFromToFileHeaders: true,
  verifyReadAfterWriteSha256Prefix: true,
  refusePatchIfRenameMissingDelete: true,
  requireExactHunkStartLine: true,
  capSandboxCombinedStreamBytes: true,
  refuseSandboxEnvHostPathLeak: true,
  requireSandboxNonRootUid: true,
  resumeReplaySkipIdsOutsideRingWindow: true,
  rejectResumeIfWriterGenerationMismatch: true,
  dropHeartbeatIfSeqUnchanged: true,
  heartbeatStampServerNowMs: true,
  rejectEnqueueIfDuplicateRequestId: true,
  demoteQueueIfWaitedOverHardCap: true,
  neverChargeIfStreamNeverOpenedAndCancelled: true,
  settleCreditsOnlyAfterDoneEvent: true,
  refundIfPromptTokensExceedHardCap: true,
  classifyEtimedoutAsTimeout: true,
  neverRetry409Conflict: true,
  latencyHintWhenStepP99OverBudget: true,
  recordTurnLatencySampleP50: true,
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

function todoOpen(item) {
  if (!item) return false;
  if (typeof item === 'string') return Boolean(item.trim());
  const status = String(item.status || item.state || '').toLowerCase();
  if (status === 'done' || status === 'completed' || status === 'cancelled') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Agent multi-step loop
// ---------------------------------------------------------------------------

function refuseFinishIfPlanHasOpenTodos({ todos, plan } = {}) {
  const list = Array.isArray(todos) ? todos : (plan && Array.isArray(plan.todos) ? plan.todos : []);
  const open = list.filter(todoOpen);
  if (open.length) return { ok: false, open: open.length, code: 'plan_todos_open' };
  return { ok: true, open: 0, code: null };
}

function cutLoopIfSameAssistantContentHashTwice(hashes) {
  const list = Array.isArray(hashes) ? hashes.map((h) => String(h || '')).filter(Boolean) : [];
  if (list.length < 2) return { cut: false, code: null };
  const a = list[list.length - 2];
  const b = list[list.length - 1];
  if (a && a === b) return { cut: true, hash: a, code: 'assistant_hash_repeat' };
  return { cut: false, code: null };
}

function stopIfMaxEmptyAssistantTurns({ emptyTurns, max = EMPTY_ASSISTANT_MAX } = {}) {
  const n = Number(emptyTurns);
  const cap = Math.max(1, Number(max) || EMPTY_ASSISTANT_MAX);
  if (Number.isFinite(n) && n >= cap) {
    return { stop: true, emptyTurns: n, max: cap, code: 'empty_assistant_max' };
  }
  return { stop: false, emptyTurns: Number.isFinite(n) ? n : 0, max: cap, code: null };
}

function refuseToolCallIfMissingCallIdAndName(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const missing = [];
  for (const c of list) {
    if (!nameOf(c) && !callIdOf(c)) missing.push('(anon)');
  }
  if (missing.length) return { ok: false, missing, code: 'tool_id_name_missing' };
  return { ok: true, missing: [], code: null };
}

// ---------------------------------------------------------------------------
// Strict tool schemas + retry/repair
// ---------------------------------------------------------------------------

function repairJsonPlusPrefixedOnce(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw).trim();
  try {
    return { ok: true, value: JSON.parse(s), repaired: false, code: null };
  } catch (_) { /* try plus-prefix */ }
  if (s.startsWith('+')) {
    try {
      const value = JSON.parse(s.slice(1));
      if (value && typeof value === 'object') {
        return { ok: true, value, repaired: true, code: 'json_plus_prefix' };
      }
    } catch (e) {
      return { ok: false, value: null, repaired: false, error: e.message, code: 'json_plus_prefix' };
    }
  }
  return { ok: false, value: null, repaired: false, code: 'json_plus_prefix' };
}

function coerceEmailStringOrRefuse(value) {
  if (value == null || value === '') return { ok: false, value, code: 'tool_email' };
  const s = String(value).trim().toLowerCase();
  if (!EMAIL_RE.test(s)) return { ok: false, value: s, code: 'tool_email' };
  return { ok: true, value: s, coerced: s !== String(value), code: s !== String(value) ? 'tool_email' : null };
}

function backoffOn504GatewayTimeout(err, { attempt = 0 } = {}) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const msg = String((err && err.message) || '');
  const is504 = status === 504 || /\b504\b|gateway timeout/i.test(msg);
  if (!is504) return { retry: false, delayMs: 0, code: null };
  const n = Math.max(0, Number(attempt) || 0);
  const delayMs = Math.min(10_000, 400 * (2 ** n));
  return { retry: true, delayMs, status: 504, code: 'http_504_retry' };
}

function refuseToolIfUnknownEnumAfterRepair({ args, schema, repaired } = {}) {
  if (!schema || typeof schema !== 'object') return { ok: true, skipped: true, code: null };
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const unknown = [];
  for (const [key, spec] of Object.entries(props)) {
    if (!spec || !Array.isArray(spec.enum) || !Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const allowed = spec.enum.map((v) => String(v));
    if (!allowed.includes(String(obj[key]))) unknown.push(key);
  }
  if (unknown.length && repaired === true) {
    return { ok: false, unknown, code: 'tool_enum_unknown' };
  }
  if (unknown.length) return { ok: false, unknown, code: 'tool_enum_unknown' };
  return { ok: true, unknown: [], code: null };
}

function stripZeroWidthFromToolName(name) {
  const raw = String(name == null ? '' : name);
  const cleaned = raw.replace(ZERO_WIDTH_RE, '');
  if (!cleaned) return { ok: false, name: cleaned, stripped: raw !== cleaned, code: 'tool_name_zw' };
  return { ok: true, name: cleaned, stripped: raw !== cleaned, code: raw !== cleaned ? 'tool_name_zw' : null };
}

// ---------------------------------------------------------------------------
// Subagent budget
// ---------------------------------------------------------------------------

function inheritSubagentMaxStepsFromParent({ parentRemaining, childRequested, hardCap = 12 } = {}) {
  const cap = Math.max(1, Number(hardCap) || 12);
  const parent = Number(parentRemaining);
  const child = Number(childRequested);
  const p = Number.isFinite(parent) && parent >= 0 ? parent : cap;
  const c = Number.isFinite(child) && child > 0 ? child : cap;
  const steps = Math.max(1, Math.min(cap, p, c));
  return { steps, inherited: steps < c, code: steps < c ? 'subagent_steps' : null };
}

function cutSubagentIfParentDeadlinePassed({ parentDeadlineAt, now = Date.now() } = {}) {
  const deadline = Number(parentDeadlineAt);
  const at = Number(now) || Date.now();
  if (Number.isFinite(deadline) && at >= deadline) {
    return { cut: true, code: 'subagent_deadline' };
  }
  return { cut: false, code: null };
}

function refuseSubagentIfParentTokensExhausted({ parentRemainingTokens } = {}) {
  const n = Number(parentRemainingTokens);
  if (Number.isFinite(n) && n <= 0) return { ok: false, code: 'subagent_tokens_exh' };
  return { ok: true, code: null };
}

function capSubagentStdoutBytes16KiB({ bytes, max = SUBAGENT_STDOUT_CAP } = {}) {
  const n = Number(bytes);
  const cap = Math.max(256, Number(max) || SUBAGENT_STDOUT_CAP);
  if (Number.isFinite(n) && n > cap) return { ok: false, bytes: n, max: cap, code: 'subagent_stdout' };
  return { ok: true, bytes: Number.isFinite(n) ? n : 0, max: cap, code: null };
}

// ---------------------------------------------------------------------------
// Compact / pgvector
// ---------------------------------------------------------------------------

function compactDropOrphanToolMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const ids = new Set();
  for (const m of list) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      const id = callIdOf(c);
      if (id) ids.add(id);
    }
  }
  const kept = [];
  let dropped = 0;
  for (const m of list) {
    if (m && m.role === 'tool') {
      const id = String(m.tool_call_id || m.toolCallId || m.id || '');
      if (id && !ids.has(id)) { dropped += 1; continue; }
    }
    kept.push(m);
  }
  return { messages: kept, dropped, code: dropped ? 'compact_orphan_tool' : null };
}

function rejectPgvectorNonFiniteNorm(vector) {
  if (!Array.isArray(vector) || !vector.length) return { ok: false, code: 'pgvector_norm' };
  let sum = 0;
  for (const n of vector) {
    const v = Number(n);
    if (!Number.isFinite(v)) return { ok: false, code: 'pgvector_norm' };
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return { ok: false, norm, code: 'pgvector_norm' };
  return { ok: true, norm, code: null };
}

function pinFactsWhenAccessCountAtLeast(facts, { min = MEMORY_ACCESS_PIN } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  const floor = Math.max(1, Number(min) || MEMORY_ACCESS_PIN);
  let pinned = 0;
  const out = list.map((f) => {
    if (!f || typeof f !== 'object') return f;
    const access = Number(f.accessCount || f.accesses || f.hits);
    if (Number.isFinite(access) && access >= floor) {
      pinned += 1;
      return { ...f, pin: true };
    }
    return f;
  });
  return { facts: out, pinned, code: pinned ? 'memory_access_pin' : null };
}

function dropMemoryHitsWithEmptyVector(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const kept = [];
  let dropped = 0;
  for (const h of list) {
    const vec = h && (h.vector || h.embedding);
    if (!Array.isArray(vec) || !vec.length) { dropped += 1; continue; }
    kept.push(h);
  }
  return { hits: kept, dropped, code: dropped ? 'memory_empty_vec' : null };
}

// ---------------------------------------------------------------------------
// Checkpoint rollback
// ---------------------------------------------------------------------------

function refuseRollbackIfByteLengthMismatch({ expectedBytes, actualBytes } = {}) {
  const a = Number(expectedBytes);
  const b = Number(actualBytes);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
    return { ok: false, expectedBytes: a, actualBytes: b, code: 'ckpt_bytes' };
  }
  return { ok: true, code: null };
}

function checkpointKeepFailedAttemptsLastN(list, { keep = CHECKPOINT_FAILED_KEEP } = {}) {
  const rows = Array.isArray(list) ? list.slice() : [];
  const cap = Math.max(1, Number(keep) || CHECKPOINT_FAILED_KEEP);
  const failed = rows.filter((c) => c && (c.failed === true || c.status === 'failed'));
  const ok = rows.filter((c) => !c || (c.failed !== true && c.status !== 'failed'));
  const keptFailed = failed.slice(-cap);
  const checkpoints = ok.concat(keptFailed).sort((a, b) => Number(a && a.seq) - Number(b && b.seq));
  return { checkpoints, keptFailed: keptFailed.length, code: 'ckpt_failed_keep' };
}

function refuseRollbackIfUnrelatedDirtyPaths({ dirtyPaths, checkpointPaths } = {}) {
  const dirty = Array.isArray(dirtyPaths) ? dirtyPaths.map(String) : [];
  const owned = new Set((Array.isArray(checkpointPaths) ? checkpointPaths : []).map(String));
  if (!dirty.length || !owned.size) return { ok: true, skipped: !dirty.length, code: null };
  const extra = dirty.filter((p) => p && !owned.has(p));
  if (extra.length) return { ok: false, extra, code: 'ckpt_dirty_unrelated' };
  return { ok: true, extra: [], code: null };
}

// ---------------------------------------------------------------------------
// Exact diffs
// ---------------------------------------------------------------------------

function refuseDiffMissingFromToFileHeaders(diff) {
  const text = String(diff == null ? '' : diff);
  const hasFrom = /^---\s+/m.test(text);
  const hasTo = /^\+\+\+\s+/m.test(text);
  if (!hasFrom || !hasTo) return { ok: false, code: 'diff_from_to' };
  return { ok: true, code: null };
}

function verifyReadAfterWriteSha256Prefix({ expected, actual, prefixLen = 16 } = {}) {
  const a = sha256Hex(expected);
  const b = sha256Hex(actual);
  const n = Math.max(8, Number(prefixLen) || 16);
  if (a.slice(0, n) !== b.slice(0, n)) {
    return { ok: false, expected: a.slice(0, n), actual: b.slice(0, n), code: 'raw_sha_prefix' };
  }
  return { ok: true, prefix: a.slice(0, n), code: null };
}

function refusePatchIfRenameMissingDelete(diff) {
  const text = String(diff == null ? '' : diff);
  const rename = /rename from\s+\S+/i.test(text) || /similarity index/i.test(text);
  if (!rename) return { ok: true, skipped: true, code: null };
  const deleted = /deleted file mode/i.test(text) || /^---\s+\S+/m.test(text);
  if (!deleted) return { ok: false, code: 'diff_rename_delete' };
  return { ok: true, code: null };
}

function requireExactHunkStartLine({ hunk, source } = {}) {
  const header = String(hunk == null ? '' : hunk);
  const m = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/m);
  if (!m) return { ok: true, skipped: true, code: null };
  const start = Number(m[1]);
  const body = String(source == null ? '' : source);
  if (!Number.isFinite(start) || start < 1) return { ok: false, code: 'diff_hunk_start' };
  const lines = body.split(/\r?\n/);
  if (start > lines.length + 1) return { ok: false, start, lines: lines.length, code: 'diff_hunk_start' };
  return { ok: true, start, code: null };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function capSandboxCombinedStreamBytes({ stdoutBytes, stderrBytes, max = SANDBOX_COMBINED_CAP } = {}) {
  const out = Number(stdoutBytes) || 0;
  const err = Number(stderrBytes) || 0;
  const cap = Math.max(1024, Number(max) || SANDBOX_COMBINED_CAP);
  const total = out + err;
  if (total > cap) return { ok: false, bytes: total, max: cap, code: 'sandbox_combined' };
  return { ok: true, bytes: total, max: cap, code: null };
}

function refuseSandboxEnvHostPathLeak(env) {
  const obj = env && typeof env === 'object' ? env : {};
  const leaked = [];
  for (const [k, v] of Object.entries(obj)) {
    const blob = `${k}=${v == null ? '' : v}`;
    if (HOST_PATH_RE.test(blob)) leaked.push(k);
  }
  if (leaked.length) return { ok: false, leaked, code: 'sandbox_host_path' };
  return { ok: true, leaked: [], code: null };
}

function requireSandboxNonRootUid({ uid, euid } = {}) {
  const u = Number(uid);
  const e = Number(euid);
  if ((Number.isFinite(u) && u === 0) || (Number.isFinite(e) && e === 0)) {
    return { ok: false, code: 'sandbox_root_uid' };
  }
  return { ok: true, code: null };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function resumeReplaySkipIdsOutsideRingWindow(events, { lastEventId, window = SSE_RING_WINDOW } = {}) {
  const list = Array.isArray(events) ? events : [];
  const win = Math.max(1, Number(window) || SSE_RING_WINDOW);
  const head = Number(lastEventId);
  if (!Number.isFinite(head)) return { events: list, skipped: 0, code: null };
  const min = head - win;
  const kept = [];
  let skipped = 0;
  for (const ev of list) {
    const id = Number(ev && (ev.id != null ? ev.id : ev.eventId));
    if (Number.isFinite(id) && id < min) { skipped += 1; continue; }
    kept.push(ev);
  }
  return { events: kept, skipped, code: skipped ? 'sse_ring_window' : null };
}

function rejectResumeIfWriterGenerationMismatch({ writerGeneration, resumeGeneration } = {}) {
  const a = Number(writerGeneration);
  const b = Number(resumeGeneration);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: true, skipped: true, code: null };
  if (a !== b) return { ok: false, code: 'sse_writer_gen' };
  return { ok: true, code: null };
}

function dropHeartbeatIfSeqUnchanged({ lastSeq, seq } = {}) {
  const a = Number(lastSeq);
  const b = Number(seq);
  if (Number.isFinite(a) && Number.isFinite(b) && a === b) {
    return { drop: true, code: 'sse_hb_same_seq' };
  }
  return { drop: false, code: null };
}

function heartbeatStampServerNowMs({ now = Date.now() } = {}) {
  const n = Number(now);
  const at = Number.isFinite(n) ? n : Date.now();
  return { nowMs: at, comment: `: t=${at}`, code: 'sse_hb_now' };
}

// ---------------------------------------------------------------------------
// Session queue
// ---------------------------------------------------------------------------

const inflightRequestIds = new Set();

function rejectEnqueueIfDuplicateRequestId({ requestId, inflight } = {}) {
  const id = String(requestId == null ? '' : requestId);
  if (!id) return { ok: true, skipped: true, code: null };
  const seen = inflight instanceof Set ? inflight : inflightRequestIds;
  if (seen.has(id)) return { ok: false, requestId: id, code: 'queue_dup_request' };
  seen.add(id);
  return { ok: true, requestId: id, code: null };
}

function resetInflightRequestIdsForTests() {
  inflightRequestIds.clear();
}

function demoteQueueIfWaitedOverHardCap({ waitedMs, maxMs = QUEUE_HARD_WAIT_MS } = {}) {
  const w = Number(waitedMs);
  const cap = Math.max(1, Number(maxMs) || QUEUE_HARD_WAIT_MS);
  if (Number.isFinite(w) && w > cap) return { demote: true, waitedMs: w, maxMs: cap, code: 'queue_hard_wait' };
  return { demote: false, waitedMs: Number.isFinite(w) ? w : 0, maxMs: cap, code: null };
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

const settledDoneEvents = new Set();

function neverChargeIfStreamNeverOpenedAndCancelled({ cancelled, streamOpened, completionTokens } = {}) {
  const completion = Number(completionTokens);
  if (cancelled === true && streamOpened === false && (!Number.isFinite(completion) || completion === 0)) {
    return { charge: false, code: 'credit_stream_cancel' };
  }
  return { charge: true, code: null };
}

function settleCreditsOnlyAfterDoneEvent({ requestId, doneEvent, settled } = {}) {
  const id = String(requestId == null ? '' : requestId);
  if (!id || doneEvent !== true) return { settle: false, code: null };
  if (settled === true || settledDoneEvents.has(id)) {
    return { settle: false, already: true, code: 'credit_done_event' };
  }
  settledDoneEvents.add(id);
  return { settle: true, already: false, code: 'credit_done_event' };
}

function resetSettledDoneEventsForTests() {
  settledDoneEvents.clear();
}

function refundIfPromptTokensExceedHardCap({ promptTokens, max = PROMPT_TOKEN_HARD_CAP } = {}) {
  const n = Number(promptTokens);
  const cap = Math.max(1, Number(max) || PROMPT_TOKEN_HARD_CAP);
  if (Number.isFinite(n) && n > cap) return { refund: true, tokens: cap, code: 'credit_prompt_cap' };
  return { refund: false, tokens: Number.isFinite(n) ? n : 0, code: null };
}

// ---------------------------------------------------------------------------
// Classified errors + latency
// ---------------------------------------------------------------------------

function classifyEtimedoutAsTimeout(err) {
  const blob = `${String((err && (err.code || err.errno || err.name)) || '')} ${String((err && err.message) || '')}`.toUpperCase();
  if (blob.includes('ETIMEDOUT') || blob.includes('ETIMEOUT')) {
    return { timeout: true, retryable: true, code: 'net_etimedout' };
  }
  return { timeout: false, retryable: false, code: null };
}

function neverRetry409Conflict(err) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const msg = String((err && (err.code || err.message)) || '');
  if (status === 409 || /\b409\b|conflict/i.test(msg)) {
    return { retry: false, status: 409, code: 'http_409' };
  }
  return { retry: true, code: null };
}

function latencyHintWhenStepP99OverBudget({ elapsedMs, budgetMs = STEP_P99_SLOW_MS } = {}) {
  const t = Number(elapsedMs);
  const cap = Math.max(1, Number(budgetMs) || STEP_P99_SLOW_MS);
  if (!Number.isFinite(t)) return { hint: false, code: null };
  if (t > cap) return { hint: true, elapsedMs: t, budgetMs: cap, code: 'step_p99_slow' };
  return { hint: false, elapsedMs: t, budgetMs: cap, code: null };
}

const latencySamples = [];

function recordTurnLatencySampleP50(elapsedMs) {
  const n = Number(elapsedMs);
  if (!Number.isFinite(n) || n < 0) return { recorded: false, p50: null, code: null };
  latencySamples.push(n);
  if (latencySamples.length > LATENCY_SAMPLE_MAX) latencySamples.splice(0, latencySamples.length - LATENCY_SAMPLE_MAX);
  const sorted = latencySamples.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor((sorted.length - 1) * 0.50));
  const p50 = sorted[idx];
  return { recorded: true, p50, samples: sorted.length, code: 'turn_p50' };
}

function resetLatencySamplesForTests() {
  latencySamples.length = 0;
}

const HINTS = Object.freeze({
  plan_todos_open: 'Hay todos abiertos en el plan. No cierro el turno.',
  assistant_hash_repeat: 'El asistente repitió el mismo contenido. Corté el bucle.',
  empty_assistant_max: 'Demasiados turnos vacíos del asistente. Paro.',
  tool_id_name_missing: 'Hay una tool_call sin id y sin nombre. La rechazo.',
  json_plus_prefix: 'Reparé JSON con prefijo +.',
  tool_email: 'El email no es válido.',
  http_504_retry: '504: reintento con backoff.',
  tool_enum_unknown: 'El enum del argumento no está en el schema.',
  tool_name_zw: 'Quité caracteres de ancho cero del nombre de la herramienta.',
  subagent_steps: 'El subagente hereda el tope de pasos del padre.',
  subagent_deadline: 'El deadline del padre ya pasó. Corté el subagente.',
  subagent_tokens_exh: 'El padre no tiene tokens. No lanzo el subagente.',
  subagent_stdout: 'stdout del subagente superó 16 KiB.',
  compact_orphan_tool: 'Solté tool_results huérfanos al compactar.',
  pgvector_norm: 'La norma del embedding no es finita o es 0.',
  memory_access_pin: 'Marqué pin:true los facts por recuento de acceso.',
  memory_empty_vec: 'Solté hits de memoria sin vector.',
  ckpt_bytes: 'El tamaño en bytes del checkpoint no coincide. Rechacé el rollback.',
  ckpt_failed_keep: 'Conservé los últimos intentos fallidos del checkpoint.',
  ckpt_dirty_unrelated: 'Hay paths sucios ajenos al checkpoint. No hago rollback.',
  diff_from_to: 'El patch no trae cabeceras --- / +++.',
  raw_sha_prefix: 'Tras el write, el prefijo SHA-256 no coincide.',
  diff_rename_delete: 'Un rename debe incluir la eliminación del origen.',
  diff_hunk_start: 'La línea de inicio del hunk no existe en el archivo.',
  sandbox_combined: 'stdout+stderr del sandbox superó el tope combinado.',
  sandbox_host_path: 'El env del sandbox filtra una ruta del host.',
  sandbox_root_uid: 'El sandbox no puede correr como uid 0.',
  sse_ring_window: 'Salté eventos SSE fuera de la ventana del ring.',
  sse_writer_gen: 'La generación del writer no coincide. Rechacé el resume.',
  sse_hb_same_seq: 'El seq no cambió. No mando heartbeat.',
  sse_hb_now: 'Heartbeat con timestamp del servidor.',
  queue_dup_request: 'Ese requestId ya está en cola.',
  queue_hard_wait: 'La espera superó el tope. Bajé prioridad.',
  credit_stream_cancel: 'Cancelado sin abrir el stream: no cobro.',
  credit_done_event: 'El hold se liquida solo tras el evento done.',
  credit_prompt_cap: 'prompt_tokens supera el tope: no cobro el excedente.',
  net_etimedout: 'ETIMEDOUT. Reintento como timeout.',
  http_409: '409: no reintento. Conflicto.',
  step_p99_slow: 'El paso tardó más que el presupuesto p99.',
  turn_p50: 'Registré la latencia del turno para p50.',
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
  refuseFinishIfPlanHasOpenTodos,
  cutLoopIfSameAssistantContentHashTwice,
  stopIfMaxEmptyAssistantTurns,
  refuseToolCallIfMissingCallIdAndName,
  repairJsonPlusPrefixedOnce,
  coerceEmailStringOrRefuse,
  backoffOn504GatewayTimeout,
  refuseToolIfUnknownEnumAfterRepair,
  stripZeroWidthFromToolName,
  inheritSubagentMaxStepsFromParent,
  cutSubagentIfParentDeadlinePassed,
  refuseSubagentIfParentTokensExhausted,
  capSubagentStdoutBytes16KiB,
  compactDropOrphanToolMessages,
  rejectPgvectorNonFiniteNorm,
  pinFactsWhenAccessCountAtLeast,
  dropMemoryHitsWithEmptyVector,
  refuseRollbackIfByteLengthMismatch,
  checkpointKeepFailedAttemptsLastN,
  refuseRollbackIfUnrelatedDirtyPaths,
  refuseDiffMissingFromToFileHeaders,
  verifyReadAfterWriteSha256Prefix,
  refusePatchIfRenameMissingDelete,
  requireExactHunkStartLine,
  capSandboxCombinedStreamBytes,
  refuseSandboxEnvHostPathLeak,
  requireSandboxNonRootUid,
  resumeReplaySkipIdsOutsideRingWindow,
  rejectResumeIfWriterGenerationMismatch,
  dropHeartbeatIfSeqUnchanged,
  heartbeatStampServerNowMs,
  rejectEnqueueIfDuplicateRequestId,
  resetInflightRequestIdsForTests,
  demoteQueueIfWaitedOverHardCap,
  neverChargeIfStreamNeverOpenedAndCancelled,
  settleCreditsOnlyAfterDoneEvent,
  resetSettledDoneEventsForTests,
  refundIfPromptTokensExceedHardCap,
  classifyEtimedoutAsTimeout,
  neverRetry409Conflict,
  latencyHintWhenStepP99OverBudget,
  recordTurnLatencySampleP50,
  resetLatencySamplesForTests,
  actionableErrorHint,
};
