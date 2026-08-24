'use strict';

/**
 * 3H61 — fail-closed wiring of unused #388 / 3H59 helpers (engine only).
 *
 * Does NOT re-export 3H59/3H60 names (no overlay collisions). Unique
 * orchestrators compose the live helpers and actually apply their
 * decisions: checkpoint+rollback, sandbox cleanup, cancel token
 * settle, classified ES errors, SSE resume/cancel leftovers, and
 * leftover anti-loop cuts.
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WAVE = '3H61';
const SAFE_WORKDIR_RE = /^(sira-sbx-|sira-sandbox-)/;
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;

const ERROR_TABLE = Object.freeze({
  ckpt_pre_write: { retryable: false, message: 'Tomé un checkpoint antes de una herramienta que escribe.' },
  ckpt_rollback_timeout: { retryable: true, message: 'La escritura expiró. Revertí al checkpoint anterior.' },
  ckpt_skip_unchanged: { retryable: false, message: 'Salté el checkpoint: el archivo no cambió.' },
  sandbox_timeout_cleanup: { retryable: true, message: 'El sandbox expiró. Limpié el directorio de trabajo.' },
  sandbox_orphan_reap: { retryable: false, message: 'Barrí directorios huérfanos del sandbox.' },
  credit_cancel_partial: { retryable: false, message: 'Contabilicé tokens parciales del turno cancelado. No cobré de más.' },
  credit_cancel_dedupe: { retryable: false, message: 'Ese usage de cancelación ya estaba registrado. No lo duplicé.' },
  sse_resume_leak: { retryable: false, message: 'Al reanudar el SSE solté listeners del stream anterior.' },
  sse_cancel_heartbeat: { retryable: false, message: 'Al cancelar el SSE apagué el heartbeat para no filtrar timers.' },
  sse_resume_ahead: { retryable: true, message: 'Last-Event-ID está por delante de la cabeza. Reinicio el replay.' },
  subtask_no_progress: { retryable: false, message: 'El sub-trabajo no avanzó. Lo detuve para no girar en vacío.' },
  subtask_token_budget: { retryable: false, message: 'El sub-trabajo se quedó sin presupuesto de tokens.' },
  loop_fingerprint_cut: { retryable: false, message: 'El agente repitió la misma huella de herramienta. Corté el bucle.' },
  loop_stall: { retryable: false, message: 'El bucle se quedó sin tokens ni resultados de herramientas. Lo detuve.' },
  tool_retry_exhausted: { retryable: false, message: 'La herramienta falló de forma transitoria demasiadas veces. Detuve el bucle.' },
  tool_repair_exhausted: { retryable: false, message: 'No pude reparar los argumentos de la herramienta. Detuve el bucle.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

function loadWave59() {
  try { return require('./engine-3h59'); } catch (_) { return null; }
}

function loadWave60() {
  try { return require('./engine-3h60'); } catch (_) { return null; }
}

function sha256Hex(bytes) {
  const raw = bytes == null ? Buffer.alloc(0) : Buffer.from(bytes);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function looksLikeTimedOutWrite(value) {
  if (value == null) return false;
  const code = String((value && value.code) || '');
  if (/^(ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT|SANDBOX_TIMEOUT|OPERATION_TIMEOUT)$/i.test(code)) {
    return true;
  }
  const msg = String((value && value.message) || value);
  return /timed?\s*out|ETIMEDOUT|sandbox_timeout|deadline/i.test(msg);
}

function looksLikeFailedWrite(value) {
  if (value == null) return false;
  if (value instanceof Error) return true;
  if (typeof value === 'string') return value.startsWith('ERROR:');
  return false;
}

/**
 * Fail-closed mutating write: hook → byte snapshot → execute →
 * rollback on timeout/fail → skip if unchanged → read-after-write hash.
 */
