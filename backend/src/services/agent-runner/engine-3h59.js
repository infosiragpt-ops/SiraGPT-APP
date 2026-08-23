'use strict';

/**
 * 3H59 — fail-open agent-loop robustness (engine only, no UI).
 *
 * Measurable Claude-Code-like helpers that are NOT in 3H32–3H46
 * (and would not collide with 3H55–3H58 if those modules appear later):
 *   tool-call schema validation / repair / backoff
 *   partial / malformed tool-call tolerance
 *   subtask token budget + infinite-loop fingerprint cutoff
 *   context compaction + critical-fact anchors
 *   checkpoint / rollback hooks
 *   sandbox timeout + orphan workdir cleanup
 *   SSE resume / cancel leak guards
 *   session-queue event order
 *   token accounting on cancel
 *   classified ES error messages (never raw stacks)
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle). Adapter loads us
 * fail-open: a missing or throwing require leaves 3H46 intact.
 */

const crypto = require('crypto');

const WAVE = '3H59';
const TOOL_CALL_KEEP = Object.freeze([
  'id', 'type', 'name', 'function', 'arguments', 'args', 'index', 'toolCallId', 'tool_call_id',
]);
const MUTATING_TOOLS = Object.freeze([
  'write_file', 'edit_file', 'apply_patch', 'str_replace',
  'create_presentation', 'add_slide', 'set_slide_background',
  'execute_bash', 'execute_python', 'bash', 'shell',
]);
const ANCHOR_RE = /(?:^|\n)\s*(?:ANCHOR|CRIT(?:ICAL)?|MUST(?:\s+NOT)?|NUNCA|SIEMPRE|DO NOT|MUST NOT)\s*:/i;
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;
const BACKOFF_BASE_MS = 80;
const BACKOFF_MAX_MS = 4_000;
const BACKOFF_MAX_ATTEMPTS = 4;
const INCOMPLETE_CHUNK_DROP = 8;
const FINGERPRINT_WINDOW = 6;
const FINGERPRINT_REPEAT = 3;
const SUBTASK_TOKEN_SLICE = 0.35;
const SUBTASK_TOKEN_FLOOR = 64;
const SUBTASK_TOKEN_CAP = 2_048;
const SANDBOX_ORPHAN_MS = 10 * 60 * 1000;
const CHARS_PER_TOKEN = 4;

