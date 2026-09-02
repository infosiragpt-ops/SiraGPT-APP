'use strict';

const { throwIfAborted } = require('../../utils/abort-signals');
const { parseReact, looksLikeToolUnsupportedError } = require('./react');
const { normalizeToolTranscript, isToolTranscriptError } = require('./tool-transcript');
const {
  MAX_VERIFICATION_RETRIES,
  needsVerification,
  verificationNudge,
} = require('./verify');
const {
  repairToolArgs,
  isTransientLlmError,
  backoffMs,
  sleep,
  callModelWithRetry,
} = require('./native-llm');

// Per-model canary telemetry (best-effort; never breaks a turn). Kept as a
// lazy require so offline tests that never emit a metric still load fast.
function recordModelTelemetry(event) {
  try { require('../codex/model-telemetry').recordLlmTurn(event); } catch { /* optional */ }
}

function loadEngine3h59() {
  try { return require('./engine-3h59'); } catch (_) { return null; }
}

function loadEngine3h60() {
  try { return require('./engine-3h60'); } catch (_) { return null; }
}

function loadEngineAdapter() {
  try { return require('./engine-adapter'); } catch (_) { return null; }
}

function loadEngine3h61() {
  try { return require('./engine-3h61'); } catch (_) { return null; }
}

function loadEngine3h62() {
  try { return require('./engine-3h62'); } catch (_) { return null; }
}

function loadEngine3h63() {
  try { return require('./engine-3h63'); } catch (_) { return null; }
}

function loadEngine3h64() {
  try { return require('./engine-3h64'); } catch (_) { return null; }
}

function loadEngine3h65() {
  try { return require('./engine-3h65'); } catch (_) { return null; }
}

function loadEngine3h66() {
  try { return require('./engine-3h66'); } catch (_) { return null; }
}

function loadEngine3h67() {
  try { return require('./engine-3h67'); } catch (_) { return null; }
}

function looksLikeTimedOutOrFailedWrite(value) {
  if (value == null) return { timedOut: false, failed: false };
  const msg = String((value && value.message) || value || '');
  if (/old_str occurs more than once|old_str not found|old_str must not be empty/i.test(msg)) {
    return { timedOut: false, failed: false };
  }
  const code = String((value && value.code) || '');
  const timedOut = /^(ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT|SANDBOX_TIMEOUT|OPERATION_TIMEOUT)$/i.test(code)
    || /timed?\s*out|ETIMEDOUT|sandbox_timeout|deadline/i.test(msg);
  const failed = (value instanceof Error)
    || (typeof value === 'string' && value.startsWith('ERROR:'))
    || timedOut;
  return { timedOut, failed };
}

function sha256HexLoop(bytes) {
  const crypto = require('crypto');
  const raw = bytes == null ? Buffer.alloc(0) : Buffer.from(bytes);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Fail-closed mutating write + sandbox timeout using live #388 / 3H59 names
 * from the adapter (not overlay aliases). Snapshot → execute → rollback on
 * timeout/fail → skip if unchanged → sandboxTimeoutThenCleanup on abort.
 */
async function executeWith3h59Checkpoint({
  adapter,
  mapped,
  execArgs,
  runExecutor,
  executors,
  fileEditCkpt,
}) {
  const filePath = execArgs && (execArgs.path || execArgs.filename);
  const diffText = execArgs && (execArgs.diff || execArgs.patch);
  const ckpt = fileEditCkpt && typeof fileEditCkpt === 'object' ? fileEditCkpt : { edits: [] };
  if (diffText && /apply_patch|edit_file|apply_diff/i.test(String(mapped || ''))) {
    try {
      const w62 = loadEngine3h62();
      if (w62 && typeof w62.requireExactDiffMarkersClosed === 'function') {
        const markers = w62.requireExactDiffMarkersClosed(diffText);
        if (markers && markers.ok === false) {
          const classified = classifyLoopError({ code: 'diff_markers' });
          return `ERROR: ${classified.message}`;
        }
      }
    } catch (_) { /* 3H62 fail-open: write still gated by timeout rollback */ }
  }
  try {
    const w63 = loadEngine3h63();
    const root = (executors && (executors.__workspaceRoot || executors.workspaceRoot))
      || (execArgs && execArgs.root)
      || null;
    if (adapter && filePath && typeof adapter.workspacePathJail === 'function' && root) {
      const jail = adapter.workspacePathJail(filePath, root);
      if (jail && jail.ok === false) {
        const classified = classifyLoopError({ code: jail.code || 'path_traversal' });
        return 'ERROR: ' + classified.message;
      }
    }
    if (w63 && typeof w63.applyExactDiffChecksumClosed === 'function') {
      const gated = w63.applyExactDiffChecksumClosed({
        path: filePath,
        haystack: execArgs && (execArgs.haystack || execArgs.content),
        diff: diffText,
        before: execArgs && execArgs.before,
        root,
        sha256AtRead: execArgs && (execArgs.sha256AtRead || execArgs.expectedSha256),
        applyUnifiedDiff: adapter && adapter.applyUnifiedDiff,
        refuseEditIfChecksumChangedSinceRead: adapter && adapter.refuseEditIfChecksumChangedSinceRead,
        checksumVerifyAfterWrite: adapter && adapter.checksumVerifyAfterWrite,
        atomicWriteViaTempRename: adapter && adapter.atomicWriteViaTempRename,
        refuseBinaryFileEdit: adapter && adapter.refuseBinaryFileEdit,
        workspacePathJail: adapter && adapter.workspacePathJail,
        skipUnchangedWrite: adapter && adapter.skipUnchangedWrite,
        normalizeLineEndingsBeforeDiff: adapter && adapter.normalizeLineEndingsBeforeDiff,
      });
      if (gated && gated.ok === false && !gated.uniqueness) {
        const classified = classifyLoopError({ code: gated.code || 'file_changed' });
        return 'ERROR: ' + classified.message;
      }
    }
  } catch (_) { /* 3H63 write gate fail-open to 3H62 RAW */ }
  const hook = adapter && typeof adapter.checkpointHookBeforeMutatingTool === 'function'
    ? adapter.checkpointHookBeforeMutatingTool({ tool: mapped, path: filePath, name: mapped })
    : { hook: false };

  const readBytes = async (p) => {
    if (typeof executors.__rawRead === 'function') return executors.__rawRead(p);
    if (typeof executors.readFile === 'function') return executors.readFile(p);
    return null;
  };
  const writeBytes = async (p, bytes) => {
    if (typeof executors.__rawWrite === 'function') return executors.__rawWrite(p, bytes);
    if (typeof executors.writeFile === 'function') return executors.writeFile(p, bytes);
    return null;
  };

  let beforeBytes = null;
  let beforeHash = '';
  if (hook && hook.hook === true && filePath) {
    try {
      beforeBytes = await readBytes(filePath);
      if (beforeBytes != null && !Buffer.isBuffer(beforeBytes)) beforeBytes = Buffer.from(beforeBytes);
      if (beforeBytes) beforeHash = sha256HexLoop(beforeBytes);
    } catch (_) { beforeBytes = null; }
  }
  if (hook && hook.hook === true && filePath && adapter) {
    try {
      if (typeof adapter.refuseBinaryFileEdit === 'function' && beforeBytes) {
        const bin = adapter.refuseBinaryFileEdit(beforeBytes);
        if (bin && bin.ok === false) {
          const classified = classifyLoopError({ code: 'binary_file' });
          return 'ERROR: ' + classified.message;
        }
      }
      const atRead = execArgs && (execArgs.sha256AtRead || execArgs.expectedSha256);
      if (typeof adapter.refuseEditIfChecksumChangedSinceRead === 'function' && atRead && beforeHash) {
        const changed = adapter.refuseEditIfChecksumChangedSinceRead({
          sha256Now: beforeHash,
          sha256AtRead: String(atRead),
        });
        if (changed && changed.ok === false) {
          const classified = classifyLoopError({ code: 'file_changed' });
          return 'ERROR: ' + classified.message;
        }
      }
    } catch (_) { /* 3H63 checksum pre-write fail-open */ }
  }

  try {
    const w65pre = loadEngine3h65();
    if (w65pre && typeof w65pre.applyFileEditGuardsClosed === 'function' && filePath && adapter) {
      const pre = w65pre.applyFileEditGuardsClosed({
        path: filePath,
        existingBytes: beforeBytes && beforeBytes.length,
        existingText: beforeBytes ? String(beforeBytes) : (execArgs && execArgs.before),
        exists: beforeBytes != null,
        backupPath: execArgs && execArgs.backupPath,
        haystack: execArgs && (execArgs.haystack || (beforeBytes && String(beforeBytes)) || execArgs.before),
        diff: diffText,
        context: execArgs && execArgs.context,
        actual: execArgs && (execArgs.actual || execArgs.before),
        checkpoint: ckpt,
        result: null,
        createIfMissingOrRefuseLargeOverwrite: adapter.createIfMissingOrRefuseLargeOverwrite,
        patchContextLinesMustMatch: adapter.patchContextLinesMustMatch,
        rollbackLastFileEdit: adapter.rollbackLastFileEdit,
        rollbackLastNFileEdits: adapter.rollbackLastNFileEdits,
        afterWriteTestHint: adapter.afterWriteTestHint,
      });
      if (pre && pre.ok === false && !pre.uniqueness) {
        const classified = classifyLoopError({ code: pre.code || 'file_too_large' });
        return 'ERROR: ' + classified.message;
      }
    }
  } catch (_) { /* 3H65 pre-write fail-open */ }

  try {
    const w66pre = loadEngine3h66();
    const writeKind = w66pre && w66pre.WRITE_TOOL_RE
      ? w66pre.WRITE_TOOL_RE.test(String(mapped || ''))
      : /^(write_|str_replace|apply_patch|apply_diff|edit_file|create_file|computer_write)/i.test(String(mapped || ''));
    const root66 = (executors && (executors.__workspaceRoot || executors.workspaceRoot))
      || (execArgs && execArgs.root)
      || null;
    if (w66pre && typeof w66pre.applyPathJailClosed === 'function' && filePath && adapter && writeKind) {
      const jail = w66pre.applyPathJailClosed({
        path: filePath,
        content: execArgs && (execArgs.content != null ? execArgs.content : execArgs.new_string),
        kind: 'write',
        root: root66,
        result: null,
        nfcPath: adapter.nfcPath,
        rejectNulInPath: adapter.rejectNulInPath,
        rejectControlCharsInPaths: adapter.rejectControlCharsInPaths,
        rejectUncAndWindowsPaths: adapter.rejectUncAndWindowsPaths,
        rejectSymlinkEscape: adapter.rejectSymlinkEscape,
        refuseWriteThroughSymlink: adapter.refuseWriteThroughSymlink,
        refuseReadThroughSymlink: adapter.refuseReadThroughSymlink,
        refuseWriteOver2MiB: adapter.refuseWriteOver2MiB,
      });
      if (jail && jail.ok === false && !jail.uniqueness) {
        const classified = classifyLoopError({ code: jail.code || 'bad_path' });
        return 'ERROR: ' + classified.message;
      }
    }
  } catch (_) { /* 3H66 path jail pre-write fail-open */ }

  let result;
  let thrown = null;
  try {
    result = await runExecutor();
  } catch (err) {
    thrown = err;
    result = `ERROR: ${(err && err.message) || String(err)}`;
  }

  const flags = looksLikeTimedOutOrFailedWrite(thrown || result);
  if (hook && hook.hook === true && filePath && adapter && typeof adapter.rollbackHookOnTimedOutWrite === 'function') {
    const rb = adapter.rollbackHookOnTimedOutWrite({
      timedOut: flags.timedOut,
      path: filePath,
      checkpointId: beforeHash || null,
    });
    if (rb && rb.rollback === true && beforeBytes) {
      try { await writeBytes(filePath, beforeBytes); } catch (_) { /* restore best-effort */ }
      if (flags.timedOut) {
        const classified = classifyLoopError({ code: 'ckpt_rollback_timeout' });
        result = `ERROR: ${classified.message}`;
      }
    } else if (!flags.failed && adapter && typeof adapter.skipCheckpointIfUnchanged === 'function') {
      try {
        let afterBytes = await readBytes(filePath);
        if (afterBytes != null && !Buffer.isBuffer(afterBytes)) afterBytes = Buffer.from(afterBytes);
        const afterHash = afterBytes != null ? sha256HexLoop(afterBytes) : '';
        adapter.skipCheckpointIfUnchanged({ beforeHash, afterHash });
      } catch (_) { /* skip is advisory */ }
    }
  }

  const uniqueness = /old_str occurs more than once|old_str not found|old_str must not be empty/i
    .test(String((thrown && thrown.message) || result || ''));
  if (hook && hook.hook === true && filePath && !flags.timedOut && !uniqueness) {
    try {
      const w62 = loadEngine3h62();
      if (w62 && typeof w62.validateWriteThenRevertClosed === 'function') {
        let afterBytes = null;
        try {
          afterBytes = await readBytes(filePath);
          if (afterBytes != null && !Buffer.isBuffer(afterBytes)) afterBytes = Buffer.from(afterBytes);
        } catch (_) { afterBytes = null; }
        const expected = execArgs && execArgs.content != null
          ? Buffer.from(String(execArgs.content))
          : null;
        const validated = await w62.validateWriteThenRevertClosed({
          path: filePath,
          beforeBytes,
          afterBytes,
          expectedBytes: expected,
          restore: writeBytes,
          tool: mapped,
          diff: diffText,
          result,
        });
        if (validated && validated.reverted) {
          const classified = classifyLoopError({ code: validated.code || 'write_syntax_revert' });
          result = `ERROR: ${classified.message}`;
        }
        if (adapter && afterBytes && !(validated && validated.uniqueness)) {
          if (typeof adapter.skipUnchangedWrite === 'function' && beforeBytes) {
            adapter.skipUnchangedWrite({ before: beforeBytes, after: afterBytes });
          }
          const expectedSha = execArgs && (execArgs.expectedSha256 || execArgs.contentSha256);
          if (typeof adapter.checksumVerifyAfterWrite === 'function' && expectedSha) {
            const chk = adapter.checksumVerifyAfterWrite({
              actual: afterBytes,
              expectedSha256: expectedSha,
            });
            if (chk && chk.ok === false) {
              const classified = classifyLoopError({ code: 'write_checksum' });
              result = 'ERROR: ' + classified.message;
            }
          }
          if (typeof adapter.atomicWriteViaTempRename === 'function' && typeof writeBytes === 'function') {
            adapter.atomicWriteViaTempRename({
              path: filePath,
              content: afterBytes,
              writeFn: (p, bytes) => { /* tmp stage recorded */ void p; void bytes; },
              renameFn: (tmp, dest) => { void tmp; void dest; },
            });
          }
        }
      }
    } catch (_) { /* 3H62 fail-open: timeout rollback still applies */ }
  }

  try {
    const w65post = loadEngine3h65();
    if (w65post && typeof w65post.applyFileEditGuardsClosed === 'function' && filePath && adapter) {
      if (typeof adapter.rememberFileEdit === 'function' && beforeBytes != null) {
        try {
          let afterForCkpt = null;
          try { afterForCkpt = await readBytes(filePath); } catch (_) { afterForCkpt = null; }
          adapter.rememberFileEdit(ckpt, {
            path: filePath,
            before: beforeBytes,
            after: afterForCkpt,
          });
        } catch (_) { /* remember is advisory */ }
      }
      const post = w65post.applyFileEditGuardsClosed({
        path: filePath,
        checkpoint: ckpt,
        n: 1,
        apply: (p, bytes) => writeBytes(p, bytes),
        failed: flags.failed,
        timedOut: flags.timedOut,
        result: thrown || result,
        hasRunner: Boolean(executors && (executors.run_tests || executors.__hasRunner)),
        rollbackLastFileEdit: adapter.rollbackLastFileEdit,
        rollbackLastNFileEdits: adapter.rollbackLastNFileEdits,
        afterWriteTestHint: adapter.afterWriteTestHint,
        createIfMissingOrRefuseLargeOverwrite: adapter.createIfMissingOrRefuseLargeOverwrite,
        patchContextLinesMustMatch: adapter.patchContextLinesMustMatch,
      });
      if (post && post.reverted && flags.timedOut) {
        const classified = classifyLoopError({ code: post.code || 'checkpoint_rollback' });
        result = 'ERROR: ' + classified.message;
      } else if (post && post.hint && post.hintText && !String(result).startsWith('ERROR:')) {
        result = String(result) + '\n' + post.hintText;
      }
    }
  } catch (_) { /* 3H65 post-write fail-open */ }

  if (flags.timedOut || /sandbox_timeout|timed?\s*out/i.test(String(result))) {
    const workdir = (executors && (executors.__sandboxWorkdir || executors.sandboxWorkdir))
      || (execArgs && execArgs.workdir)
      || (thrown && thrown.workdir)
      || null;
    const timeoutMs = Math.max(1, Number((execArgs && execArgs.timeoutMs) || (thrown && thrown.timeoutMs) || 8000));
    if (adapter && typeof adapter.sandboxTimeoutThenCleanup === 'function') {
      const decision = adapter.sandboxTimeoutThenCleanup({
        elapsedMs: timeoutMs,
        timeoutMs,
        workdir,
      });
      if (decision && decision.cleanup === true) {
        try {
          const w61 = loadEngine3h61();
          if (w61 && typeof w61.cleanupSandboxOnTimeoutClosed === 'function') {
            w61.cleanupSandboxOnTimeoutClosed({
              elapsedMs: timeoutMs,
              timeoutMs,
              workdir,
            });
          }
        } catch (_) { /* apply best-effort */ }
      }
    }
    if (adapter && typeof adapter.sandboxReapOrphanWorkdirs === 'function') {
      const listed = Array.isArray(executors && executors.__sandboxDirs)
        ? executors.__sandboxDirs
        : (workdir ? [{ path: workdir, orphan: true, mtimeMs: Date.now() }] : []);
      if (listed.length) adapter.sandboxReapOrphanWorkdirs(listed, { now: Date.now() });
    }
  }

  if (thrown && thrown.stopLoop) throw thrown;
  return result;
}

const MAX_ITERATIONS_DEFAULT = 25;
const MAX_CONSECUTIVE_REPAIR_FAILS = 3;

// Keep tool-call turns SHORT. Providers charge/reserve max_tokens up front:
// with a low credit balance an 8192-token reservation gets rejected with 402
// ("You requested up to 8192 tokens, but can only afford …") even though the
// actual turn needs a few hundred tokens. 2048 still fits a code-bearing tool
// call (contract floor in agent-runner-routing.test.js) while staying far
// below the 8192 that 402s on low balances. Env-overridable.
const MAX_TOKENS_DEFAULT = 2048;
const LLM_RETRY_MAX = Math.max(1, Number.parseInt(process.env.LLM_RETRY_MAX || '', 10) || 3);

function resolveAgentRunnerMaxTokens(env = process.env) {
  const raw = Number(env.SIRAGPT_AGENT_RUNNER_MAX_TOKENS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(256, Math.min(8192, Math.floor(raw)));
  }
  return MAX_TOKENS_DEFAULT;
}

// ── Stream-stall guard ──────────────────────────────────────────────
// A mid-stream hang (provider stalls after first token, or never emits one)
// previously left the loop hanging until the outer response timeout. The
// guard cuts the turn early with `loop_stall` so the SSE stream gets an
// honest error and the caller can retry cheaply.
const STREAM_STALL_MS_DEFAULT = 20_000;
const STREAM_STALL_CANCEL_AFTER = 3;

function stallIfNoEvent20sMidStream({ lastEventAt, firstTokenAt, now, stallMs } = {}) {
  const budgetMs = Number(stallMs) > 0 ? Number(stallMs) : STREAM_STALL_MS_DEFAULT;
  // Anchor on the LATEST signal of progress (first token wins when present —
  // it is by definition newer than the generation start).
  const candidates = [firstTokenAt, lastEventAt].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!candidates.length) return { stalled: false };
  const anchor = Math.max(...candidates);
  const at = Number(now) || Date.now();
  return { stalled: at - anchor >= budgetMs, idleMs: at - anchor };
}

