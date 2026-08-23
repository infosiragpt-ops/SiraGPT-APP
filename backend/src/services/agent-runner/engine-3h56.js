'use strict';

/**
 * 3H56 — agent-loop robustness helpers (engine-only).
 *
 * Complements 3H55 without duplicating its settle / ping-pong / CRC /
 * UTF-8 / billed-token helpers. Pure functions + tiny in-memory maps.
 * DeepSeek Flash/Pro only; no OpenRouter generate client.
 */

const crypto = require('crypto');

const WAVE = '3H56';
const SIBLING_SUBAGENTS_MAX = 2;
const CHECKPOINT_KEEP_LAST_N = 8;
const TOOL_BODY_KEEP_TURNS = 4;
const SANDBOX_STDOUT_CAP = 64 * 1024;
const SANDBOX_RSS_CAP_MB = 256;
const QUEUE_STARVE_MS = 20_000;
const STEP_SLOW_MS = 15_000;
const HEARTBEAT_JITTER_MAX_MS = 400;

const FLAGS = Object.freeze({
  refuseFinishWhileParallelToolsOpen: true,
  cutLoopIfSameToolCallIdReused: true,
  stopIfMaxStepsWithPartialFinal: true,
  refuseEmptyAssistantWithOpenTools: true,
  rejectUndefinedRequiredToolArgs: true,
  repairJsonSingleQuotedValuesOnce: true,
  coerceEnumArgOrRefuse: true,
  backoffOn429RetryAfterHeader: true,
  stripUnknownArgsWhenAdditionalPropertiesFalse: true,
  refuseToolIfRequiredMissingAfterRepair: true,
  inheritSubagentTokenBudget: true,
  cutSubagentIfNoProgressTwoSteps: true,
  shareParentAbortDeadlineMs: true,
  capSiblingSubagentsPerParent: true,
  compactKeepPinnedAndLastUserPair: true,
  rejectPgvectorNaNOrInfComponents: true,
  pinFactsWhenFlagTrue: true,
  dropToolBodiesOlderThanNTurns: true,
  refuseRollbackIfSeqNotMonotonic: true,
  checkpointKeepLastNPlusPinned: true,
  refuseRollbackAcrossSessionBoundary: true,
  refuseDiffMissingGitHeaders: true,
  verifyReadAfterWriteLineCount: true,
  refuseBinaryPatchOnTextFile: true,
  requireHunkContextLinesMatch: true,
  capSandboxStdoutBytesPerCommand: true,
  refuseSandboxRssOverCap: true,
  requireSandboxTmpdirUnderPrefix: true,
  resumeReplayMustBeIdempotent: true,
  rejectResumeIfCursorAheadOfHead: true,
  dropBufferedTokensOnCancelOnce: true,
  heartbeatJitterWithinWindow: true,
  rejectEnqueueIfSessionLockedByOther: true,
  boostStarvedQueueAfterWaitMs: true,
  neverChargeIfNoCompletionAndNoErrorUsage: true,
  settleHoldOnceOnTerminalState: true,
  classifyDnsEnotfoundAsUnavailable: true,
  neverRetry401Unauthorized: true,
  latencyHintWhenStepOverBudget: true,
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

function lineCountOf(text) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text == null ? '' : text);
  if (!s) return 0;
  return s.split(/\r?\n/).length;
}

// ---------------------------------------------------------------------------
// Agent multi-step loop
// ---------------------------------------------------------------------------

function refuseFinishWhileParallelToolsOpen({ inflight, toolCalls } = {}) {
  const n = Number(inflight);
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const open = Number.isFinite(n) ? n : list.length;
  if (open > 0) return { ok: false, open, code: 'parallel_tools_open' };
  return { ok: true, open: 0, code: null };
}

function cutLoopIfSameToolCallIdReused(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const seen = new Set();
  for (const c of list) {
    const id = callIdOf(c);
    if (!id) continue;
    if (seen.has(id)) return { cut: true, id, code: 'tool_id_reused' };
    seen.add(id);
  }
  return { cut: false, code: null };
}