const ERROR_TABLE = Object.freeze({
  tool_schema_repair: { retryable: false, message: 'Reparé argumentos incompletos de la herramienta y seguí.' },
  tool_call_backoff: { retryable: true, message: 'El llamado a la herramienta llegó malformado. Reintento con espera.' },
  tool_call_incomplete: { retryable: true, message: 'El llamado a la herramienta aún no cerró. Lo retuve.' },
  tool_call_dropped: { retryable: false, message: 'Descarté un llamado a herramienta incompleto tras varios fragmentos.' },
  tool_call_strip: { retryable: false, message: 'Quité campos extra del llamado a la herramienta.' },
  tool_name_inferred: { retryable: false, message: 'Inferí el nombre de la herramienta desde el id del llamado.' },
  subtask_token_budget: { retryable: false, message: 'El sub-trabajo se quedó sin presupuesto de tokens.' },
  loop_fingerprint_cut: { retryable: false, message: 'El agente repitió la misma huella de herramienta. Corté el bucle.' },
  subtask_no_progress: { retryable: false, message: 'El sub-trabajo no avanzó. Lo detuve para no girar en vacío.' },
  fact_anchor: { retryable: false, message: 'Conservé anclas de hechos críticos al compactar el contexto.' },
  ckpt_pre_write: { retryable: false, message: 'Tomé un checkpoint antes de una herramienta que escribe.' },
  ckpt_rollback_timeout: { retryable: true, message: 'La escritura expiró. Revertí al checkpoint anterior.' },
  ckpt_skip_unchanged: { retryable: false, message: 'Salté el checkpoint: el archivo no cambió.' },
  sandbox_timeout_cleanup: { retryable: true, message: 'El sandbox expiró. Limpié el directorio de trabajo.' },
  sandbox_orphan_reap: { retryable: false, message: 'Barrí directorios huérfanos del sandbox.' },
  sse_resume_leak: { retryable: false, message: 'Al reanudar el SSE solté listeners del stream anterior.' },
  sse_cancel_heartbeat: { retryable: false, message: 'Al cancelar el SSE apagué el heartbeat para no filtrar timers.' },
  sse_resume_ahead: { retryable: true, message: 'Last-Event-ID está por delante de la cabeza. Reinicio el replay.' },
  session_queue_reorder: { retryable: false, message: 'Reordené eventos de la cola de sesión por seq.' },
  session_queue_late: { retryable: false, message: 'Descarté un evento tardío fuera de orden.' },
  credit_cancel_partial: { retryable: false, message: 'Contabilicé tokens parciales del turno cancelado. No cobré de más.' },
  credit_cancel_dedupe: { retryable: false, message: 'Ese usage de cancelación ya estaba registrado. No lo duplicé.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

function stableJson(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  try {
    const keys = Object.keys(value).sort();
    const o = {};
    for (const k of keys) o[k] = value[k];
    return JSON.stringify(o);
  } catch (_) {
    return String(value);
  }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function defaultForSchemaType(type) {
  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return null;
}

function parseArgsLoose(raw) {
  if (raw == null) return { value: {}, parsed: true, partial: false };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { value: raw, parsed: true, partial: false };
  const s = String(raw).trim();
  if (!s) return { value: {}, parsed: true, partial: false };
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v, parsed: true, partial: false };
    return { value: {}, parsed: false, partial: false, raw: s };
  } catch (_) {
    let candidate = s.replace(/,\s*([}\]])/g, '$1');
    const opens = (candidate.match(/\{/g) || []).length;
    const closes = (candidate.match(/\}/g) || []).length;
    if (opens > closes) candidate += '}'.repeat(opens - closes);
    const openArr = (candidate.match(/\[/g) || []).length;
    const closeArr = (candidate.match(/\]/g) || []).length;
    if (openArr > closeArr) candidate += ']'.repeat(openArr - closeArr);
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { value: v, parsed: true, partial: true };
      }
    } catch (__) { /* still broken */ }
    return { value: {}, parsed: false, partial: true, raw: s };
  }
}

function callNameOf(call) {
  if (!call || typeof call !== 'object') return '';
  return String(
    call.name
    || (call.function && call.function.name)
    || call.tool
    || '',
  ).trim();
}

function callArgsOf(call) {
  if (!call || typeof call !== 'object') return null;
  if (call.arguments !== undefined) return call.arguments;
  if (call.args !== undefined) return call.args;
  if (call.function && call.function.arguments !== undefined) return call.function.arguments;
  return null;
}

function withCallArgs(call, args) {
  const next = { ...call };
  if (next.function && typeof next.function === 'object') {
    next.function = { ...next.function, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
  }
  next.arguments = args;
  next.args = args;
  return next;
}

/**
 * Validate a (possibly partial) tool call against a JSON schema, fill
 * missing required fields with type defaults, and drop unknown properties
 * when additionalProperties === false. Fail-open on empty input.
 */
function repairPartialToolCallSchema(call, schema) {
  if (call == null || typeof call !== 'object') {
    return { ok: true, skipped: true, repaired: false, missing: [], call: call || null, code: null };
  }
  const spec = schema && typeof schema === 'object' ? schema : {};
  const parsed = parseArgsLoose(callArgsOf(call));
  const args = { ...(parsed.value || {}) };
  const required = Array.isArray(spec.required) ? spec.required.map(String) : [];
  const props = spec.properties && typeof spec.properties === 'object' ? spec.properties : {};
  const missing = [];
  let repaired = parsed.partial === true;
  for (const key of required) {
    if (args[key] === undefined) {
      const t = props[key] && props[key].type;
      args[key] = defaultForSchemaType(t);
      missing.push(key);
      repaired = true;
    }
  }
  if (spec.additionalProperties === false && Object.keys(props).length) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        delete args[key];
        repaired = true;
      }
    }
  }
  const next = withCallArgs(call, args);
  return {
    ok: true,
    skipped: false,
    repaired,
    missing,
    partial: parsed.partial === true,
    call: next,
    code: repaired ? 'tool_schema_repair' : null,
  };
}

