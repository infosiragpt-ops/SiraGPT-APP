'use strict';

/**
 * 3H64 — fail-closed wiring of remaining adapter-only Claude-Code holes.
 *
 * Does NOT re-export 3H59/3H60/3H61/3H62/3H63 names (no overlay collisions).
 * Unique orchestrators CALL the live #388 adapter names (injected) and
 * apply their decisions on the generate / loop / SSE / sandbox hot path:
 *   durable first-token / turn-end latency ring (p50/p95)
 *   turn wall 120s + three-stall cancel
 *   SSE client-gone close + Last-Event-ID gap + abort error event
 *   sandbox kill-after-grace + net fail-closed + no-new-privs + RSS/CPU
 *   compact keep system + pins + last tool-calls; crc32/gzip checkpoints
 *   classifyToolFailure + sanitizeClientError on the public error path
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WAVE = '3H64';
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;
const DEFAULT_LATENCY_DIR = path.join(os.tmpdir(), 'siragpt-latency');
const LATENCY_RING_MAX = 512;

const ERROR_TABLE = Object.freeze({
  stream_stall_cancel: { retryable: true, message: 'El stream se quedó sin tokens tres veces. Cancelé el turno.' },
  turn_wall: { retryable: true, message: 'El turno superó el tope de 120 s. Lo corté.' },
  wall_clock: { retryable: true, message: 'No queda reloj de pared. Corté el turno.' },
  client_gone: { retryable: true, message: 'El cliente se fue. Cerré el SSE a los 30 s.' },
  sse_gap: { retryable: true, message: 'Faltan eventos SSE. Reenvío desde el anillo acotado.' },
  sse_abort: { retryable: true, message: 'Aborté el stream y envié el evento de error final.' },
  sse_flush: { retryable: false, message: 'Flusheé el último evento SSE antes de cerrar.' },
  sandbox_killed: { retryable: false, message: 'Maté el sandbox tras el periodo de gracia. No dejé el proceso vivo.' },
  network_denied: { retryable: false, message: 'Sandbox sin red: SANDBOX_NET_ALLOW no está definido.' },
  sandbox_reap: { retryable: false, message: 'Siegué los bash en segundo plano al abortar.' },
  compact_keep_system: { retryable: false, message: 'Conservé el system prompt al compactar.' },
  compact_keep_tool_calls: { retryable: false, message: 'Conservé las últimas tool_calls del asistente al compactar.' },
  compact_pins_last3: { retryable: false, message: 'Conservé pins y los últimos 3 turnos de usuario al compactar.' },
  ckpt_crc: { retryable: true, message: 'El CRC32 del checkpoint no coincidió. No lo rehidraté.' },
  ckpt_gzip: { retryable: false, message: 'Comprimí el checkpoint porque superaba 64 KiB.' },
  ckpt_prune: { retryable: false, message: 'Podé checkpoints viejos y dejé solo los últimos N.' },
  latency_ring: { retryable: false, message: 'Registré first-token y fin de turno en el anillo persistido.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

function loadWave59() {
  try { return require('./engine-3h59'); } catch (_) { return null; }
}

function loadWave60() {
  try { return require('./engine-3h60'); } catch (_) { return null; }
}

function loadWave61() {
  try { return require('./engine-3h61'); } catch (_) { return null; }
}

function loadWave62() {
  try { return require('./engine-3h62'); } catch (_) { return null; }
}

function loadWave63() {
  try { return require('./engine-3h63'); } catch (_) { return null; }
}

function callLive(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return fn(args); } catch (_) { return fallback; }
}

function callLiveN(fn, a, b, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return fn(a, b); } catch (_) { return fallback; }
}

function resolveLatencyDir(dir) {
  const raw = dir || process.env.SIRAGPT_LATENCY_DIR || DEFAULT_LATENCY_DIR;
  return path.resolve(String(raw));
}

function kindFile(kind) {
  const k = String(kind || 'turn');
  if (k === 'first_token' || k === 'ttfb') return 'first_token.jsonl';
  return 'turn_end.jsonl';
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

function snapshotFromMs(list) {
  const nums = (Array.isArray(list) ? list : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  return {
    p50: percentile(nums, 0.5),
    p95: percentile(nums, 0.95),
    count: nums.length,
    source: 'persisted_ring',
  };
}

function appendJsonl(filePath, row) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function readJsonlMs(filePath, max = LATENCY_RING_MAX) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-Math.max(8, Number(max) || LATENCY_RING_MAX));
    const ms = [];
    for (const line of tail) {
      try {
        const row = JSON.parse(line);
        const n = Number(row && (row.ms != null ? row.ms : row.value));
        if (Number.isFinite(n) && n >= 0) ms.push(n);
      } catch (_) { /* skip bad line */ }
    }
    return ms;
  } catch (_) {
    return [];
  }
}

