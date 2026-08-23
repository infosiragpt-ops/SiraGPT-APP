'use strict';

/**
 * 3H60 — fail-open agent-loop robustness (engine only, no UI).
 *
 * Remaining Claude-Code-like holes after 3H59 (do not collide with
 * 3H55–3H59 helper names):
 *   type/enum/fence repair + transient tool retry
 *   A-B-A-B oscillation cut + inherited subagent step budget
 *   faithful compact summary + query prune + pinned memory recover
 *   file-byte checkpoint / hash read-after-write / syntax revert
 *   sandbox stdout cap + abort-finally cleanup
 *   SSE Last-Event-ID replay + comment heartbeat (no seq) + abort
 *   single-writer session lock + seq-gap detect
 *   credit settle on error (not only cancel) + never charge pre-token
 *   classified ES errors (never raw stacks) + scripted p50/p95
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle). Adapter loads us
 * fail-open: a missing or throwing require leaves 3H59 intact.
 */

const crypto = require('crypto');

const WAVE = '3H60';
const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 3_200;
const BACKOFF_MAX_ATTEMPTS = 4;
const OSCILLATION_MIN = 4;
const SUBAGENT_STEP_FLOOR = 1;
const SUBAGENT_STEP_CAP = 12;
const COMPACT_SUMMARY_MAX = 720;
const OVERLAP_MIN = 0.12;
const KEEP_LAST_DEFAULT = 4;
const CHUNK_CAP_DEFAULT = 64 * 1024;
const PROMPT_TOKEN_ERROR_CAP = 8_192;
const LATENCY_RING = 256;
const CHARS_PER_TOKEN = 4;
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/;
const FENCE_RE = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/i;

const ERROR_TABLE = Object.freeze({
  tool_arg_coerce: { retryable: false, message: 'Coercí tipos de argumentos de la herramienta y seguí.' },
  tool_arg_fence: { retryable: false, message: 'Saqué el JSON de argumentos de un bloque con vallas.' },
  tool_enum_repair: { retryable: false, message: 'Ajusté un valor de enumeración al más cercano permitido.' },
  tool_transient_retry: { retryable: true, message: 'La herramienta falló de forma transitoria. Reintento con espera.' },
  tool_nameless: { retryable: false, message: 'El llamado no tenía nombre de herramienta. No lo ejecuté.' },
  loop_oscillation_cut: { retryable: false, message: 'El agente alternó las mismas dos herramientas. Corté el bucle.' },
  subagent_steps_inherit: { retryable: false, message: 'El subagente heredó el presupuesto de pasos restante del padre.' },
  subagent_parent_budget: { retryable: false, message: 'El padre ya no tiene pasos. No lancé el subagente.' },
  compact_faithful: { retryable: false, message: 'Resumí los turnos descartados para no perder el hilo.' },
  compact_prune: { retryable: false, message: 'Quité mensajes irrelevantes al compactar el contexto.' },
  memory_pin_recover: { retryable: false, message: 'Recuperé hechos anclados de memoria que el compactado había soltado.' },
  compact_keep_user: { retryable: false, message: 'Conservé el último mensaje del usuario al compactar.' },
  ckpt_bytes: { retryable: false, message: 'Guardé un snapshot de bytes antes de escribir el archivo.' },
  ckpt_bytes_rollback: { retryable: true, message: 'Restauré el archivo al snapshot de bytes anterior.' },
  write_hash_mismatch: { retryable: true, message: 'El hash posterior a la escritura no coincidió. No di el cambio por bueno.' },
  write_syntax_revert: { retryable: false, message: 'La escritura dejó sintaxis inválida. Restauré el original.' },
  diff_markers: { retryable: false, message: 'El diff no trae marcadores ---/+++. No lo apliqué.' },
  sandbox_chunk_cap: { retryable: false, message: 'Corté un fragmento de stdout/stderr del sandbox al tope.' },
  sandbox_abort_cleanup: { retryable: false, message: 'Al abortar el sandbox limpié el proceso y el directorio.' },
  sse_replay_resume: { retryable: true, message: 'Reanudé el SSE desde Last-Event-ID sin reejecutar el turno.' },
  sse_heartbeat_noseq: { retryable: false, message: 'El heartbeat SSE es un comentario: no incrementa seq.' },
  sse_disconnect_abort: { retryable: false, message: 'El cliente se desconectó. Aborté el controlador del turno.' },
  sse_cancel_buffer: { retryable: false, message: 'Al cancelar el SSE solté tokens aún no enviados.' },
  session_writer_busy: { retryable: true, message: 'Esta sesión ya tiene un escritor. Encolé el turno.' },
  session_queue_gap: { retryable: true, message: 'Falta un seq en la cola de sesión. Espero el hueco.' },
  credit_error_settle: { retryable: false, message: 'Asenté el uso real del turno con error. No cobré de más.' },
  credit_pre_token: { retryable: false, message: 'No cobré: el stream se cortó antes del primer token.' },
  credit_prompt_cap: { retryable: false, message: 'Topeé los tokens de prompt al asentar un error.' },
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
  const encoded = typeof args === 'string' ? args : JSON.stringify(args);
  if (next.function && typeof next.function === 'object') {
    next.function = { ...next.function, arguments: encoded };
  }
  next.arguments = args;
  next.args = args;
  return next;
}

function parseLooseObject(raw) {
  if (raw == null) return { value: {}, parsed: true };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { value: raw, parsed: true };
  const s = String(raw).trim();
  if (!s) return { value: {}, parsed: true };
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v, parsed: true };
    return { value: {}, parsed: false, raw: s };
  } catch (_) {
    return { value: {}, parsed: false, raw: s };
  }
}