/**
 * Deterministic exponential backoff for malformed tool-call retries.
 * Jitter is attempt-seeded (no Date/random) so tests stay scripted.
 */
function backoffMalformedToolCall({ attempt = 0, kind = 'schema' } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  if (n >= BACKOFF_MAX_ATTEMPTS) {
    return { retry: false, delayMs: 0, attempt: n, kind: String(kind || 'schema'), code: 'tool_call_dropped' };
  }
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** n));
  const jitter = (n * 17) % 40;
  const delayMs = Math.min(BACKOFF_MAX_MS, exp + jitter);
  return { retry: true, delayMs, attempt: n, kind: String(kind || 'schema'), code: 'tool_call_backoff' };
}

function argsLookIncomplete(raw) {
  if (raw == null) return false;
  if (typeof raw === 'object') return false;
  const s = String(raw);
  if (!s.trim()) return true;
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  if (opens !== closes) return true;
  if (/,\s*$/.test(s.trim()) || /:\s*$/.test(s.trim())) return true;
  try { JSON.parse(s); return false; } catch (_) { return true; }
}

/**
 * Hold a streamed tool call until name + args close; drop after N chunks.
 */
function tolerateIncompleteStreamedToolCall(call, opts = {}) {
  if (call == null || typeof call !== 'object') {
    return { hold: false, drop: false, call: call || null, code: null };
  }
  const chunks = Math.max(0, Number(opts.chunks) || 0);
  const name = callNameOf(call);
  const incomplete = !name || argsLookIncomplete(callArgsOf(call));
  if (!incomplete) return { hold: false, drop: false, call, code: null };
  if (chunks >= INCOMPLETE_CHUNK_DROP) {
    return { hold: false, drop: true, call, code: 'tool_call_dropped' };
  }
  return { hold: true, drop: false, call, chunks, code: 'tool_call_incomplete' };
}

function stripUnknownToolCallProperties(call) {
  if (call == null || typeof call !== 'object') {
    return { call: call || null, stripped: 0, code: null };
  }
  const out = {};
  let stripped = 0;
  for (const key of Object.keys(call)) {
    if (TOOL_CALL_KEEP.includes(key)) out[key] = call[key];
    else stripped += 1;
  }
  if (out.function && typeof out.function === 'object') {
    const fn = {};
    for (const key of Object.keys(out.function)) {
      if (key === 'name' || key === 'arguments') fn[key] = out.function[key];
      else stripped += 1;
    }
    out.function = fn;
  }
  return { call: out, stripped, code: stripped ? 'tool_call_strip' : null };
}

function inferToolNameFromCallId(call, catalog) {
  const names = Array.isArray(catalog) ? catalog.map(String) : [];
  const existing = callNameOf(call);
  if (existing) return { name: existing, inferred: false, call, code: null };
  const id = String((call && (call.id || call.toolCallId || call.tool_call_id)) || '');
  if (!id || !names.length) return { name: '', inferred: false, call, code: null };
  const lower = id.toLowerCase();
  const hit = names.find((n) => {
    const nn = String(n || '').toLowerCase();
    return nn && (lower === nn || lower.startsWith(`${nn}_`) || lower.includes(`_${nn}_`) || lower.endsWith(`_${nn}`));
  });
  if (!hit) return { name: '', inferred: false, call, code: null };
  const next = { ...call };
  if (next.function && typeof next.function === 'object') {
    next.function = { ...next.function, name: hit };
  } else {
    next.name = hit;
  }
  return { name: hit, inferred: true, call: next, code: 'tool_name_inferred' };
}