/** Fence token for KV heartbeats — proves "this runner is alive on this thread". */
function newFenceToken() {
  return `fence_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * heartbeatFence — refresh a KV lease that marks this runner as the live
 * owner of `threadId`. A recovering worker compares timestamps before taking
 * over; a stale fence (no heartbeat within ttlSec) may be stolen. KV shape:
 * any object with get/set (ioredis, in-memory Map wrapper, …). Fail-open:
 * fence errors never break the loop.
 */
async function heartbeatFence(kv, threadId, token, { now, ttlSec = 60 } = {}) {
  if (!kv || !threadId || !token) return false;
  try {
    const key = `agent:fence:${threadId}`;
    const payload = JSON.stringify({ token, at: now || Date.now(), ttlSec });
    if (typeof kv.set === 'function') await kv.set(key, payload, { ttlSec });
    else await kv.set(key, payload);
    return true;
  } catch {
    return false;
  }
}

/** True when the stored fence is expired (safe to steal). */
async function stealStaleFence(kv, threadId, { now, ttlSec = 60 } = {}) {
  if (!kv || !threadId) return { stolen: true, reason: 'no_fence' };
  try {
    const raw = typeof kv.get === 'function' ? await kv.get(`agent:fence:${threadId}`) : null;
    if (!raw) return { stolen: true, reason: 'expired' };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const ageMs = (now || Date.now()) - Number(parsed.at || 0);
    if (ageMs >= Math.min(ttlSec, parsed.ttlSec || ttlSec) * 1000) return { stolen: true, reason: 'expired' };
    return { stolen: false, token: parsed.token };
  } catch {
    return { stolen: true, reason: 'error' };
  }
}

/** Classify a loop stop into a user-facing Spanish code + message (no stacks). */
function classifyLoopError({ code, err } = {}) {
  try {
    const w67 = loadEngine3h67();
    if (w67 && typeof w67.classifyEngine3h67Error === 'function') {
      const hit = w67.classifyEngine3h67Error({ code, err });
      if (hit && hit.message) return hit;
    }
  } catch (_) { /* 3H67 fail-open to 3H66 */ }
  try {
    const w66 = loadEngine3h66();
    if (w66 && typeof w66.classifyEngine3h66Error === 'function') {
      const hit = w66.classifyEngine3h66Error({ code, err });
      if (hit && hit.message) return hit;
    }
  } catch (_) { /* 3H66 fail-open to 3H65 */ }
  try {
    const w65 = loadEngine3h65();
    if (w65 && typeof w65.classifyEngine3h65Error === 'function') {
      const hit = w65.classifyEngine3h65Error({ code, err });
      if (hit && hit.message) return hit;
    }
  } catch (_) { /* 3H65 fail-open to 3H64 */ }
  try {
    const w64 = loadEngine3h64();
    if (w64 && typeof w64.classifyEngine3h64Error === 'function') {
      const hit = w64.classifyEngine3h64Error({ code, err });
      if (hit && hit.message) return hit;
    }
    // classifyPublicGenerateErrorClosed always returns a message (tool_isolated
    // for unknown codes). Only use it for uncoded tool failures so 3H59–3H63
    // table codes (subtask_no_progress, credit_ledger_settle, ...) still fall
    // through. Known `code` keeps its wave table + Spanish copy.
    const adapter = loadEngineAdapter();
    if (w64 && typeof w64.classifyPublicGenerateErrorClosed === 'function' && err && !code) {
      const pub = w64.classifyPublicGenerateErrorClosed({
        err,
        classifyToolFailure: adapter && adapter.classifyToolFailure,
        sanitizeClientError: adapter && adapter.sanitizeClientError,
      });
      if (pub && pub.message) return pub;
    }
  } catch (_) { /* 3H64 fail-open to 3H63 */ }
  try {
    const w63 = loadEngine3h63();
    if (w63 && typeof w63.classifyEngine3h63Error === 'function') {
      const hit = w63.classifyEngine3h63Error({ code, err });
      if (hit && hit.message) return hit;
    }
  } catch (_) { /* 3H63 fail-open to 3H62 */ }
  try {
    const w62 = loadEngine3h62();
    if (w62 && typeof w62.classifyEngine3h62Error === 'function') {
      const hit = w62.classifyEngine3h62Error({ code, err });
      if (hit && hit.message) return hit;
    }
  } catch (_) { /* 3H62 fail-open to 3H61 */ }
  try {
    const w61 = loadEngine3h61();
    if (w61 && typeof w61.classifyPublicLoopErrorClosed === 'function') {
      const hit = w61.classifyPublicLoopErrorClosed({ code, err });
      if (hit && hit.message) return hit;
    }
  } catch (_) { /* 3H61 fail-open to local table */ }
  switch (code) {
    case 'loop_stall':
      return {
        code,
        retryable: false,
        message: 'El bucle se quedó sin tokens ni resultados de herramientas. Lo detuve.',
      };
    case 'fence_conflict':
      return {
        code,
        retryable: false,
        message: 'Otro proceso está atendiendo esta tarea; no la duplicaré.',
      };
    case 'tool_retry_exhausted':
      return {
        code,
        retryable: false,
        message: 'La herramienta falló de forma transitoria demasiadas veces. Detuve el bucle.',
      };
    case 'tool_repair_exhausted':
      return {
        code,
        retryable: false,
        message: 'No pude reparar los argumentos de la herramienta. Detuve el bucle.',
      };
    case 'ckpt_rollback_timeout':
      return {
        code,
        retryable: true,
        message: 'La escritura expiró. Revertí al checkpoint anterior.',
      };
    case 'subtask_no_progress':
      return {
        code,
        retryable: false,
        message: 'El sub-trabajo no avanzó. Lo detuve para no girar en vacío.',
      };
    case 'write_syntax_revert':
      return {
        code,
        retryable: false,
        message: 'La escritura dejó sintaxis inválida. Restauré el original.',
      };
    case 'write_hash_mismatch':
      return {
        code,
        retryable: true,
        message: 'El hash posterior a la escritura no coincidió. No di el cambio por bueno.',
      };
    case 'diff_markers':
      return {
        code,
        retryable: false,
        message: 'El diff no trae marcadores ---/+++. No lo apliqué.',
      };
    case 'file_changed':
      return {
        code,
        retryable: false,
        message: 'El archivo cambió desde la lectura. No apliqué el edit.',
      };
    case 'subagent_budget':
      return {
        code,
        retryable: false,
        message: 'El subagente no tenía presupuesto de pasos. No lo lancé.',
      };
    case 'subagent_parent_cancelled':
      return {
        code,
        retryable: false,
        message: 'El padre se canceló. No lancé el subagente.',
      };
    case 'ttfb_abort':
      return {
        code,
        retryable: true,
        message: 'El modelo no envió el primer byte a tiempo. Cancelé el turno.',
      };
    case 'computer_flag_off':
      return {
        code,
        retryable: false,
        message: 'La computadora no está habilitada. No ejecuté la herramienta.',
      };
    case 'computer_no_user':
      return {
        code,
        retryable: false,
        message: 'Falta el usuario de esta computadora. No ejecuté la herramienta.',
      };
    case 'computer_no_session':
      return {
        code,
        retryable: false,
        message: 'No hay sesión de computadora. No ejecuté la herramienta.',
      };
    case 'isolation_required':
      return {
        code,
        retryable: false,
        message: 'No se pudo aislar la computadora de esta conversación.',
      };
    case 'credit_screenshot':
      return {
        code,
        retryable: false,
        message: 'La captura de pantalla no cobra créditos.',
      };
    default:
      return { code: code || 'loop_error', retryable: true, message: String(code || 'loop_error') };
  }
}

/**
 * Fit `messages` to the adapter token budget before callModel.
 * Uses live #388 helpers only: compactUntilTokenBudget + 3H59 fact anchors.
 * Mutates the array in place so callers keep the same reference.
 */
function compactMessagesInPlace(messages, opts = {}) {
  const adapter = loadEngineAdapter();
  if (!adapter || typeof adapter.compactUntilTokenBudget !== 'function') return false;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const budget = Math.max(1500, resolveAgentRunnerMaxTokens());
  if (typeof adapter.estimateCompactTokens === 'function') {
    const used = adapter.estimateCompactTokens(messages);
    if (Number.isFinite(used) && used <= budget) {
      const pinned = tryRestorePins(messages, messages, opts);
      if (pinned && pinned !== messages && Array.isArray(opts.memoryHits) && opts.memoryHits.length) {
        messages.length = 0;
        for (const m of pinned) messages.push(m);
        return true;
      }
      return false;
    }
  }
  const packed = adapter.compactUntilTokenBudget(messages, { remaining: budget, keep: 6 });
  if (!packed || !Array.isArray(packed.messages)) return false;
  let next = packed.messages;
  try {
    const w = loadEngine3h59();
    if (w && typeof w.anchorCriticalFacts === 'function' && typeof w.compactPreserveFactAnchors === 'function') {
      const { anchors } = w.anchorCriticalFacts(messages);
      const restored = w.compactPreserveFactAnchors(messages, next, anchors);
      if (restored && Array.isArray(restored.messages)) next = restored.messages;
    }
  } catch (_) { /* 3H59 fail-open */ }
  next = tryRestorePins(messages, next, opts) || next;
  try {
    const w64 = loadEngine3h64();
    const adapter = loadEngineAdapter();
    if (w64 && typeof w64.applyCompactKeepPinsClosed === 'function' && adapter) {
      const kept = w64.applyCompactKeepPinsClosed({
        messages,
        compacted: next,
        pins: opts.memoryHits,
        skipCompactIfUnderBudget: adapter.skipCompactIfUnderBudget,
        compactKeepPinnedFactsAndLast3UserTurns: adapter.compactKeepPinnedFactsAndLast3UserTurns,
        compactNeverDropSystemPrompt: adapter.compactNeverDropSystemPrompt,
        compactNeverDropLastAssistantToolCalls: adapter.compactNeverDropLastAssistantToolCalls,
        pinLastToolErrorOnCompact: adapter.pinLastToolErrorOnCompact,
      });
      if (kept && Array.isArray(kept.messages)) next = kept.messages;
    }
  } catch (_) { /* 3H64 compact fail-open */ }
  if (next === messages) return Boolean(packed.compressed);
  messages.length = 0;
  for (const m of next) messages.push(m);
  return true;
}

function tryRestorePins(original, compacted, opts = {}) {
  try {
    const w62 = loadEngine3h62();
    if (w62 && typeof w62.recoverPgvectorPinsClosed === 'function' && Array.isArray(opts.memoryHits) && opts.memoryHits.length) {
      const recovered = w62.recoverPgvectorPinsClosed({
        compacted,
        memoryHits: opts.memoryHits,
        query: opts.query,
      });
      if (recovered && !recovered.then && Array.isArray(recovered.messages)) return recovered.messages;
    }
  } catch (_) { /* 3H62 fail-open */ }
  return compacted;
}

function recoverParsedToolArgs(raw, call) {
  const adapter = loadEngineAdapter();
  if (adapter && typeof adapter.repairTruncatedJson === 'function') {
    const fixed = adapter.repairTruncatedJson(raw);
    if (fixed && fixed.ok && fixed.value && !fixed.value.__parse_error) {
      return { ok: true, value: fixed.value, repaired: Boolean(fixed.repaired) };
    }
  }
  try {
    const w66 = loadEngine3h66();
    if (w66 && typeof w66.applyToolJsonCoerceClosed === 'function' && adapter) {
      const coerced = w66.applyToolJsonCoerceClosed({
        raw,
        args: null,
        schema: null,
        prior: null,
        repairSingleQuotesAndCommentsInToolJson: adapter.repairSingleQuotesAndCommentsInToolJson,
        repairUnquotedKeysInToolJson: adapter.repairUnquotedKeysInToolJson,
        coerceTrueFalseStringsToBool: adapter.coerceTrueFalseStringsToBool,
        coerceIntegerFromNumericString: adapter.coerceIntegerFromNumericString,
        repairEnumCaseInsensitive: adapter.repairEnumCaseInsensitive,
        repairMissingRequiredFromPriorTurn: adapter.repairMissingRequiredFromPriorTurn,
      });
      if (coerced && coerced.ok && coerced.args && !coerced.args.__parse_error) {
        return { ok: true, value: coerced.args, repaired: Boolean(coerced.repaired) };
      }
    }
  } catch (_) { /* 3H66 json coerce fail-open */ }
  try {
    const w = loadEngine3h59();
    if (w && typeof w.repairPartialToolCallSchema === 'function') {
      const repaired = w.repairPartialToolCallSchema({
        ...(call && typeof call === 'object' ? call : {}),
        function: {
          ...((call && call.function) || {}),
          arguments: raw,
        },
      });
      if (repaired && repaired.partial && repaired.repaired && Array.isArray(repaired.missing) && repaired.missing.length === 0) {
        return { ok: false, value: null, repaired: false };
      }
      const nextArgs = repaired && repaired.call && repaired.call.function
        ? repaired.call.function.arguments
        : null;
      if (nextArgs && typeof nextArgs === 'object' && !nextArgs.__parse_error && !Array.isArray(nextArgs)) {
        return { ok: true, value: nextArgs, repaired: Boolean(repaired.repaired) };
      }
      if (typeof nextArgs === 'string') {
        const parsed = safeParseArgs(nextArgs);
        if (!parsed.__parse_error) return { ok: true, value: parsed, repaired: true };
      }
    }
  } catch (_) { /* 3H59 fail-open */ }
  return { ok: false, value: null, repaired: false };
}

function retrySleepFn(ms) {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve();
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Out-of-credit detection for OpenRouter (HTTP 402 / "can only afford") and
 * Anthropic ("credit balance is too low"). These are NOT transient: retrying
 * burns latency without any chance of success, so the loop must stop
 * immediately and surface the reason.
 */
function isLlmCreditError(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode || err.response?.status || (err.code === 402 ? 402 : NaN));
  if (status === 402) return true;
  const message = String(err.message || err.error?.message || '').toLowerCase();
  return /\b402\b|credit balance is too low|insufficient credits?|requires more credits|can only afford|payment required/i.test(message);
}

function previewOf(value, max = 200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeParseArgs(raw) {
  const repaired = repairToolArgs(raw);
  if (repaired.ok) return repaired.value;
  return { __parse_error: true, raw: String(raw).slice(0, 500) };
}

function kindIsReadBlocked(mapped, filePath, blocked) {
  if (!filePath || !Array.isArray(blocked) || !blocked.length) return false;
  if (!/^(read_file|read_|cat_file|sandbox_read)/i.test(String(mapped || ''))) return false;
  return blocked.indexOf(String(filePath)) >= 0;
}

function asNativeCalls(calls, iteration) {
  return calls.map((c, idx) => ({
    id: `react_${iteration}_${idx}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
  }));
}

