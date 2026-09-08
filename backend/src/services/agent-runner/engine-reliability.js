'use strict';

/**
 * 3H16 — engine reliability helpers for AgentRunner /chat /code.
 *
 * Claude Code / Cowork parity in the ENGINE (not UI):
 *   2 tool-call repair + transient retry
 *   3 infinite-loop cut + step budget
 *   4 compact/pin long context
 *   5 in-memory checkpoint + rollback
 *   10 token usage even on cancel/error
 *   11 classified loop errors
 *   12 first-token / turn-end latency
 *
 * Pure helpers. The live loop wires these; tests exercise them without DeepSeek.
 */

const REPEAT_CUT_DEFAULT = 3;
const STEP_BUDGET_DEFAULT = 40;
const COMPACT_TARGET_TOKENS = 12_000;
const MAX_BACKOFF_MS = 4_000;
const FIRST_BACKOFF_MS = 200;

let compactTrajectory = null;
try {
  ({ compactTrajectory } = require('../agents/trajectory-compactor'));
} catch (_) {
  compactTrajectory = null;
}

let createMultiQuantile = null;
try {
  ({ createMultiQuantile } = require('../observability/p2-quantile'));
} catch (_) {
  createMultiQuantile = null;
}

const firstTokenQuantiles = createMultiQuantile
  ? createMultiQuantile([0.5, 0.95])
  : null;
const turnEndQuantiles = createMultiQuantile
  ? createMultiQuantile([0.5, 0.95])
  : null;

function snapshotQuantiles(q) {
  if (!q || typeof q.values !== 'function') return { p50: null, p95: null, count: 0 };
  const v = q.values() || {};
  const snap = typeof q.snapshot === 'function' ? q.snapshot() : null;
  const count = snap && typeof snap.count === 'number'
    ? snap.count
    : (typeof q.count === 'function' ? q.count() : 0);
  return {
    p50: v['0.5'] == null ? null : Number(v['0.5']),
    p95: v['0.95'] == null ? null : Number(v['0.95']),
    count: Number(count) || 0,
  };
}

function engineLatencySnapshot() {
  return {
    firstTokenMs: snapshotQuantiles(firstTokenQuantiles),
    turnEndMs: snapshotQuantiles(turnEndQuantiles),
  };
}

function persistLatencyFire(kind, n) {
  try {
    const dur = require('./engine-durability');
    Promise.resolve(dur.persistLatencyObservation(dur.getSharedKv(), kind, n)).catch(() => {});
  } catch (_) { /* optional */ }
}

function observeFirstToken(ms, opts = {}) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  try { firstTokenQuantiles && firstTokenQuantiles.observe(n); } catch (_) { /* optional */ }
  if (opts.persist !== false) persistLatencyFire('ttfb', n);
}

function observeTurnEnd(ms, opts = {}) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  try { turnEndQuantiles && turnEndQuantiles.observe(n); } catch (_) { /* optional */ }
  if (opts.persist !== false) persistLatencyFire('turn', n);
}

let latencyHydrated = false;
function hydrateLatencyFromDurable() {
  if (latencyHydrated) return;
  latencyHydrated = true;
  try {
    const dur = require('./engine-durability');
    const kv = dur.getSharedKv();
    Promise.all([
      dur.loadLatencyObservations(kv, 'ttfb'),
      dur.loadLatencyObservations(kv, 'turn'),
    ]).then(([ttfb, turn]) => {
      for (const it of ttfb || []) observeFirstToken(it && it.ms, { persist: false });
      for (const it of turn || []) observeTurnEnd(it && it.ms, { persist: false });
    }).catch(() => {});
  } catch (_) { /* optional */ }
}
/* 3H17: hydrate on /health, not at module load — ioredis would keep node --test alive */

/**
 * Repair malformed tool-call JSON arguments.
 * Handles trailing commas, single quotes, truncated braces, fenced blobs.
 */
