'use strict';


/**
 * OSS-rewrite control layer — 2026-08-18 America/Lima.
 * Ideas adapted (not copied) from:
 *   - vercel/ai (Apache-2.0): validate tool args, feedback to the model, attempt cap
 *   - LibreChat (MIT): SSE id + heartbeat + clean abort of orphan streams
 *   - Mastra (Apache-2.0, no ee/): stopWhen + per-turn token budget + step telemetry
 *   - VoltAgent (MIT): explicit loop guardrails
 * Original SiraGPT rewrite. No vendor source. No OpenRouter. DeepSeek Flash/Pro only.
 */

const { repairToolArgs } = require('./engine-reliability');
const { validateToolArgs } = require('./engine-hardening');

const TOOL_REPAIR_MAX_ATTEMPTS = 3;
const TURN_TOKEN_BUDGET_DEFAULT = 24_000;
const ORPHAN_STREAM_TTL_MS = 120_000;
const SSE_HEARTBEAT_MS = 15_000;

function coerceScalar(specType, value) {
  const t = String(specType || '');
  if (t === 'number' || t === 'integer') {
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      const n = Number(value);
      if (t === 'integer' && !Number.isInteger(n)) return { ok: false };
      return { ok: true, value: n };
    }
    return { ok: false };
  }
  if (t === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === '1') return { ok: true, value: true };
    if (value === 'false' || value === '0') return { ok: true, value: false };
    return { ok: false };
  }
  if (t === 'string') {
    if (value == null) return { ok: false };
    return { ok: true, value: String(value) };
  }
  return { ok: true, value };
}

function applyLocalRepair(schema, args) {
  const src = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  if (src.__parse_error) {
    const inner = repairToolArgs(src.raw);
    if (!inner.ok) return { ok: false, args: src, repaired: false, error: 'parse_error' };
    return applyLocalRepair(schema, inner.value);
  }
  if (!schema || typeof schema !== 'object') {
    return { ok: true, args: src, repaired: false };
  }
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const allowAdditional = schema.additionalProperties === true;
  const next = {};
  let repaired = false;
  for (const [key, v] of Object.entries(src)) {
    if (String(key).startsWith('__')) continue;
    const spec = props[key];
    if (!spec && !allowAdditional) {
      repaired = true;
      continue;
    }
    if (spec && spec.type) {
      const c = coerceScalar(spec.type, v);
      if (!c.ok) return { ok: false, args: src, repaired: false, error: `type:${key}` };
      if (c.value !== v) repaired = true;
      next[key] = c.value;
    } else {
      next[key] = v;
    }
  }
  const check = validateToolArgs(schema, next);
  if (!check.ok) return { ok: false, args: next, repaired, error: check.error, code: check.code };
  return { ok: true, args: check.value, repaired };
}

function schemaFeedback({ name, error, attempt, maxAttempts }) {
  const tool = String(name || 'tool');
  const err = String(error || 'schema_invalid');
  return [
    `ERROR: schema_invalid: ${err}`,
    `La herramienta "${tool}" rechazo los argumentos (intento ${attempt}/${maxAttempts}).`,
    'Devuelve UN tool_call con JSON valido, solo las propiedades del esquema, sin texto extra.',
  ].join(' ');
}

function repairToolCallWithFeedback({
  name,
  args,
  schema,
  attempt = 1,
  maxAttempts = TOOL_REPAIR_MAX_ATTEMPTS,
} = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  const cap = Math.max(1, Math.min(8, Number(maxAttempts) || TOOL_REPAIR_MAX_ATTEMPTS));
  const parsed = args && args.__parse_error
    ? repairToolArgs(args.raw)
    : { ok: true, value: args && typeof args === 'object' ? args : {}, repaired: false };
  if (!parsed.ok) {
    if (n >= cap) {
      return {
        ok: false,
        retry: false,
        args: parsed.value,
        attempt: n,
        maxAttempts: cap,
        code: 'tool_repair_exhausted',
        feedback: `ERROR: tool_repair_exhausted: la herramienta "${name}" no entrego JSON valido tras ${cap} intentos.`,
      };
    }
    return {
      ok: false,
      retry: true,
      args: parsed.value,
      attempt: n,
      maxAttempts: cap,
      code: 'tool_args_invalid',
      feedback: schemaFeedback({ name, error: 'parse_error', attempt: n, maxAttempts: cap }),
    };
  }
  const local = applyLocalRepair(schema, parsed.value);
  if (local.ok) {
    return {
      ok: true,
      retry: false,
      args: local.args,
      repaired: Boolean(local.repaired || parsed.repaired),
      attempt: n,
      maxAttempts: cap,
      code: null,
      feedback: null,
    };
  }
  if (n >= cap) {
    return {
      ok: false,
      retry: false,
      args: local.args,
      attempt: n,
      maxAttempts: cap,
      code: 'tool_repair_exhausted',
      feedback: `ERROR: tool_repair_exhausted: la herramienta "${name}" no cumplio el esquema tras ${cap} intentos (${local.error || 'schema_invalid'}).`,
    };
  }
  return {
    ok: false,
    retry: true,
    args: local.args,
    attempt: n,
    maxAttempts: cap,
    code: local.code || 'schema_invalid',
    feedback: schemaFeedback({ name, error: local.error || 'schema_invalid', attempt: n, maxAttempts: cap }),
  };
}