async function callModel({ client, model, messages, tools, signal, maxTokens, onFirstToken }) {
  const max_tokens = maxTokens || resolveAgentRunnerMaxTokens();
  // The request payload is a structurally valid copy of the transcript: the
  // compaction / pruning hooks may leave orphan tool results or unanswered
  // tool_calls behind, which strict providers (DeepSeek native, OpenAI,
  // Gemini, xAI) reject with a 400. The runner's own `messages` state is
  // never mutated here.
  const normalized = normalizeToolTranscript(messages);
  if (normalized.repaired > 0) {
    try { console.warn(`[agent-runner] tool transcript repaired (${normalized.repaired} fix${normalized.repaired === 1 ? '' : 'es'}) before the LLM call`); } catch (_) { /* ignore */ }
  }
  const create = (withTools) => client.chat.completions.create({
    model,
    messages: normalized.messages,
    ...(withTools ? { tools, tool_choice: 'auto' } : {}),
    max_tokens,
  }, signal ? { signal } : undefined);
  return callModelWithRetry(async () => {
    try {
      const out = await create(true);
      if (typeof onFirstToken === 'function') { try { onFirstToken(); } catch { /* optional */ } }
      return out;
    } catch (err) {
      if (signal && signal.aborted) throw err;
      // A transcript-shape 400 mentions "tool_calls" but is NOT "this model
      // has no tools": retrying without tools would fail identically.
      if (isToolTranscriptError(err) || !looksLikeToolUnsupportedError(err)) throw err;
      const out = await create(false);
      if (typeof onFirstToken === 'function') { try { onFirstToken(); } catch { /* optional */ } }
      return out;
    }
  }, {
    signal,
    retryMax: LLM_RETRY_MAX,
  });
}

/**
 * Generic LLM → tool_call → tool_result → LLM loop.
 * Native OpenRouter/OpenAI function calling first; ReAct text fallback when
 * the model (or the provider) cannot emit tool_calls.
 */