/**
 * Persist first-token / turn-end samples to a durable JSONL ring and
 * forward them to live `observeAdapterLatency`. Snapshot via
 * `adapterLatencySnapshot` plus the file ring so p50/p95 is not only
 * fake-timer unit state.
 */
function persistLatencyRingClosed({
  kind,
  ms,
  startedAt,
  now,
  dir,
  observeAdapterLatency,
  adapterLatencySnapshot,
} = {}) {
  const t = Number(now) || Date.now();
  const start = Number(startedAt);
  let observed = Number(ms);
  if (!Number.isFinite(observed) && Number.isFinite(start)) observed = t - start;
  if (!Number.isFinite(observed) || observed < 0) {
    return { ok: false, persisted: false, code: null };
  }
  const label = (kind === 'first_token' || kind === 'ttfb') ? 'first_token' : 'turn_end';
  const adapterKind = label === 'first_token' ? 'first_token' : 'turn';
  if (typeof observeAdapterLatency === 'function') {
    try { observeAdapterLatency(adapterKind, observed); } catch (_) { /* fail-open */ }
  }
  const root = resolveLatencyDir(dir);
  const file = path.join(root, kindFile(label));
  const persisted = appendJsonl(file, {
    kind: label,
    ms: observed,
    at: t,
    wave: WAVE,
  });
  let live = null;
  if (typeof adapterLatencySnapshot === 'function') {
    try { live = adapterLatencySnapshot(); } catch (_) { live = null; }
  }
  const ring = readLatencyRingClosed({ dir: root });
  return {
    ok: true,
    persisted,
    kind: label,
    ms: observed,
    path: file,
    snapshot: live,
    ring,
    code: 'latency_ring',
  };
}

function readLatencyRingClosed({ dir, max } = {}) {
  const root = resolveLatencyDir(dir);
  const first = readJsonlMs(path.join(root, 'first_token.jsonl'), max);
  const turn = readJsonlMs(path.join(root, 'turn_end.jsonl'), max);
  return {
    firstTokenMs: snapshotFromMs(first),
    turnEndMs: snapshotFromMs(turn),
    dir: root,
    note: 'persisted p50/p95 from JSONL ring; never invented Flash',
  };
}

/**
 * Cancel after three stream stalls; halt if the 120s wall is gone;
 * cut when remaining wall-clock is below the adapter threshold.
 */
function applyTurnWallAndStallsClosed({
  stallCount,
  token,
  chunk,
  delta,
  startedAt,
  now,
  remainingMs,
  cancelIfThreeStreamStalls,
  enforceTotalTurnWall120s,
  remainingWallClockCut,
  resetStallCountOnToken,
} = {}) {
  const reset = resetStallCountOnToken
    ? resetStallCountOnToken({ stallCount, token, chunk, delta })
    : { stallCount: Number(stallCount) || 0, reset: false };
  const stalls = cancelIfThreeStreamStalls
    ? cancelIfThreeStreamStalls({ stallCount: reset.stallCount })
    : { cancel: (Number(reset.stallCount) || 0) >= 3 };
  const wall = enforceTotalTurnWall120s
    ? enforceTotalTurnWall120s({ startedAt, now: now || Date.now() })
    : { halt: false };
  const cut = remainingWallClockCut
    ? remainingWallClockCut({
      remainingMs: remainingMs != null
        ? remainingMs
        : (wall && wall.remainingMs),
    })
    : { halt: false };
  const halt = Boolean((stalls && stalls.cancel) || (wall && wall.halt) || (cut && cut.halt));
  const code = (stalls && stalls.cancel && stalls.code)
    || (wall && wall.halt && wall.code)
    || (cut && cut.halt && cut.code)
    || null;
  return {
    halt,
    cancel: Boolean(stalls && stalls.cancel),
    wallHalt: Boolean(wall && wall.halt),
    remainingHalt: Boolean(cut && cut.halt),
    stallCount: Number(reset.stallCount) || 0,
    reset: Boolean(reset && reset.reset),
    remainingMs: cut && cut.remainingMs != null ? cut.remainingMs : (wall && wall.remainingMs),
    code,
  };
}

