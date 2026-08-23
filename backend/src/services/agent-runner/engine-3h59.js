'use strict';

/**
 * 3H59 — fail-open agent-loop robustness (engine only, no UI).
 *
 * Measurable Claude-Code-like helpers that are NOT in 3H32–3H46
 * (and do not collide with 3H55–3H58). Live VPS contract is 40 helpers
 * (same FLAGS + snapshotFlags shape as 3H55–3H58) so a recreate from
 * git does not drop the hot-patched wave:
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
 *   finish-hold / backtick JSON / HTTP URL / 499 backoff
 *   subagent cancel inherit + per-turn tool cap
 *   pgvector all-zero / anchor-tag pin / wave-mismatch rollback
 *   sidecar SHA-256 / empty-allowlist net / tmp-file cap
 *   cancelled SSE replay / lost session fence / partial-hold refund
 *   EAI_AGAIN → unavailable
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
const SUBAGENT_TOOLS_PER_TURN = 8;
const SANDBOX_TMP_FILE_CAP = 32;

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
  held_tool_calls_open: { retryable: false, message: 'Hay llamados a herramienta en hold. No cierro el turno.' },
  json_backtick_wrap: { retryable: false, message: 'Quité el envoltorio de backticks del JSON de la herramienta.' },
  tool_http_url: { retryable: false, message: 'La URL de la herramienta no es http(s) válida.' },
  http_499_retry: { retryable: true, message: '499: el cliente cerró. Reintento con espera.' },
  http_499: { retryable: false, message: '499: el cliente cerró. No reintento más.' },
  subagent_cancel_inherit: { retryable: false, message: 'El subagente heredó la cancelación del padre.' },
  subagent_tools_cap: { retryable: false, message: 'El subagente superó 8 llamados a herramienta en el turno.' },
  pgvector_sparse_zero: { retryable: false, message: 'El vector es todo ceros. Lo rechacé.' },
  fact_anchor_tag: { retryable: false, message: 'Piné hechos que traían etiqueta de ancla.' },
  ckpt_wave_mismatch: { retryable: false, message: 'El checkpoint es de otra ola. No revertí.' },
  sidecar_sha256: { retryable: false, message: 'El SHA-256 del sidecar no coincide tras el write.' },
  sandbox_net_allowlist: { retryable: false, message: 'Red del sandbox pedida con allowlist vacía. Fail-closed.' },
  sandbox_tmp_count: { retryable: false, message: 'El sandbox superó 32 archivos temporales.' },
  sse_replay_cancelled: { retryable: false, message: 'El run está cancelado. No reenvio el replay SSE.' },
  queue_fence_lost: { retryable: false, message: 'La sesión perdió el fence. No encolo.' },
  credit_cancel_hold: { retryable: false, message: 'Cancelado tras hold parcial. Devuelvo el remanente.' },
  net_eai_again: { retryable: true, message: 'EAI_AGAIN: DNS temporal. Trato como no disponible.' },
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

function refuseFinishIfHeldToolCallsOpen({ held, count } = {}) {
  const list = Array.isArray(held) ? held : [];
  const n = Number(count);
  const open = Number.isFinite(n) && n > 0 ? n : list.length;
  if (open > 0) return { ok: false, open, code: 'held_tool_calls_open' };
  return { ok: true, open: 0, code: null };
}

function repairJsonBacktickWrappedOnce(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw).trim();
  try {
    return { ok: true, value: JSON.parse(s), repaired: false, code: null };
  } catch (_) { /* unwrap fences */ }
  const m = s.match(/^`+(?:json|javascript|js)?\s*([\s\S]*?)`+$/i);
  if (m) {
    try {
      const value = JSON.parse(m[1].trim());
      return { ok: true, value, repaired: true, code: 'json_backtick_wrap' };
    } catch (e) {
      return { ok: false, value: null, repaired: false, error: e.message, code: 'json_backtick_wrap' };
    }
  }
  return { ok: false, value: null, repaired: false, code: 'json_backtick_wrap' };
}

function coerceHttpUrlOrRefuse(value) {
  if (value == null || value === '') return { ok: false, value, code: 'tool_http_url' };
  const s = String(value).trim();
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, value: s, code: 'tool_http_url' };
    }
    if (!u.hostname) return { ok: false, value: s, code: 'tool_http_url' };
    const next = u.toString();
    return { ok: true, value: next, coerced: next !== s, code: next !== s ? 'tool_http_url' : null };
  } catch (_) {
    return { ok: false, value: s, code: 'tool_http_url' };
  }
}