function stopIfMaxStepsWithPartialFinal({ step, maxSteps, text } = {}) {
  const n = Number(step);
  const cap = Number(maxSteps);
  if (!Number.isFinite(n) || !Number.isFinite(cap) || n < cap) {
    return { stop: false, code: null };
  }
  const body = String(text == null ? '' : text).trim();
  return {
    stop: true,
    partial: Boolean(body),
    text: body,
    code: 'max_steps_partial',
  };
}

function refuseEmptyAssistantWithOpenTools({ content, openToolIds } = {}) {
  const text = String(content == null ? '' : content).trim();
  const open = Array.isArray(openToolIds) ? openToolIds.filter(Boolean) : [];
  if (!text && open.length) return { ok: false, open: open.length, code: 'empty_assistant_open' };
  return { ok: true, open: open.length, code: null };
}

// ---------------------------------------------------------------------------
// Strict tool schemas + retry/repair
// ---------------------------------------------------------------------------

function rejectUndefinedRequiredToolArgs(args, required) {
  const keys = Array.isArray(required) ? required.map(String) : [];
  if (!keys.length) return { ok: true, missing: [], code: null };
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const missing = keys.filter((k) => obj[k] === undefined);
  if (missing.length) return { ok: false, missing, code: 'tool_args_undefined' };
  return { ok: true, missing: [], code: null };
}

function repairJsonSingleQuotedValuesOnce(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw);
  try { return { ok: true, value: JSON.parse(s), repaired: false, code: null }; } catch (_) { /* repair */ }
  const quoted = s.replace(/'([^'\\]|\\.)*'/g, (m) => {
    const inner = m.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
    return `"${inner}"`;
  });
  try {
    return { ok: true, value: JSON.parse(quoted), repaired: quoted !== s, code: quoted !== s ? 'json_single_quote_val' : null };
  } catch (e) {
    return { ok: false, value: null, repaired: false, error: e.message, code: 'json_single_quote_val' };
  }
}

function coerceEnumArgOrRefuse(value, allowed) {
  const list = Array.isArray(allowed) ? allowed.map(String) : [];
  if (!list.length) return { ok: true, skipped: true, value, code: null };
  if (value == null) return { ok: false, value, code: 'tool_enum' };
  const raw = String(value);
  if (list.includes(raw)) return { ok: true, value: raw, coerced: false, code: null };
  const lower = raw.toLowerCase();
  const hit = list.find((x) => String(x).toLowerCase() === lower);
  if (hit != null) return { ok: true, value: hit, coerced: true, code: 'tool_enum' };
  return { ok: false, value: raw, allowed: list, code: 'tool_enum' };
}

function backoffOn429RetryAfterHeader(err, { attempt = 0 } = {}) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const headers = (err && (err.headers || (err.response && err.response.headers))) || {};
  const retryAfter = headers['retry-after'] || headers['Retry-After'] || (err && err.retryAfter);
  const msg = String((err && err.message) || '');
  const is429 = status === 429 || /\b429\b|rate.?limit|too many requests/i.test(msg);
  if (!is429) return { retry: false, delayMs: 0, code: null };
  const n = Math.max(0, Number(attempt) || 0);
  let delayMs = Math.min(8_000, 250 * (2 ** n));
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra >= 0) delayMs = Math.min(30_000, ra > 100 ? ra : ra * 1000);
  return { retry: true, delayMs, status: 429, code: 'http_429_retry_after' };
}

function stripUnknownArgsWhenAdditionalPropertiesFalse(args, schema) {
  if (!schema || schema.additionalProperties !== false) {
    return { args, stripped: [], code: null };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { args, stripped: [], code: null };
  }
  const allowed = new Set(Object.keys((schema.properties && typeof schema.properties === 'object') ? schema.properties : {}));
  const out = {};
  const stripped = [];
  for (const [k, v] of Object.entries(args)) {
    if (allowed.has(k)) out[k] = v;
    else stripped.push(k);
  }
  return { args: out, stripped, code: stripped.length ? 'tool_args_strip' : null };
}