function messageText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
  }
  return String(content || '');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  const row = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) row[j] = j;
  for (let i = 1; i <= n; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const tmp = row[j];
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[m];
}

function defaultForType(type) {
  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return null;
}

function coerceValue(value, spec) {
  const type = spec && spec.type;
  if (value == null) return { value: defaultForType(type), changed: value !== defaultForType(type) };
  if (type === 'number' || type === 'integer') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const n = type === 'integer' ? Math.trunc(value) : value;
      return { value: n, changed: n !== value };
    }
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      const n = type === 'integer' ? parseInt(value, 10) : Number(value);
      return { value: n, changed: true };
    }
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return { value, changed: false };
    if (value === 'true' || value === '1' || value === 1) return { value: true, changed: true };
    if (value === 'false' || value === '0' || value === 0) return { value: false, changed: true };
  }
  if (type === 'string' && typeof value !== 'string') {
    return { value: String(value), changed: true };
  }
  if (type === 'array' && !Array.isArray(value)) {
    return { value: [value], changed: true };
  }
  return { value, changed: false };
}

/**
 * Coerce tool-call args to the schema types (string "42" → number, "true" → bool).
 */
function coerceToolArgTypes(call, schema) {
  if (call == null || typeof call !== 'object') {
    return { ok: true, skipped: true, changed: false, call: call || null, code: null };
  }
  const spec = schema && typeof schema === 'object' ? schema : {};
  const props = spec.properties && typeof spec.properties === 'object' ? spec.properties : {};
  const parsed = parseLooseObject(callArgsOf(call));
  const args = { ...(parsed.value || {}) };
  let changed = false;
  for (const key of Object.keys(props)) {
    if (args[key] === undefined) continue;
    const next = coerceValue(args[key], props[key]);
    if (next.changed) {
      args[key] = next.value;
      changed = true;
    }
  }
  return {
    ok: true,
    skipped: false,
    changed,
    call: changed ? withCallArgs(call, args) : call,
    code: changed ? 'tool_arg_coerce' : null,
  };
}

/**
 * Unwrap ```json fences or a leading '+' that models emit around tool args.
 */
function unwrapFencedToolArgs(raw) {
  if (raw == null) return { value: {}, unwrapped: false, code: null };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { value: raw, unwrapped: false, code: null };
  }
  let s = String(raw).trim();
  let unwrapped = false;
  if (s.charAt(0) === '+') {
    s = s.slice(1).trim();
    unwrapped = true;
  }
  const fence = s.match(FENCE_RE);
  if (fence) {
    s = String(fence[1] || '').trim();
    unwrapped = true;
  }
  const parsed = parseLooseObject(s);
  return {
    value: parsed.value,
    unwrapped,
    parsed: parsed.parsed === true,
    code: unwrapped ? 'tool_arg_fence' : null,
  };
}

