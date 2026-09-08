'use strict';

/**
 * Session / tool-budget circuit breaker for the ReAct loop.
 *
 * Native rewrite of OpenClaw loop-detection ideas (MIT,
 * github.com/openclaw/openclaw — consecutive no-progress, generic
 * repeat, ping-pong, unknown-tool streak, then a global circuit that
 * blocks the session). SiraGPT-owned CommonJS: fail closed, Spanish
 * labels, injectable clock. No OpenClaw runtime, env, SDK, or vendor
 * strings. Not a dump of `agents/tool-loop-detection.ts`.
 *
 * Public §16 code is `E_TIMEOUT` (techo de plano). Internal reasons
 * stay `session_circuit_open` / `tool_circuit_open`.
 */

const crypto = require('crypto');

const DEFAULT_TOOL_THRESHOLD = 5;
const DEFAULT_SESSION_THRESHOLD = 8;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HISTORY_SIZE = 24;
const DEFAULT_TRANSIENT_WEIGHT = 0.34;
const DEFAULT_REPEAT_OPEN = 6;
const DEFAULT_PING_PONG_OPEN = 8;
const DEFAULT_UNKNOWN_OPEN = 6;

const CIRCUIT_CODE = 'E_TIMEOUT';

const CIRCUIT_LABELS = Object.freeze({
  warning_tool:
    'La herramienta está fallando de forma repetida. Cambia de enfoque o responde con lo que ya tienes.',
  warning_session:
    'Van varios fallos consecutivos de herramientas. Evita reintentar lo mismo.',
  critical_tool:
    'Demasiados fallos consecutivos de esta herramienta. El circuito está a punto de abrirse.',
  critical_session:
    'El presupuesto de fallos de esta sesión está al límite. Deja de invocar herramientas.',
  open_tool:
    'El circuito de esta herramienta está abierto: demasiados fallos consecutivos. No se invocará de nuevo hasta que se enfríe.',
  open_session:
    'El presupuesto de fallos de esta sesión se agotó. El circuito está abierto: no se invocarán más herramientas. Responde con lo que ya tienes.',
  half_open: 'El circuito está en prueba. Un fallo más lo vuelve a abrir.',
  generic_repeat:
    'La misma herramienta con los mismos argumentos falló de forma repetida. El circuito se abrió para evitar un bucle.',
  ping_pong:
    'Se detectó un vaivén entre dos herramientas sin progreso. El circuito se abrió.',
  unknown_tool:
    'Se insistió en una herramienta inexistente. El circuito se abrió.',
  cooldown:
    'El circuito sigue abierto. Espera a que se enfríe antes de reintentar.',
  session_missing:
    'El presupuesto de fallos de esta sesión se agotó. Falta la clave de sesión.',
  params: 'Faltan datos o el pedido no es válido.',
});

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function clampWeight(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(1, n);
}

function stableKey(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  try {
    const keys = Object.keys(value).sort();
    const sorted = {};
    for (const k of keys) sorted[k] = value[k];
    return JSON.stringify(sorted);
  } catch {
    return String(value);
  }
}