function refuseToolIfRequiredMissingAfterRepair({ args, required, repaired } = {}) {
  const keys = Array.isArray(required) ? required.map(String) : [];
  if (!keys.length) return { ok: true, missing: [], code: null };
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const missing = keys.filter((k) => obj[k] === undefined || obj[k] === null || obj[k] === '');
  if (missing.length && repaired === true) {
    return { ok: false, missing, code: 'tool_required_missing' };
  }
  if (missing.length) return { ok: false, missing, code: 'tool_required_missing' };
  return { ok: true, missing: [], code: null };
}

// ---------------------------------------------------------------------------
// Subagent budget
// ---------------------------------------------------------------------------

function inheritSubagentTokenBudget({ parentRemaining, childRequested } = {}) {
  const parent = Number(parentRemaining);
  const child = Number(childRequested);
  const p = Number.isFinite(parent) && parent > 0 ? parent : 2048;
  const c = Number.isFinite(child) && child > 0 ? child : p;
  const tokens = Math.max(1, Math.min(p, c));
  return { tokens, inherited: Number.isFinite(parent), code: 'subagent_tokens' };
}

function cutSubagentIfNoProgressTwoSteps({ hashes } = {}) {
  const list = Array.isArray(hashes) ? hashes.map(String) : [];
  if (list.length < 2) return { cut: false, code: null };
  const a = list[list.length - 2];
  const b = list[list.length - 1];
  if (a && b && a === b) return { cut: true, code: 'subagent_no_progress' };
  return { cut: false, code: null };
}

function shareParentAbortDeadlineMs({ parentDeadlineAt, now, childRequestedMs } = {}) {
  const t = Number(now) || Date.now();
  const parentAt = Number(parentDeadlineAt);
  const child = Number(childRequestedMs);
  const childMs = Number.isFinite(child) && child > 0 ? child : 30_000;
  if (!Number.isFinite(parentAt)) return { timeoutMs: childMs, inherited: false, code: 'subagent_deadline' };
  const remain = Math.max(1, parentAt - t);
  return { timeoutMs: Math.min(remain, childMs), inherited: true, code: 'subagent_deadline' };
}

function capSiblingSubagentsPerParent({ active, max = SIBLING_SUBAGENTS_MAX } = {}) {
  const n = Number(active) || 0;
  const cap = Math.max(1, Number(max) || SIBLING_SUBAGENTS_MAX);
  if (n >= cap) return { ok: false, active: n, max: cap, code: 'subagent_siblings' };
  return { ok: true, active: n, max: cap, code: null };
}

// ---------------------------------------------------------------------------
// Compact / pin / pgvector
// ---------------------------------------------------------------------------

function compactKeepPinnedAndLastUserPair(messages, pinIds) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const pins = new Set((Array.isArray(pinIds) ? pinIds : []).map(String));
  let lastUser = -1;
  let lastAsst = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const role = list[i] && list[i].role;
    if (lastAsst < 0 && role === 'assistant') lastAsst = i;
    if (lastUser < 0 && role === 'user') lastUser = i;
    if (lastUser >= 0 && lastAsst >= 0) break;
  }
  const keep = new Set();
  if (lastUser >= 0) keep.add(lastUser);
  if (lastAsst >= 0) keep.add(lastAsst);
  const kept = [];
  let pinned = 0;
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    const id = m && m.id != null ? String(m.id) : '';
    const isPin = id && pins.has(id);
    if (isPin) pinned += 1;
    if (isPin || keep.has(i) || (m && m.role === 'system' && i === 0)) kept.push(m);
  }
  return { messages: kept, pinned, kept: kept.length, code: 'compact_pin_pair' };
}