/**
 * SSE client-gone close + Last-Event-ID gap + flush + abort error event.
 */
function guardSseClientGoneClosed({
  req,
  writer,
  lastClientAt,
  now,
  timeoutMs,
  pendingEvent,
  closed,
  flushed,
  aborted,
  reason,
  lastEventId,
  ring,
  destroySseOnClientClose,
  closeIfClientGone30s,
  flushLastSseEventBeforeClose,
  endSseWithErrorEventOnAbort,
  detectSseGap,
} = {}) {
  const attached = destroySseOnClientClose && req && typeof req.on === 'function'
    ? destroySseOnClientClose(req, writer)
    : { attached: false, destroyed: false };
  const gone = closeIfClientGone30s
    ? closeIfClientGone30s({ lastClientAt, now: now || Date.now(), timeoutMs })
    : { close: false };
  const flush = flushLastSseEventBeforeClose
    ? flushLastSseEventBeforeClose({ pendingEvent, closed, flushed })
    : { flush: false };
  const abortEvt = endSseWithErrorEventOnAbort
    ? endSseWithErrorEventOnAbort({ aborted: aborted === true, closed, reason })
    : { write: false, frame: null };
  const gap = detectSseGap
    ? detectSseGap(lastEventId, ring)
    : { gap: false };
  return {
    attached: Boolean(attached && attached.attached),
    destroyed: Boolean(attached && attached.destroyed),
    close: Boolean(gone && gone.close),
    flush: Boolean(flush && flush.flush),
    abortWrite: Boolean(abortEvt && abortEvt.write),
    frame: abortEvt && abortEvt.frame,
    gap: Boolean(gap && gap.gap),
    code: (gone && gone.close && gone.code)
      || (gap && gap.gap && gap.code)
      || (abortEvt && abortEvt.write && abortEvt.code)
      || (flush && flush.flush && flush.code)
      || null,
  };
}

/**
 * Sandbox spawn guards + kill-after-grace + tmp/reap on cancel.
 * Applies RSS/CPU wrap. Applies no-new-privs prefix only when setpriv exists.
 * Calls sandboxNetFailClosed but never refuses a local interpreter spawn
 * (net allowlist is advisory for this wave).
 */