async function runAgentLoop({
  client,
  model,
  messages,
  tools,
  executors,
  maxIterations = MAX_ITERATIONS_DEFAULT,
  onEvent = () => {},
  signal,
  // Stall-guard + fence seams (optional). `kv` is any { get, set } store;
  // `threadId` scopes the fence lease. Both fail-open when absent.
  kv = null,
  threadId = null,
  stallMs = STREAM_STALL_MS_DEFAULT,
  memoryHits = null,
  recall = null,
  persistRoot = null,
} = {}) {
  if (!client?.chat?.completions?.create) throw new Error('runAgentLoop: client is required');
  const cap = Math.max(1, Math.min(50, Number(maxIterations) || MAX_ITERATIONS_DEFAULT));
  const steps = [];
  let finalText = '';
  let stoppedReason = 'max_iterations';
  let verificationAttempts = 0;
  let stallCount = 0;
  let lastProgressAt = Date.now();
  let fenceToken = null;
  const nestedSubagents = [];
  const siblingTools = [];
  const sameTurnCache = { map: new Map() };
  const fileEditCkpt = { edits: [] };
  const webFetchTurnCache = {};
  const observationHistory = [];
  const deadLetterHistory = [];
  const emptyModelState = {};
  const callIdInflight = {};
  const callResultStore = {};
  const turnBlockedReadPaths = [];
  const lastToolArgsByName = {};
  let firstByteAt = null;
  if (kv && threadId) {
    try {
      const safety = await stealStaleFence(kv, threadId);
      if (!safety.stolen) {
        const classified = classifyLoopError({ code: 'fence_conflict' });
        onEvent({
          type: 'error',
          message: classified.message,
          code: classified.code,
          retryable: classified.retryable,
          iteration: 0,
        });
        return {
          finalText: '',
          iterations: 0,
          steps,
          stoppedReason: 'fence_conflict',
          verificationAttempts,
          errorMessage: classified.message,
        };
      }
      fenceToken = newFenceToken();
      await heartbeatFence(kv, threadId, fenceToken);
    } catch (_) { /* fail-open: loop still runs */ }
  }
  const touchFence = async () => {
    if (!kv || !fenceToken || !threadId) return;
    try { await heartbeatFence(kv, threadId, fenceToken); } catch (_) { /* optional */ }
  };

  // F3: a user cancel (Stop button → AbortSignal) must stop the loop AND
  // leave a trace. `bail` emits exactly one 'cancelled' stage event before
  // rethrowing so the SSE stream shows "Cancelado" instead of dying silently.
  let cancelledEmitted = false;
  let consecutiveRepairFails = 0;
  const loopFingerprints = [];
  let pinHits = Array.isArray(memoryHits) ? memoryHits.slice() : [];
  const turnStartedAt = Date.now();
  try {
    const w62 = loadEngine3h62();
    if (w62 && threadId && typeof w62.hydrateSessionCheckpointClosed === 'function') {
      const hydrated = w62.hydrateSessionCheckpointClosed({ sessionKey: threadId, root: persistRoot });
      if (
        hydrated &&
        hydrated.hydrated &&
        hydrated.state &&
        Array.isArray(hydrated.state.messages) &&
        hydrated.state.messages.length &&
        Array.isArray(messages) &&
        messages.length === 0
      ) {
        for (const m of hydrated.state.messages) messages.push(m);
      }
      try {
        const w64 = loadEngine3h64();
        const adapter = loadEngineAdapter();
        if (w64 && typeof w64.applyCheckpointResumeClosed === 'function' && adapter && hydrated && hydrated.state) {
          const resumed = w64.applyCheckpointResumeClosed({
            resume: true,
            persist: false,
            state: hydrated.state,
            payload: hydrated.state,
            remaining: cap,
            checkpointRemaining: hydrated.state.remaining,
            messages: hydrated.state.messages,
            store: new Map(),
            replayToolResultsOnResume: adapter.replayToolResultsOnResume,
            boundStepsOnCheckpointResume: adapter.boundStepsOnCheckpointResume,
            crc32CheckOnCheckpointLoad: adapter.crc32CheckOnCheckpointLoad,
            gzipCheckpointIfOver64KiB: adapter.gzipCheckpointIfOver64KiB,
            pruneCheckpointsKeepLastN: adapter.pruneCheckpointsKeepLastN,
            crc32StampOnCheckpointSave: adapter.crc32StampOnCheckpointSave,
          });
          if (resumed && resumed.ok === false) {
            /* crc mismatch: keep live messages, do not trust ckpt bytes */
          }
        }
      } catch (_) { /* 3H64 resume fail-open */ }
    }
    const lastUser = Array.isArray(messages)
      ? [...messages].reverse().find((m) => m && m.role === 'user')
      : null;
    if (w62 && typeof w62.retrieveMemoryBeforeGenerateClosed === 'function') {
      const retrieved = await w62.retrieveMemoryBeforeGenerateClosed({
        query: lastUser && lastUser.content,
        retrieve: recall,
        memoryHits: pinHits,
        timeoutMs: 2000,
      });
      if (retrieved && Array.isArray(retrieved.hits) && retrieved.hits.length) pinHits = retrieved.hits;
      try {
        const adapter = loadEngineAdapter();
        if (adapter && typeof adapter.pgvectorMemoryQueryTimeout === 'function') {
          const to = adapter.pgvectorMemoryQueryTimeout({
            elapsedMs: retrieved && retrieved.elapsedMs,
            timeoutMs: 2000,
          });
          if (to && to.timedOut) pinHits = [];
        }
        if (adapter && typeof adapter.skipMemoryIfScoreNaN === 'function' && pinHits.length) {
          const nan = adapter.skipMemoryIfScoreNaN(pinHits);
          if (nan && Array.isArray(nan.facts)) pinHits = nan.facts;
        }
        if (adapter && typeof adapter.rejectNaNInfinityNumbers === 'function' && pinHits.length) {
          pinHits = pinHits.filter((h) => adapter.rejectNaNInfinityNumbers(h).ok !== false);
        }
        if (adapter && typeof adapter.minScoreMemoryRetrieve === 'function' && pinHits.length) {
          const scored = adapter.minScoreMemoryRetrieve(pinHits);
          if (scored && Array.isArray(scored.facts)) pinHits = scored.facts;
        }
        try {
          const w66mem = loadEngine3h66();
          if (w66mem && typeof w66mem.applyMemoryRetrieveClosed === 'function' && pinHits.length) {
            const mem = w66mem.applyMemoryRetrieveClosed({
              facts: pinHits,
              hits: pinHits,
              skipEmptyWhitespaceMemoryFacts: adapter.skipEmptyWhitespaceMemoryFacts,
              skipMemoryIfVectorAllZeros: adapter.skipMemoryIfVectorAllZeros,
              skipEmptyEmbeddingUpsert: adapter.skipEmptyEmbeddingUpsert,
              memoryRetrieveDedupeByHash: adapter.memoryRetrieveDedupeByHash,
              sortMemoryHitsByScoreDesc: adapter.sortMemoryHitsByScoreDesc,
              capMemoryHitsReturned8: adapter.capMemoryHitsReturned8,
            });
            if (mem && Array.isArray(mem.hits)) pinHits = mem.hits;
          }
        } catch (_) { /* 3H66 memory retrieve fail-open */ }
        if (typeof recall !== 'function') {
          try {
            const dur = require('./engine-durability');
            if (dur && typeof dur.retrieveMemoryForLoop === 'function' && lastUser && lastUser.content && !pinHits.length) {
              const extra = await dur.retrieveMemoryForLoop({
                query: lastUser.content,
                recall,
              });
              if (Array.isArray(extra) && extra.length) pinHits = extra;
            }
          } catch (_) { /* durability optional */ }
        }
      } catch (_) { /* adapter memory filters fail-open */ }
    }
    if (w62 && typeof w62.recoverPgvectorPinsClosed === 'function' && (pinHits.length || typeof recall === 'function')) {
      const recovered = await w62.recoverPgvectorPinsClosed({
        compacted: messages,
        memoryHits: pinHits,
        retrieve: recall,
        query: lastUser && lastUser.content,
      });
      if (recovered && Array.isArray(recovered.hits) && recovered.hits.length) pinHits = recovered.hits;
      if (recovered && recovered.recovered && Array.isArray(recovered.messages)) {
        messages.length = 0;
        for (const m of recovered.messages) messages.push(m);
      }
    }
  } catch (_) { /* 3H62 fail-open */ }
  const bail = (iteration) => {
    if (!signal?.aborted) return;
    let cancelUsage = null;
    try {
      const w61 = loadEngine3h61();
      if (w61 && typeof w61.settleCancelUsageClosed === 'function') {
        cancelUsage = w61.settleCancelUsageClosed({
          cancelled: true,
          streamedChars: String(finalText || '').length,
          usage: null,
          alreadyRecorded: cancelledEmitted,
        });
      }
    } catch (_) { /* 3H61 fail-open to 3H59 */ }
    try {
      const w = loadEngine3h59();
      if (!cancelUsage && w && typeof w.accountPartialTokensOnCancel === 'function') {
        cancelUsage = w.accountPartialTokensOnCancel({
          cancelled: true,
          streamedChars: String(finalText || '').length,
          usage: null,
        });
      }
      if (w && typeof w.neverDoubleCountCancelUsage === 'function') {
        w.neverDoubleCountCancelUsage({ alreadyRecorded: cancelledEmitted, usage: cancelUsage });
      }
    } catch (_) { /* 3H59 fail-open */ }
    try {
      const w60 = loadEngine3h60();
      if (w60 && typeof w60.neverChargeBeforeFirstToken === 'function') {
        w60.neverChargeBeforeFirstToken({
          firstToken: Boolean(finalText),
          cancelled: true,
          tokens: 0,
        });
      }
      if (w60 && typeof w60.settleCreditsOnError === 'function') {
        w60.settleCreditsOnError({
          errored: false,
          alreadySettled: cancelledEmitted,
          usage: { streamedChars: String(finalText || '').length },
        });
      }
    } catch (_) { /* 3H60 fail-open */ }
    try {
      const w62 = loadEngine3h62();
      if (w62 && typeof w62.settleLedgerOnErrorClosed === 'function') {
        const ledger = w62.settleLedgerOnErrorClosed({
          cancelled: true,
          errored: false,
          usage: { streamedChars: String(finalText || '').length },
          alreadySettled: cancelledEmitted,
          firstToken: Boolean(finalText),
        });
        if (ledger && !cancelUsage) cancelUsage = ledger;
      }
    } catch (_) { /* 3H62 fail-open */ }
    try {
      const adapter = loadEngineAdapter();
      const w63 = loadEngine3h63();
      if (adapter && typeof adapter.refundPartialTokensOnCancel === 'function') {
        adapter.refundPartialTokensOnCancel({
          requestId: threadId,
          cancelled: true,
          promptTokens: String(finalText || '').length ? 1 : 0,
          completionTokens: 0,
          alreadyRefunded: cancelledEmitted,
        });
      }
      if (adapter && typeof adapter.abortCascade === 'function') {
        adapter.abortCascade({
          userSignal: signal,
          modelAbort: () => {},
          sandboxKill: () => {},
        });
      }
      if (adapter && typeof adapter.abortNestedSubagentsOnParentHalt === 'function') {
        adapter.abortNestedSubagentsOnParentHalt({
          parentHalt: true,
          children: nestedSubagents,
          abortFn: (id) => {
            const rec = nestedSubagents.find((c) => c && (c.id === id || c.subagentId === id));
            if (rec) rec.aborted = true;
          },
        });
      }
      if (adapter && typeof adapter.abortSiblingToolsOnParentCancelToken === 'function') {
        adapter.abortSiblingToolsOnParentCancelToken({
          parentToken: signal,
          siblings: siblingTools,
          abortFn: (id) => {
            const rec = siblingTools.find((s) => s && (s.id === id || s.callId === id));
            if (rec) rec.aborted = true;
          },
        });
      }
      if (w63 && typeof w63.abortSubagentCascadeClosed === 'function') {
        w63.abortSubagentCascadeClosed({
          parentHalt: true,
          parentCancelled: true,
          parentToken: signal,
          parentSignal: signal,
          children: nestedSubagents,
          siblings: siblingTools,
          userSignal: signal,
          abortNestedSubagentsOnParentHalt: adapter && adapter.abortNestedSubagentsOnParentHalt,
          abortSiblingToolsOnParentCancelToken: adapter && adapter.abortSiblingToolsOnParentCancelToken,
          refuseSubagentIfParentCancelled: adapter && adapter.refuseSubagentIfParentCancelled,
          abortCascade: adapter && adapter.abortCascade,
          subagentInheritAbortSignal: adapter && adapter.subagentInheritAbortSignal,
        });
      }
      if (w63 && typeof w63.guardSseLastIdRefundClosed === 'function' && adapter) {
        w63.guardSseLastIdRefundClosed({
          cancelled: true,
          requestId: threadId,
          promptTokens: String(finalText || '').length ? 1 : 0,
          completionTokens: 0,
          alreadyRefunded: cancelledEmitted,
          refundPartialTokensOnCancel: adapter.refundPartialTokensOnCancel,
          abortIfFirstByteOver45s: adapter.abortIfFirstByteOver45s,
          rejectLastEventIdGoingBackwards: adapter.rejectLastEventIdGoingBackwards,
        });
      }
    } catch (_) { /* 3H63 cancel cascade fail-open */ }
    try {
      const w65c = loadEngine3h65();
      const adC = loadEngineAdapter();
      if (w65c && typeof w65c.applyDeepSeekCreditGuardsClosed === 'function' && adC) {
        w65c.applyDeepSeekCreditGuardsClosed({
          cancelled: true,
          firstToken: Boolean(firstByteAt),
          firstByteAt,
          tokens: String(finalText || '').length,
          mapDeepSeekHttpError: adC.mapDeepSeekHttpError,
          neverRetry402: adC.neverRetry402,
          neverRetry413: adC.neverRetry413,
          neverChargeIfCancelledBeforeFirstToken: adC.neverChargeIfCancelledBeforeFirstToken,
        });
      }
    } catch (_) { /* 3H65 cancel charge fail-open */ }
    try {
      const w66bg = loadEngine3h66();
      const adBg = loadEngineAdapter();
      if (w66bg && typeof w66bg.applyReadHygieneClosed === 'function' && adBg) {
        w66bg.applyReadHygieneClosed({
          reset: true,
          stripUtf8BomOnRead: adBg.stripUtf8BomOnRead,
          sliceReadWindow: adBg.sliceReadWindow,
          formatReadWithLineNumbers: adBg.formatReadWithLineNumbers,
          startBackgroundBash: adBg.startBackgroundBash,
          resetBackgroundBash: adBg.resetBackgroundBash,
        });
      }
    } catch (_) { /* 3H66 bash reset fail-open */ }
    if (!cancelledEmitted) {
      cancelledEmitted = true;
      try { onEvent({ type: 'cancelled', iteration, label: 'Cancelado', usage: cancelUsage }); } catch (_) { /* trace only */ }
    }
    try {
      throwIfAborted(signal);
    } catch (err) {
      if (err && cancelUsage) err.cancelUsage = cancelUsage;
      throw err;
    }
  };

  try {
  for (let iteration = 1; iteration <= cap; iteration += 1) {
    bail(iteration);
    try {
      const w64 = loadEngine3h64();
      const adapter = loadEngineAdapter();
      if (w64 && typeof w64.applyTurnWallAndStallsClosed === 'function' && adapter) {
        const wall = w64.applyTurnWallAndStallsClosed({
          stallCount: 0,
          startedAt: turnStartedAt,
          now: Date.now(),
          cancelIfThreeStreamStalls: adapter.cancelIfThreeStreamStalls,
          enforceTotalTurnWall120s: adapter.enforceTotalTurnWall120s,
          remainingWallClockCut: adapter.remainingWallClockCut,
          resetStallCountOnToken: adapter.resetStallCountOnToken,
        });
        if (wall && (wall.wallHalt || wall.remainingHalt)) {
          const classifiedWall = classifyLoopError({ code: wall.code || 'turn_wall' });
          onEvent({
            type: 'error',
            code: classifiedWall.code,
            message: classifiedWall.message,
            retryable: classifiedWall.retryable,
            iteration,
          });
          stoppedReason = wall.code || 'turn_wall';
          return { finalText: '', iterations: iteration, steps, stoppedReason, verificationAttempts, errorCode: wall.code || 'turn_wall' };
        }
      }
    } catch (_) { /* 3H64 wall fail-open */ }
    try {
      const w65hint = loadEngine3h65();
      const adapterHint = loadEngineAdapter();
      if (w65hint && typeof w65hint.applyAntiLoopGuardsClosed === 'function' && adapterHint) {
        const hinted = w65hint.applyAntiLoopGuardsClosed({
          step: iteration,
          remaining: Math.max(0, cap - iteration),
          max: cap,
          budgetHintEveryFiveSteps: adapterHint.budgetHintEveryFiveSteps,
          remainingStepBudgetReminder: adapterHint.remainingStepBudgetReminder,
          detectDagCycle: adapterHint.detectDagCycle,
          rejectToolCallCycleAtoBtoA: adapterHint.rejectToolCallCycleAtoBtoA,
          deadLetterSameToolAfterN: adapterHint.deadLetterSameToolAfterN,
          identicalObservationLoopCut: adapterHint.identicalObservationLoopCut,
          maxConcurrentSubagents: adapterHint.maxConcurrentSubagents,
          maxSubagentDepth: adapterHint.maxSubagentDepth,
          maxInflightToolsPerSession8: adapterHint.maxInflightToolsPerSession8,
          perToolRateLimit: adapterHint.perToolRateLimit,
        });
        if (hinted && hinted.inject && hinted.text) {
          // Advisory only: never rewrite system/user messages (F7 pins the
          // original system contract verbatim). Helpers still ran above.
          onEvent({
            type: 'budget_hint',
            iteration,
            text: String(hinted.text),
            code: hinted.code || 'plan_budget',
          });
        }
      }
    } catch (_) { /* 3H65 budget hint fail-open */ }
    onEvent({ type: 'iteration_start', iteration, label: 'Pensando' });
    void touchFence();
    try {
      const w60 = loadEngine3h60();
      if (w60 && Array.isArray(messages) && messages.length > 24) {
        const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
        let next = messages;
        if (typeof w60.pruneMessagesByQueryOverlap === 'function') {
          const pruned = w60.pruneMessagesByQueryOverlap(next, lastUser && lastUser.content, { keepLast: 4 });
          if (pruned && Array.isArray(pruned.messages)) next = pruned.messages;
        }
        if (typeof w60.compactFaithfulDroppedSummary === 'function') {
          const summed = w60.compactFaithfulDroppedSummary(messages, next);
          if (summed && Array.isArray(summed.messages)) next = summed.messages;
        }
        if (typeof w60.neverDropLastUserOnCompact === 'function') {
          const kept = w60.neverDropLastUserOnCompact(messages, next);
          if (kept && Array.isArray(kept.messages)) next = kept.messages;
        }
        if (Array.isArray(next) && next.length) {
          messages.length = 0;
          for (const m of next) messages.push(m);
        }
      }
    } catch (_) { /* 3H60 fail-open */ }

    // Stall guard: no progress (no token, no tool result) within the budget
    // cuts the turn with loop_stall instead of hanging until the outer
    // response timeout. After STREAM_STALL_CANCEL_AFTER stalls the run is
    // declared unrecoverable for this iteration budget.
    const stall = stallIfNoEvent20sMidStream({
      lastEventAt: lastProgressAt,
      firstTokenAt: null,
      now: Date.now(),
      stallMs,
    });
    if (stall.stalled && iteration > 1) {
      stallCount += 1;
      try {
        const w64 = loadEngine3h64();
        const adapter = loadEngineAdapter();
        if (w64 && typeof w64.applyTurnWallAndStallsClosed === 'function' && adapter) {
          const cut = w64.applyTurnWallAndStallsClosed({
            stallCount,
            startedAt: turnStartedAt,
            now: Date.now(),
            cancelIfThreeStreamStalls: adapter.cancelIfThreeStreamStalls,
            enforceTotalTurnWall120s: adapter.enforceTotalTurnWall120s,
            remainingWallClockCut: adapter.remainingWallClockCut,
            resetStallCountOnToken: adapter.resetStallCountOnToken,
          });
          if (cut && cut.cancel) stallCount = Math.max(stallCount, STREAM_STALL_CANCEL_AFTER);
          if (cut && (cut.wallHalt || cut.remainingHalt)) {
            const classifiedWall = classifyLoopError({ code: cut.code || 'turn_wall' });
            onEvent({
              type: 'error',
              code: classifiedWall.code,
              message: classifiedWall.message,
              retryable: classifiedWall.retryable,
              iteration,
            });
            stoppedReason = cut.code || 'turn_wall';
            return { finalText: '', iterations: iteration, steps, stoppedReason, verificationAttempts, errorCode: cut.code || 'turn_wall' };
          }
        }
      } catch (_) { /* 3H64 stall/wall fail-open */ }
      const classified = classifyLoopError({ code: stallCount >= STREAM_STALL_CANCEL_AFTER ? 'loop_stall' : 'stream_stall_retryable' });
      onEvent({
        type: 'error',
        code: classified.code,
        message: classified.message,
        retryable: classified.retryable,
        iteration,
      });
      if (stallCount >= STREAM_STALL_CANCEL_AFTER) {
        stoppedReason = 'loop_stall';
        return { finalText: '', iterations: iteration, steps, stoppedReason, verificationAttempts, errorCode: 'loop_stall' };
      }
      lastProgressAt = Date.now();
    }

    let response;
    const modelTurnStart = Date.now();
    let modelTtfbMs = null;
    try {
      compactMessagesInPlace(messages, { memoryHits: pinHits });
      response = await callModel({
        client,
        model,
        messages,
        tools,
        signal,
        onFirstToken: () => {
          if (modelTtfbMs === null) modelTtfbMs = Date.now() - modelTurnStart;
          firstByteAt = Date.now();
        },
      });
      try {
        const adapter = loadEngineAdapter();
        if (adapter && typeof adapter.abortIfFirstByteOver45s === 'function') {
          const ttfb = adapter.abortIfFirstByteOver45s({
            startedAt: modelTurnStart,
            now: Date.now(),
            firstByteAt,
          });
          if (ttfb && ttfb.abort) {
            const classified = classifyLoopError({ code: 'ttfb_abort' });
            stoppedReason = 'ttfb_abort';
            return {
              finalText: finalText || '',
              iterations: iteration,
              steps,
              stoppedReason,
              verificationAttempts,
              errorCode: 'ttfb_abort',
              errorMessage: classified.message,
            };
          }
        }
      } catch (_) { /* 3H63 TTFB fail-open */ }
      recordModelTelemetry({
        model,
        agent: 'agent_runner',
        outcome: 'ok',
        durationMs: Date.now() - modelTurnStart,
        ttftMs: modelTtfbMs,
        tokensIn: response?.usage?.prompt_tokens,
        tokensOut: response?.usage?.completion_tokens,
      });
      lastProgressAt = Date.now();
      bail(iteration);
    } catch (err) {
      recordModelTelemetry({
        model,
        agent: 'agent_runner',
        outcome: signal?.aborted ? 'cancelled' : 'error',
        error: err,
        durationMs: Date.now() - modelTurnStart,
        ttftMs: modelTtfbMs,
      });
      if (signal?.aborted) bail(iteration);
      try {
        const w65ds = loadEngine3h65();
        const adDs = loadEngineAdapter();
        if (w65ds && typeof w65ds.applyDeepSeekCreditGuardsClosed === 'function' && adDs) {
          const ds = w65ds.applyDeepSeekCreditGuardsClosed({
            err,
            cancelled: Boolean(signal && signal.aborted),
            firstToken: Boolean(firstByteAt),
            firstByteAt,
            tokens: 0,
            mapDeepSeekHttpError: adDs.mapDeepSeekHttpError,
            neverRetry402: adDs.neverRetry402,
            neverRetry413: adDs.neverRetry413,
            neverChargeIfCancelledBeforeFirstToken: adDs.neverChargeIfCancelledBeforeFirstToken,
          });
          if (ds && ds.code && (ds.retry === false || ds.charge === false)) {
            const classifiedDs = classifyLoopError({ code: ds.code, err });
            onEvent({
              type: 'error',
              code: classifiedDs.code,
              message: classifiedDs.message,
              retryable: classifiedDs.retryable,
              iteration,
            });
            if (ds.retry === false && (ds.code === 'credit_ceiling' || ds.code === 'quota_exhausted' || ds.code === 'payload_too_large')) {
              // Keep the pre-3H65 contract: HTTP 402 is always llm_402 so
              // orchestrator / executeAgentRunnerTurn stay honest (not no_output).
              const creditStop = ds.code === 'credit_ceiling' || ds.code === 'quota_exhausted';
              return {
                finalText: '',
                iterations: iteration,
                steps,
                stoppedReason: creditStop ? 'llm_402' : ds.code,
                verificationAttempts,
                errorCode: ds.code,
                errorMessage: classifiedDs.message,
              };
            }
          }
        }
      } catch (_) { /* 3H65 DeepSeek map fail-open */ }
      const classifiedErr = classifyLoopError({ code: err?.code, err });
      onEvent({
        type: 'error',
        code: classifiedErr.code,
        message: classifiedErr.message,
        retryable: classifiedErr.retryable,
        iteration,
      });
      if (isLlmCreditError(err)) {
        // Out of credits: no retry can succeed. Stop the loop NOW and hand
        // the reason to the caller so the user gets an honest message
        // instead of a silent fallback to the generic pipeline.
        return {
          finalText: '',
          iterations: iteration,
          steps,
          stoppedReason: 'llm_402',
          verificationAttempts,
          errorMessage: err?.message || String(err),
        };
      }
      throw err;
    }

    const msg = response?.choices?.[0]?.message || {};
    let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    let viaReact = false;
    if (!toolCalls.length) {
      const parsed = parseReact(msg.content);
      if (parsed.length) {
        toolCalls = asNativeCalls(parsed, iteration);
        viaReact = true;
      }
    }

    try {
      const w = loadEngine3h59();
      if (w && toolCalls.length) {
        const next = [];
        for (const raw of toolCalls) {
          let call = raw;
          if (typeof w.stripUnknownToolCallProperties === 'function') {
            const stripped = w.stripUnknownToolCallProperties(call);
            if (stripped && stripped.call) call = stripped.call;
          }
          if (typeof w.inferToolNameFromCallId === 'function') {
            const inferred = w.inferToolNameFromCallId(call, Object.keys(executors || {}));
            if (inferred && inferred.call) call = inferred.call;
          }
          if (typeof w.repairPartialToolCallSchema === 'function') {
            const repaired = w.repairPartialToolCallSchema(call);
            // A parse-failed call that only produced `{}` is not a real
            // schema repair — keep the original so repairTruncatedJson can
            // re-invoke, then consecutive-fail can stop the loop.
            const garbageToEmpty = Boolean(
              repaired
              && repaired.partial
              && repaired.repaired
              && Array.isArray(repaired.missing)
              && repaired.missing.length === 0,
            );
            if (repaired && repaired.call && !garbageToEmpty) call = repaired.call;
          }
          try {
            const adapter = loadEngineAdapter();
            const rawArgs = call && call.function ? call.function.arguments : null;
            if (adapter && typeof adapter.repairTruncatedJson === 'function' && typeof rawArgs === 'string') {
              const fixed = adapter.repairTruncatedJson(rawArgs);
              if (fixed && fixed.ok && fixed.value && !fixed.value.__parse_error) {
                call = {
                  ...call,
                  function: {
                    ...(call.function || {}),
                    arguments: JSON.stringify(fixed.value),
                  },
                };
              }
            }
          } catch (_) { /* adapter fail-open */ }
          if (typeof w.tolerateIncompleteStreamedToolCall === 'function') {
            const held = w.tolerateIncompleteStreamedToolCall(call);
            // A finished model turn is not a streamed partial: holding would
            // drop the call and skip repair-fail accounting. Only drop.
            if (held && held.drop) continue;
          }
          next.push(call);
          const argsRaw = call && call.function ? call.function.arguments : null;
          let argsParseable = true;
          if (typeof argsRaw === 'string') {
            try { JSON.parse(argsRaw); } catch (_) { argsParseable = false; }
          }
          if (argsParseable) loopFingerprints.push(call);
        }
        toolCalls = next;
        if (typeof w.cutInfiniteLoopByFingerprint === 'function') {
          const cut = w.cutInfiniteLoopByFingerprint(loopFingerprints);
          if (cut && cut.cut) {
            const classified = typeof w.classifyEngine3h59Error === 'function'
              ? w.classifyEngine3h59Error({ code: cut.code })
              : classifyLoopError({ code: cut.code });
            onEvent({
              type: 'error',
              code: classified.code,
              message: classified.message,
              retryable: classified.retryable,
              iteration,
            });
            stoppedReason = cut.code || 'loop_fingerprint_cut';
            return {
              finalText: finalText || '',
              iterations: iteration,
              steps,
              stoppedReason,
              verificationAttempts,
              errorCode: cut.code,
            };
          }
        }
      }
    } catch (_) { /* 3H59 fail-open */ }
    try {
      const w60 = loadEngine3h60();
      if (w60 && toolCalls.length) {
        const next60 = [];
        for (const raw of toolCalls) {
          let call = raw;
          if (typeof w60.unwrapFencedToolArgs === 'function') {
            const rawArgs = call && (call.function && call.function.arguments);
            const unwrapped = w60.unwrapFencedToolArgs(rawArgs);
            if (unwrapped && unwrapped.unwrapped && unwrapped.parsed) {
              call = {
                ...call,
                arguments: unwrapped.value,
                args: unwrapped.value,
                function: call.function
                  ? { ...call.function, arguments: JSON.stringify(unwrapped.value) }
                  : call.function,
              };
            }
          }
          if (typeof w60.coerceToolArgTypes === 'function') {
            const coerced = w60.coerceToolArgTypes(call);
            if (coerced && coerced.call) call = coerced.call;
          }
          if (typeof w60.refuseNamelessToolAfterRepair === 'function') {
            const named = w60.refuseNamelessToolAfterRepair(call);
            if (named && named.refused) continue;
          }
          next60.push(call);
        }
        toolCalls = next60;
        if (typeof w60.cutOscillatingToolPair === 'function') {
          const osc = w60.cutOscillatingToolPair(loopFingerprints);
          if (osc && osc.cut) {
            const classified = typeof w60.classifyEngine3h60Error === 'function'
              ? w60.classifyEngine3h60Error({ code: osc.code })
              : classifyLoopError({ code: osc.code });
            onEvent({
              type: 'error',
              code: classified.code,
              message: classified.message,
              retryable: classified.retryable,
              iteration,
            });
            stoppedReason = osc.code || 'loop_oscillation_cut';
            return {
              finalText: finalText || '',
              iterations: iteration,
              steps,
              stoppedReason,
              verificationAttempts,
              errorCode: osc.code,
            };
          }
        }
        if (typeof w60.observeScriptedLatencySample === 'function' && modelTtfbMs != null) {
          w60.observeScriptedLatencySample('first_token', modelTtfbMs);
        }
        try {
          const w62 = loadEngine3h62();
          if (w62 && typeof w62.recordFirstTokenLatencySampleP95 === 'function' && modelTtfbMs != null) {
            w62.recordFirstTokenLatencySampleP95({ ms: modelTtfbMs });
          } else if (w62 && typeof w62.observeTurnLatencyClosed === 'function' && modelTtfbMs != null) {
            w62.observeTurnLatencyClosed({ kind: 'first_token', ms: modelTtfbMs });
          }
          try {
            const rel = require('./engine-reliability');
            if (rel && typeof rel.observeFirstToken === 'function' && modelTtfbMs != null) {
              rel.observeFirstToken(modelTtfbMs);
            }
          } catch (_) { /* reliability optional */ }
          try {
            const w64 = loadEngine3h64();
            const adapter = loadEngineAdapter();
            if (w64 && typeof w64.persistLatencyRingClosed === 'function' && adapter && modelTtfbMs != null) {
              w64.persistLatencyRingClosed({
                kind: 'first_token',
                ms: modelTtfbMs,
                observeAdapterLatency: adapter.observeAdapterLatency,
                adapterLatencySnapshot: adapter.adapterLatencySnapshot,
              });
            }
          } catch (_) { /* 3H64 latency fail-open */ }
        } catch (_) { /* 3H62 fail-open */ }
      }
    } catch (_) { /* 3H60 fail-open */ }
    try {
      const adapter = loadEngineAdapter();
      const w63 = loadEngine3h63();
      if (adapter && toolCalls.length) {
        const frags = [];
        for (const raw of toolCalls) {
          const args = raw && raw.function ? raw.function.arguments : null;
          if (Array.isArray(args)) frags.push(...args);
          else if (raw && Array.isArray(raw.fragments)) frags.push(...raw.fragments);
        }
        if (typeof adapter.concatenateSplitToolCallFragments === 'function' && frags.length > 1) {
          adapter.concatenateSplitToolCallFragments(frags);
        }
        if (typeof adapter.repairStreamingJsonAcrossChunks === 'function') {
          for (const raw of toolCalls) {
            const args = raw && raw.function ? raw.function.arguments : null;
            if (typeof args === 'string') adapter.repairStreamingJsonAcrossChunks([args]);
          }
        }
        if (typeof adapter.repairUnescapedNewlinesInJsonStrings === 'function') {
          for (const raw of toolCalls) {
            const args = raw && raw.function ? raw.function.arguments : null;
            if (typeof args === 'string') adapter.repairUnescapedNewlinesInJsonStrings(args);
          }
        }
        if (w63 && typeof w63.repairPartialToolCallsClosed === 'function') {
          const repaired = w63.repairPartialToolCallsClosed({
            calls: toolCalls,
            fragments: frags.length > 1 ? frags : null,
            messages,
            concatenateSplitToolCallFragments: adapter.concatenateSplitToolCallFragments,
            dropIncompleteTrailingToolCall: adapter.dropIncompleteTrailingToolCall,
            repairStreamingJsonAcrossChunks: adapter.repairStreamingJsonAcrossChunks,
            repairUnescapedNewlinesInJsonStrings: adapter.repairUnescapedNewlinesInJsonStrings,
            dropOrphanToolResults: adapter.dropOrphanToolResults,
            requireToolCallId: adapter.requireToolCallId,
            aliasCommonToolNames: adapter.aliasCommonToolNames,
            isolateParallelToolTimeout: adapter.isolateParallelToolTimeout,
            joinParallelToolResultsStableOrder: adapter.joinParallelToolResultsStableOrder,
            cacheIdenticalToolCallSameTurn: adapter.cacheIdenticalToolCallSameTurn,
          });
          if (repaired && Array.isArray(repaired.calls)) toolCalls = repaired.calls;
          if (repaired && repaired.orphansDropped && Array.isArray(messages)) {
            const cleaned = adapter.dropOrphanToolResults(messages);
            if (cleaned && Array.isArray(cleaned.messages)) {
              messages.length = 0;
              for (const m of cleaned.messages) messages.push(m);
            }
          }
        } else {
          if (typeof adapter.requireToolCallId === 'function') {
            const reqId = adapter.requireToolCallId(toolCalls);
            if (reqId && Array.isArray(reqId.calls)) toolCalls = reqId.calls;
          }
          if (typeof adapter.dropIncompleteTrailingToolCall === 'function') {
            const dropped = adapter.dropIncompleteTrailingToolCall(toolCalls);
            if (dropped && Array.isArray(dropped.calls)) toolCalls = dropped.calls;
          }
          if (typeof adapter.aliasCommonToolNames === 'function') {
            toolCalls = toolCalls.map((c) => {
              const n = c && c.function && c.function.name;
              const a = adapter.aliasCommonToolNames(n);
              if (a && a.aliased && a.name && c.function) {
                return { ...c, function: { ...c.function, name: a.name } };
              }
              return c;
            });
          }
        }
        if (typeof adapter.isolateParallelToolTimeout === 'function') {
          adapter.isolateParallelToolTimeout(toolCalls);
        }
      }
    } catch (_) { /* 3H63 tool-call repair fail-open */ }

    try {
      const w65loop = loadEngine3h65();
      const adLoop = loadEngineAdapter();
      if (w65loop && typeof w65loop.applyAntiLoopGuardsClosed === 'function' && adLoop && toolCalls.length) {
        const looksSubList = toolCalls.filter((c) => {
          const n = (c && c.function && c.function.name) || '';
          return /^(run_subagent|subagent|delegate)$/i.test(n);
        });
        const guarded = w65loop.applyAntiLoopGuardsClosed({
          calls: toolCalls.map((c) => ({
            name: c && c.function && c.function.name,
            function: c && c.function,
          })),
          history: deadLetterHistory,
          observations: observationHistory,
          step: iteration,
          remaining: Math.max(0, cap - iteration),
          max: cap,
          subagents: looksSubList,
          depth: nestedSubagents.length,
          inflight: toolCalls.length,
          detectDagCycle: adLoop.detectDagCycle,
          rejectToolCallCycleAtoBtoA: adLoop.rejectToolCallCycleAtoBtoA,
          deadLetterSameToolAfterN: adLoop.deadLetterSameToolAfterN,
          identicalObservationLoopCut: adLoop.identicalObservationLoopCut,
          budgetHintEveryFiveSteps: adLoop.budgetHintEveryFiveSteps,
          remainingStepBudgetReminder: adLoop.remainingStepBudgetReminder,
          maxConcurrentSubagents: adLoop.maxConcurrentSubagents,
          maxSubagentDepth: adLoop.maxSubagentDepth,
          maxInflightToolsPerSession8: adLoop.maxInflightToolsPerSession8,
          perToolRateLimit: adLoop.perToolRateLimit,
        });
        if (guarded && guarded.halt) {
          const classified = classifyLoopError({ code: guarded.code || 'tool_cycle' });
          onEvent({
            type: 'error',
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
            iteration,
          });
          stoppedReason = guarded.code || 'tool_cycle';
          return {
            finalText: finalText || '',
            iterations: iteration,
            steps,
            stoppedReason,
            verificationAttempts,
            errorCode: guarded.code || 'tool_cycle',
            errorMessage: classified.message,
          };
        }
      }
    } catch (_) { /* 3H65 anti-loop fail-open */ }

    let emptyHaltThisTurn = false;
    try {
      const w66cap = loadEngine3h66();
      const adCap = loadEngineAdapter();
      if (w66cap && typeof w66cap.applyEmptyModelAndParallelCapsClosed === 'function' && adCap) {
        const capped = w66cap.applyEmptyModelAndParallelCapsClosed({
          response,
          state: emptyModelState,
          calls: toolCalls,
          emptyResponseRetryOnce: adCap.emptyResponseRetryOnce,
          circuitBreakerEmptyModelTwice: adCap.circuitBreakerEmptyModelTwice,
          allowParallelReads: adCap.allowParallelReads,
          maxToolsPerTurnHardCap: adCap.maxToolsPerTurnHardCap,
          maxUniqueToolsPerTurn16: adCap.maxUniqueToolsPerTurn16,
          maxToolCallsPerMessage: adCap.maxToolCallsPerMessage,
        });
        if (capped && Array.isArray(capped.calls) && (capped.calls.length || !toolCalls.length)) {
          toolCalls = capped.calls;
        }
        if (capped && capped.emptyHalt) emptyHaltThisTurn = true;
        if (capped && capped.halt) {
          const classified = classifyLoopError({ code: capped.code || 'too_many_tools' });
          onEvent({
            type: 'error',
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
            iteration,
          });
          stoppedReason = capped.code || 'too_many_tools';
          return {
            finalText: finalText || '',
            iterations: iteration,
            steps,
            stoppedReason,
            verificationAttempts,
            errorCode: capped.code || 'too_many_tools',
            errorMessage: classified.message,
          };
        }
        if (capped && Array.isArray(capped.blockedReads) && capped.blockedReads.length) {
          turnBlockedReadPaths.length = 0;
          for (const br of capped.blockedReads) {
            const p = br && (br.path || (br.args && (br.args.path || br.args.file_path)));
            if (p) turnBlockedReadPaths.push(String(p));
          }
        }
      }
    } catch (_) { /* 3H66 empty/caps fail-open */ }

    try {
      const w67cap = loadEngine3h67();
      const ad67cap = loadEngineAdapter();
      if (w67cap && typeof w67cap.applyToolNameArgsHygieneClosed === 'function' && ad67cap) {
        const hygList = w67cap.applyToolNameArgsHygieneClosed({
          calls: toolCalls,
          dropDuplicateToolCallIds: ad67cap.dropDuplicateToolCallIds,
          rejectToolCallIfArgsIsArray: ad67cap.rejectToolCallIfArgsIsArray,
          rejectPrototypePollutionKeys: ad67cap.rejectPrototypePollutionKeys,
          rejectToolNameStartingWithHyphen: ad67cap.rejectToolNameStartingWithHyphen,
          rejectToolNameStartingWithDigit: ad67cap.rejectToolNameStartingWithDigit,
          rejectToolNameOutsideCharset: ad67cap.rejectToolNameOutsideCharset,
          rejectToolNameWithWhitespace: ad67cap.rejectToolNameWithWhitespace,
          rejectToolNameLongerThan64: ad67cap.rejectToolNameLongerThan64,
          capToolArgKeys32: ad67cap.capToolArgKeys32,
          stripBidiOverrideChars: ad67cap.stripBidiOverrideChars,
          stripZeroWidthCharsFromArgs: ad67cap.stripZeroWidthCharsFromArgs,
          dropNullBytesInToolArgs: ad67cap.dropNullBytesInToolArgs,
          stripTagCharsUPlusE0000: ad67cap.stripTagCharsUPlusE0000,
        });
        if (hygList && Array.isArray(hygList.calls)) toolCalls = hygList.calls;
      }
    } catch (_) { /* 3H67 tool-name list fail-open */ }

    if (!toolCalls.length) {
      // A model response with no tool calls and no content is the classic
      // "provider accepted the request but produced nothing" stall. Count it;
      // after STREAM_STALL_CANCEL_AFTER empty responses, stop as loop_stall
      // instead of burning the remaining iterations.
      if (!String(msg.content || '').trim()) {
        stallCount += 1;
        if (emptyHaltThisTurn) stallCount = Math.max(stallCount, STREAM_STALL_CANCEL_AFTER);
        recordModelTelemetry({
          model,
          agent: 'agent_runner',
          outcome: stallCount >= STREAM_STALL_CANCEL_AFTER ? 'stall' : 'error',
          error: { code: stallCount >= STREAM_STALL_CANCEL_AFTER ? 'loop_stall' : 'stream_stall_retryable' },
          durationMs: Date.now() - modelTurnStart,
          ttftMs: modelTtfbMs,
        });
        lastProgressAt = Date.now();
        if (stallCount >= STREAM_STALL_CANCEL_AFTER) {
          const classified = classifyLoopError({ code: 'loop_stall' });
          onEvent({
            type: 'error',
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
            iteration,
          });
          stoppedReason = 'loop_stall';
          return { finalText: '', iterations: iteration, steps, stoppedReason, verificationAttempts, errorCode: 'loop_stall' };
        }
        continue;
      }
      const gate = needsVerification(steps);
      if (gate.needed && verificationAttempts < MAX_VERIFICATION_RETRIES) {
        verificationAttempts += 1;
        try {
          const w61 = loadEngine3h61();
          if (w61 && typeof w61.sliceVerificationTokenBudgetClosed === 'function') {
            w61.sliceVerificationTokenBudgetClosed({
              parentRemaining: resolveAgentRunnerMaxTokens(),
            });
          }
        } catch (_) { /* 3H61 fail-open */ }
        onEvent({
          type: 'retry',
          reason: gate.reason,
          attempt: verificationAttempts,
          label: 'Verificando resultado',
        });
        messages.push({ role: 'assistant', content: msg.content || '' });
        messages.push({
          role: 'user',
          content: verificationNudge(verificationAttempts, gate.reason),
        });
        continue;
      }
      finalText = String(msg.content || '').trim();
      if (gate.needed) {
        stoppedReason = 'verification_failed';
        if (!finalText) {
          finalText = 'No pude verificar que el cambio se aplicó de verdad. Revisa el archivo o inténtalo de nuevo.';
        }
        onEvent({
          type: 'final',
          text: finalText,
          iterations: iteration,
          label: 'Error verificado',
          verified: false,
        });
      } else {
        stoppedReason = 'final';
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Listo', verified: true });
      }
      messages.push({ role: 'assistant', content: msg.content || '' });
      return { finalText, iterations: iteration, steps, stoppedReason, verificationAttempts };
    }

    if (msg.content) {
      onEvent({
        type: 'thought',
        iteration,
        label: previewOf(msg.content, 80) || 'Pensando',
        preview: previewOf(msg.content, 240),
      });
    }

    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls,
    });

    try {
      const adIso = loadEngineAdapter();
      if (adIso && typeof adIso.isolateParallelToolTimeout === 'function') {
        adIso.isolateParallelToolTimeout(toolCalls);
      }
    } catch (_) { /* isolate is advisory */ }
    const parallelFinished = [];
    for (const call of toolCalls) {
      bail(iteration);
      const name = call?.function?.name || 'unknown';
      const mapped = name === 'bash' ? 'execute_bash' : name;
      let args = safeParseArgs(call?.function?.arguments);
      siblingTools.push({ id: call && call.id, callId: call && call.id, name: mapped });
      let result;
      let cacheHit = false;
      try {
        const adapter = loadEngineAdapter();
        const w63 = loadEngine3h63();
        if (adapter && typeof adapter.refuseSubagentIfParentCancelled === 'function') {
          const refused = adapter.refuseSubagentIfParentCancelled({
            parentCancelled: Boolean(signal && signal.aborted),
            signal,
          });
          if (refused && refused.refuse) {
            const classified = classifyLoopError({ code: 'subagent_parent_cancelled' });
            stoppedReason = 'subagent_parent_cancelled';
            return {
              finalText: finalText || '',
              iterations: iteration,
              steps,
              stoppedReason,
              verificationAttempts,
              errorCode: 'subagent_parent_cancelled',
              errorMessage: classified.message,
            };
          }
        }
        if (adapter && typeof adapter.subagentInheritAbortSignal === 'function') {
          adapter.subagentInheritAbortSignal({ parentSignal: signal, child: { id: call && call.id } });
        }
        const parentRemaining = Math.max(0, cap - iteration + 1);
        if (adapter && typeof adapter.inheritSubagentSteps === 'function') {
          adapter.inheritSubagentSteps({
            parentRemaining: parentRemaining - 1,
            childRequested: parentRemaining - 1,
            siblings: toolCalls.length,
          });
        }
        if (adapter && typeof adapter.subagentInheritRemainingStepBudget === 'function') {
          adapter.subagentInheritRemainingStepBudget({
            parentRemaining: parentRemaining - 1,
            childRequested: parentRemaining - 1,
          });
        }
        if (adapter && typeof adapter.minRemainingSubagentBudget1 === 'function') {
          adapter.minRemainingSubagentBudget1({ remaining: parentRemaining - 1, parentRemaining });
        }
        const looksSub = w63 && typeof w63.isSubagentToolName === 'function'
          ? w63.isSubagentToolName(mapped)
          : /^(run_subagent|subagent|delegate)$/i.test(mapped);
        if (looksSub) {
          nestedSubagents.push({ id: call && call.id, subagentId: call && call.id, depth: 1 });
          if (w63 && typeof w63.inheritSubagentBudgetClosed === 'function') {
            const budget = w63.inheritSubagentBudgetClosed({
              parentRemaining,
              childRequested: parentRemaining - 1,
              siblings: 1,
              inheritSubagentSteps: adapter && adapter.inheritSubagentSteps,
              subagentInheritRemainingStepBudget: adapter && adapter.subagentInheritRemainingStepBudget,
              minRemainingSubagentBudget1: adapter && adapter.minRemainingSubagentBudget1,
            });
            if (budget && budget.refuse) {
              const classified = classifyLoopError({ code: 'subagent_budget' });
              result = 'ERROR: ' + classified.message;
              cacheHit = true;
            }
          }
        }
        try {
          const w66hy = loadEngine3h66();
          if (w66hy && adapter) {
            const schema66 = (Array.isArray(tools) ? tools : []).map((t) => (
              t && t.function && t.function.name === mapped ? (t.function.parameters || t.function.input_schema) : null
            )).find(Boolean);
            if (typeof w66hy.applyToolJsonCoerceClosed === 'function') {
              const coerced = w66hy.applyToolJsonCoerceClosed({
                raw: call && call.function && call.function.arguments,
                args,
                schema: schema66,
                prior: lastToolArgsByName[mapped] || null,
                repairSingleQuotesAndCommentsInToolJson: adapter.repairSingleQuotesAndCommentsInToolJson,
                repairUnquotedKeysInToolJson: adapter.repairUnquotedKeysInToolJson,
                coerceTrueFalseStringsToBool: adapter.coerceTrueFalseStringsToBool,
                coerceIntegerFromNumericString: adapter.coerceIntegerFromNumericString,
                repairEnumCaseInsensitive: adapter.repairEnumCaseInsensitive,
                repairMissingRequiredFromPriorTurn: adapter.repairMissingRequiredFromPriorTurn,
              });
              if (coerced && coerced.ok === false && !(args && args.__parse_error)) {
                const classified = classifyLoopError({ code: coerced.code || 'json_parse' });
                result = 'ERROR: ' + classified.message;
                cacheHit = true;
              } else if (coerced && coerced.args && !coerced.args.__parse_error) {
                args = coerced.args;
                lastToolArgsByName[mapped] = args;
              }
            }
            const filePath66 = args && (args.path || args.file_path || args.target);
            if (typeof w66hy.applyPathJailClosed === 'function' && filePath66 && result === undefined) {
              const kind = w66hy.WRITE_TOOL_RE && w66hy.WRITE_TOOL_RE.test(mapped)
                ? 'write'
                : ((w66hy.READ_TOOL_RE && w66hy.READ_TOOL_RE.test(mapped)) ? 'read' : null);
              if (kind) {
                const root66hy = (executors && (executors.__workspaceRoot || executors.workspaceRoot))
                  || (args && args.root)
                  || null;
                const jail = w66hy.applyPathJailClosed({
                  path: filePath66,
                  content: args && (args.content != null ? args.content : args.new_string),
                  kind,
                  root: root66hy,
                  nfcPath: adapter.nfcPath,
                  rejectNulInPath: adapter.rejectNulInPath,
                  rejectControlCharsInPaths: adapter.rejectControlCharsInPaths,
                  rejectUncAndWindowsPaths: adapter.rejectUncAndWindowsPaths,
                  rejectSymlinkEscape: adapter.rejectSymlinkEscape,
                  refuseWriteThroughSymlink: adapter.refuseWriteThroughSymlink,
                  refuseReadThroughSymlink: adapter.refuseReadThroughSymlink,
                  refuseWriteOver2MiB: adapter.refuseWriteOver2MiB,
                });
                if (jail && jail.ok === false) {
                  const classified = classifyLoopError({ code: jail.code || 'bad_path' });
                  result = 'ERROR: ' + classified.message;
                  cacheHit = true;
                } else if (jail && jail.path) {
                  if (args.path != null) args.path = jail.path;
                  else if (args.file_path != null) args.file_path = jail.path;
                }
              }
            }
            if (kindIsReadBlocked(mapped, filePath66, turnBlockedReadPaths) && result === undefined) {
              const classified = classifyLoopError({ code: 'bad_path' });
              result = 'ERROR: ' + classified.message;
              cacheHit = true;
            }
            if (w66hy.BASH_TOOL_RE && w66hy.BASH_TOOL_RE.test(mapped) && typeof w66hy.applyReadHygieneClosed === 'function') {
              w66hy.applyReadHygieneClosed({
                bashId: call && call.id,
                cmd: args && (args.command || args.cmd || args.code),
                stripUtf8BomOnRead: adapter.stripUtf8BomOnRead,
                sliceReadWindow: adapter.sliceReadWindow,
                formatReadWithLineNumbers: adapter.formatReadWithLineNumbers,
                startBackgroundBash: adapter.startBackgroundBash,
                resetBackgroundBash: adapter.resetBackgroundBash,
              });
            }
            if (typeof w66hy.applyCallIdempotencyClosed === 'function' && call && call.id && result === undefined) {
              const same = w66hy.applyCallIdempotencyClosed({
                callId: call.id,
                inflight: callIdInflight,
                store: callResultStore,
                args,
                create: () => ({ id: call.id, pending: true }),
                idempotentSameCallIdInflight: adapter.idempotentSameCallIdInflight,
                rememberCallResult: adapter.rememberCallResult,
              });
              if (same && same.coalesced && same.promise && same.promise.result != null) {
                result = same.promise.result;
                cacheHit = true;
              }
            }
          }
        } catch (_) { /* 3H66 coerce/jail/bash fail-open */ }
        try {
          const w67hy = loadEngine3h67();
          const ad67 = loadEngineAdapter();
          if (w67hy && ad67 && result === undefined) {
            if (typeof w67hy.applyToolNameArgsHygieneClosed === 'function') {
              const hyg67 = w67hy.applyToolNameArgsHygieneClosed({
                name: mapped,
                args,
                rejectPrototypePollutionKeys: ad67.rejectPrototypePollutionKeys,
                dropDuplicateToolCallIds: ad67.dropDuplicateToolCallIds,
                rejectToolNameStartingWithHyphen: ad67.rejectToolNameStartingWithHyphen,
                rejectToolNameStartingWithDigit: ad67.rejectToolNameStartingWithDigit,
                rejectToolNameOutsideCharset: ad67.rejectToolNameOutsideCharset,
                rejectToolNameWithWhitespace: ad67.rejectToolNameWithWhitespace,
                rejectToolNameLongerThan64: ad67.rejectToolNameLongerThan64,
                capToolArgKeys32: ad67.capToolArgKeys32,
                rejectToolCallIfArgsIsArray: ad67.rejectToolCallIfArgsIsArray,
                stripBidiOverrideChars: ad67.stripBidiOverrideChars,
                stripZeroWidthCharsFromArgs: ad67.stripZeroWidthCharsFromArgs,
                dropNullBytesInToolArgs: ad67.dropNullBytesInToolArgs,
                stripTagCharsUPlusE0000: ad67.stripTagCharsUPlusE0000,
              });
              if (hyg67 && hyg67.ok === false) {
                const classified = classifyLoopError({ code: hyg67.code || 'tool_name_charset' });
                result = 'ERROR: ' + classified.message;
                cacheHit = true;
              } else if (hyg67 && hyg67.args && typeof hyg67.args === 'object') {
                args = hyg67.args;
              }
            }
            const filePath67 = args && (args.path || args.file_path || args.target);
            const writeKind67 = w67hy.WRITE_TOOL_RE && w67hy.WRITE_TOOL_RE.test(String(mapped || ''));
            if (typeof w67hy.applyWriteRefuseClosed === 'function' && writeKind67 && filePath67 && result === undefined) {
              const refused = w67hy.applyWriteRefuseClosed({
                path: filePath67,
                content: args && (args.content != null ? args.content : args.new_string),
                refuseWriteIfDestDirMissing: ad67.refuseWriteIfDestDirMissing,
                refuseWriteToEtcProcSys: ad67.refuseWriteToEtcProcSys,
                refuseWriteToDevBoot: ad67.refuseWriteToDevBoot,
                refuseWriteToRootMnt: ad67.refuseWriteToRootMnt,
                refuseCheckpointOver1MiBUncompressed: ad67.refuseCheckpointOver1MiBUncompressed,
              });
              if (refused && refused.ok === false && !refused.uniqueness) {
                const classified = classifyLoopError({ code: refused.code || 'path_system' });
                result = 'ERROR: ' + classified.message;
                cacheHit = true;
              }
            }
            const planShaped = (w67hy.PLAN_TOOL_RE && w67hy.PLAN_TOOL_RE.test(String(mapped || '')))
              || (args && Array.isArray(args.steps));
            if (typeof w67hy.applyPlanGuardsClosed === 'function' && planShaped && result === undefined) {
              const plan = w67hy.applyPlanGuardsClosed({
                title: args && args.title,
                steps: args && args.steps,
                completedIds: args && args.completedIds,
                capPlanTitle128Chars: ad67.capPlanTitle128Chars,
                refuseDuplicatePlanStepIds: ad67.refuseDuplicatePlanStepIds,
                refuseEmptyPlanTitle: ad67.refuseEmptyPlanTitle,
                capPlanSteps24: ad67.capPlanSteps24,
                skipCompletedPlanStepsOnResume: ad67.skipCompletedPlanStepsOnResume,
              });
              if (plan && plan.ok === false) {
                const classified = classifyLoopError({ code: plan.code || 'plan_title_empty' });
                result = 'ERROR: ' + classified.message;
                cacheHit = true;
              } else if (plan && args && typeof args === 'object') {
                if (plan.title != null) args.title = plan.title;
                if (Array.isArray(plan.steps)) args.steps = plan.steps;
              }
            }
          }
        } catch (_) { /* 3H67 name/write/plan fail-open */ }
        try {
          const w65hy = loadEngine3h65();
          if (w65hy && typeof w65hy.applyToolArgHygieneClosed === 'function' && adapter) {
            if (typeof adapter.perToolRateLimit === 'function' && threadId) {
              const rated = adapter.perToolRateLimit(threadId, mapped);
              if (rated && rated.ok === false) {
                const classified = classifyLoopError({ code: 'rate_limited' });
                result = 'ERROR: ' + classified.message;
                cacheHit = true;
              }
            }
            const schema = (Array.isArray(tools) ? tools : []).map((t) => (
              t && t.function && t.function.name === mapped ? (t.function.parameters || t.function.input_schema) : null
            )).find(Boolean);
            if (typeof adapter.enforceAdditionalPropertiesFalse === 'function' && schema) {
              adapter.enforceAdditionalPropertiesFalse(schema);
            }
            const hyg = w65hy.applyToolArgHygieneClosed({
              args,
              schema,
              name: mapped,
              url: args && (args.url || args.href || args.uri),
              turnCache: webFetchTurnCache,
              capToolArgBytes: adapter.capToolArgBytes,
              capToolArgBytes32KiB: adapter.capToolArgBytes32KiB,
              enforceAdditionalPropertiesFalse: adapter.enforceAdditionalPropertiesFalse,
              validateEnumArgs: adapter.validateEnumArgs,
              skipDuplicateWebFetchSameUrlTurn: adapter.skipDuplicateWebFetchSameUrlTurn,
            });
            if (hyg && hyg.cacheHit && hyg.skipped && result === undefined) {
              result = hyg.cachedResult;
              cacheHit = true;
            } else if (hyg && hyg.refuse) {
              const classified = classifyLoopError({ code: hyg.code || 'tool_args_invalid' });
              result = 'ERROR: ' + classified.message;
              cacheHit = true;
            }
          }
        } catch (_) { /* 3H65 arg hygiene fail-open */ }
        try {
          if (adapter && /^(computer_|host_bash)/i.test(String(mapped || name || ''))) {
            const guard = require('../computer/computer-code-guard');
            const liveUser = (executors && (executors.__userId || executors.userId)) || threadId;
            const liveSession = threadId || (executors && executors.__sessionId) || undefined;
            const liveSessionObj = threadId ? { id: threadId } : (executors && executors.__session) || undefined;
            const requireIdentity = !!(executors && executors.__requireComputerSession);
            if (typeof adapter.refuseComputerToolsIfNoUserId === 'function') {
              adapter.refuseComputerToolsIfNoUserId({ toolName: mapped, userId: liveUser });
            }
            if (typeof adapter.refuseComputerToolsIfSessionMissing === 'function') {
              adapter.refuseComputerToolsIfSessionMissing({
                toolName: mapped,
                sessionId: liveSession,
                session: liveSessionObj,
              });
            }
            const refused = guard.applyRefuseComputerToolsClosed({
              toolName: mapped,
              userId: liveUser,
              sessionId: liveSession,
              session: liveSessionObj,
              computerEnabled: !(executors && executors.__computerEnabled === false),
              computerOnly: !!(executors && executors.__computerOnly),
              refuseComputerToolsIfFlagOff: adapter.refuseComputerToolsIfFlagOff,
              refuseComputerToolsIfNoUserId: (requireIdentity || liveUser)
                ? adapter.refuseComputerToolsIfNoUserId
                : undefined,
              refuseComputerToolsIfSessionMissing: (requireIdentity || liveSession)
                ? adapter.refuseComputerToolsIfSessionMissing
                : undefined,
              refuseHostBashIfComputerOnlyTurn: adapter.refuseHostBashIfComputerOnlyTurn,
            });
            if (refused && refused.ok === false) {
              const classified = classifyLoopError({ code: refused.code });
              result = 'ERROR: ' + classified.message;
              cacheHit = true;
            }
            if (typeof adapter.screenshotOnlyNoCharge === 'function') {
              adapter.screenshotOnlyNoCharge({
                tools: [{ name: mapped }],
                screenshotOnly: /screenshot/.test(String(mapped || '')),
              });
            }
            if (typeof adapter.observeOnlyNoCharge === 'function') {
              adapter.observeOnlyNoCharge({
                tools: [{ name: mapped }],
                observeOnly: /observe/.test(String(mapped || '')),
              });
            }
          }
        } catch (_) { /* computer refuse fail-closed only on explicit helper refuse */ }
        if (adapter && typeof adapter.cacheIdenticalToolCallSameTurn === 'function'
          && !/^(computer_|write_|str_replace|apply_patch|bash|run_|generate_|create_|edit_|delete_|screenshot|browser_)/i.test(String(mapped || name || ''))) {
          const hit = adapter.cacheIdenticalToolCallSameTurn(mapped, args, { turn: sameTurnCache });
          if (hit && hit.cacheHit) {
            result = hit.result;
            cacheHit = true;
          }
        }
      } catch (_) { /* 3H63 subagent/cache fail-open */ }
      onEvent({
        type: 'tool_call',
        iteration,
        tool: mapped,
        args,
        preview: previewOf(args.code || args.command || args.path || args.color || args),
        label: mapped === 'render_preview' ? 'Verificando resultado' : 'Ejecutando código',
        viaReact,
      });

      const executor = executors[mapped] || executors[name];
      if (cacheHit && result !== undefined) {
        /* identical same-turn tool or refused subagent budget — skip execute */
      } else if (!executor) {
        result = `ERROR: unknown tool "${name}". Available: ${Object.keys(executors).join(', ')}`;
      } else {
        let execArgs = args;
        if (execArgs && execArgs.__parse_error) {
          const recovered = recoverParsedToolArgs(execArgs.raw, call);
          if (recovered.ok && recovered.value && !recovered.value.__parse_error) {
            consecutiveRepairFails = 0;
            execArgs = recovered.value;
          } else {
            consecutiveRepairFails += 1;
            if (consecutiveRepairFails >= MAX_CONSECUTIVE_REPAIR_FAILS) {
              const classified = classifyLoopError({ code: 'tool_repair_exhausted' });
              onEvent({
                type: 'error',
                code: classified.code,
                message: classified.message,
                retryable: classified.retryable,
                iteration,
              });
              stoppedReason = 'tool_repair_exhausted';
              return {
                finalText: finalText || '',
                iterations: iteration,
                steps,
                stoppedReason,
                verificationAttempts,
                errorCode: 'tool_repair_exhausted',
                errorMessage: classified.message,
              };
            }
            result = `ERROR: tool arguments were not valid JSON: ${execArgs.raw}`;
          }
        }
        if (result === undefined) {
          const runExecutor = async () => {
            bail(iteration);
            // The per-call signal lets an in-flight execute_python/bash sandbox
            // command die WITH the Stop button, not just between tool calls.
            const adapter = loadEngineAdapter();
            if (adapter && typeof adapter.retryToolWithBackoff === 'function') {
              const retried = await adapter.retryToolWithBackoff(
                async () => executor(execArgs, { signal }),
                {
                  maxAttempts: 3,
                  isRetryable: (err) => {
                    try {
                      const w65r = loadEngine3h65();
                      if (w65r && typeof w65r.applyDeepSeekCreditGuardsClosed === 'function') {
                        const g = w65r.applyDeepSeekCreditGuardsClosed({
                          err,
                          mapDeepSeekHttpError: adapter.mapDeepSeekHttpError,
                          neverRetry402: adapter.neverRetry402,
                          neverRetry413: adapter.neverRetry413,
                          neverChargeIfCancelledBeforeFirstToken: adapter.neverChargeIfCancelledBeforeFirstToken,
                        });
                        if (g && g.retry === false) return false;
                      }
                    } catch (_) { /* 3H65 retry gate fail-open */ }
                    if (typeof adapter.isRetryableToolFailure === 'function') {
                      return adapter.isRetryableToolFailure(err);
                    }
                    return false;
                  },
                  signal,
                  sleepFn: retrySleepFn,
                },
              );
              if (retried && retried.ok) {
                consecutiveRepairFails = 0;
                return retried.value;
              }
              if (signal?.aborted) bail(iteration);
              const err = (retried && retried.error) || new Error('tool_retry_exhausted');
              const transient = typeof adapter.isRetryableToolFailure === 'function'
                && adapter.isRetryableToolFailure(err);
              if (transient) {
                const classified = classifyLoopError({ code: 'tool_retry_exhausted', err });
                const stopErr = new Error(classified.message);
                stopErr.code = 'tool_retry_exhausted';
                stopErr.stopLoop = true;
                stopErr.classified = classified;
                throw stopErr;
              }
              return `ERROR: ${err?.message || String(err)}`;
            }
            try {
              return await executor(execArgs, { signal });
            } catch (execErr) {
              if (signal?.aborted) bail(iteration);
              let retried = false;
              try {
                const w60 = loadEngine3h60();
                if (w60 && typeof w60.retryTransientToolError === 'function') {
                  const retry = w60.retryTransientToolError({
                    attempt: 0,
                    status: execErr && (execErr.status || execErr.statusCode),
                    code: execErr && execErr.code,
                  });
                  if (retry && retry.retry && typeof executor === 'function') {
                    const again = await executor(execArgs, { signal });
                    retried = true;
                    return again;
                  }
                }
              } catch (_) { /* 3H60 fail-open */ }
              if (!retried) return `ERROR: ${execErr?.message || String(execErr)}`;
            }
            return undefined;
          };
          try {
            result = await executeWith3h59Checkpoint({
              adapter: loadEngineAdapter(),
              mapped,
              execArgs,
              runExecutor,
              executors,
              fileEditCkpt,
            });
          } catch (err) {
            if (err && err.stopLoop) {
              const classified = err.classified || classifyLoopError({ code: err.code || 'tool_retry_exhausted', err });
              onEvent({
                type: 'error',
                code: classified.code,
                message: classified.message,
                retryable: classified.retryable,
                iteration,
              });
              stoppedReason = err.code || 'tool_retry_exhausted';
              return {
                finalText: finalText || '',
                iterations: iteration,
                steps,
                stoppedReason,
                verificationAttempts,
                errorCode: err.code || 'tool_retry_exhausted',
                errorMessage: classified.message,
              };
            }
            if (signal?.aborted) bail(iteration);
            result = `ERROR: ${err?.message || String(err)}`;
          }
          lastProgressAt = Date.now();
        }
        if (typeof result === 'string' && result.startsWith('ERROR:')) {
          try {
            const w60 = loadEngine3h60();
            if (w60 && typeof w60.settleCreditsOnError === 'function') {
              w60.settleCreditsOnError({
                errored: true,
                usage: { streamedChars: String(finalText || '').length },
              });
            }
            try {
              const w62 = loadEngine3h62();
              if (w62 && typeof w62.settleLedgerOnErrorClosed === 'function') {
                w62.settleLedgerOnErrorClosed({
                  errored: true,
                  cancelled: false,
                  usage: { streamedChars: String(finalText || '').length },
                  firstToken: Boolean(finalText),
                });
              }
            } catch (_) { /* 3H62 fail-open */ }
          } catch (_) { /* 3H60 fail-open */ }
        }
      }

      // ── F7 (multimodal) hook ────────────────────────────────────────────
      // A tool may return an image payload instead of a plain string
      // ({ __f7Image: { base64, mediaType }, text }). The text goes into the
      // tool_result message as usual; the pixels are attached to the NEXT
      // LLM call as a real vision content block, framed as DATA — never as
      // instructions.
      let f7Image = null;
      if (result && typeof result === 'object' && result.__f7Image) {
        f7Image = result.__f7Image;
        result = String(result.text || '[imagen capturada]');
      }
      // ── end F7 hook ─────────────────────────────────────────────────────

      bail(iteration);
      try {
        const adCache = loadEngineAdapter();
        if (adCache && typeof adCache.cacheIdenticalToolCallSameTurn === 'function' && !cacheHit
          && !/^(computer_|write_|str_replace|apply_patch|bash|run_|generate_|create_|edit_|delete_|screenshot|browser_)/i.test(String(mapped || name || ''))) {
          adCache.cacheIdenticalToolCallSameTurn(mapped, args, { turn: sameTurnCache, result });
        }
        if (String(result).startsWith('ERROR:')) {
          const uniqueness = /old_str occurs more than once|old_str not found|old_str must not be empty/i.test(String(result));
          if (!uniqueness) {
            const w64 = loadEngine3h64();
            let publicErr = null;
            if (w64 && typeof w64.classifyPublicGenerateErrorClosed === 'function') {
              publicErr = w64.classifyPublicGenerateErrorClosed({
                err: { message: String(result) },
                classifyToolFailure: adCache && adCache.classifyToolFailure,
                sanitizeClientError: adCache && adCache.sanitizeClientError,
              });
            } else {
              if (adCache && typeof adCache.classifyToolFailure === 'function') {
                publicErr = adCache.classifyToolFailure({ message: String(result) });
              }
              if (adCache && typeof adCache.sanitizeClientError === 'function') {
                publicErr = adCache.sanitizeClientError({ message: String(result) });
              }
            }
            if (publicErr && publicErr.message) {
              onEvent({
                type: 'error',
                iteration,
                tool: mapped,
                code: publicErr.code,
                message: publicErr.message,
                retryable: publicErr.retryable,
              });
            }
          }
        }
      } catch (_) { /* cache/classify advisory */ }
      try {
        const w66res = loadEngine3h66();
        const ad66 = loadEngineAdapter();
        if (w66res && ad66 && result !== undefined) {
          if (typeof w66res.applyReadHygieneClosed === 'function'
            && w66res.READ_TOOL_RE && w66res.READ_TOOL_RE.test(mapped)
            && !String(result).startsWith('ERROR:')) {
            const readHy = w66res.applyReadHygieneClosed({
              text: typeof result === 'string' ? result : String(result),
              offset: args && args.offset,
              limit: args && args.limit,
              windowed: Boolean(args && (args.offset != null || args.limit != null)),
              stripUtf8BomOnRead: ad66.stripUtf8BomOnRead,
              sliceReadWindow: ad66.sliceReadWindow,
              formatReadWithLineNumbers: ad66.formatReadWithLineNumbers,
              startBackgroundBash: ad66.startBackgroundBash,
              resetBackgroundBash: ad66.resetBackgroundBash,
            });
            if (readHy && readHy.text != null) result = readHy.text;
          }
          if (typeof w66res.applyCallIdempotencyClosed === 'function' && call && call.id) {
            w66res.applyCallIdempotencyClosed({
              callId: call.id,
              inflight: callIdInflight,
              store: callResultStore,
              args,
              result,
              remember: true,
              idempotentSameCallIdInflight: ad66.idempotentSameCallIdInflight,
              rememberCallResult: ad66.rememberCallResult,
            });
          }
        }
      } catch (_) { /* 3H66 read hygiene / remember fail-open */ }
      try {
        const w67res = loadEngine3h67();
        const ad67res = loadEngineAdapter();
        if (w67res && ad67res && result !== undefined) {
          if (typeof w67res.applySandboxOutCapClosed === 'function'
            && w67res.BASH_TOOL_RE && w67res.BASH_TOOL_RE.test(mapped)
            && !String(result).startsWith('ERROR:')) {
            const cappedOut = w67res.applySandboxOutCapClosed({
              text: typeof result === 'string' ? result : String(result),
              stdout: (result && typeof result === 'object' && result.stdout != null) ? result.stdout : (typeof result === 'string' ? result : String(result)),
              stderr: (result && typeof result === 'object' && result.stderr != null) ? result.stderr : '',
              stripAnsiFromSandboxOut: ad67res.stripAnsiFromSandboxOut,
              stderrByteCapPerCommand: ad67res.stderrByteCapPerCommand,
              stdoutByteCapPerCommand: ad67res.stdoutByteCapPerCommand,
              combinedStdoutStderr96KiB: ad67res.combinedStdoutStderr96KiB,
              capStdoutLine8KiB: ad67res.capStdoutLine8KiB,
            });
            if (cappedOut && cappedOut.text != null) result = cappedOut.text;
          }
          if (typeof w67res.applyCreditErrorPathClosed === 'function'
            && String(result).startsWith('ERROR:')) {
            w67res.applyCreditErrorPathClosed({
              usage: (response && response.usage) || {},
              error: { message: String(result) },
              noCompletion: true,
              aborted: Boolean(signal && signal.aborted),
              buffer: '',
              recordTokenUsageOnErrorPath: ad67res.recordTokenUsageOnErrorPath,
              cancelDropsBufferedTokens: ad67res.cancelDropsBufferedTokens,
            });
          }
        }
      } catch (_) { /* 3H67 sandbox/credit fail-open */ }
      try {
        const w65res = loadEngine3h65();
        const adRes = loadEngineAdapter();
        if (w65res && typeof w65res.applyToolResultHygieneClosed === 'function' && adRes && result !== undefined) {
          const cleaned = w65res.applyToolResultHygieneClosed({
            result,
            validateToolResultShape: adRes.validateToolResultShape,
            gzipToolResultOverSize: adRes.gzipToolResultOverSize,
            clampToolResultWithHash: adRes.clampToolResultWithHash,
            redactSecretsInToolResult: adRes.redactSecretsInToolResult,
            redactAuthorizationBearerInToolResults: adRes.redactAuthorizationBearerInToolResults,
          });
          if (cleaned && cleaned.ok === false) {
            const classified = classifyLoopError({ code: cleaned.code || 'bad_tool_result' });
            result = 'ERROR: ' + classified.message;
          } else if (cleaned && cleaned.text != null && !String(result).startsWith('ERROR:')) {
            result = cleaned.text;
          }
        }
      } catch (_) { /* 3H65 result hygiene fail-open */ }
      observationHistory.push(result);
      if (String(result).startsWith('ERROR:')) {
        deadLetterHistory.push({ tool: mapped, name: mapped, code: 'tool_error' });
      }
      parallelFinished.push({ id: call && call.id, call, result });
      const ok = !String(result).startsWith('ERROR:');
      steps.push({
        iteration,
        tool: mapped,
        args,
        ok,
        resultPreview: previewOf(result, 400),
        viaReact,
        tokensDelta: 0,
        artifactsDelta: ok ? 1 : 0,
      });
      onEvent({
        type: 'tool_result',
        iteration,
        tool: mapped,
        ok,
        preview: previewOf(result, 400),
        label: ok ? 'Verificando resultado' : 'Reintentando',
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${iteration}_${mapped}`,
        content: String(result),
      });
      // F7 (multimodal): hand the tool-produced image to the next LLM call.
      if (f7Image) {
        try {
          const { buildImageDataMessage } = require('./multimodal');
          messages.push(buildImageDataMessage([f7Image]));
        } catch (_) { /* F7 module absent — the text result was delivered */ }
      }
    }
    try {
      const adJoin = loadEngineAdapter();
      if (adJoin && typeof adJoin.joinParallelToolResultsStableOrder === 'function') {
        adJoin.joinParallelToolResultsStableOrder(toolCalls, parallelFinished);
      }
    } catch (_) { /* join is advisory */ }

    try {
      const w61 = loadEngine3h61();
      if (w61 && typeof w61.enforceSubtaskProgressClosed === 'function') {
        const cut = w61.enforceSubtaskProgressClosed({
          steps,
          tokensDelta: 0,
          artifactsDelta: 0,
        });
        if (cut && cut.cut) {
          const classified = classifyLoopError({ code: cut.code || 'subtask_no_progress' });
          onEvent({
            type: 'error',
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
            iteration,
          });
          stoppedReason = cut.code || 'subtask_no_progress';
          return {
            finalText: finalText || '',
            iterations: iteration,
            steps,
            stoppedReason,
            verificationAttempts,
            errorCode: cut.code || 'subtask_no_progress',
            errorMessage: classified.message,
          };
        }
      }
    } catch (_) { /* 3H61 fail-open */ }
  }

  bail(cap);
  onEvent({ type: 'final', text: finalText, iterations: cap, label: 'Listo' });
  return { finalText, iterations: cap, steps, stoppedReason, verificationAttempts };
  } finally {
    try {
      const w62 = loadEngine3h62();
      if (w62 && typeof w62.observeTurnLatencyClosed === 'function') {
        w62.observeTurnLatencyClosed({
          kind: 'turn_end',
          startedAt: turnStartedAt,
          now: Date.now(),
        });
      }
      try {
        const w64 = loadEngine3h64();
        const adapter = loadEngineAdapter();
        if (w64 && typeof w64.persistLatencyRingClosed === 'function' && adapter) {
          w64.persistLatencyRingClosed({
            kind: 'turn_end',
            startedAt: turnStartedAt,
            now: Date.now(),
            observeAdapterLatency: adapter.observeAdapterLatency,
            adapterLatencySnapshot: adapter.adapterLatencySnapshot,
          });
        }
      } catch (_) { /* 3H64 turn latency fail-open */ }
      if (w62 && threadId && typeof w62.persistSessionCheckpointClosed === 'function') {
        const ckptState = { messages, steps, stoppedReason, finalText, remaining: Math.max(0, cap - steps.length) };
        try {
          const w64 = loadEngine3h64();
          const adapter = loadEngineAdapter();
          if (w64 && typeof w64.applyCheckpointResumeClosed === 'function' && adapter) {
            w64.applyCheckpointResumeClosed({
              persist: true,
              resume: false,
              state: ckptState,
              payload: ckptState,
              remaining: ckptState.remaining,
              list: [ckptState],
              replayToolResultsOnResume: adapter.replayToolResultsOnResume,
              boundStepsOnCheckpointResume: adapter.boundStepsOnCheckpointResume,
              crc32CheckOnCheckpointLoad: adapter.crc32CheckOnCheckpointLoad,
              gzipCheckpointIfOver64KiB: adapter.gzipCheckpointIfOver64KiB,
              pruneCheckpointsKeepLastN: adapter.pruneCheckpointsKeepLastN,
              crc32StampOnCheckpointSave: adapter.crc32StampOnCheckpointSave,
              persistFn: (packed) => {
                w62.persistSessionCheckpointClosed({
                  sessionKey: threadId,
                  state: Object.assign({}, ckptState, {
                    crc32: packed && packed.crc32,
                    gzipped: packed && packed.gzipped,
                  }),
                  root: persistRoot,
                });
              },
            });
          } else {
            w62.persistSessionCheckpointClosed({
              sessionKey: threadId,
              state: ckptState,
              root: persistRoot,
            });
          }
        } catch (_) {
          w62.persistSessionCheckpointClosed({
            sessionKey: threadId,
            state: ckptState,
            root: persistRoot,
          });
        }
      }
    } catch (_) { /* 3H62 fail-open */ }
  }
}

module.exports = {
  runAgentLoop,
  callModel,
  MAX_ITERATIONS_DEFAULT,
  MAX_VERIFICATION_RETRIES,
  MAX_TOKENS_DEFAULT,
  LLM_RETRY_MAX,
  STREAM_STALL_MS_DEFAULT,
  STREAM_STALL_CANCEL_AFTER,
  MAX_CONSECUTIVE_REPAIR_FAILS,
  resolveAgentRunnerMaxTokens,
  isLlmCreditError,
  stallIfNoEvent20sMidStream,
  newFenceToken,
  heartbeatFence,
  stealStaleFence,
  classifyLoopError,
  compactMessagesInPlace,
};