function backoffOn499ClientClosedRequest(err, { attempt = 0 } = {}) {
  const status = Number((err && (err.status || err.statusCode)) || (err && err.response && err.response.status));
  const msg = String((err && err.message) || '');
  const is499 = status === 499 || /\b499\b|client closed request/i.test(msg);
  if (!is499) return { retry: false, delayMs: 0, code: null };
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  if (n >= BACKOFF_MAX_ATTEMPTS) {
    return { retry: false, delayMs: 0, status: 499, attempt: n, code: 'http_499' };
  }
  const delayMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** n));
  return { retry: true, delayMs, status: 499, attempt: n, code: 'http_499_retry' };
}

function inheritSubagentCancelSignal({ parentSignal, childSignal } = {}) {
  const parentAborted = Boolean(parentSignal && (parentSignal.aborted === true || parentSignal.cancelled === true));
  if (parentAborted) {
    return { abort: true, inherited: true, code: 'subagent_cancel_inherit' };
  }
  const childAborted = Boolean(childSignal && (childSignal.aborted === true || childSignal.cancelled === true));
  if (childAborted) return { abort: true, inherited: false, code: 'subagent_cancel_inherit' };
  return { abort: false, inherited: false, code: null };
}

function capSubagentToolCallsPerTurn8({ count, max = SUBAGENT_TOOLS_PER_TURN } = {}) {
  const n = Number(count);
  const cap = Math.max(1, Number(max) || SUBAGENT_TOOLS_PER_TURN);
  if (Number.isFinite(n) && n > cap) return { ok: false, count: n, max: cap, code: 'subagent_tools_cap' };
  return { ok: true, count: Number.isFinite(n) ? n : 0, max: cap, code: null };
}

function rejectPgvectorSparseAllZeros(vector) {
  if (!Array.isArray(vector) || !vector.length) return { ok: false, nonzero: 0, code: 'pgvector_sparse_zero' };
  let nonzero = 0;
  for (const n of vector) {
    const v = Number(n);
    if (!Number.isFinite(v)) return { ok: false, nonzero, code: 'pgvector_sparse_zero' };
    if (v !== 0) nonzero += 1;
  }
  if (nonzero === 0) return { ok: false, nonzero: 0, code: 'pgvector_sparse_zero' };
  return { ok: true, nonzero, code: null };
}

function pinFactsWhenAnchorTagPresent(facts) {
  const list = Array.isArray(facts) ? facts : [];
  let pinned = 0;
  const out = list.map((f) => {
    if (!f || typeof f !== 'object') return f;
    const text = String(f.content || f.text || f.fact || '');
    if (f.anchor === true || ANCHOR_RE.test(text) || /<anchor\b/i.test(text)) {
      pinned += 1;
      return { ...f, pin: true };
    }
    return f;
  });
  return { facts: out, pinned, code: pinned ? 'fact_anchor_tag' : null };
}

function refuseRollbackIfWaveMismatch({ expectedWave, actualWave } = {}) {
  const a = String(expectedWave == null ? '' : expectedWave);
  const b = String(actualWave == null ? '' : actualWave);
  if (!a || !b) return { ok: true, skipped: true, code: null };
  if (a !== b) return { ok: false, expectedWave: a, actualWave: b, code: 'ckpt_wave_mismatch' };
  return { ok: true, code: null };
}

function verifySidecarSha256AfterWrite({ expected, actual, sidecar } = {}) {
  const exp = String(expected == null ? (sidecar && sidecar.sha256) || '' : expected);
  const act = String(actual == null ? '' : actual);
  if (!exp && !act) return { ok: true, skipped: true, code: null };
  const a = /^[a-f0-9]{64}$/i.test(exp) ? exp.toLowerCase() : sha256Hex(exp);
  const b = /^[a-f0-9]{64}$/i.test(act) ? act.toLowerCase() : sha256Hex(act);
  if (a !== b) return { ok: false, expected: a, actual: b, code: 'sidecar_sha256' };
  return { ok: true, sha256: a, code: null };
}

function refuseSandboxNetIfAllowlistEmpty({ allowlist, netEnabled } = {}) {
  if (netEnabled !== true) return { ok: true, skipped: true, code: null };
  const list = Array.isArray(allowlist) ? allowlist.filter((x) => String(x || '').trim()) : [];
  if (!list.length) return { ok: false, code: 'sandbox_net_allowlist' };
  return { ok: true, allowlist: list, code: null };
}

function capSandboxTmpFileCount32({ count, max = SANDBOX_TMP_FILE_CAP } = {}) {
  const n = Number(count);
  const cap = Math.max(1, Number(max) || SANDBOX_TMP_FILE_CAP);
  if (Number.isFinite(n) && n > cap) return { ok: false, count: n, max: cap, code: 'sandbox_tmp_count' };
  return { ok: true, count: Number.isFinite(n) ? n : 0, max: cap, code: null };
}