function createToolRepairBudget({ maxAttempts = TOOL_REPAIR_MAX_ATTEMPTS } = {}) {
  const cap = Math.max(1, Math.min(8, Number(maxAttempts) || TOOL_REPAIR_MAX_ATTEMPTS));
  const counts = new Map();
  return {
    max: cap,
    see(name) {
      const key = String(name || '');
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { count: n, exhausted: n >= cap };
    },
    used(name) { return counts.get(String(name || '')) || 0; },
    exhausted(name) { return (counts.get(String(name || '')) || 0) >= cap; },
    reset(name) { counts.delete(String(name || '')); },
  };
}

function formatSseFrame(frame, { heartbeatComment = false } = {}) {
  if (heartbeatComment) {
    const seq = frame && frame.seq != null ? Number(frame.seq) : 0;
    return `: ping ${seq}\n\n`;
  }
  const f = frame && typeof frame === 'object' ? frame : {};
  const seq = f.seq != null ? Number(f.seq) : (f.id != null ? Number(f.id) : 0);
  const ev = String(f.type || f.event || 'message');
  const data = JSON.stringify(f);
  const lines = [];
  if (Number.isFinite(seq) && seq > 0) lines.push(`id: ${seq}`);
  if (ev) lines.push(`event: ${ev}`);
  lines.push(`data: ${data}`);
  return `${lines.join('\n')}\n\n`;
}

function resumeSseAfterDisconnect({ frames, lastEventId = 0 } = {}) {
  const n = Number(lastEventId) || 0;
  const list = Array.isArray(frames) ? frames : [];
  const replay = list.filter((f) => {
    const seq = Number(f && (f.seq != null ? f.seq : f.id)) || 0;
    return seq > n;
  });
  return {
    ok: true,
    lastEventId: n,
    replayed: replay.length,
    frames: replay,
    code: replay.length ? null : 'sse_resume',
  };
}

async function hydrateSseRingFromRedis({ eventLog, kv, sessionKey, lastEventId = 0 } = {}) {
  const key = String(sessionKey || '');
  if (!key) return { ok: false, frames: [], replayed: 0, code: 'sse_resume' };
  let remote = [];
  try {
    const dur = require('./engine-durability');
    remote = await dur.replayEventFrames(kv || dur.getSharedKv(), key, lastEventId);
  } catch (_) {
    remote = [];
  }
  if (eventLog && typeof eventLog.remember === 'function') {
    for (const f of remote) {
      try { eventLog.remember(key, f); } catch (_) { /* ring optional */ }
    }
  }
  if (eventLog && typeof eventLog.replayFrom === 'function') {
    const local = eventLog.replayFrom(key, lastEventId) || [];
    return { ok: true, frames: local, replayed: local.length, code: null };
  }
  return { ok: true, frames: remote, replayed: remote.length, code: remote.length ? null : 'sse_resume' };
}

function createOrphanStreamRegistry({ ttlMs = ORPHAN_STREAM_TTL_MS } = {}) {
  const ttl = Math.max(1, Number(ttlMs) || ORPHAN_STREAM_TTL_MS);
  const streams = new Map();
  return {
    register(id, closer) {
      const key = String(id || '');
      if (!key) return { ok: false, code: 'sse_orphan' };
      streams.set(key, { closer, lastAt: Date.now(), closed: false });
      return { ok: true, id: key };
    },
    beat(id) {
      const rec = streams.get(String(id || ''));
      if (!rec || rec.closed) return { ok: false, code: 'sse_orphan' };
      rec.lastAt = Date.now();
      return { ok: true };
    },
    close(id, reason) {
      const key = String(id || '');
      const rec = streams.get(key);
      if (!rec || rec.closed) return { ok: false, closed: false, code: 'sse_orphan' };
      rec.closed = true;
      try { if (typeof rec.closer === 'function') rec.closer(reason || 'sse_orphan'); } catch (_) { /* ignore */ }
      streams.delete(key);
      return { ok: true, closed: true, code: 'sse_orphan', reason: reason || 'sse_orphan' };
    },
    closeStale(now = Date.now()) {
      let closed = 0;
      for (const [id, rec] of [...streams.entries()]) {
        if (rec.closed) { streams.delete(id); continue; }
        if ((Number(now) - Number(rec.lastAt || 0)) >= ttl) {
          this.close(id, 'sse_orphan');
          closed += 1;
        }
      }
      return { ok: true, closed, remaining: streams.size, code: closed ? 'sse_orphan' : null };
    },
    size() { return streams.size; },
  };
}