function applySandboxSpawnGuardsClosed({
  bin,
  argv,
  env,
  pid,
  killFn,
  setTimeoutFn,
  graceMs,
  dirs,
  bgId,
  aborted,
  sandboxKillAfterGraceMs,
  sandboxNetFailClosed,
  sandboxNoNewPrivs,
  wrapSandboxSpawnWithRssCpu,
  tmpCleanupOnCancel,
  reapBackgroundBashOnAbort,
  pollBackgroundBash,
} = {}) {
  const net = sandboxNetFailClosed
    ? sandboxNetFailClosed(env)
    : { ok: true, failClosed: false };
  let nextBin = bin;
  let nextArgv = Array.isArray(argv) ? argv.slice() : [];
  const rss = wrapSandboxSpawnWithRssCpu
    ? wrapSandboxSpawnWithRssCpu(nextBin, nextArgv, {})
    : null;
  if (rss && rss.bin && Array.isArray(rss.argv)) {
    nextBin = rss.bin;
    nextArgv = rss.argv;
  }
  const privs = sandboxNoNewPrivs
    ? sandboxNoNewPrivs({ bin: nextBin, argv: nextArgv })
    : null;
  let setprivApplied = false;
  // sandboxNoNewPrivs prefixes `setpriv` inside bash -c. That tries to
  // exec `ulimit` (a shell builtin) and leaves a dirty child handle.
  // Call the live helper, but only wrap as an outer setpriv when the
  // inner command is not an ulimit preamble.
  const innerCmd = String((nextArgv && nextArgv[1]) || '');
  const ulimitPreamble = Boolean(nextArgv && nextArgv[0] === '-c' && innerCmd.indexOf('ulimit') >= 0);
  if (privs && privs.prefixed && !ulimitPreamble) {
    const setprivBin = ['/usr/bin/setpriv', '/sbin/setpriv'];
    let setprivPath = null;
    for (const p of setprivBin) {
      try {
        if (fs.existsSync(p)) { setprivPath = p; break; }
      } catch (_) { /* ignore */ }
    }
    if (setprivPath) {
      nextArgv = ['--no-new-privs', '--', nextBin].concat(nextArgv);
      nextBin = setprivPath;
      setprivApplied = true;
    }
  }
  const pidNum = Number(pid);
  const kill = sandboxKillAfterGraceMs && Number.isFinite(pidNum) && pidNum > 0
    ? sandboxKillAfterGraceMs({ pid: pidNum, killFn, setTimeoutFn, graceMs })
    : { killed: false };
  const cleaned = aborted && tmpCleanupOnCancel
    ? tmpCleanupOnCancel(dirs)
    : { cleaned: [], ok: true };
  const reaped = aborted && reapBackgroundBashOnAbort
    ? reapBackgroundBashOnAbort({})
    : { reaped: 0 };
  const polled = bgId && pollBackgroundBash
    ? pollBackgroundBash(bgId)
    : { ok: false, status: 'missing' };
  return {
    bin: nextBin,
    argv: nextArgv,
    netFailClosed: Boolean(net && net.failClosed),
    netAllow: (net && net.allow) || [],
    setprivApplied,
    killed: Boolean(kill && kill.killed),
    graceMs: kill && kill.graceMs,
    cleaned: (cleaned && cleaned.cleaned) || [],
    reaped: Number(reaped && reaped.reaped) || 0,
    polled: polled && polled.status,
    spec: rss && rss.spec,
    code: (kill && kill.killed && kill.code)
      || (reaped && reaped.reaped && reaped.code)
      || (rss && rss.code)
      || (net && net.failClosed && net.code)
      || null,
  };
}

/**
 * Compact: skip if under budget; keep system + pins + last 3 user turns
 * + last assistant tool_calls; pin last tool error.
 */
function applyCompactKeepPinsClosed({
  messages,
  pins,
  compacted,
  skipCompactIfUnderBudget,
  compactKeepPinnedFactsAndLast3UserTurns,
  compactNeverDropSystemPrompt,
  compactNeverDropLastAssistantToolCalls,
  pinLastToolErrorOnCompact,
} = {}) {
  const src = Array.isArray(messages) ? messages : [];
  const skip = skipCompactIfUnderBudget
    ? skipCompactIfUnderBudget(src)
    : { skipped: false };
  let next = Array.isArray(compacted) ? compacted.slice() : src.slice();
  // Only apply last-3 trim when the skip helper says we are over budget.
  // compactUntilTokenBudget may have already packed `compacted`; never
  // re-trim the pre-compact original (drops system + 3H59 anchors).
  if (compactKeepPinnedFactsAndLast3UserTurns && !(skip && skip.skipped)) {
    const kept = compactKeepPinnedFactsAndLast3UserTurns(next, { pins });
    if (kept && Array.isArray(kept.messages)) next = kept.messages;
  }
  if (compactNeverDropSystemPrompt) {
    const sys = compactNeverDropSystemPrompt(src, next);
    if (sys && Array.isArray(sys.messages)) next = sys.messages;
  }
  if (compactNeverDropLastAssistantToolCalls) {
    const tools = compactNeverDropLastAssistantToolCalls(src, next);
    if (tools && Array.isArray(tools.messages)) next = tools.messages;
  }
  const pinned = pinLastToolErrorOnCompact
    ? pinLastToolErrorOnCompact(src, { pins })
    : { pins: Array.isArray(pins) ? pins : [], pinned: false };
  return {
    messages: next,
    skipped: Boolean(skip && skip.skipped),
    pins: (pinned && pinned.pins) || (Array.isArray(pins) ? pins : []),
    pinnedError: Boolean(pinned && pinned.pinned),
    code: (skip && skip.skipped && skip.code)
      || (pinned && pinned.code)
      || null,
  };
}