function repairEnumArgClosestMatch(value, allowed) {
  const list = Array.isArray(allowed) ? allowed.map(String) : [];
  if (!list.length) return { value, repaired: false, code: null };
  const raw = value == null ? '' : String(value);
  if (!raw) return { value: list[0], repaired: true, code: 'tool_enum_repair' };
  if (list.includes(raw)) return { value: raw, repaired: false, code: null };
  const lower = raw.toLowerCase();
  const exact = list.find((a) => a.toLowerCase() === lower);
  if (exact) return { value: exact, repaired: true, code: 'tool_enum_repair' };
  let best = list[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const a of list) {
    const d = levenshtein(lower, a.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return { value: best, repaired: true, distance: bestD, code: 'tool_enum_repair' };
}

function isTransientToolStatus(status, code) {
  const n = Number(status);
  if (n === 429 || n === 408 || n === 502 || n === 503 || n === 504) return true;
  const c = String(code || '').toLowerCase();
  return c === 'etimedout' || c === 'econnreset' || c === 'eai_again' || c === 'timeout' || c === 'unavailable';
}

/**
 * Deterministic backoff for transient tool errors (429/5xx/timeout). 4xx
 * other than 408/429 never retry.
 */
function retryTransientToolError({ attempt = 0, status, code } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const transient = isTransientToolStatus(status, code);
  if (!transient) {
    return { retry: false, delayMs: 0, attempt: n, code: null };
  }
  if (n >= BACKOFF_MAX_ATTEMPTS) {
    return { retry: false, delayMs: 0, attempt: n, code: 'tool_nameless' };
  }
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** n));
  const jitter = (n * 13) % 30;
  return {
    retry: true,
    delayMs: Math.min(BACKOFF_MAX_MS, exp + jitter),
    attempt: n,
    code: 'tool_transient_retry',
  };
}

function refuseNamelessToolAfterRepair(call) {
  const name = callNameOf(call);
  if (name) return { ok: true, refused: false, name, call, code: null };
  return { ok: false, refused: true, name: '', call, code: 'tool_nameless' };
}

function fingerprintName(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return callNameOf(entry) || String(entry.tool || '');
}

/**
 * Cut A-B-A-B oscillation (two distinct tools alternating ≥ 4 steps).
 */
function cutOscillatingToolPair(history, opts = {}) {
  const list = Array.isArray(history) ? history : [];
  const min = Math.max(4, Number(opts.min) || OSCILLATION_MIN);
  if (list.length < min) return { cut: false, pair: null, code: null };
  const names = list.slice(-min).map(fingerprintName);
  if (names.some((n) => !n)) return { cut: false, pair: null, code: null };
  const a = names[0];
  const b = names[1];
  if (!a || !b || a === b) return { cut: false, pair: null, code: null };
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] !== (i % 2 === 0 ? a : b)) return { cut: false, pair: [a, b], code: null };
  }
  return { cut: true, pair: [a, b], count: names.length, code: 'loop_oscillation_cut' };
}

function inheritSubagentRemainingSteps({ parentRemaining = 0, requested = null } = {}) {
  const parent = Math.max(0, Math.floor(Number(parentRemaining) || 0));
  if (parent <= 0) return { ok: false, steps: 0, code: 'subagent_parent_budget' };
  let steps = Math.max(SUBAGENT_STEP_FLOOR, Math.min(SUBAGENT_STEP_CAP, parent - 1));
  if (requested != null) {
    const r = Math.floor(Number(requested));
    if (Number.isFinite(r) && r > 0) steps = Math.min(steps, r);
  }
  if (steps < 1) return { ok: false, steps: 0, code: 'subagent_parent_budget' };
  return { ok: true, steps, parentRemaining: parent, code: 'subagent_steps_inherit' };
}

function refuseSubagentIfParentBudgetGone({ parentRemaining = 0 } = {}) {
  const parent = Math.max(0, Math.floor(Number(parentRemaining) || 0));
  if (parent <= 0) return { refuse: true, code: 'subagent_parent_budget' };
  return { refuse: false, code: null };
}

function compactFaithfulDroppedSummary(original, compacted) {
  const src = Array.isArray(original) ? original : [];
  const out = Array.isArray(compacted) ? compacted.slice() : [];
  const keep = new Set(out.map((m) => messageText(m)));
  const dropped = src.filter((m) => m && m.role !== 'system' && !keep.has(messageText(m)));
  if (!dropped.length) return { messages: out, summary: null, dropped: 0, code: null };
  const bits = dropped.map((m) => {
    const role = (m && m.role) || 'user';
    const text = messageText(m).replace(/\s+/g, ' ').trim().slice(0, 160);
    return `${role}: ${text}`;
  }).filter(Boolean);
  const summary = bits.join(' · ').slice(0, COMPACT_SUMMARY_MAX);
  out.unshift({
    role: 'system',
    content: `Resumen fiel de turnos compactados (${dropped.length}): ${summary}`,
    compactSummary: true,
  });
  return { messages: out, summary, dropped: dropped.length, code: 'compact_faithful' };
}