function repairToolArgs(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.__parse_error) {
      const inner = repairToolArgs(raw.raw);
      return inner.ok ? { ok: true, value: inner.value, repaired: true } : inner;
    }
    return { ok: true, value: raw, repaired: false };
  }
  let s = String(raw).trim();
  if (!s) return { ok: true, value: {}, repaired: false };
  try {
    return { ok: true, value: JSON.parse(s), repaired: false };
  } catch (_) { /* repair */ }

  let repaired = s;
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  repaired = repaired.replace(/'/g, '"');
  const fence = repaired.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) repaired = fence[1].trim();
  const firstBrace = repaired.indexOf('{');
  const lastBrace = repaired.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    repaired = repaired.slice(firstBrace, lastBrace + 1);
  } else if (firstBrace !== -1 && lastBrace === -1) {
    let open = 0;
    for (const ch of repaired.slice(firstBrace)) {
      if (ch === '{') open += 1;
      else if (ch === '}') open -= 1;
    }
    repaired = `${repaired.slice(firstBrace)}${'}'.repeat(Math.max(0, open))}`;
  }
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  try {
    return { ok: true, value: JSON.parse(repaired), repaired: true };
  } catch (err) {
    return {
      ok: false,
      value: { __parse_error: true, raw: s.slice(0, 500) },
      repaired: false,
      error: err && err.message,
    };
  }
}

/**
 * Tolerate partial / malformed native tool_calls.
 * Missing id, missing name, object-shaped arguments, empty function.
 */
function normalizeToolCall(call, iteration, idx) {
  const src = call && typeof call === 'object' ? call : {};
  const fn = src.function && typeof src.function === 'object' ? src.function : {};
  const name = String(fn.name || src.name || src.tool || '').trim() || 'unknown';
  let argsRaw = fn.arguments;
  if (argsRaw == null) argsRaw = src.arguments != null ? src.arguments : src.args;
  const repaired = repairToolArgs(argsRaw);
  return {
    id: String(src.id || `call_${iteration}_${idx}`),
    type: 'function',
    function: {
      name,
      arguments: repaired.ok ? JSON.stringify(repaired.value) : String(argsRaw == null ? '{}' : argsRaw),
    },
    __repaired: Boolean(repaired.repaired),
    __parse_error: repaired.ok ? false : true,
    __args: repaired.ok ? repaired.value : { __parse_error: true, raw: String(argsRaw || '').slice(0, 500) },
  };
}