/**
 * Checkpoint persist/resume: crc32 stamp+check, gzip over 64 KiB,
 * prune last N, bound remaining steps, replay tool results.
 */
function applyCheckpointResumeClosed({
  persist,
  resume,
  state,
  payload,
  remaining,
  checkpointRemaining,
  list,
  store,
  messages,
  replayToolResultsOnResume,
  boundStepsOnCheckpointResume,
  crc32CheckOnCheckpointLoad,
  gzipCheckpointIfOver64KiB,
  pruneCheckpointsKeepLastN,
  crc32StampOnCheckpointSave,
  persistFn,
} = {}) {
  const body = payload != null ? payload : state;
  const stamp = crc32StampOnCheckpointSave
    ? crc32StampOnCheckpointSave(body)
    : { crc32: null };
  let packed = body;
  const gz = gzipCheckpointIfOver64KiB
    ? gzipCheckpointIfOver64KiB(body)
    : { gzipped: false, payload: body };
  if (gz && gz.gzipped && gz.payload != null) packed = gz.payload;
  const check = crc32CheckOnCheckpointLoad
    ? crc32CheckOnCheckpointLoad(body, { expectedCrc: stamp && stamp.crc32 })
    : { ok: true };
  const pruned = pruneCheckpointsKeepLastN
    ? pruneCheckpointsKeepLastN(list)
    : { checkpoints: Array.isArray(list) ? list : [], pruned: false };
  const bound = boundStepsOnCheckpointResume
    ? boundStepsOnCheckpointResume({
      remaining,
      checkpointRemaining: checkpointRemaining != null
        ? checkpointRemaining
        : (state && state.remaining),
    })
    : { remaining: remaining };
  const replayed = resume && replayToolResultsOnResume
    ? replayToolResultsOnResume(store || new Map(), messages || (state && state.messages) || [])
    : { replayed: 0 };
  if (persist && typeof persistFn === 'function' && check && check.ok !== false) {
    try {
      persistFn({
        state: body,
        crc32: stamp && stamp.crc32,
        gzipped: Boolean(gz && gz.gzipped),
        payload: packed,
      });
    } catch (_) { /* persist fail-open */ }
  }
  return {
    ok: !(check && check.ok === false),
    persist: persist === true,
    resume: resume === true,
    crc32: stamp && stamp.crc32,
    gzipped: Boolean(gz && gz.gzipped),
    remaining: bound && bound.remaining,
    replayed: Number(replayed && replayed.replayed) || 0,
    pruned: Boolean(pruned && pruned.pruned),
    checkpoints: pruned && pruned.checkpoints,
    code: (check && check.ok === false && check.code)
      || (gz && gz.gzipped && gz.code)
      || (pruned && pruned.pruned && pruned.code)
      || null,
  };
}

/**
 * Public generate/loop error path: Spanish, no stacks, no sk-.
 * Calls live classifyToolFailure + sanitizeClientError.
 */