function pruneMessagesByQueryOverlap(messages, query, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const q = String(query || '');
  const min = Number(opts.minOverlap);
  const threshold = Number.isFinite(min) ? min : OVERLAP_MIN;
  const keepLast = Math.max(1, Number(opts.keepLast) || KEEP_LAST_DEFAULT);
  const kept = [];
  const pruned = [];
  list.forEach((m, idx) => {
    const fromEnd = list.length - idx;
    if (!m || m.role === 'system' || m.pin === true || fromEnd <= keepLast) {
      kept.push(m);
      return;
    }
    const score = jaccard(q, messageText(m));
    if (score >= threshold) kept.push(m);
    else pruned.push(m);
  });
  return {
    messages: kept,
    pruned: pruned.length,
    code: pruned.length ? 'compact_prune' : null,
  };
}

function recoverPinnedMemoryFacts(compacted, memoryHits) {
  const out = Array.isArray(compacted) ? compacted.slice() : [];
  const hits = Array.isArray(memoryHits) ? memoryHits : [];
  const have = new Set(out.map((m) => String((m && (m.factId || m.id)) || messageText(m))));
  let recovered = 0;
  for (const hit of hits) {
    if (!hit) continue;
    const pin = hit.pin === true || hit.keep === true || Number(hit.score) >= 0.85;
    if (!pin) continue;
    const id = String(hit.factId || hit.id || '');
    const text = String(hit.content || hit.text || hit.fact || '');
    const key = id || text;
    if (!key || have.has(key) || have.has(text)) continue;
    out.unshift({
      role: 'system',
      content: text,
      pin: true,
      factId: id || null,
      memoryRecovered: true,
    });
    have.add(key);
    have.add(text);
    recovered += 1;
  }
  return { messages: out, recovered, code: recovered ? 'memory_pin_recover' : null };
}

function neverDropLastUserOnCompact(original, compacted) {
  const src = Array.isArray(original) ? original : [];
  const out = Array.isArray(compacted) ? compacted.slice() : [];
  let lastUser = null;
  for (let i = src.length - 1; i >= 0; i -= 1) {
    if (src[i] && src[i].role === 'user') {
      lastUser = src[i];
      break;
    }
  }
  if (!lastUser) return { messages: out, restored: false, code: null };
  const text = messageText(lastUser);
  const has = out.some((m) => m && m.role === 'user' && messageText(m) === text);
  if (has) return { messages: out, restored: false, code: null };
  out.push({ role: 'user', content: lastUser.content, pin: true });
  return { messages: out, restored: true, code: 'compact_keep_user' };
}

function checkpointFileByteSnapshot({ path: filePath, bytes } = {}) {
  const p = filePath == null ? '' : String(filePath);
  if (!p) return { ok: false, snapshot: null, code: null };
  const raw = bytes == null ? Buffer.alloc(0) : Buffer.from(bytes);
  return {
    ok: true,
    snapshot: {
      path: p,
      sha256: sha256Hex(raw),
      bytes: raw,
      byteLength: raw.length,
    },
    code: 'ckpt_bytes',
  };
}

function rollbackFileByteSnapshot({ path: filePath, snapshot, restore } = {}) {
  const p = filePath == null ? '' : String(filePath);
  if (!p || !snapshot || snapshot.path !== p || !snapshot.bytes) {
    return { ok: false, restored: false, code: null };
  }
  if (typeof restore === 'function') {
    try { restore(p, snapshot.bytes); } catch (_) { /* fail-open */ }
  }
  return { ok: true, restored: true, path: p, sha256: snapshot.sha256, code: 'ckpt_bytes_rollback' };
}

function verifyReadAfterWriteHash({ expectedHash, actualBytes } = {}) {
  const expected = expectedHash == null ? '' : String(expectedHash);
  if (!expected) return { ok: true, skipped: true, code: null };
  const actual = sha256Hex(actualBytes == null ? '' : actualBytes);
  if (actual === expected) return { ok: true, match: true, sha256: actual, code: null };
  return { ok: false, match: false, sha256: actual, expected, code: 'write_hash_mismatch' };
}