function sliceSubtaskTokenBudget({ parentRemaining = 0, requested = null, floor = SUBTASK_TOKEN_FLOOR, cap = SUBTASK_TOKEN_CAP } = {}) {
  const parent = Math.max(0, Number(parentRemaining) || 0);
  const lo = Math.max(1, Number(floor) || SUBTASK_TOKEN_FLOOR);
  const hi = Math.max(lo, Number(cap) || SUBTASK_TOKEN_CAP);
  if (parent <= 0) return { ok: false, budget: 0, code: 'subtask_token_budget' };
  let budget = Math.max(lo, Math.min(hi, Math.floor(parent * SUBTASK_TOKEN_SLICE) || lo));
  if (requested != null) {
    const r = Number(requested);
    if (Number.isFinite(r) && r > 0) budget = Math.min(budget, Math.floor(r));
  }
  budget = Math.min(budget, parent);
  if (budget < 1) return { ok: false, budget: 0, code: 'subtask_token_budget' };
  return { ok: true, budget, parentRemaining: parent, code: null };
}

function fingerprintOfCall(entry) {
  if (!entry) return '';
  const name = typeof entry === 'string' ? entry : callNameOf(entry) || String(entry.tool || '');
  const args = typeof entry === 'string' ? '' : callArgsOf(entry);
  const parsed = parseArgsLoose(args);
  return sha256Hex(`${name}\0${stableJson(parsed.value)}`);
}

function cutInfiniteLoopByFingerprint(history, opts = {}) {
  const list = Array.isArray(history) ? history : [];
  const window = Math.max(2, Number(opts.window) || FINGERPRINT_WINDOW);
  const repeat = Math.max(2, Number(opts.repeat) || FINGERPRINT_REPEAT);
  const slice = list.slice(-window);
  if (slice.length < repeat) return { cut: false, count: 0, fingerprint: null, code: null };
  const fps = slice.map(fingerprintOfCall);
  const last = fps[fps.length - 1];
  if (!last) return { cut: false, count: 0, fingerprint: null, code: null };
  let run = 0;
  for (let i = fps.length - 1; i >= 0; i -= 1) {
    if (fps[i] === last) run += 1;
    else break;
  }
  if (run >= repeat) {
    return { cut: true, count: run, fingerprint: last, code: 'loop_fingerprint_cut' };
  }
  return { cut: false, count: run, fingerprint: last, code: null };
}

function cutSubtaskIfNoProgress({ steps = [], tokensDelta = 0, artifactsDelta = 0, maxIdle = 3 } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const idleCap = Math.max(1, Number(maxIdle) || 3);
  const tail = list.slice(-idleCap);
  if (!tail.length) return { cut: false, idle: 0, code: null };
  const tokenN = Number(tokensDelta);
  const artN = Number(artifactsDelta);
  const noTokens = !Number.isFinite(tokenN) || tokenN <= 0;
  const noArts = !Number.isFinite(artN) || artN <= 0;
  const tailIdle = tail.every((s) => {
    const t = Number(s && (s.tokensDelta != null ? s.tokensDelta : s.tokens));
    const a = Number(s && (s.artifactsDelta != null ? s.artifactsDelta : s.artifacts));
    const stepTokens = Number.isFinite(t) ? t : 0;
    const stepArts = Number.isFinite(a) ? a : 0;
    return stepTokens <= 0 && stepArts <= 0;
  });
  if (tail.length >= idleCap && tailIdle && noTokens && noArts) {
    return { cut: true, idle: tail.length, code: 'subtask_no_progress' };
  }
  return { cut: false, idle: tailIdle ? tail.length : 0, code: null };
}

function extractAnchorText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (msg.pin === true && msg.content) return String(msg.content);
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
  }
  return String(content || '');
}

function anchorCriticalFacts(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const anchors = [];
  for (const m of list) {
    const text = extractAnchorText(m);
    if (m && m.pin === true && text.trim()) {
      anchors.push({ role: (m && m.role) || 'system', content: text, pin: true });
      continue;
    }
    if (ANCHOR_RE.test(text)) {
      anchors.push({ role: (m && m.role) || 'system', content: text, pin: true });
    }
  }
  return { anchors, count: anchors.length, code: anchors.length ? 'fact_anchor' : null };
}