async function guardMutatingWriteClosed({
  tool,
  path: filePath,
  name,
  execute,
  readBytes,
  writeBytes,
} = {}) {
  const w59 = loadWave59();
  const w60 = loadWave60();
  if (typeof execute !== 'function') {
    return { result: undefined, checkpointed: false, rolledBack: false, skipped: false, hook: false };
  }
  const hook = w59 && typeof w59.checkpointHookBeforeMutatingTool === 'function'
    ? w59.checkpointHookBeforeMutatingTool({ tool, path: filePath, name })
    : { hook: false };
  if (!hook || hook.hook !== true) {
    const value = await execute();
    return {
      result: value,
      checkpointed: false,
      rolledBack: false,
      skipped: false,
      hook: false,
      tool: hook && hook.tool,
    };
  }

  const p = filePath == null ? '' : String(filePath);
  let beforeBytes = null;
  if (p && typeof readBytes === 'function') {
    try { beforeBytes = await readBytes(p); } catch (_) { beforeBytes = null; }
    if (beforeBytes != null && !Buffer.isBuffer(beforeBytes)) {
      beforeBytes = Buffer.from(beforeBytes);
    }
  }

  let snapshot = null;
  if (w60 && typeof w60.checkpointFileByteSnapshot === 'function' && p && beforeBytes) {
    const snap = w60.checkpointFileByteSnapshot({ path: p, bytes: beforeBytes });
    snapshot = snap && snap.snapshot;
  } else if (p && beforeBytes) {
    snapshot = { path: p, sha256: sha256Hex(beforeBytes), bytes: beforeBytes, byteLength: beforeBytes.length };
  }
  const beforeHash = snapshot ? snapshot.sha256 : '';

  let result;
  let timedOut = false;
  let failed = false;
  let thrown = null;
  try {
    result = await execute();
    timedOut = looksLikeTimedOutWrite(result);
    failed = looksLikeFailedWrite(result);
  } catch (err) {
    thrown = err;
    timedOut = looksLikeTimedOutWrite(err);
    failed = true;
    result = `ERROR: ${(err && err.message) || String(err)}`;
  }

  const rb = w59 && typeof w59.rollbackHookOnTimedOutWrite === 'function'
    ? w59.rollbackHookOnTimedOutWrite({
      timedOut: timedOut || failed,
      path: p,
      checkpointId: snapshot && snapshot.sha256,
    })
    : { rollback: false };

  let rolledBack = false;
  if (rb && rb.rollback === true && snapshot && snapshot.bytes && typeof writeBytes === 'function') {
    if (w60 && typeof w60.rollbackFileByteSnapshot === 'function') {
      w60.rollbackFileByteSnapshot({
        path: p,
        snapshot,
        restore: (restorePath, bytes) => { writeBytes(restorePath, bytes); },
      });
    }
    try {
      await writeBytes(p, snapshot.bytes);
      rolledBack = true;
    } catch (_) { /* restore best-effort; still report rollback intent */ }
  }

  let skipped = false;
  let raw = null;
  if (!rolledBack && p && typeof readBytes === 'function') {
    let afterBytes = null;
    try { afterBytes = await readBytes(p); } catch (_) { afterBytes = null; }
    if (afterBytes != null && !Buffer.isBuffer(afterBytes)) afterBytes = Buffer.from(afterBytes);
    const afterHash = afterBytes != null ? sha256Hex(afterBytes) : '';
    if (w59 && typeof w59.skipCheckpointIfUnchanged === 'function') {
      const skip = w59.skipCheckpointIfUnchanged({ beforeHash, afterHash });
      skipped = Boolean(skip && skip.skip);
    }
    if (w60 && typeof w60.verifyReadAfterWriteHash === 'function' && afterBytes && !failed && !timedOut) {
      raw = w60.verifyReadAfterWriteHash({
        expectedHash: afterHash,
        actualBytes: afterBytes,
      });
    }
  }

  if (thrown && thrown.stopLoop) {
    thrown.rolledBack = rolledBack;
    throw thrown;
  }

  return {
    result,
    checkpointed: true,
    rolledBack,
    skipped,
    timedOut,
    failed,
    hook: true,
    path: p,
    beforeHash,
    raw,
    code: rolledBack ? 'ckpt_rollback_timeout' : (skipped ? 'ckpt_skip_unchanged' : hook.code),
  };
}

function isSafeSandboxWorkdir(dir) {
  const raw = String(dir || '');
  if (!raw) return false;
  let abs;
  try { abs = path.resolve(raw); } catch (_) { return false; }
  const tmp = path.resolve(os.tmpdir());
  if (abs === tmp) return false;
  if (!abs.startsWith(`${tmp}${path.sep}`)) return false;
  return SAFE_WORKDIR_RE.test(path.basename(abs));
}

function defaultRemoveWorkdir(dir) {
  if (!isSafeSandboxWorkdir(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 1 });
    return true;
  } catch (_) {
    return false;
  }
}

function registerSandboxWorkdirClosed(registry, dir, { now = Date.now() } = {}) {
  const list = Array.isArray(registry) ? registry : [];
  const p = dir == null ? '' : String(dir);
  if (!p || !isSafeSandboxWorkdir(p)) return { registered: false, path: p };
  list.push({ path: p, mtimeMs: Number(now) || Date.now() });
  return { registered: true, path: p };
}