function rejectPgvectorNaNOrInfComponents(vector) {
  const list = Array.isArray(vector) ? vector : (vector && vector.embedding);
  if (!Array.isArray(list)) return { ok: true, skipped: true, code: null };
  for (let i = 0; i < list.length; i += 1) {
    const n = Number(list[i]);
    if (!Number.isFinite(n)) return { ok: false, index: i, code: 'pgvector_nan' };
  }
  return { ok: true, dim: list.length, code: null };
}

function pinFactsWhenFlagTrue(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const pinned = [];
  const rest = [];
  for (const f of list) {
    if (f && (f.pin === true || f.pinned === true || f.pin === 'true')) pinned.push(f);
    else rest.push(f);
  }
  return { pinned, rest, code: pinned.length ? 'memory_pin_flag' : null };
}

function dropToolBodiesOlderThanNTurns(messages, { keepTurns = TOOL_BODY_KEEP_TURNS } = {}) {
  const list = Array.isArray(messages) ? messages.map((m) => (m && typeof m === 'object' ? { ...m } : m)) : [];
  const cap = Math.max(1, Number(keepTurns) || TOOL_BODY_KEEP_TURNS);
  let assistantTurns = 0;
  let dropped = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') assistantTurns += 1;
    if (m.role === 'tool' && assistantTurns > cap) {
      const before = String(m.content == null ? '' : m.content);
      if (before.length > 32) {
        m.content = `[dropped ${before.length} bytes]`;
        dropped += 1;
      }
    }
  }
  return { messages: list, dropped, code: dropped ? 'compact_old_tools' : null };
}

// ---------------------------------------------------------------------------
// Checkpoint rollback
// ---------------------------------------------------------------------------

function refuseRollbackIfSeqNotMonotonic({ currentSeq, targetSeq } = {}) {
  const cur = Number(currentSeq);
  const tgt = Number(targetSeq);
  if (!Number.isFinite(tgt)) return { ok: false, code: 'ckpt_seq' };
  if (!Number.isFinite(cur)) return { ok: true, seq: tgt, code: null };
  if (tgt > cur) return { ok: false, currentSeq: cur, targetSeq: tgt, code: 'ckpt_seq' };
  if (tgt < 0) return { ok: false, code: 'ckpt_seq' };
  return { ok: true, seq: tgt, code: null };
}

function checkpointKeepLastNPlusPinned(list, { keep = CHECKPOINT_KEEP_LAST_N } = {}) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const n = Math.max(1, Number(keep) || CHECKPOINT_KEEP_LAST_N);
  const pinned = arr.filter((c) => c && (c.pin === true || c.pinned === true));
  const rest = arr.filter((c) => !(c && (c.pin === true || c.pinned === true)));
  const tail = rest.slice(-n);
  const seen = new Set();
  const out = [];
  for (const c of pinned.concat(tail)) {
    const id = c && (c.id != null ? c.id : c.seq);
    const key = id == null ? sha256Hex(stableJson(c)) : String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  const dropped = Math.max(0, arr.length - out.length);
  return { checkpoints: out, dropped, pinned: pinned.length, code: dropped ? 'ckpt_keep_pin' : null };
}

function refuseRollbackAcrossSessionBoundary({ sessionKey, checkpointSessionKey } = {}) {
  const a = String(sessionKey == null ? '' : sessionKey);
  const b = String(checkpointSessionKey == null ? '' : checkpointSessionKey);
  if (!a || !b) return { ok: true, skipped: true, code: null };
  if (a !== b) return { ok: false, code: 'ckpt_session' };
  return { ok: true, code: null };
}

// ---------------------------------------------------------------------------
// Exact diffs + read-after-write
// ---------------------------------------------------------------------------

function refuseDiffMissingGitHeaders(diff) {
  const s = String(diff == null ? '' : diff);
  if (!s.trim()) return { ok: false, code: 'diff_git_header' };
  const hasOld = /^---\s+\S+/m.test(s);
  const hasNew = /^\+\+\+\s+\S+/m.test(s);
  if (!hasOld || !hasNew) return { ok: false, code: 'diff_git_header' };
  return { ok: true, code: null };
}