function compactPreserveFactAnchors(original, compacted, anchors) {
  const src = Array.isArray(original) ? original : [];
  const out = Array.isArray(compacted) ? compacted.slice() : src.slice();
  const pins = Array.isArray(anchors) ? anchors : anchorCriticalFacts(src).anchors;
  if (!pins.length) return { messages: out, restored: 0, code: null };
  let restored = 0;
  const have = new Set(out.map((m) => extractAnchorText(m)));
  for (let i = pins.length - 1; i >= 0; i -= 1) {
    const pin = pins[i];
    const text = extractAnchorText(pin);
    if (!text || have.has(text)) continue;
    out.unshift({ role: pin.role || 'system', content: text, pin: true });
    have.add(text);
    restored += 1;
  }
  return { messages: out, restored, code: restored ? 'fact_anchor' : null };
}

function checkpointHookBeforeMutatingTool({ tool, path, name } = {}) {
  const t = String(tool || name || '').trim();
  if (!t) return { hook: false, skipped: true, code: null };
  if (!MUTATING_TOOLS.includes(t)) return { hook: false, skipped: true, tool: t, code: null };
  return {
    hook: true,
    kind: 'pre_write',
    tool: t,
    path: path == null ? null : String(path),
    code: 'ckpt_pre_write',
  };
}

function rollbackHookOnTimedOutWrite({ timedOut, path, checkpointId } = {}) {
  if (timedOut !== true) return { rollback: false, code: null };
  const p = path == null ? '' : String(path);
  if (!p) return { rollback: false, code: null };
  return {
    rollback: true,
    path: p,
    checkpointId: checkpointId == null ? null : String(checkpointId),
    code: 'ckpt_rollback_timeout',
  };
}

function skipCheckpointIfUnchanged({ beforeHash, afterHash } = {}) {
  const a = beforeHash == null ? '' : String(beforeHash);
  const b = afterHash == null ? '' : String(afterHash);
  if (a && b && a === b) return { skip: true, code: 'ckpt_skip_unchanged' };
  return { skip: false, code: null };
}

function sandboxTimeoutThenCleanup({ elapsedMs, timeoutMs, workdir } = {}) {
  const elapsed = Number(elapsedMs);
  const limit = Number(timeoutMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(limit) || limit <= 0) {
    return { timeout: false, cleanup: false, code: null };
  }
  if (elapsed < limit) return { timeout: false, cleanup: false, remainingMs: limit - elapsed, code: null };
  return {
    timeout: true,
    cleanup: true,
    workdir: workdir == null ? null : String(workdir),
    signals: Object.freeze(['SIGTERM', 'SIGKILL']),
    code: 'sandbox_timeout_cleanup',
  };
}

function sandboxReapOrphanWorkdirs(dirs, { now = Date.now(), maxAgeMs = SANDBOX_ORPHAN_MS } = {}) {
  const list = Array.isArray(dirs) ? dirs : [];
  const t = Number(now) || Date.now();
  const age = Math.max(1000, Number(maxAgeMs) || SANDBOX_ORPHAN_MS);
  const reap = [];
  const kept = [];
  for (const d of list) {
    const path = typeof d === 'string' ? d : (d && (d.path || d.dir || d.workdir)) || '';
    const mtime = Number(typeof d === 'object' && d ? (d.mtimeMs != null ? d.mtimeMs : d.mtime) : NaN);
    const marked = typeof d === 'object' && d && d.orphan === true;
    const stale = Number.isFinite(mtime) && (t - mtime) >= age;
    if (path && (marked || stale)) reap.push(typeof d === 'string' ? { path: d } : { ...d, path });
    else kept.push(d);
  }
  return { reap, kept, count: reap.length, code: reap.length ? 'sandbox_orphan_reap' : null };
}

function sseResumeDropsPriorListeners({ listeners, resume } = {}) {
  const list = Array.isArray(listeners) ? listeners : [];
  if (resume !== true) return { listeners: list, dropped: 0, code: null };
  for (const l of list) {
    if (l && typeof l.off === 'function') {
      try { l.off(); } catch (_) { /* leak-guard best-effort */ }
    } else if (typeof l === 'function') {
      try { l(); } catch (_) { /* ignore */ }
    }
  }
  return { listeners: [], dropped: list.length, code: list.length ? 'sse_resume_leak' : null };
}