function evaluateStopConditions({
  iteration = 1,
  maxIterations = 12,
  tokensUsed = 0,
  tokenBudget = null,
  wallStop = false,
  errorBudgetStop = false,
  repairExhausted = false,
  custom = null,
} = {}) {
  if (wallStop) return { stop: true, reason: 'turn_deadline' };
  if (errorBudgetStop) return { stop: true, reason: 'error_budget' };
  if (repairExhausted) return { stop: true, reason: 'tool_repair_exhausted' };
  const tok = assertTurnTokenBudget(tokensUsed, tokenBudget);
  if (tok.stop) return { stop: true, reason: 'token_budget', used: tok.used, budget: tok.budget };
  const iter = Number(iteration) || 0;
  const cap = Math.max(1, Number(maxIterations) || 12);
  if (iter > cap) return { stop: true, reason: 'max_iterations' };
  if (typeof custom === 'function') {
    try {
      const extra = custom({ iteration: iter, tokensUsed, tokenBudget });
      if (extra && extra.stop) return { stop: true, reason: extra.reason || 'stop_condition' };
    } catch (_) { /* custom fail-open */ }
  }
  return { stop: false, reason: null };
}

function assertTurnTokenBudget(used, budget) {
  if (budget == null || budget === false) {
    return { ok: true, stop: false, used: Number(used) || 0, budget: Infinity, code: null };
  }
  const cap = Number(budget);
  if (!Number.isFinite(cap) || cap < 0) {
    return { ok: true, stop: false, used: Number(used) || 0, budget: Infinity, code: null };
  }
  const n = Number(used) || 0;
  if (n >= cap) return { ok: false, stop: true, used: n, budget: cap, code: 'token_budget' };
  return { ok: true, stop: false, used: n, budget: cap, remaining: cap - n, code: null };
}

function recordStepTelemetry(store, rec) {
  const step = {
    stepIndex: rec && rec.stepIndex != null ? Number(rec.stepIndex) : 0,
    type: rec && rec.type ? String(rec.type) : 'tool_call',
    toolName: rec && rec.toolName ? String(rec.toolName) : null,
    args: rec && rec.args != null ? rec.args : null,
    result: rec && rec.result != null ? rec.result : null,
    status: rec && rec.status ? String(rec.status) : 'completed',
    durationMs: rec && rec.durationMs != null ? Math.round(Number(rec.durationMs)) : null,
    isError: Boolean(rec && rec.isError),
  };
  if (!store) return { ok: false, skipped: true, step };
  try {
    if (Array.isArray(store)) {
      store.push(step);
      return { ok: true, persisted: 'memory', step };
    }
    if (typeof store.record === 'function') {
      store.record(step);
      return { ok: true, persisted: 'buffer', step };
    }
    if (store.agentStep && typeof store.agentStep.create === 'function') {
      const p = store.agentStep.create({ data: step });
      return { ok: true, persisted: 'prisma', pending: p, step };
    }
  } catch (_) {
    return { ok: false, skipped: true, step, code: 'step_telemetry' };
  }
  return { ok: false, skipped: true, step };
}

function createStepTelemetry({ persist = null, prisma = null, messageId = null } = {}) {
  const steps = [];
  return {
    record(rec) {
      const out = recordStepTelemetry(steps, rec);
      if (typeof persist === 'function') {
        try { persist(out.step); } catch (_) { /* fail-open */ }
      }
      return out;
    },
    snapshot() { return steps.slice(); },
    async flush() {
      if (!prisma || !messageId || !steps.length) {
        return { ok: false, stepsPersisted: 0, skipped: true };
      }
      try {
        const { persistAgentRun } = require('../agent-harness/agent-steps-store');
        return await persistAgentRun({
          prisma,
          messageId,
          run: {
            steps,
            interrupted: false,
            durationMs: steps.reduce((n, s) => n + (Number(s.durationMs) || 0), 0),
            toolCallCount: steps.filter((s) => s.type === 'tool_call').length,
            errorCount: steps.filter((s) => s.isError).length,
          },
        });
      } catch (_) {
        return { ok: false, stepsPersisted: 0, skipped: true };
      }
    },
  };
}

function controlSnapshot() {
  return {
    toolRepairFeedback: true,
    toolRepairBudget: true,
    sseOrphanClose: true,
    sseResumeHydrate: true,
    turnTokenBudget: true,
    stopConditions: true,
    stepTelemetryPg: true,
    repairMaxAttempts: TOOL_REPAIR_MAX_ATTEMPTS,
    tokenBudgetDefault: TURN_TOKEN_BUDGET_DEFAULT,
    orphanTtlMs: ORPHAN_STREAM_TTL_MS,
    heartbeatMs: SSE_HEARTBEAT_MS,
  };
}

module.exports = {
  TOOL_REPAIR_MAX_ATTEMPTS,
  TURN_TOKEN_BUDGET_DEFAULT,
  ORPHAN_STREAM_TTL_MS,
  coerceScalar,
  applyLocalRepair,
  repairToolCallWithFeedback,
  createToolRepairBudget,
  formatSseFrame,
  resumeSseAfterDisconnect,
  hydrateSseRingFromRedis,
  createOrphanStreamRegistry,
  evaluateStopConditions,
  assertTurnTokenBudget,
  recordStepTelemetry,
  createStepTelemetry,
  controlSnapshot,
};