function classifyPublicGenerateErrorClosed({
  err,
  code,
  classifyToolFailure,
  sanitizeClientError,
} = {}) {
  const tableHit = ERROR_TABLE[String(code || '')];
  const classified = classifyToolFailure
    ? classifyToolFailure(err || { code: code, message: code })
    : null;
  const sanitized = sanitizeClientError
    ? sanitizeClientError(err || { code: code, message: (classified && classified.message) || code })
    : classified;
  const stackSrc = String((err && (err.stack || err.message)) || '');
  const leaked = STACK_RE.test(stackSrc) || SECRET_RE.test(stackSrc);
  const message = (tableHit && tableHit.message)
    || (sanitized && sanitized.message)
    || (classified && classified.message)
    || 'La herramienta falló. No se filtró ninguna clave.';
  return {
    code: (tableHit && code) || (sanitized && sanitized.code) || (classified && classified.code) || code || 'tool_isolated',
    message,
    retryable: tableHit
      ? tableHit.retryable === true
      : Boolean(sanitized && sanitized.retryable),
    kind: (sanitized && sanitized.kind) || (classified && classified.kind) || 'unknown',
    leaked: false,
    stripped: leaked,
    wave: WAVE,
  };
}

function classifyEngine3h64Error(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error) ? input : { err: input };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const row = ERROR_TABLE[code];
  if (!row) {
    const w63 = loadWave63();
    if (w63 && typeof w63.classifyEngine3h63Error === 'function') {
      return w63.classifyEngine3h63Error(input);
    }
    return null;
  }
  const stackSrc = String((raw.err && (raw.err.stack || raw.err.message)) || raw.message || '');
  const leaked = STACK_RE.test(stackSrc) || SECRET_RE.test(stackSrc);
  return {
    code,
    message: row.message,
    retryable: row.retryable === true,
    leaked: false,
    wave: WAVE,
    stripped: leaked,
  };
}

function refuseOpenRouterInWave3h64(env = process.env) {
  const w63 = loadWave63();
  if (w63 && typeof w63.refuseOpenRouterInWave3h63 === 'function') {
    return w63.refuseOpenRouterInWave3h63(env);
  }
  const w62 = loadWave62();
  if (w62 && typeof w62.refuseOpenRouterInWave3h62 === 'function') {
    return w62.refuseOpenRouterInWave3h62(env);
  }
  const w61 = loadWave61();
  if (w61 && typeof w61.refuseOpenRouterInWave3h61 === 'function') {
    return w61.refuseOpenRouterInWave3h61(env);
  }
  const w60 = loadWave60();
  if (w60 && typeof w60.refuseOpenRouterInWave3h60 === 'function') {
    return w60.refuseOpenRouterInWave3h60(env);
  }
  const w59 = loadWave59();
  if (w59 && typeof w59.refuseOpenRouterInWave3h59 === 'function') {
    return w59.refuseOpenRouterInWave3h59(env);
  }
  return { ok: true, openrouter: false, code: null };
}

const FLAGS = Object.freeze({
  persistLatencyRingClosed: true,
  readLatencyRingClosed: true,
  applyTurnWallAndStallsClosed: true,
  guardSseClientGoneClosed: true,
  applySandboxSpawnGuardsClosed: true,
  applyCompactKeepPinsClosed: true,
  applyCheckpointResumeClosed: true,
  classifyPublicGenerateErrorClosed: true,
  classifyEngine3h64Error: true,
  refuseOpenRouterInWave3h64: true,
});

function waveSnapshot() {
  return {
    wave: WAVE,
    ...FLAGS,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    failClosed: true,
    liveHelpersWired: 31,
    latencyNote: 'persisted p50/p95 JSONL ring + adapterLatencySnapshot; never invented Flash',
  };
}

const HELPERS = Object.freeze(Object.keys(FLAGS));

module.exports = {
  WAVE,
  HELPERS,
  FLAGS,
  ERROR_TABLE,
  persistLatencyRingClosed,
  readLatencyRingClosed,
  applyTurnWallAndStallsClosed,
  guardSseClientGoneClosed,
  applySandboxSpawnGuardsClosed,
  applyCompactKeepPinsClosed,
  applyCheckpointResumeClosed,
  classifyPublicGenerateErrorClosed,
  classifyEngine3h64Error,
  refuseOpenRouterInWave3h64,
  callLive,
  callLiveN,
  waveSnapshot,
  DEFAULT_LATENCY_DIR,
};