function cleanupSandboxOnTimeoutClosed({
  elapsedMs,
  timeoutMs,
  workdir,
  remove = defaultRemoveWorkdir,
} = {}) {
  const w59 = loadWave59();
  const decision = w59 && typeof w59.sandboxTimeoutThenCleanup === 'function'
    ? w59.sandboxTimeoutThenCleanup({ elapsedMs, timeoutMs, workdir })
    : { timeout: false, cleanup: false };
  let removed = false;
  if (decision && decision.cleanup === true && workdir && typeof remove === 'function') {
    try { removed = Boolean(remove(String(workdir))); } catch (_) { removed = false; }
  }
  return {
    timeout: Boolean(decision && decision.timeout),
    cleanup: Boolean(decision && decision.cleanup),
    removed,
    workdir: workdir == null ? null : String(workdir),
    safe: isSafeSandboxWorkdir(workdir),
    signals: (decision && decision.signals) || ['SIGTERM', 'SIGKILL'],
    code: decision && decision.code,
  };
}

function reapOrphanSandboxDirsClosed(dirs, {
  now = Date.now(),
  maxAgeMs,
  remove = defaultRemoveWorkdir,
} = {}) {
  const w59 = loadWave59();
  const listed = Array.isArray(dirs) ? dirs : [];
  const decision = w59 && typeof w59.sandboxReapOrphanWorkdirs === 'function'
    ? w59.sandboxReapOrphanWorkdirs(listed, { now, maxAgeMs })
    : { reap: [], kept: listed, count: 0 };
  const reap = Array.isArray(decision.reap) ? decision.reap : [];
  const removed = [];
  for (const entry of reap) {
    const p = entry && (entry.path || entry.dir || entry.workdir);
    if (!p || !isSafeSandboxWorkdir(p)) continue;
    let ok = false;
    try { ok = Boolean(remove(String(p))); } catch (_) { ok = false; }
    if (ok) removed.push(String(p));
  }
  if (Array.isArray(dirs)) {
    const gone = new Set(removed);
    for (let i = dirs.length - 1; i >= 0; i -= 1) {
      const item = dirs[i];
      const p = typeof item === 'string' ? item : (item && item.path);
      if (p && gone.has(String(p))) dirs.splice(i, 1);
    }
  }
  return {
    reap,
    removed,
    count: removed.length,
    code: removed.length ? 'sandbox_orphan_reap' : (decision && decision.code) || null,
  };
}

function settleCancelUsageClosed({
  cancelled,
  streamedChars,
  usage,
  alreadyRecorded,
} = {}) {
  const w59 = loadWave59();
  const billed = w59 && typeof w59.accountPartialTokensOnCancel === 'function'
    ? w59.accountPartialTokensOnCancel({ cancelled, streamedChars, usage })
    : { billed: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const dedupe = w59 && typeof w59.neverDoubleCountCancelUsage === 'function'
    ? w59.neverDoubleCountCancelUsage({ alreadyRecorded, usage: billed })
    : { recorded: alreadyRecorded !== true, skipped: alreadyRecorded === true };
  const recorded = Boolean(dedupe && dedupe.recorded && billed && billed.billed);
  return {
    billed: recorded,
    skipped: Boolean(dedupe && dedupe.skipped),
    recorded,
    promptTokens: recorded ? billed.promptTokens : 0,
    completionTokens: recorded ? billed.completionTokens : 0,
    totalTokens: recorded ? billed.totalTokens : 0,
    code: (dedupe && dedupe.skipped) ? dedupe.code : (billed && billed.code),
  };
}

function classifyPublicLoopErrorClosed(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error)
    ? input
    : { err: input, code: input && input.code };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const w59 = loadWave59();
  if (w59 && typeof w59.classifyEngine3h59Error === 'function') {
    const hit = w59.classifyEngine3h59Error(raw);
    if (hit && hit.message) {
      return { ...hit, leaked: false, wave: hit.wave || WAVE };
    }
  }
  const w60 = loadWave60();
  if (w60 && typeof w60.classifyEngine3h60Error === 'function') {
    const hit = w60.classifyEngine3h60Error(raw);
    if (hit && hit.message) {
      return { ...hit, leaked: false, wave: hit.wave || WAVE };
    }
  }
  const row = ERROR_TABLE[code];
  const stackSrc = String((raw.err && (raw.err.stack || raw.err.message)) || raw.message || '');
  const leaked = STACK_RE.test(stackSrc) || SECRET_RE.test(stackSrc);
  if (row) {
    return {
      code,
      message: row.message,
      retryable: row.retryable === true,
      leaked: false,
      wave: WAVE,
      stripped: leaked,
    };
  }
  let message = 'La operación no pudo completarse.';
  if (w60 && typeof w60.redactSecretsFromPublicError === 'function') {
    const redacted = w60.redactSecretsFromPublicError(stackSrc);
    if (redacted && redacted.message && !STACK_RE.test(redacted.message) && !SECRET_RE.test(redacted.message)) {
      message = redacted.message.slice(0, 180) || message;
    }
  }
  return {
    code: code || 'loop_error',
    message,
    retryable: false,
    leaked: false,
    wave: WAVE,
    stripped: leaked,
  };
}