function hashArgs(toolName, argsKey) {
  const raw = `${String(toolName || '')}:${stableKey(argsKey)}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function bandFor(count, threshold) {
  if (count >= threshold) return 'open';
  if (count >= Math.ceil(threshold * 0.75)) return 'critical';
  if (count >= Math.ceil(threshold * 0.5)) return 'warning';
  return 'closed';
}

function emptySession() {
  return {
    consecutive: 0,
    toolFails: new Map(),
    openUntil: 0,
    sessionProbeUsed: false,
    toolOpenUntil: new Map(),
    toolProbeUsed: new Set(),
    history: [],
    lastAt: 0,
  };
}

function deny({ state = 'open', scope = 'session', reason, label, remainingMs = 0 } = {}) {
  return {
    allowed: false,
    ok: false,
    state,
    scope,
    code: CIRCUIT_CODE,
    reason: reason || 'session_circuit_open',
    label: label || CIRCUIT_LABELS.open_session,
    remainingMs,
  };
}

function allow({ state = 'closed', scope = 'tool', label = null } = {}) {
  return {
    allowed: true,
    ok: true,
    state,
    scope,
    code: null,
    reason: null,
    label,
    remainingMs: 0,
  };
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {number} [opts.toolThreshold]
 * @param {number} [opts.sessionThreshold]
 * @param {number} [opts.cooldownMs]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.historySize]
 * @param {number} [opts.transientWeight]
 * @param {number} [opts.repeatOpen]
 * @param {number} [opts.pingPongOpen]
 * @param {number} [opts.unknownOpen]
 */
function createToolFailureCircuit(opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const toolThreshold = positiveInt(opts.toolThreshold, DEFAULT_TOOL_THRESHOLD);
  const sessionThreshold = positiveInt(opts.sessionThreshold, DEFAULT_SESSION_THRESHOLD);
  const cooldownMs = positiveInt(opts.cooldownMs, DEFAULT_COOLDOWN_MS);
  const ttlMs = positiveInt(opts.ttlMs, DEFAULT_TTL_MS);
  const historySize = positiveInt(opts.historySize, DEFAULT_HISTORY_SIZE);
  const transientWeight = clampWeight(opts.transientWeight, DEFAULT_TRANSIENT_WEIGHT);
  const repeatOpen = positiveInt(opts.repeatOpen, DEFAULT_REPEAT_OPEN);
  const pingPongOpen = positiveInt(opts.pingPongOpen, DEFAULT_PING_PONG_OPEN);
  const unknownOpen = positiveInt(opts.unknownOpen, DEFAULT_UNKNOWN_OPEN);
  const sessions = new Map();

  function load(sessionKey, { create = true } = {}) {
    const key = String(sessionKey || '').trim();
    if (!key) return { key: '', rec: null };
    const t = nowFn();
    let rec = sessions.get(key);
    if (rec && t - rec.lastAt > ttlMs) {
      sessions.delete(key);
      rec = null;
    }
    if (!rec && create) {
      rec = emptySession();
      sessions.set(key, rec);
    }
    if (rec) rec.lastAt = t;
    return { key, rec };
  }

  function sessionPhase(rec, t) {
    if (rec.openUntil > t) return 'open';
    if (rec.openUntil > 0 && rec.openUntil <= t) {
      return rec.sessionProbeUsed ? 'open' : 'half_open';
    }
    return bandFor(rec.consecutive, sessionThreshold);
  }

  function toolPhase(rec, name, t) {
    const until = rec.toolOpenUntil.get(name) || 0;
    if (until > t) return 'open';
    if (until > 0 && until <= t) {
      return rec.toolProbeUsed.has(name) ? 'open' : 'half_open';
    }
    return bandFor(rec.toolFails.get(name) || 0, toolThreshold);
  }

  function detectLoops(rec, name, argsKey, unknownTool) {
    const sig = hashArgs(name, argsKey);
    const hist = rec.history;

    if (unknownTool) {
      let streak = 0;
      for (let i = hist.length - 1; i >= 0; i -= 1) {
        if (hist[i].transient) continue;
        if (hist[i].unknown && hist[i].name === name) streak += 1;
        else break;
      }
      if (streak >= unknownOpen) {
        return { detector: 'unknown_tool', label: CIRCUIT_LABELS.unknown_tool };
      }
    }

    let repeat = 0;
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      if (hist[i].transient) continue;
      if (hist[i].name === name && hist[i].sig === sig && hist[i].ok === false) repeat += 1;
      else break;
    }
    if (repeat >= repeatOpen) {
      return { detector: 'generic_repeat', label: CIRCUIT_LABELS.generic_repeat };
    }

    if (hist.length >= pingPongOpen) {
      const tail = hist.slice(-pingPongOpen);
      const names = tail.map((h) => h.name);
      const allFailed = tail.every((h) => h.ok === false && !h.transient);
      const unique = new Set(names);
      if (allFailed && unique.size === 2 && names[0] !== names[1]) {
        let alternating = true;
        for (let i = 2; i < names.length; i += 1) {
          if (names[i] !== names[i - 2]) {
            alternating = false;
            break;
          }
        }
        if (alternating) {
          return { detector: 'ping_pong', label: CIRCUIT_LABELS.ping_pong };
        }
      }
    }
    return { detector: null, label: null };
  }

  function authorize(sessionKey, toolName) {
    const name = String(toolName || '').trim();
    if (name === 'finalize') return allow({ state: 'closed', scope: null });
    if (!name) {
      return deny({
        scope: 'tool',
        reason: 'E_PARAMS',
        label: CIRCUIT_LABELS.params,
      });
    }
    const { rec } = load(sessionKey);
    if (!rec) {
      return deny({
        reason: 'session_missing',
        label: CIRCUIT_LABELS.session_missing,
      });
    }
    const t = nowFn();
    const sPhase = sessionPhase(rec, t);
    if (sPhase === 'open') {
      return deny({
        scope: 'session',
        reason: 'session_circuit_open',
        label: rec.openUntil > t ? CIRCUIT_LABELS.cooldown : CIRCUIT_LABELS.open_session,
        remainingMs: Math.max(0, rec.openUntil - t),
      });
    }
    if (sPhase === 'half_open') {
      rec.sessionProbeUsed = true;
      return allow({ state: 'half_open', scope: 'session', label: CIRCUIT_LABELS.half_open });
    }
    const tPhase = toolPhase(rec, name, t);
    if (tPhase === 'open') {
      const until = rec.toolOpenUntil.get(name) || 0;
      return deny({
        scope: 'tool',
        reason: 'tool_circuit_open',
        label: until > t ? CIRCUIT_LABELS.cooldown : CIRCUIT_LABELS.open_tool,
        remainingMs: Math.max(0, until - t),
      });
    }
    if (tPhase === 'half_open') {
      rec.toolProbeUsed.add(name);
      return allow({ state: 'half_open', scope: 'tool', label: CIRCUIT_LABELS.half_open });
    }
    const state = sPhase !== 'closed' ? sPhase : tPhase;
    const scope = sPhase !== 'closed' ? 'session' : 'tool';
    let label = null;
    if (state === 'warning') {
      label = scope === 'session' ? CIRCUIT_LABELS.warning_session : CIRCUIT_LABELS.warning_tool;
    } else if (state === 'critical') {
      label = scope === 'session' ? CIRCUIT_LABELS.critical_session : CIRCUIT_LABELS.critical_tool;
    }
    return allow({ state, scope, label });
  }

  function record(sessionKey, toolName, outcome = {}) {
    const name = String(toolName || '').trim();
    if (!name || name === 'finalize') {
      return { ok: true, opened: false, state: 'closed', scope: null, code: null, label: null, detector: null };
    }
    const { rec } = load(sessionKey);
    if (!rec) {
      return {
        ok: false,
        opened: true,
        state: 'open',
        scope: 'session',
        code: CIRCUIT_CODE,
        reason: 'session_missing',
        label: CIRCUIT_LABELS.session_missing,
        detector: null,
      };
    }
    const t = nowFn();
    const success = outcome.ok === true;
    const weight = success ? 0 : (outcome.transient ? transientWeight : 1);
    const sig = hashArgs(name, outcome.argsKey);
    const wasHalfOpenSession = rec.openUntil > 0 && rec.openUntil <= t;
    const wasHalfOpenTool = (rec.toolOpenUntil.get(name) || 0) > 0
      && (rec.toolOpenUntil.get(name) || 0) <= t;

    rec.history.push({
      name,
      sig,
      ok: success,
      unknown: Boolean(outcome.unknownTool),
      transient: Boolean(outcome.transient),
      at: t,
    });
    if (rec.history.length > historySize) rec.history.shift();

    if (success) {
      rec.consecutive = 0;
      rec.toolFails.delete(name);
      rec.toolOpenUntil.delete(name);
      rec.toolProbeUsed.delete(name);
      if (wasHalfOpenSession || rec.openUntil > 0) {
        rec.openUntil = 0;
        rec.sessionProbeUsed = false;
      }
      return {
        ok: true,
        opened: false,
        state: 'closed',
        scope: 'tool',
        code: null,
        reason: null,
        label: null,
        detector: null,
      };
    }

    rec.consecutive += weight;
    rec.toolFails.set(name, (rec.toolFails.get(name) || 0) + weight);

    const loop = detectLoops(rec, name, outcome.argsKey, outcome.unknownTool);
    const toolCount = rec.toolFails.get(name) || 0;
    const reopenHalfOpen = wasHalfOpenSession || wasHalfOpenTool;
    const sessionOpened = rec.consecutive >= sessionThreshold || Boolean(loop.detector) || wasHalfOpenSession;
    const toolOpened = toolCount >= toolThreshold || wasHalfOpenTool;

    if (sessionOpened) {
      rec.openUntil = t + cooldownMs;
      rec.sessionProbeUsed = false;
      return {
        ok: false,
        opened: true,
        state: 'open',
        scope: 'session',
        code: CIRCUIT_CODE,
        reason: loop.detector || 'session_circuit_open',
        detector: loop.detector,
        label: loop.label || (reopenHalfOpen ? CIRCUIT_LABELS.open_session : CIRCUIT_LABELS.open_session),
        count: rec.consecutive,
      };
    }
    if (toolOpened) {
      rec.toolOpenUntil.set(name, t + cooldownMs);
      rec.toolProbeUsed.delete(name);
      return {
        ok: false,
        opened: true,
        state: 'open',
        scope: 'tool',
        code: CIRCUIT_CODE,
        reason: 'tool_circuit_open',
        detector: null,
        label: CIRCUIT_LABELS.open_tool,
        count: toolCount,
      };
    }

    const sPhase = sessionPhase(rec, t);
    const tPhase = toolPhase(rec, name, t);
    const state = sPhase !== 'closed' ? sPhase : tPhase;
    const scope = sPhase !== 'closed' ? 'session' : 'tool';
    let label = null;
    if (state === 'warning') {
      label = scope === 'session' ? CIRCUIT_LABELS.warning_session : CIRCUIT_LABELS.warning_tool;
    } else if (state === 'critical') {
      label = scope === 'session' ? CIRCUIT_LABELS.critical_session : CIRCUIT_LABELS.critical_tool;
    }
    return {
      ok: true,
      opened: false,
      state,
      scope,
      code: null,
      reason: null,
      detector: null,
      label,
      count: scope === 'session' ? rec.consecutive : toolCount,
    };
  }

  function snapshot(sessionKey) {
    const { key, rec } = load(sessionKey, { create: false });
    const t = nowFn();
    if (!rec) {
      return { sessionKey: key, missing: true, state: 'closed', consecutive: 0, tools: {}, history: 0 };
    }
    const tools = {};
    for (const [name, count] of rec.toolFails) {
      tools[name] = { count, state: toolPhase(rec, name, t) };
    }
    return {
      sessionKey: key,
      missing: false,
      state: sessionPhase(rec, t),
      consecutive: rec.consecutive,
      openUntil: rec.openUntil,
      tools,
      history: rec.history.length,
      toolThreshold,
      sessionThreshold,
      cooldownMs,
    };
  }

  function reset(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) return { ok: false };
    sessions.delete(key);
    return { ok: true };
  }

  function sweep(at) {
    const t = Number.isFinite(Number(at)) ? Number(at) : nowFn();
    let removed = 0;
    for (const [key, rec] of sessions) {
      if (t - rec.lastAt > ttlMs) {
        sessions.delete(key);
        removed += 1;
      }
    }
    return { ok: true, removed, remaining: sessions.size };
  }

  return {
    authorize,
    record,
    snapshot,
    reset,
    sweep,
    toolThreshold,
    sessionThreshold,
    cooldownMs,
    ttlMs,
  };
}

function attachToolFailureCircuit(ctx, opts = {}) {
  const target = ctx && typeof ctx === 'object' ? ctx : {};
  if (!target.toolFailureCircuit) {
    target.toolFailureCircuit = opts.circuit || createToolFailureCircuit(opts);
  }
  if (!target.circuitSessionKey) {
    const inherited = String(opts.sessionKey || target.taskId || target.chatId || '').trim();
    target.circuitSessionKey = inherited || `react-${Date.now()}`;
  }
  return target;
}

function presentCircuitDenial(gate) {
  if (!gate || gate.allowed) return null;
  const denial = {
    error: gate.reason || 'session_circuit_open',
    code: gate.code || CIRCUIT_CODE,
    message: gate.label || CIRCUIT_LABELS.open_session,
    circuit: { state: gate.state, scope: gate.scope, remainingMs: gate.remainingMs || 0 },
  };
  try {
    require('./session-isolation').attachAuditLine(denial, {
      kind: 'circuit',
      code: denial.code,
      scope: gate.scope,
      reason: gate.reason,
      label: denial.message,
    });
  } catch { /* audit is best-effort */ }
  return denial;
}

function circuitSessionKeyOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  return String(ctx.circuitSessionKey || ctx.taskId || ctx.chatId || '').trim();
}

module.exports = {
  createToolFailureCircuit,
  attachToolFailureCircuit,
  presentCircuitDenial,
  circuitSessionKeyOf,
  CIRCUIT_CODE,
  CIRCUIT_LABELS,
  DEFAULT_TOOL_THRESHOLD,
  DEFAULT_SESSION_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TTL_MS,
  DEFAULT_TRANSIENT_WEIGHT,
  DEFAULT_REPEAT_OPEN,
  DEFAULT_PING_PONG_OPEN,
  DEFAULT_UNKNOWN_OPEN,
};