function sseCancelClearsHeartbeat({ cancelled, heartbeatTimer } = {}) {
  if (cancelled !== true) return { cleared: false, code: null };
  if (typeof heartbeatTimer === 'function') {
    try { heartbeatTimer(); } catch (_) { /* ignore */ }
  } else if (heartbeatTimer && typeof heartbeatTimer.clear === 'function') {
    try { heartbeatTimer.clear(); } catch (_) { /* ignore */ }
  }
  return { cleared: true, code: 'sse_cancel_heartbeat' };
}

function sseResumeRejectsSeqPastHead({ lastEventId, headSeq } = {}) {
  const last = Number(lastEventId);
  const head = Number(headSeq);
  if (!Number.isFinite(last) || !Number.isFinite(head)) {
    return { ok: true, reset: false, code: null };
  }
  if (last > head) return { ok: false, reset: true, lastEventId: last, headSeq: head, code: 'sse_resume_ahead' };
  return { ok: true, reset: false, lastEventId: last, headSeq: head, code: null };
}

function eventSeqOf(ev) {
  if (ev == null) return Number.POSITIVE_INFINITY;
  const n = Number(ev.seq != null ? ev.seq : (ev.id != null ? ev.id : ev.eventId));
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function sessionQueueOrderBySeq(events) {
  const list = Array.isArray(events) ? events.slice() : [];
  const before = list.map(eventSeqOf).join('\0');
  list.sort((a, b) => eventSeqOf(a) - eventSeqOf(b));
  const after = list.map(eventSeqOf).join('\0');
  return { events: list, reordered: before !== after, code: before !== after ? 'session_queue_reorder' : null };
}

function sessionQueueDropLateOutOfOrder(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const head = Number(opts.headSeq);
  const maxLag = Math.max(0, Number(opts.maxLag) || 2);
  if (!Number.isFinite(head)) return { events: list, dropped: 0, code: null };
  const kept = [];
  let dropped = 0;
  for (const ev of list) {
    const seq = eventSeqOf(ev);
    if (Number.isFinite(seq) && seq < head - maxLag) {
      dropped += 1;
      continue;
    }
    kept.push(ev);
  }
  return { events: kept, dropped, code: dropped ? 'session_queue_late' : null };
}

function accountPartialTokensOnCancel({ cancelled, streamedChars, usage } = {}) {
  if (cancelled !== true) {
    return { billed: false, promptTokens: 0, completionTokens: 0, code: null };
  }
  const prompt = Math.max(0, Number(usage && usage.promptTokens) || 0);
  let completion = Math.max(0, Number(usage && usage.completionTokens) || 0);
  const chars = Number(streamedChars);
  if ((!completion || !Number.isFinite(completion)) && Number.isFinite(chars) && chars > 0) {
    completion = Math.ceil(chars / CHARS_PER_TOKEN);
  }
  return {
    billed: prompt + completion > 0,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    code: 'credit_cancel_partial',
  };
}

function neverDoubleCountCancelUsage({ alreadyRecorded, usage } = {}) {
  if (alreadyRecorded === true) {
    return { recorded: false, skipped: true, usage: usage || null, code: 'credit_cancel_dedupe' };
  }
  return { recorded: true, skipped: false, usage: usage || null, code: null };
}

function classifyEngine3h59Error(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error) ? input : { err: input };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const row = ERROR_TABLE[code];
  const stackSrc = String((raw.err && (raw.err.stack || raw.err.message)) || raw.message || '');
  const leaked = STACK_RE.test(stackSrc) || SECRET_RE.test(stackSrc);
  if (!row) return null;
  return {
    code,
    message: row.message,
    retryable: row.retryable === true,
    leaked: false,
    wave: WAVE,
    stripped: leaked,
  };
}