function verifyReadAfterWriteLineCount({ expected, actual } = {}) {
  const e = lineCountOf(expected);
  const a = lineCountOf(actual);
  if (e !== a) return { ok: false, expected: e, actual: a, code: 'raw_line_count' };
  return { ok: true, lines: e, code: null };
}

function refuseBinaryPatchOnTextFile({ path: filePath, diff, content } = {}) {
  const p = String(filePath || '');
  const d = String(diff == null ? '' : diff);
  const body = content == null ? '' : (Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
  const looksText = /\.(js|mjs|cjs|ts|tsx|json|md|txt|css|html|yml|yaml|py|sh)$/i.test(p)
    || (typeof content === 'string');
  const gitBinary = /^GIT binary patch/m.test(d) || /^Binary files /m.test(d);
  const hasNul = Buffer.isBuffer(body) && body.includes(0);
  if (looksText && (gitBinary || hasNul)) return { ok: false, code: 'diff_binary' };
  return { ok: true, code: null };
}

function requireHunkContextLinesMatch({ hunk, source } = {}) {
  const lines = Array.isArray(hunk && hunk.lines) ? hunk.lines : [];
  const src = String(source == null ? '' : source).split(/\r?\n/);
  const start = Number(hunk && (hunk.oldStart != null ? hunk.oldStart : hunk.start));
  if (!lines.length) return { ok: true, skipped: true, code: null };
  if (!Number.isFinite(start) || start < 1) return { ok: false, code: 'diff_context' };
  let idx = start - 1;
  for (const line of lines) {
    const s = String(line);
    if (s.charAt(0) === ' ' || s.charAt(0) === '-') {
      const want = s.slice(1);
      if (src[idx] !== want) return { ok: false, line: idx + 1, code: 'diff_context' };
      idx += 1;
    }
  }
  return { ok: true, code: null };
}

// ---------------------------------------------------------------------------
// Sandbox limits
// ---------------------------------------------------------------------------

function capSandboxStdoutBytesPerCommand({ bytes, max = SANDBOX_STDOUT_CAP } = {}) {
  const n = Number(bytes);
  const cap = Math.max(1024, Number(max) || SANDBOX_STDOUT_CAP);
  const used = Number.isFinite(n) && n > 0 ? n : 0;
  if (used > cap) return { ok: false, bytes: used, max: cap, truncated: true, code: 'sandbox_stdout_cap' };
  return { ok: true, bytes: used, max: cap, truncated: false, code: null };
}

function refuseSandboxRssOverCap({ rssMb, maxMb = SANDBOX_RSS_CAP_MB } = {}) {
  const rss = Number(rssMb);
  const cap = Math.max(16, Number(maxMb) || SANDBOX_RSS_CAP_MB);
  if (Number.isFinite(rss) && rss > cap) return { ok: false, rssMb: rss, maxMb: cap, code: 'sandbox_rss' };
  return { ok: true, rssMb: Number.isFinite(rss) ? rss : null, maxMb: cap, code: null };
}

function requireSandboxTmpdirUnderPrefix(tmpDir, prefix) {
  const d = String(tmpDir == null ? '' : tmpDir).split('\\').join('/');
  const p = String(prefix == null ? '' : prefix).split('\\').join('/');
  if (!d || !p) return { ok: true, skipped: true, code: null };
  const dir = d.charAt(d.length - 1) === '/' ? d.slice(0, -1) : d;
  const base = p.charAt(p.length - 1) === '/' ? p.slice(0, -1) : p;
  if (dir === base || dir.indexOf(`${base}/`) === 0) return { ok: true, path: dir, code: null };
  return { ok: false, path: dir, prefix: base, code: 'sandbox_tmp_prefix' };
}

// ---------------------------------------------------------------------------
// SSE resume / cancel
// ---------------------------------------------------------------------------

function resumeReplayMustBeIdempotent(events, lastEventId) {
  const first = resumeSkipWindow(events, lastEventId);
  const second = resumeSkipWindow(events, lastEventId);
  const a = first.events.map((e) => (e && (e.id != null ? e.id : e.eventId)));
  const b = second.events.map((e) => (e && (e.id != null ? e.id : e.eventId)));
  const same = a.length === b.length && a.every((id, i) => id === b[i]);
  if (!same) return { ok: false, events: first.events, code: 'sse_replay_idempotent' };
  return { ok: true, events: first.events, skipped: first.skipped, code: first.skipped ? 'sse_replay_idempotent' : null };
}

function resumeSkipWindow(events, lastEventId) {
  const list = Array.isArray(events) ? events : [];
  const cursor = Number(lastEventId);
  if (!Number.isFinite(cursor)) return { events: list, skipped: 0 };
  const kept = [];
  let skipped = 0;
  for (const e of list) {
    const id = Number(e && (e.id != null ? e.id : e.eventId));
    if (Number.isFinite(id) && id <= cursor) { skipped += 1; continue; }
    kept.push(e);
  }
  return { events: kept, skipped };
}

function rejectResumeIfCursorAheadOfHead({ lastEventId, headId } = {}) {
  const cursor = Number(lastEventId);
  const head = Number(headId);
  if (!Number.isFinite(cursor) || !Number.isFinite(head)) return { ok: true, skipped: true, code: null };
  if (cursor > head) return { ok: false, lastEventId: cursor, headId: head, code: 'sse_cursor_ahead' };
  return { ok: true, lastEventId: cursor, headId: head, code: null };
}

function dropBufferedTokensOnCancelOnce({ cancelled, dropped } = {}) {
  if (cancelled !== true) return { drop: false, already: false, code: null };
  if (dropped === true) return { drop: false, already: true, code: null };
  return { drop: true, already: false, code: 'sse_drop_buffer' };
}

function heartbeatJitterWithinWindow({ baseMs, jitterMs, maxJitter = HEARTBEAT_JITTER_MAX_MS } = {}) {
  const base = Number(baseMs);
  const jitter = Number(jitterMs);
  const cap = Math.max(0, Number(maxJitter) || HEARTBEAT_JITTER_MAX_MS);
  if (!Number.isFinite(base) || base <= 0) return { ok: false, code: 'sse_hb_jitter' };
  if (!Number.isFinite(jitter)) return { ok: true, intervalMs: base, code: null };
  if (Math.abs(jitter) > cap) return { ok: false, jitterMs: jitter, maxJitter: cap, code: 'sse_hb_jitter' };
  return { ok: true, intervalMs: base + jitter, code: null };
}

// ---------------------------------------------------------------------------
// Session queue
// ---------------------------------------------------------------------------

function rejectEnqueueIfSessionLockedByOther({ ownerId, requesterId, locked } = {}) {
  if (locked !== true) return { ok: true, skipped: true, code: null };
  const a = String(ownerId == null ? '' : ownerId);
  const b = String(requesterId == null ? '' : requesterId);
  if (!a || !b) return { ok: true, skipped: true, code: null };
  if (a !== b) return { ok: false, code: 'queue_lock' };
  return { ok: true, code: null };
}

function boostStarvedQueueAfterWaitMs({ waitedMs, thresholdMs = QUEUE_STARVE_MS } = {}) {
  const waited = Number(waitedMs);
  const lim = Math.max(1, Number(thresholdMs) || QUEUE_STARVE_MS);
  if (!Number.isFinite(waited)) return { boost: false, code: null };
  if (waited >= lim) return { boost: true, waitedMs: waited, code: 'queue_starve' };
  return { boost: false, waitedMs: waited, remainingMs: lim - waited, code: null };
}

// ---------------------------------------------------------------------------
// Credit accounting
// ---------------------------------------------------------------------------

function neverChargeIfNoCompletionAndNoErrorUsage({ completionTokens, errorUsage, error } = {}) {
  const completion = Number(completionTokens);
  const usage = Number(errorUsage);
  const hasCompletion = Number.isFinite(completion) && completion > 0;
  const hasErrorUsage = Boolean(error) && Number.isFinite(usage) && usage > 0;
  if (!hasCompletion && !hasErrorUsage) {
    return { charge: false, tokens: 0, code: 'credit_no_completion' };
  }
  return { charge: true, tokens: hasCompletion ? completion : usage, code: null };
}

const _settledHolds = new Set();

function settleHoldOnceOnTerminalState({ holdId, terminal, settled } = {}) {
  const id = String(holdId == null ? '' : holdId);
  if (!id) return { settle: false, skipped: true, code: null };
  if (terminal !== true) return { settle: false, code: null };
  if (settled === true || _settledHolds.has(id)) {
    return { settle: false, already: true, code: 'credit_settle_once' };
  }
  _settledHolds.add(id);
  return { settle: true, already: false, code: 'credit_settle_once' };
}

function resetSettledHoldsForTests() {
  _settledHolds.clear();
}

// ---------------------------------------------------------------------------
// Classified errors + latency
// ---------------------------------------------------------------------------

function classifyDnsEnotfoundAsUnavailable(err) {
  if (err == null) return { unavailable: false, retryable: false, code: null };
  const blob = `${(err && (err.code || err.errno || err.name)) || ''} ${(err && err.message) || ''}`.toUpperCase();
  if (blob.indexOf('ENOTFOUND') >= 0 || blob.indexOf('EAI_AGAIN') >= 0) {
    return { unavailable: true, retryable: true, code: 'dns_unavailable' };
  }
  return { unavailable: false, retryable: false, code: null };
}

function neverRetry401Unauthorized(err) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || '');
  const is401 = status === 401 || code === '401' || /\b401\b|unauthorized/i.test(msg);
  if (is401) return { retry: false, status: 401, code: 'http_401' };
  return { retry: null, status: Number.isFinite(status) ? status : null, code: null };
}