function dropSseReplayIfRunCancelled({ cancelled, events } = {}) {
  const list = Array.isArray(events) ? events : [];
  if (cancelled === true) {
    return { events: [], dropped: list.length, code: 'sse_replay_cancelled' };
  }
  return { events: list, dropped: 0, code: null };
}

function rejectEnqueueIfSessionFenceLost({ fence, expectedFence, sessionLocked } = {}) {
  if (sessionLocked === true) return { ok: false, code: 'queue_fence_lost' };
  const a = fence == null ? '' : String(fence);
  const b = expectedFence == null ? '' : String(expectedFence);
  if (!a && !b) return { ok: true, skipped: true, code: null };
  if (a && b && a !== b) return { ok: false, fence: a, expectedFence: b, code: 'queue_fence_lost' };
  if (expectedFence != null && expectedFence !== '' && !a) {
    return { ok: false, code: 'queue_fence_lost' };
  }
  return { ok: true, code: null };
}

function refundIfCancelledAfterPartialHold({ cancelled, heldTokens, settledTokens } = {}) {
  if (cancelled !== true) return { refund: false, tokens: 0, code: null };
  const held = Math.max(0, Number(heldTokens) || 0);
  const settled = Math.max(0, Number(settledTokens) || 0);
  const tokens = Math.max(0, held - settled);
  if (tokens > 0) return { refund: true, tokens, code: 'credit_cancel_hold' };
  return { refund: false, tokens: 0, code: null };
}

function classifyEaiAgainAsUnavailable(err) {
  const blob = `${String((err && (err.code || err.errno || err.name)) || '')} ${String((err && err.message) || '')}`.toUpperCase();
  if (blob.includes('EAI_AGAIN') || blob.includes('EAIAGAIN')) {
    return { unavailable: true, retryable: true, code: 'net_eai_again' };
  }
  return { unavailable: false, retryable: false, code: null };
}

const FLAGS = Object.freeze({
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
  refuseFinishIfHeldToolCallsOpen: true,
  repairJsonBacktickWrappedOnce: true,
  coerceHttpUrlOrRefuse: true,
  backoffOn499ClientClosedRequest: true,
  inheritSubagentCancelSignal: true,
  capSubagentToolCallsPerTurn8: true,
  rejectPgvectorSparseAllZeros: true,
  pinFactsWhenAnchorTagPresent: true,
  refuseRollbackIfWaveMismatch: true,
  verifySidecarSha256AfterWrite: true,
  refuseSandboxNetIfAllowlistEmpty: true,
  capSandboxTmpFileCount32: true,
  dropSseReplayIfRunCancelled: true,
  rejectEnqueueIfSessionFenceLost: true,
  refundIfCancelledAfterPartialHold: true,
  classifyEaiAgainAsUnavailable: true,
  wave: WAVE,
  openrouterGenerate: false,
  interpreter: 'local',
});

function snapshotFlags() {
  return { ...FLAGS };
}

function waveSnapshot() {
  return {
    ...snapshotFlags(),
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
  'refuseFinishIfHeldToolCallsOpen',
  'repairJsonBacktickWrappedOnce',
  'coerceHttpUrlOrRefuse',
  'backoffOn499ClientClosedRequest',
  'inheritSubagentCancelSignal',
  'capSubagentToolCallsPerTurn8',
  'rejectPgvectorSparseAllZeros',
  'pinFactsWhenAnchorTagPresent',
  'refuseRollbackIfWaveMismatch',
  'verifySidecarSha256AfterWrite',
  'refuseSandboxNetIfAllowlistEmpty',
  'capSandboxTmpFileCount32',
  'dropSseReplayIfRunCancelled',
  'rejectEnqueueIfSessionFenceLost',
  'refundIfCancelledAfterPartialHold',
  'classifyEaiAgainAsUnavailable',
]);

module.exports = {
  WAVE,
  FLAGS,
  HELPERS,
  ERROR_TABLE,
  MUTATING_TOOLS,
  snapshotFlags,
  waveSnapshot,
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
  refuseFinishIfHeldToolCallsOpen,
  repairJsonBacktickWrappedOnce,
  coerceHttpUrlOrRefuse,
  backoffOn499ClientClosedRequest,
  inheritSubagentCancelSignal,
  capSubagentToolCallsPerTurn8,
  rejectPgvectorSparseAllZeros,
  pinFactsWhenAnchorTagPresent,
  refuseRollbackIfWaveMismatch,
  verifySidecarSha256AfterWrite,
  refuseSandboxNetIfAllowlistEmpty,
  capSandboxTmpFileCount32,
  dropSseReplayIfRunCancelled,
  rejectEnqueueIfSessionFenceLost,
  refundIfCancelledAfterPartialHold,
  classifyEaiAgainAsUnavailable,
};