function looksUnbalanced(text) {
  const s = String(text || '');
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (stack.pop() !== ch) return true;
    }
  }
  return inStr || stack.length > 0;
}

function revertWriteOnSyntaxFail({ path: filePath, before, after, restore } = {}) {
  const p = filePath == null ? '' : String(filePath);
  if (!p) return { ok: true, skipped: true, reverted: false, code: null };
  if (!looksUnbalanced(after)) return { ok: true, reverted: false, code: null };
  if (typeof restore === 'function') {
    try { restore(p, before); } catch (_) { /* fail-open */ }
  }
  return { ok: false, reverted: true, path: p, code: 'write_syntax_revert' };
}

function applyExactDiffRequiresMarkers(diff) {
  const text = String(diff || '');
  if (!text.trim()) return { ok: false, code: 'diff_markers' };
  const hasMinus = /^---\s+\S+/m.test(text);
  const hasPlus = /^\+\+\+\s+\S+/m.test(text);
  if (!hasMinus || !hasPlus) return { ok: false, code: 'diff_markers' };
  return { ok: true, code: null };
}

function sandboxStreamChunkCap({ chunk, used = 0, cap = CHUNK_CAP_DEFAULT } = {}) {
  const limit = Math.max(1, Number(cap) || CHUNK_CAP_DEFAULT);
  const already = Math.max(0, Number(used) || 0);
  const raw = chunk == null ? Buffer.alloc(0) : Buffer.from(chunk);
  const remaining = Math.max(0, limit - already);
  if (raw.length <= remaining) {
    return { chunk: raw, truncated: false, used: already + raw.length, code: null };
  }
  return {
    chunk: raw.subarray(0, remaining),
    truncated: true,
    used: limit,
    dropped: raw.length - remaining,
    code: 'sandbox_chunk_cap',
  };
}

function sandboxFinallyCleanupOnAbort({ aborted, workdir, pid, kill } = {}) {
  if (aborted !== true) return { cleanup: false, code: null };
  if (typeof kill === 'function' && pid) {
    try { kill(pid, 'SIGTERM'); } catch (_) { /* best-effort */ }
    try { kill(pid, 'SIGKILL'); } catch (_) { /* best-effort */ }
  }
  return {
    cleanup: true,
    workdir: workdir == null ? null : String(workdir),
    pid: pid == null ? null : pid,
    signals: Object.freeze(['SIGTERM', 'SIGKILL']),
    code: 'sandbox_abort_cleanup',
  };
}

function eventSeqOf(ev) {
  if (ev == null) return Number.NaN;
  const n = Number(ev.seq != null ? ev.seq : (ev.id != null ? ev.id : ev.eventId));
  return Number.isFinite(n) ? n : Number.NaN;
}

function sseReplayFromLastEventId(events, lastEventId) {
  const list = Array.isArray(events) ? events : [];
  const last = Number(lastEventId);
  if (!Number.isFinite(last)) return { events: list, replayed: list.length, skipped: 0, code: null };
  const replay = [];
  let skipped = 0;
  for (const ev of list) {
    const seq = eventSeqOf(ev);
    if (Number.isFinite(seq) && seq <= last) {
      skipped += 1;
      continue;
    }
    replay.push(ev);
  }
  return {
    events: replay,
    replayed: replay.length,
    skipped,
    lastEventId: last,
    code: skipped ? 'sse_replay_resume' : null,
  };
}

function sseHeartbeatCommentNoSeq({ seq, kind } = {}) {
  const n = Number(seq);
  const comment = kind === 'comment' || kind === 'heartbeat' || kind == null;
  if (!comment) return { seq: Number.isFinite(n) ? n : 0, bumped: true, code: null };
  return {
    seq: Number.isFinite(n) ? n : 0,
    bumped: false,
    frame: ': heartbeat\n\n',
    code: 'sse_heartbeat_noseq',
  };
}

function sseAbortOnClientDisconnect({ disconnected, controller } = {}) {
  if (disconnected !== true) return { aborted: false, code: null };
  if (controller && typeof controller.abort === 'function') {
    try { controller.abort(); } catch (_) { /* ignore */ }
  }
  return { aborted: true, code: 'sse_disconnect_abort' };
}