function latencyHintWhenStepOverBudget({ elapsedMs, budgetMs = STEP_SLOW_MS } = {}) {
  const t = Number(elapsedMs);
  const cap = Math.max(1, Number(budgetMs) || STEP_SLOW_MS);
  if (!Number.isFinite(t)) return { hint: false, code: null };
  if (t > cap) return { hint: true, elapsedMs: t, budgetMs: cap, code: 'step_slow' };
  return { hint: false, elapsedMs: t, budgetMs: cap, code: null };
}

const HINTS = Object.freeze({
  parallel_tools_open: 'Aún hay herramientas en paralelo. No cierro el turno.',
  tool_id_reused: 'El mismo tool_call_id se reutilizó. Corté el bucle.',
  max_steps_partial: 'Se agotaron los pasos. Entrego el texto parcial.',
  empty_assistant_open: 'El asistente llegó vacío con herramientas abiertas.',
  tool_args_undefined: 'Faltan argumentos requeridos (undefined).',
  json_single_quote_val: 'Reparé comillas simples en el JSON de la herramienta.',
  tool_enum: 'El argumento no está en el enum permitido.',
  http_429_retry_after: '429: reintento respetando Retry-After.',
  tool_args_strip: 'Quité propiedades extra (additionalProperties:false).',
  tool_required_missing: 'Tras reparar el JSON siguen faltando campos requeridos.',
  subagent_tokens: 'El subagente hereda el presupuesto de tokens del padre.',
  subagent_no_progress: 'El subagente no avanzó en dos pasos. Corté.',
  subagent_deadline: 'El subagente no puede superar el deadline del padre.',
  subagent_siblings: 'Este padre ya tiene el máximo de subagentes hermanos.',
  compact_pin_pair: 'Compacté: pines + último par user/assistant.',
  pgvector_nan: 'El embedding tiene NaN/Inf. No recupero memoria.',
  memory_pin_flag: 'Conservé los facts con pin:true.',
  compact_old_tools: 'Solté cuerpos de tool_result viejos.',
  ckpt_seq: 'El seq del rollback no es monotónico. Rechacé.',
  ckpt_keep_pin: 'Conservé pines + últimos N checkpoints.',
  ckpt_session: 'El checkpoint es de otra sesión. No hago rollback.',
  diff_git_header: 'El patch no trae cabeceras --- / +++.',
  raw_line_count: 'Tras el write, el número de líneas no coincide.',
  diff_binary: 'No aplico un patch binario sobre un archivo de texto.',
  diff_context: 'El contexto del hunk no coincide con el archivo.',
  sandbox_stdout_cap: 'stdout del sandbox superó el tope por comando.',
  sandbox_rss: 'El proceso del sandbox superó el tope de RSS.',
  sandbox_tmp_prefix: 'El tmpdir del sandbox está fuera del prefijo permitido.',
  sse_replay_idempotent: 'El replay de SSE debe ser idempotente.',
  sse_cursor_ahead: 'Last-Event-ID está por delante del head. Rechacé el resume.',
  sse_drop_buffer: 'Cancelación: solté tokens buffered una sola vez.',
  sse_hb_jitter: 'El jitter del heartbeat está fuera de ventana.',
  queue_lock: 'La sesión está locked por otro writer.',
  queue_starve: 'La cola esperó de más. Subí prioridad.',
  credit_no_completion: 'Sin completion ni usage de error: no cobro.',
  credit_settle_once: 'El hold se liquida una sola vez en estado terminal.',
  dns_unavailable: 'DNS ENOTFOUND/EAI_AGAIN. Reintento como unavailable.',
  http_401: '401: no reintento. Revisa la credencial.',
  step_slow: 'Este paso tardó más que el presupuesto. Avisa latencia.',
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
  refuseFinishWhileParallelToolsOpen,
  cutLoopIfSameToolCallIdReused,
  stopIfMaxStepsWithPartialFinal,
  refuseEmptyAssistantWithOpenTools,
  rejectUndefinedRequiredToolArgs,
  repairJsonSingleQuotedValuesOnce,
  coerceEnumArgOrRefuse,
  backoffOn429RetryAfterHeader,
  stripUnknownArgsWhenAdditionalPropertiesFalse,
  refuseToolIfRequiredMissingAfterRepair,
  inheritSubagentTokenBudget,
  cutSubagentIfNoProgressTwoSteps,
  shareParentAbortDeadlineMs,
  capSiblingSubagentsPerParent,
  compactKeepPinnedAndLastUserPair,
  rejectPgvectorNaNOrInfComponents,
  pinFactsWhenFlagTrue,
  dropToolBodiesOlderThanNTurns,
  refuseRollbackIfSeqNotMonotonic,
  checkpointKeepLastNPlusPinned,
  refuseRollbackAcrossSessionBoundary,
  refuseDiffMissingGitHeaders,
  verifyReadAfterWriteLineCount,
  refuseBinaryPatchOnTextFile,
  requireHunkContextLinesMatch,
  capSandboxStdoutBytesPerCommand,
  refuseSandboxRssOverCap,
  requireSandboxTmpdirUnderPrefix,
  resumeReplayMustBeIdempotent,
  rejectResumeIfCursorAheadOfHead,
  dropBufferedTokensOnCancelOnce,
  heartbeatJitterWithinWindow,
  rejectEnqueueIfSessionLockedByOther,
  boostStarvedQueueAfterWaitMs,
  neverChargeIfNoCompletionAndNoErrorUsage,
  settleHoldOnceOnTerminalState,
  resetSettledHoldsForTests,
  classifyDnsEnotfoundAsUnavailable,
  neverRetry401Unauthorized,
  latencyHintWhenStepOverBudget,
  actionableErrorHint,
};