function refuseOpenRouterInWave3h59(env = process.env) {
  const e = env && typeof env === 'object' ? env : {};
  const bases = [
    e.DEEPSEEK_BASE_URL, e.OPENAI_BASE_URL, e.LLM_BASE_URL,
    e.SIRAGPT_LLM_BASE_URL, e.NATIVE_LLM_BASE_URL, e.GENERATE_BASE_URL,
  ].map((v) => String(v || ''));
  const flagged = bases.some((b) => /openrouter\.ai/i.test(b));
  const forced = String(e.SIRAGPT_USE_OPENROUTER || e.USE_OPENROUTER || '') === '1';
  const model = String(e.SIRAGPT_AGENT_RUNNER_MODEL || e.VISIBLE_MODELS_ALLOWLIST || '');
  const modelOr = /openrouter/i.test(model);
  if (flagged || forced || modelOr) {
    return { ok: false, openrouter: true, code: 'openrouter_denied' };
  }
  return { ok: true, openrouter: false, code: null };
}

function waveSnapshot() {
  return {
    wave: WAVE,
    repairPartialToolCallSchema: true,
    backoffMalformedToolCall: true,
    tolerateIncompleteStreamedToolCall: true,
    stripUnknownToolCallProperties: true,
    inferToolNameFromCallId: true,
    sliceSubtaskTokenBudget: true,
    cutInfiniteLoopByFingerprint: true,
    cutSubtaskIfNoProgress: true,
    anchorCriticalFacts: true,
    compactPreserveFactAnchors: true,
    checkpointHookBeforeMutatingTool: true,
    rollbackHookOnTimedOutWrite: true,
    skipCheckpointIfUnchanged: true,
    sandboxTimeoutThenCleanup: true,
    sandboxReapOrphanWorkdirs: true,
    sseResumeDropsPriorListeners: true,
    sseCancelClearsHeartbeat: true,
    sseResumeRejectsSeqPastHead: true,
    sessionQueueOrderBySeq: true,
    sessionQueueDropLateOutOfOrder: true,
    accountPartialTokensOnCancel: true,
    neverDoubleCountCancelUsage: true,
    classifyEngine3h59Error: true,
    refuseOpenRouterInWave3h59: true,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
  };
}

const HELPERS = Object.freeze([
  'repairPartialToolCallSchema',
  'backoffMalformedToolCall',
  'tolerateIncompleteStreamedToolCall',
  'stripUnknownToolCallProperties',
  'inferToolNameFromCallId',
  'sliceSubtaskTokenBudget',
  'cutInfiniteLoopByFingerprint',
  'cutSubtaskIfNoProgress',
  'anchorCriticalFacts',
  'compactPreserveFactAnchors',
  'checkpointHookBeforeMutatingTool',
  'rollbackHookOnTimedOutWrite',
  'skipCheckpointIfUnchanged',
  'sandboxTimeoutThenCleanup',
  'sandboxReapOrphanWorkdirs',
  'sseResumeDropsPriorListeners',
  'sseCancelClearsHeartbeat',
  'sseResumeRejectsSeqPastHead',
  'sessionQueueOrderBySeq',
  'sessionQueueDropLateOutOfOrder',
  'accountPartialTokensOnCancel',
  'neverDoubleCountCancelUsage',
  'classifyEngine3h59Error',
  'refuseOpenRouterInWave3h59',
]);

module.exports = {
  WAVE,
  HELPERS,
  ERROR_TABLE,
  MUTATING_TOOLS,
  repairPartialToolCallSchema,
  backoffMalformedToolCall,
  tolerateIncompleteStreamedToolCall,
  stripUnknownToolCallProperties,
  inferToolNameFromCallId,
  sliceSubtaskTokenBudget,
  cutInfiniteLoopByFingerprint,
  cutSubtaskIfNoProgress,
  anchorCriticalFacts,
  compactPreserveFactAnchors,
  checkpointHookBeforeMutatingTool,
  rollbackHookOnTimedOutWrite,
  skipCheckpointIfUnchanged,
  sandboxTimeoutThenCleanup,
  sandboxReapOrphanWorkdirs,
  sseResumeDropsPriorListeners,
  sseCancelClearsHeartbeat,
  sseResumeRejectsSeqPastHead,
  sessionQueueOrderBySeq,
  sessionQueueDropLateOutOfOrder,
  accountPartialTokensOnCancel,
  neverDoubleCountCancelUsage,
  classifyEngine3h59Error,
  refuseOpenRouterInWave3h59,
  waveSnapshot,
};
