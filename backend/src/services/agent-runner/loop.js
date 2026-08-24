'use strict';

const { throwIfAborted } = require('../../utils/abort-signals');
const { parseReact, looksLikeToolUnsupportedError } = require('./react');
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
}) {
  const filePath = execArgs && (execArgs.path || execArgs.filename);
  const diffText = execArgs && (execArgs.diff || execArgs.patch);
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
      }
    } catch (_) { /* 3H62 fail-open: timeout rollback still applies */ }
  }

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

function asNativeCalls(calls, iteration) {
  return calls.map((c, idx) => ({
    id: `react_${iteration}_${idx}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
  }));
}

async function callModel({ client, model, messages, tools, signal, maxTokens, onFirstToken }) {
  const max_tokens = maxTokens || resolveAgentRunnerMaxTokens();
  const create = (withTools) => client.chat.completions.create({
    model,
    messages,
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
      if (!looksLikeToolUnsupportedError(err)) throw err;
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
    }
    if (w62 && typeof w62.recoverPgvectorPinsClosed === 'function' && (pinHits.length || typeof recall === 'function')) {
      const lastUser = Array.isArray(messages)
        ? [...messages].reverse().find((m) => m && m.role === 'user')
        : null;
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
        onFirstToken: () => { if (modelTtfbMs === null) modelTtfbMs = Date.now() - modelTurnStart; },
      });
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
          if (w62 && typeof w62.observeTurnLatencyClosed === 'function' && modelTtfbMs != null) {
            w62.observeTurnLatencyClosed({ kind: 'first_token', ms: modelTtfbMs });
          }
        } catch (_) { /* 3H62 fail-open */ }
      }
    } catch (_) { /* 3H60 fail-open */ }

    if (!toolCalls.length) {
      // A model response with no tool calls and no content is the classic
      // "provider accepted the request but produced nothing" stall. Count it;
      // after STREAM_STALL_CANCEL_AFTER empty responses, stop as loop_stall
      // instead of burning the remaining iterations.
      if (!String(msg.content || '').trim()) {
        stallCount += 1;
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

    for (const call of toolCalls) {
      bail(iteration);
      const name = call?.function?.name || 'unknown';
      const mapped = name === 'bash' ? 'execute_bash' : name;
      const args = safeParseArgs(call?.function?.arguments);
      onEvent({
        type: 'tool_call',
        iteration,
        tool: mapped,
        args,
        preview: previewOf(args.code || args.command || args.path || args.color || args),
        label: mapped === 'render_preview' ? 'Verificando resultado' : 'Ejecutando código',
        viaReact,
      });

      let result;
      const executor = executors[mapped] || executors[name];
      if (!executor) {
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
                  isRetryable: typeof adapter.isRetryableToolFailure === 'function'
                    ? adapter.isRetryableToolFailure
                    : undefined,
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
      if (w62 && threadId && typeof w62.persistSessionCheckpointClosed === 'function') {
        w62.persistSessionCheckpointClosed({
          sessionKey: threadId,
          state: { messages, steps, stoppedReason, finalText },
          root: persistRoot,
        });
      }
    } catch (_) { /* 3H62 fail-open */ }
  }
}

module.exports = {
  runAgentLoop,
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