function dropBufferedTokensOnSseCancel({ cancelled, buffered } = {}) {
  if (cancelled !== true) return { dropped: 0, code: null };
  const n = Array.isArray(buffered) ? buffered.length : Math.max(0, Number(buffered) || 0);
  return { dropped: n, buffer: [], code: n ? 'sse_cancel_buffer' : null };
}

function sessionSingleWriterLock({ held, sessionKey } = {}) {
  const key = sessionKey == null ? '' : String(sessionKey);
  if (!key) return { acquired: false, skipped: true, code: null };
  if (held === true) return { acquired: false, busy: true, sessionKey: key, code: 'session_writer_busy' };
  return { acquired: true, busy: false, sessionKey: key, code: null };
}

function sessionQueueDetectGap(events) {
  const list = Array.isArray(events) ? events.slice() : [];
  const seqs = list.map(eventSeqOf).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (seqs.length < 2) return { gap: false, missing: [], code: null };
  const missing = [];
  for (let i = 1; i < seqs.length; i += 1) {
    for (let s = seqs[i - 1] + 1; s < seqs[i]; s += 1) missing.push(s);
  }
  if (!missing.length) return { gap: false, missing: [], code: null };
  return { gap: true, missing, wait: missing[0], code: 'session_queue_gap' };
}

function settleCreditsOnError({ errored, usage, alreadySettled } = {}) {
  if (errored !== true) return { settled: false, promptTokens: 0, completionTokens: 0, code: null };
  if (alreadySettled === true) return { settled: false, skipped: true, code: 'credit_error_settle' };
  const prompt = Math.max(0, Number(usage && usage.promptTokens) || 0);
  let completion = Math.max(0, Number(usage && usage.completionTokens) || 0);
  const chars = Number(usage && usage.streamedChars);
  if (!completion && Number.isFinite(chars) && chars > 0) {
    completion = Math.ceil(chars / CHARS_PER_TOKEN);
  }
  return {
    settled: true,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    code: 'credit_error_settle',
  };
}

function neverChargeBeforeFirstToken({ firstToken, cancelled, errored, tokens } = {}) {
  const tok = Number(tokens);
  const noToken = firstToken !== true && !(Number.isFinite(tok) && tok > 0);
  if ((cancelled === true || errored === true) && noToken) {
    return { charge: false, code: 'credit_pre_token' };
  }
  return { charge: true, code: null };
}

function capPromptTokensOnErrorSettle({ promptTokens, cap = PROMPT_TOKEN_ERROR_CAP } = {}) {
  const n = Number(promptTokens);
  const limit = Math.max(1, Number(cap) || PROMPT_TOKEN_ERROR_CAP);
  if (!Number.isFinite(n) || n < 0) return { promptTokens: 0, capped: false, code: null };
  if (n <= limit) return { promptTokens: n, capped: false, code: null };
  return { promptTokens: limit, capped: true, code: 'credit_prompt_cap' };
}