function applySseResumeGuardsClosed({ listeners, resume, lastEventId, headSeq } = {}) {
  const w59 = loadWave59();
  const dropped = w59 && typeof w59.sseResumeDropsPriorListeners === 'function'
    ? w59.sseResumeDropsPriorListeners({ listeners, resume })
    : { listeners: Array.isArray(listeners) ? listeners : [], dropped: 0 };
  const ahead = w59 && typeof w59.sseResumeRejectsSeqPastHead === 'function'
    ? w59.sseResumeRejectsSeqPastHead({ lastEventId, headSeq })
    : { ok: true, reset: false };
  return {
    listeners: dropped.listeners,
    dropped: dropped.dropped || 0,
    ok: ahead.ok !== false,
    reset: ahead.reset === true,
    lastEventId: ahead.reset === true ? 0 : lastEventId,
    headSeq,
    code: ahead.reset ? ahead.code : dropped.code,
  };
}

function applySseCancelHeartbeatClosed({ cancelled, heartbeatTimer } = {}) {
  const w59 = loadWave59();
  if (w59 && typeof w59.sseCancelClearsHeartbeat === 'function') {
    return w59.sseCancelClearsHeartbeat({ cancelled, heartbeatTimer });
  }
  if (cancelled === true && typeof heartbeatTimer === 'function') {
    try { heartbeatTimer(); } catch (_) { /* ignore */ }
    return { cleared: true, code: 'sse_cancel_heartbeat' };
  }
  return { cleared: false, code: null };
}

function enforceSubtaskProgressClosed({ steps = [], tokensDelta = 0, artifactsDelta = 0, maxIdle = 3 } = {}) {
  const w59 = loadWave59();
  if (!w59 || typeof w59.cutSubtaskIfNoProgress !== 'function') {
    return { cut: false, idle: 0, code: null };
  }
  return w59.cutSubtaskIfNoProgress({ steps, tokensDelta, artifactsDelta, maxIdle });
}

function sliceVerificationTokenBudgetClosed({ parentRemaining, requested } = {}) {
  const w59 = loadWave59();
  if (!w59 || typeof w59.sliceSubtaskTokenBudget !== 'function') {
    return { ok: false, budget: 0, code: 'subtask_token_budget' };
  }
  return w59.sliceSubtaskTokenBudget({ parentRemaining, requested });
}

function refuseOpenRouterInWave3h61(env = process.env) {
  const w59 = loadWave59();
  if (w59 && typeof w59.refuseOpenRouterInWave3h59 === 'function') {
    return w59.refuseOpenRouterInWave3h59(env);
  }
  const w60 = loadWave60();
  if (w60 && typeof w60.refuseOpenRouterInWave3h60 === 'function') {
    return w60.refuseOpenRouterInWave3h60(env);
  }
  return { ok: true, openrouter: false, code: null };
}

const FLAGS = Object.freeze({
  guardMutatingWriteClosed: true,
  looksLikeTimedOutWrite: true,
  cleanupSandboxOnTimeoutClosed: true,
  reapOrphanSandboxDirsClosed: true,
  isSafeSandboxWorkdir: true,
  registerSandboxWorkdirClosed: true,
  settleCancelUsageClosed: true,
  classifyPublicLoopErrorClosed: true,
  applySseResumeGuardsClosed: true,
  applySseCancelHeartbeatClosed: true,
  enforceSubtaskProgressClosed: true,
  sliceVerificationTokenBudgetClosed: true,
  refuseOpenRouterInWave3h61: true,
});

function waveSnapshot() {
  return {
    wave: WAVE,
    ...FLAGS,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    failClosed: true,
  };
}

const HELPERS = Object.freeze(Object.keys(FLAGS));

module.exports = {
  WAVE,
  HELPERS,
  FLAGS,
  ERROR_TABLE,
  guardMutatingWriteClosed,
  looksLikeTimedOutWrite,
  cleanupSandboxOnTimeoutClosed,
  reapOrphanSandboxDirsClosed,
  isSafeSandboxWorkdir,
  registerSandboxWorkdirClosed,
  settleCancelUsageClosed,
  classifyPublicLoopErrorClosed,
  applySseResumeGuardsClosed,
  applySseCancelHeartbeatClosed,
  enforceSubtaskProgressClosed,
  sliceVerificationTokenBudgetClosed,
  refuseOpenRouterInWave3h61,
  waveSnapshot,
};