function normalizeToolCalls(calls, iteration) {
  if (!Array.isArray(calls)) return [];
  const out = [];
  const seen = new Set();
  calls.forEach((call, idx) => {
    const n = normalizeToolCall(call, iteration, idx);
    if (!n.function.name || n.function.name === 'unknown') return;
    const key = `${n.function.name}:${n.function.arguments}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  });
  return out;
}

function isTransientLlmError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || (err && err.code === 'ABORT_ERR')) return false;
  const status = Number(err.status || err.statusCode || err.response?.status || NaN);
  if (status === 402 || status === 401 || status === 403 || status === 400) return false;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const msg = String(err.message || err.code || '').toLowerCase();
  if (/\b402\b|insufficient credits|payment required/.test(msg)) return false;
  return /econnreset|econnrefused|etimedout|eai_again|socket hang up|fetch failed|network|overloaded|temporarily unavailable|service unavailable|502|503|504/.test(msg);
}

function backoffMs(attempt, { first = FIRST_BACKOFF_MS, max = MAX_BACKOFF_MS, jitter = true } = {}) {
  const n = Math.max(0, Number(attempt) || 0);
  const base = Math.min(max, first * (2 ** n));
  if (!jitter) return base;
  const spread = base * 0.2;
  return Math.max(0, Math.floor(base - spread + Math.random() * spread * 2));
}

function toolFingerprint(name, args) {
  const norm = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
    if (typeof value !== 'object') return String(value);
    const keys = Object.keys(value).sort();
    const o = {};
    for (const k of keys) o[k] = typeof value[k] === 'string' ? value[k].replace(/\s+/g, ' ').trim() : value[k];
    try { return JSON.stringify(o); } catch (_) { return String(value); }
  };
  return `${String(name || '')}:${norm(args)}`;
}

function createRepeatGuard({ limit = REPEAT_CUT_DEFAULT } = {}) {
  const counts = new Map();
  const cap = Math.max(2, Math.min(10, Number(limit) || REPEAT_CUT_DEFAULT));
  return {
    limit: cap,
    see(name, args) {
      const key = toolFingerprint(name, args);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { key, count: n, cut: n >= cap };
    },
    size: () => counts.size,
  };
}

function createStepBudget({ maxSteps = STEP_BUDGET_DEFAULT } = {}) {
  const cap = Math.max(1, Math.min(80, Number(maxSteps) || STEP_BUDGET_DEFAULT));
  let used = 0;
  return {
    cap,
    remaining() { return Math.max(0, cap - used); },
    consume(n = 1) {
      used += Math.max(0, Number(n) || 0);
      return used > cap;
    },
    used() { return used; },
    exceeded() { return used >= cap; },
  };
}

function pinCriticalFacts(messages, pins = []) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const facts = Array.isArray(pins) ? pins.filter((p) => p && String(p).trim()) : [];
  if (!facts.length) return list;
  const block = `[PINNED FACTS — do not drop]\n${facts.map((f) => `- ${String(f).slice(0, 400)}`).join('\n')}`;
  const existing = list.findIndex((m) => m && m.role === 'system' && /PINNED FACTS/.test(String(m.content || '')));
  if (existing >= 0) {
    list[existing] = { role: 'system', content: block };
    return list;
  }
  const insertAt = list.findIndex((m) => m && m.role === 'system') >= 0
    ? list.findIndex((m) => m && m.role === 'system') + 1
    : 0;
  list.splice(insertAt, 0, { role: 'system', content: block });
  return list;
}

function compactMessagesIfNeeded(messages, opts = {}) {
  const input = Array.isArray(messages) ? messages : [];
  const target = opts.targetMaxTokens || COMPACT_TARGET_TOKENS;
  if (input.length <= 6) {
    return { messages: input, compressed: false, beforeTokens: 0, afterTokens: 0 };
  }
  if (typeof compactTrajectory === 'function') {
    try {
      const result = compactTrajectory(input, {
        targetMaxTokens: target,
        protectHead: opts.protectHead || 2,
        protectTail: opts.protectTail || 4,
        activeTask: opts.activeTask,
      });
      return {
        messages: result.turns || input,
        compressed: Boolean(result.compressed),
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        removedTurns: result.removedTurns || 0,
      };
    } catch (_) { /* fall through to local compact */ }
  }
  const beforeTokens = Math.ceil(JSON.stringify(input).length / 4);
  if (beforeTokens <= target) {
    return { messages: input, compressed: false, beforeTokens, afterTokens: beforeTokens };
  }
  const head = input.slice(0, 2);
  const tail = input.slice(-4);
  const removed = Math.max(0, input.length - 6);
  const summary = {
    role: 'system',
    type: 'compaction_summary',
    content: `Compressed ${removed} middle turns to fit the context budget. Resume from the tail. Do not repeat completed tool calls.`,
  };
  const compacted = [...head, summary, ...tail];
  return {
    messages: compacted,
    compressed: true,
    beforeTokens,
    afterTokens: Math.ceil(JSON.stringify(compacted).length / 4),
    removedTurns: removed,
  };
}

function createCheckpoint() {
  let stack = [];
  return {
    save(state) {
      const snap = {
        id: `ckpt_${Date.now()}_${stack.length}`,
        at: Date.now(),
        iteration: state && state.iteration,
        messages: Array.isArray(state && state.messages) ? state.messages.map((m) => ({ ...m })) : [],
        steps: Array.isArray(state && state.steps) ? state.steps.slice() : [],
        usage: state && state.usage ? { ...state.usage } : { promptTokens: 0, completionTokens: 0 },
      };
      stack.push(snap);
      if (stack.length > 8) stack = stack.slice(-8);
      return snap.id;
    },
    latest() { return stack.length ? stack[stack.length - 1] : null; },
    rollback() {
      if (!stack.length) return null;
      return stack[stack.length - 1];
    },
    restore(messages) {
      const snap = stack.length ? stack[stack.length - 1] : null;
      if (!snap) return null;
      if (Array.isArray(messages) && Array.isArray(snap.messages)) {
        messages.splice(0, messages.length, ...snap.messages.map((m) => ({ ...m })));
      }
      return snap;
    },
    rollbackN(n = 1) {
      const k = Math.max(1, Number(n) || 1);
      if (!stack.length) return { ok: false, code: 'checkpoint_missing', state: null, depth: 0 };
      let last = null;
      for (let i = 0; i < k && stack.length; i += 1) last = stack.pop();
      const snap = stack.length ? stack[stack.length - 1] : last;
      return { ok: true, state: snap, popped: last, depth: stack.length, code: 'checkpoint_rollback' };
    },
    restoreN(messages, n = 1) {
      const k = Math.max(1, Number(n) || 1);
      if (!stack.length) return null;
      for (let i = 0; i < k && stack.length; i += 1) stack.pop();
      const snap = stack.length ? stack[stack.length - 1] : null;
      if (!snap) return null;
      if (Array.isArray(messages) && Array.isArray(snap.messages)) {
        messages.splice(0, messages.length, ...snap.messages.map((m) => ({ ...m })));
      }
      return snap;
    },
    pop() { return stack.pop() || null; },
    size() { return stack.length; },
  };
}

function extractUsage(response) {
  const u = (response && (response.usage || response.token_usage)) || {};
  const prompt = Number(u.prompt_tokens || u.input_tokens || u.promptTokens || 0) || 0;
  const completion = Number(u.completion_tokens || u.output_tokens || u.completionTokens || 0) || 0;
  return { promptTokens: prompt, completionTokens: completion };
}

function createUsageAccumulator() {
  let promptTokens = 0;
  let completionTokens = 0;
  return {
    add(responseOrUsage) {
      const u = responseOrUsage && (responseOrUsage.promptTokens != null || responseOrUsage.completionTokens != null)
        ? responseOrUsage
        : extractUsage(responseOrUsage);
      promptTokens += Number(u.promptTokens) || 0;
      completionTokens += Number(u.completionTokens) || 0;
      return this.snapshot();
    },
    snapshot() {
      return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
    },
  };
}

function classifyLoopError(err) {
  if (!err) return { code: 'internal_error', retryable: false, message: 'La operación no pudo completarse.' };
  if (err.name === 'AbortError' || /abort|cancel/i.test(String(err.message || ''))) {
    return { code: 'aborted', retryable: true, message: 'La operación fue cancelada.' };
  }
  const status = Number(err.status || err.statusCode || NaN);
  if (status === 402 || /llm_402|insufficient credits/i.test(String(err.message || err.code || ''))) {
    return { code: 'credits_exhausted', retryable: false, message: 'No quedan créditos suficientes para esta operación.' };
  }
  if (err.code === 'loop_cut' || err.code === 'infinite_loop_cut') {
    return { code: 'loop_cut', retryable: false, message: 'El agente repitió el mismo paso demasiadas veces. Detuve el bucle.' };
  }
  if (err.code === 'budget_exceeded' || /budget_exceeded|max_iterations/i.test(String(err.code || err.message || ''))) {
    return { code: 'budget_exceeded', retryable: false, message: 'El presupuesto de pasos del agente se agotó.' };
  }
  if (err.code === 'tool_args_invalid') {
    return { code: 'tool_args_invalid', retryable: false, message: 'Los argumentos de la herramienta no eran JSON válido. El agente debe reintentar con JSON correcto.' };
  }
  if (err.code === 'checkpoint_missing') {
    return { code: 'checkpoint_missing', retryable: false, message: 'No encontré el punto de restauración de esta sesión.' };
  }
  if (err.code === 'tool_timeout') {
    return { code: 'tool_timeout', retryable: true, message: 'La herramienta tardó demasiado y la detuve.' };
  }
  if (err.code === 'sandbox_killed') {
    return { code: 'sandbox_killed', retryable: true, message: 'El entorno de ejecución se cerró. Reintenta el paso.' };
  }
  if (err.code === 'file_too_large') {
    return { code: 'file_too_large', retryable: false, message: 'El archivo supera el tamaño máximo permitido.' };
  }
  if (err.code === 'checkpoint_expired') {
    return { code: 'checkpoint_expired', retryable: false, message: 'El punto de restauración de esta sesión expiró.' };
  }
  if (err.code === 'resume_conflict') {
    return { code: 'resume_conflict', retryable: false, message: 'Otra reanudación de esta sesión ya está en curso.' };
  }
  if (err.code === 'schema_invalid') {
    return { code: 'schema_invalid', retryable: false, message: 'Los argumentos no cumplen el esquema de la herramienta.' };
  }
  if (err.code === 'memory_acl_denied') {
    return { code: 'memory_acl_denied', retryable: false, message: 'No pude usar recuerdos de otro usuario.' };
  }
  if (err.code === 'symlink_rejected') {
    return { code: 'symlink_rejected', retryable: false, message: 'No escribo sobre enlaces simbólicos en el sandbox.' };
  }
  if (err.code === 'sandbox_resource_limit') {
    return { code: 'sandbox_resource_limit', retryable: true, message: 'El sandbox alcanzó el límite de CPU o memoria.' };
  }
  if (err.code === 'coercion_rejected') {
    return { code: 'coercion_rejected', retryable: false, message: 'Los argumentos superan el límite permitido de la herramienta.' };
  }
  if (err.code === 'dlq_exhausted') {
    return { code: 'dlq_exhausted', retryable: false, message: 'La herramienta falló demasiadas veces. La pasé a la cola de errores.' };
  }
  if (err.code === 'fence_conflict') {
    return { code: 'fence_conflict', retryable: false, message: 'Otra instancia del motor ya está ejecutando esta sesión.' };
  }
  if (err.code === 'network_denied') {
    return { code: 'network_denied', retryable: false, message: 'El sandbox no tiene red permitida para ese destino.' };
  }
  if (err.code === 'path_traversal') {
    return { code: 'path_traversal', retryable: false, message: 'La ruta sale del espacio de trabajo.' };
  }
  if (err.code === 'duplicate_event') {
    return { code: 'duplicate_event', retryable: false, message: 'Ese evento ya se entregó. Lo descarté.' };
  }
  if (err.code === 'fence_expired') {
    return { code: 'fence_expired', retryable: true, message: 'El candado de esta sesión expiró. Puedes reanudar.' };
  }
  if (err.code === 'dlq_replay') {
    return { code: 'dlq_replay', retryable: true, message: 'Reintentaré el paso con espera aleatoria.' };
  }
  if (err.code === 'pgvector_failed') {
    return { code: 'pgvector_failed', retryable: true, message: 'No pude consultar la memoria vectorial. Sigo sin ella.' };
  }
  if (err.code === 'tmpfs_exceeded') {
    return { code: 'tmpfs_exceeded', retryable: false, message: 'El espacio temporal del sandbox está lleno.' };
  }
  if (err.code === 'credit_mismatch') {
    return { code: 'credit_mismatch', retryable: false, message: 'El audit de créditos no cuadra con el ledger.' };
  }
  if (err.code === 'credit_ceiling') {
    return { code: 'credit_ceiling', retryable: false, message: 'Este turno alcanzó el techo de tokens.' };
  }
  if (err.code === 'stdout_rate') {
    return { code: 'stdout_rate', retryable: false, message: 'La salida de la herramienta se recortó por velocidad.' };
  }
  if (err.code === 'hash_expired') {
    return { code: 'hash_expired', retryable: false, message: 'El hash del evento expiró y se limpió.' };
  }
  if (err.code === 'dlq_poison') {
    return { code: 'dlq_poison', retryable: false, message: 'La herramienta falló demasiadas veces. La pasé a la cola de envenenados.' };
  }
  if (err.code === 'gzip_version') {
    return { code: 'gzip_version', retryable: false, message: 'El punto de restauración usa una versión de compresión desconocida.' };
  }
  if (err.code === 'hash_sweep') {
    return { code: 'hash_sweep', retryable: true, message: 'Se limpiaron hashes de eventos vencidos.' };
  }
  if (err.code === 'retrieve_memory_failed') {
    return { code: 'retrieve_memory_failed', retryable: true, message: 'No pude consultar la memoria. Sigo sin ella.' };
  }
  if (err.code === 'tmpfs_cleanup') {
    return { code: 'tmpfs_cleanup', retryable: false, message: 'Limpié el espacio temporal del sandbox al cancelar.' };
  }
  if (err.code === 'timeout_table') {
    return { code: 'timeout_table', retryable: false, message: 'Falta un tiempo máximo para una herramienta.' };
  }
  if (err.code === 'turn_deadline') {
    return { code: 'turn_deadline', retryable: false, message: 'Se agotó el tiempo máximo de este turno.' };
  }
  if (err.code === 'unknown_tool') {
    return { code: 'unknown_tool', retryable: false, message: 'Esa herramienta no existe en este motor.' };
  }
  if (err.code === 'tool_result_capped') {
    return { code: 'tool_result_capped', retryable: false, message: 'Recorté el resultado de la herramienta por tamaño.' };
  }
  if (err.code === 'tool_isolated') {
    return { code: 'tool_isolated', retryable: true, message: 'Una herramienta falló en paralelo; las demás siguieron.' };
  }
  if (err.code === 'ckpt_cas') {
    return { code: 'ckpt_cas', retryable: false, message: 'El punto de restauración cambió; no pude sobrescribirlo.' };
  }
  if (err.code === 'error_budget') {
    return { code: 'error_budget', retryable: false, message: 'Este turno acumuló demasiados errores. Lo detuve.' };
  }
  if (err.code === 'circuit_open') {
    return { code: 'circuit_open', retryable: false, message: 'Esa herramienta falló demasiado y quedó en circuito abierto.' };
  }
  if (err.code === 'queue_lease') {
    return { code: 'queue_lease', retryable: true, message: 'El trabajo en cola expiró. Encola de nuevo.' };
  }
  if (err.code === 'sse_backpressure') {
    return { code: 'sse_backpressure', retryable: false, message: 'Descarté eventos viejos para no saturar el flujo.' };
  }
  if (err.code === 'write_hash') {
    return { code: 'write_hash', retryable: false, message: 'El archivo escrito no coincide con el hash esperado. Revertí.' };
  }
  if (err.code === 'credit_hold') {
    return { code: 'credit_hold', retryable: false, message: 'No pude reservar créditos para este turno.' };
  }
  if (err.code === 'stderr_rate') {
    return { code: 'stderr_rate', retryable: false, message: 'La salida de error de la herramienta se recortó por velocidad.' };
  }
  if (err.code === 'tool_repair_exhausted') {
    return { code: 'tool_repair_exhausted', retryable: false, message: 'La herramienta no entregó argumentos válidos tras varios intentos. Detuve el turno.' };
  }
  if (err.code === 'token_budget') {
    return { code: 'token_budget', retryable: false, message: 'Este turno alcanzó el presupuesto de tokens.' };
  }
  if (err.code === 'sse_orphan') {
    return { code: 'sse_orphan', retryable: false, message: 'Cerré un flujo SSE huérfano.' };
  }
  if (err.code === 'sse_resume') {
    return { code: 'sse_resume', retryable: true, message: 'Reanudé el flujo desde el último evento.' };
  }
  if (err.code === 'subagent_budget') {
    return { code: 'subagent_budget', retryable: false, message: 'El presupuesto del subagente se agotó.' };
  }
  if (err.code === 'subagent_tool_denied' || err.code === 'subagent_type') {
    return { code: err.code, retryable: false, message: 'Ese tipo de subagente no puede usar esa herramienta.' };
  }
  if (err.code === 'git_apply_dirty') {
    return { code: 'git_apply_dirty', retryable: false, message: 'El archivo tiene cambios sin commit. No apliqué el diff.' };
  }
  if (err.code === 'git_syntax_revert') {
    return { code: 'git_syntax_revert', retryable: false, message: 'El diff no pasó validación de sintaxis y se revirtió.' };
  }
  if (err.code === 'sleep_compact') {
    return { code: 'sleep_compact', retryable: false, message: 'Compacté el contexto y guardé la memoria del turno.' };
  }
  if (err.code === 'retrieve_before') {
    return { code: 'retrieve_before', retryable: true, message: 'No pude recuperar memoria antes de generar. Sigo sin ella.' };
  }
  if (err.code === 'pin_dedup') {
    return { code: 'pin_dedup', retryable: false, message: 'Quité recuerdos duplicados del contexto.' };
  }
  if (err.code === 'credit_cancel') {
    return { code: 'credit_cancel', retryable: false, message: 'Al cancelar, asenté el uso real y liberé el resto del hold.' };
  }
  if (err.code === 'resume_recreate') {
    return { code: 'resume_recreate', retryable: true, message: 'Reanudé la sesión desde el último checkpoint.' };
  }
  if (err.code === 'write_syntax_revert') {
    return { code: 'write_syntax_revert', retryable: false, message: 'La escritura no pasó validación de sintaxis y restauré el original.' };
  }
  if (err.code === 'plan_budget') {
    return { code: 'plan_budget', retryable: false, message: 'El presupuesto restante del plan anidado se agotó.' };
  }
  if (err.code === 'first_byte_real') {
    return { code: 'first_byte_real', retryable: false, message: 'Registré el primer byte real del flujo.' };
  }
  if (err.code === 'tool_storm') {
    return { code: 'tool_storm', retryable: false, message: 'Demasiadas herramientas a la vez. Completé las que cabían y dejé el resto para el siguiente turno.' };
  }
  if (err.code === 'dag_blocked') {
    return { code: 'dag_blocked', retryable: false, message: 'El plan no puede seguir: hay tareas esperando dependencias que no terminaron.' };
  }
  if (err.code === 'dag_wait') {
    return { code: 'dag_wait', retryable: false, message: 'Esperé a que terminaran las dependencias del plan antes de seguir.' };
  }
  if (err.code === 'compact_fidelity') {
    return { code: 'compact_fidelity', retryable: false, message: 'Compacté el contexto sin romper pares herramienta/resultado.' };
  }
  if (err.code === 'event_order') {
    return { code: 'event_order', retryable: false, message: 'Reordené eventos del gateway para que la secuencia por sesión sea estricta.' };
  }
  if (err.code === 'concurrent_turn') {
    return { code: 'concurrent_turn', retryable: false, message: 'Registré la latencia de turnos concurrentes.' };
  }
  try {
    const extra = require('./engine-resilience').classifyResilienceError(err.code);
    if (extra) return extra;
  } catch (_) { /* optional */ }
  try {
    const extra = require('./engine-correctness').classifyCorrectnessError(err.code);
    if (extra) return extra;
  } catch (_) { /* optional */ }
  try {
    const extra = require('./engine-lifecycle').classifyLifecycleError(err.code);
    if (extra) return extra;
  } catch (_) { /* optional */ }
  try {
    const extra = require('./engine-adapter').classifyAdapterError(err.code);
    if (extra) return extra;
  } catch (_) { /* optional */ }
  if (err.code === 'rate_limited') {
    return { code: 'rate_limited', retryable: true, message: 'El proveedor está saturado. Reintentaré en un momento.' };
  }
  if (err.code === 'provider_auth') {
    return { code: 'provider_auth', retryable: false, message: 'El proveedor rechazó la autenticación. No se filtró ninguna clave.' };
  }
  if (err.code === 'provider_unavailable') {
    return { code: 'provider_unavailable', retryable: true, message: 'El proveedor falló temporalmente. Reintentaré.' };
  }
  if (err.code === 'provider_timeout') {
    return { code: 'provider_timeout', retryable: true, message: 'El proveedor tardó demasiado. Corté la espera.' };
  }
  if (err.code === 'turn_cancelled' || err.code === 'tool_aborted') {
    return { code: err.code, retryable: false, message: err.code === 'tool_aborted' ? 'Aborté las herramientas que seguían en vuelo.' : 'Cancelé el turno en curso. Liberé la reserva y corté las herramientas.' };
  }
  if (err.code === 'first_token_stall') {
    return { code: 'first_token_stall', retryable: true, message: 'El proveedor no envió el primer token a tiempo. Mandé un latido.' };
  }
  if (err.code === 'tool_result_dup') {
    return { code: 'tool_result_dup', retryable: false, message: 'Ese resultado de herramienta ya se entregó. No lo repetí.' };
  }
  if (err.code === 'gateway_busy') {
    return { code: 'gateway_busy', retryable: true, message: 'Esta sesión ya tiene un productor activo. Esperé a que termine.' };
  }
  if (err.code === 'turn_superseded') {
    return { code: 'turn_superseded', retryable: false, message: 'Un mensaje nuevo canceló este turno. El anterior no se filtró.' };
  }
  if (err.code === 'tool_unknown' || err.code === 'unknown_tool') {
    return { code: 'tool_unknown', retryable: false, message: 'No reconozco esa herramienta. Te sugerí la más cercana.' };
  }
  if (err.code === 'dag_cycle') {
    return { code: 'dag_cycle', retryable: false, message: 'El plan tiene una dependencia circular. Lo detuve para que no se cuelgue.' };
  }
  if (err.code === 'write_noop') {
    return { code: 'write_noop', retryable: false, message: 'La escritura no cambió el archivo. No la cuento como éxito.' };
  }
  if (err.code === 'sandbox_spawn' || err.code === 'sandbox_spawn_failed') {
    return { code: 'sandbox_spawn', retryable: true, message: 'No pude arrancar el sandbox.' };
  }
  if (err.code === 'sse_duplicate') {
    return { code: 'sse_duplicate', retryable: false, message: 'Ese evento ya se entregó. No lo repetí.' };
  }
  if (err.code === 'credit_no_usage') {
    return { code: 'credit_no_usage', retryable: true, message: 'El proveedor falló sin reportar uso. Liberé la reserva; no cobré tokens.' };
  }
  if (err.code === 'loop_stall') {
    return { code: 'loop_stall', retryable: false, message: 'El bucle se quedó sin tokens ni resultados de herramientas. Lo detuve.' };
  }
  if (err.code === 'sandbox_timeout') {
    return { code: 'sandbox_timeout', retryable: true, message: 'El sandbox no produjo salida a tiempo y lo detuve.' };
  }
  if (err.code === 'tool_id_duplicate') {
    return { code: 'tool_id_duplicate', retryable: false, message: 'Había identificadores de herramienta duplicados en el mismo turno. Los reparé.' };
  }
  if (err.code === 'session_busy') {
    return { code: 'session_busy', retryable: true, message: 'Hay otro turno de esta sesión en curso. Este espera su turno.' };
  }
  if (err.code === 'pin_evict') {
    return { code: 'pin_evict', retryable: false, message: 'Quité recuerdos menos importantes del contexto y conservé los anclados.' };
  }
  if (err.code === 'exactly_once_tool') {
    return { code: 'exactly_once_tool', retryable: false, message: 'Esa herramienta ya produjo un resultado. No la volví a ejecutar.' };
  }
  if (status === 429 || /rate.?limit/i.test(String(err.message || ''))) {
    return { code: 'rate_limited', retryable: true, message: 'El servicio está procesando muchas solicitudes. Inténtalo en unos segundos.' };
  }
  if (isTransientLlmError(err)) {
    return { code: 'provider_unavailable', retryable: true, message: 'El proveedor no está disponible temporalmente.' };
  }
  return { code: 'internal_error', retryable: false, message: 'La operación no pudo completarse.' };
}

function syntaxValidate(pathName, content) {
  const p = String(pathName || '');
  const text = String(content ?? '');
  if (/\.json$/i.test(p)) {
    JSON.parse(text);
    return { ok: true, kind: 'json' };
  }
  if (/\.(js|mjs|cjs)$/i.test(p)) {
    const vm = require('vm');
    // Compile only — never run.
    // eslint-disable-next-line no-new
    new vm.Script(text, { filename: p });
    return { ok: true, kind: 'js' };
  }
  return { ok: true, kind: 'skip' };
}

function sleep(ms, signal) {
  const n = Math.max(0, Number(ms) || 0);
  if (n === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch (_) { /* ignore */ }
      }
      resolve();
    }, n);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

module.exports = {
  REPEAT_CUT_DEFAULT,
  STEP_BUDGET_DEFAULT,
  COMPACT_TARGET_TOKENS,
  repairToolArgs,
  normalizeToolCall,
  normalizeToolCalls,
  isTransientLlmError,
  backoffMs,
  toolFingerprint,
  createRepeatGuard,
  createStepBudget,
  pinCriticalFacts,
  compactMessagesIfNeeded,
  createCheckpoint,
  extractUsage,
  createUsageAccumulator,
  classifyLoopError,
  syntaxValidate,
  sleep,
  engineLatencySnapshot,
  observeFirstToken,
  observeTurnEnd,
  hydrateLatencyFromDurable,
};