function classifyEngine3h60Error(input) {
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

function redactSecretsFromPublicError(message) {
  let text = String(message == null ? '' : message);
  const hadSecret = SECRET_RE.test(text);
  const hadStack = STACK_RE.test(text);
  text = text.replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-[redacted]');
  if (hadStack) {
    text = text.split('\n').filter((line) => !/^\s*at\s+/.test(line)).join('\n').trim();
  }
  return { message: text || 'La operación no pudo completarse.', redacted: hadSecret || hadStack };
}

const latencyStores = {
  first_token: [],
  turn_end: [],
};

function observeScriptedLatencySample(kind, ms, store) {
  const key = kind === 'ttfb' || kind === 'first_token' ? 'first_token' : 'turn_end';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return { ok: false, snapshot: snapshotLatency(key, store) };
  const ring = Array.isArray(store) ? store : latencyStores[key];
  ring.push(n);
  if (ring.length > LATENCY_RING) ring.shift();
  return { ok: true, kind: key, ms: n, snapshot: snapshotLatency(key, ring) };
}

function snapshotLatency(kind, store) {
  const ring = Array.isArray(store) ? store : latencyStores[kind === 'ttfb' || kind === 'first_token' ? 'first_token' : 'turn_end'];
  if (!ring.length) return { p50: null, p95: null, count: 0, source: 'scripted' };
  const sorted = ring.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
  return { p50: at(0.5), p95: at(0.95), count: sorted.length, source: 'scripted' };
}

function refuseOpenRouterInWave3h60(env = process.env) {
  const e = env && typeof env === 'object' ? env : {};
  const bases = [
    e.DEEPSEEK_BASE_URL, e.OPENAI_BASE_URL, e.LLM_BASE_URL,
    e.SIRAGPT_LLM_BASE_URL, e.NATIVE_LLM_BASE_URL, e.GENERATE_BASE_URL,
  ].map((v) => String(v || ''));
  const flagged = bases.some((b) => /openrouter\.ai/i.test(b));
  const forced = String(e.SIRAGPT_USE_OPENROUTER || e.USE_OPENROUTER || '') === '1';
  const model = String(e.SIRAGPT_AGENT_RUNNER_MODEL || e.VISIBLE_MODELS_ALLOWLIST || '');
  if (flagged || forced || /openrouter/i.test(model)) {
    return { ok: false, openrouter: true, code: 'openrouter_denied' };
  }
  return { ok: true, openrouter: false, code: null };
}

const FLAGS = Object.freeze({
  coerceToolArgTypes: true,
  unwrapFencedToolArgs: true,
  repairEnumArgClosestMatch: true,
  retryTransientToolError: true,
  refuseNamelessToolAfterRepair: true,
  cutOscillatingToolPair: true,
  inheritSubagentRemainingSteps: true,
  refuseSubagentIfParentBudgetGone: true,
  compactFaithfulDroppedSummary: true,
  pruneMessagesByQueryOverlap: true,
  recoverPinnedMemoryFacts: true,
  neverDropLastUserOnCompact: true,
  checkpointFileByteSnapshot: true,
  rollbackFileByteSnapshot: true,
  verifyReadAfterWriteHash: true,
  revertWriteOnSyntaxFail: true,
  applyExactDiffRequiresMarkers: true,
  sandboxStreamChunkCap: true,
  sandboxFinallyCleanupOnAbort: true,
  sseReplayFromLastEventId: true,
  sseHeartbeatCommentNoSeq: true,
  sseAbortOnClientDisconnect: true,
  dropBufferedTokensOnSseCancel: true,
  sessionSingleWriterLock: true,
  sessionQueueDetectGap: true,
  settleCreditsOnError: true,
  neverChargeBeforeFirstToken: true,
  capPromptTokensOnErrorSettle: true,
  classifyEngine3h60Error: true,
  redactSecretsFromPublicError: true,
  observeScriptedLatencySample: true,
  refuseOpenRouterInWave3h60: true,
});

function snapshotFlags() {
  return { ...FLAGS, wave: WAVE, interpreter: 'local', openrouterGenerate: false, sandboxUsesRunsc: false };
}

function waveSnapshot() {
  return {
    wave: WAVE,
    ...FLAGS,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    latencyNote: 'scripted p50/p95; never invented Flash',
  };
}

const HELPERS = Object.freeze(Object.keys(FLAGS));

module.exports = {
  WAVE,
  HELPERS,
  FLAGS,
  ERROR_TABLE,
  coerceToolArgTypes,
  unwrapFencedToolArgs,
  repairEnumArgClosestMatch,
  retryTransientToolError,
  refuseNamelessToolAfterRepair,
  cutOscillatingToolPair,
  inheritSubagentRemainingSteps,
  refuseSubagentIfParentBudgetGone,
  compactFaithfulDroppedSummary,
  pruneMessagesByQueryOverlap,
  recoverPinnedMemoryFacts,
  neverDropLastUserOnCompact,
  checkpointFileByteSnapshot,
  rollbackFileByteSnapshot,
  verifyReadAfterWriteHash,
  revertWriteOnSyntaxFail,
  applyExactDiffRequiresMarkers,
  sandboxStreamChunkCap,
  sandboxFinallyCleanupOnAbort,
  sseReplayFromLastEventId,
  sseHeartbeatCommentNoSeq,
  sseAbortOnClientDisconnect,
  dropBufferedTokensOnSseCancel,
  sessionSingleWriterLock,
  sessionQueueDetectGap,
  settleCreditsOnError,
  neverChargeBeforeFirstToken,
  capPromptTokensOnErrorSettle,
  classifyEngine3h60Error,
  redactSecretsFromPublicError,
  observeScriptedLatencySample,
  snapshotLatency,
  refuseOpenRouterInWave3h60,
  snapshotFlags,
  waveSnapshot,
};
