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

function load3h57() {
  try { return require('./engine-3h57'); } catch (_) { return null; }
}

// Per-model canary telemetry (best-effort; never breaks a turn). Kept as a
// lazy require so offline tests that never emit a metric still load fast.
function recordModelTelemetry(event) {
  try { require('../codex/model-telemetry').recordLlmTurn(event); } catch { /* optional */ }
}

const MAX_ITERATIONS_DEFAULT = 25;

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

/** Classify a loop stop into a user-facing code + message. */
function classifyLoopError({ code } = {}) {
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
    default:
      return { code: code || 'loop_error', retryable: true, message: String(code || 'loop_error') };
  }
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
  let cancelPartialDropped = false;
  const h57 = load3h57();
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
  const bail = (iteration) => {
    if (!signal?.aborted) return;
    if (!cancelledEmitted) {
      cancelledEmitted = true;
      try { onEvent({ type: 'cancelled', iteration, label: 'Cancelado' }); } catch (_) { /* trace only */ }
      if (h57 && typeof h57.dropPartialSseFrameOnCancel === 'function' && !cancelPartialDropped) {
        try {
          const drop = h57.dropPartialSseFrameOnCancel({ cancelled: true, partial: true, dropped: cancelPartialDropped });
          if (drop && drop.drop) cancelPartialDropped = true;
        } catch (_) { /* audit only */ }
      }
    }
    throwIfAborted(signal);
  };

  for (let iteration = 1; iteration <= cap; iteration += 1) {
    bail(iteration);
    onEvent({ type: 'iteration_start', iteration, label: 'Pensando' });
    void touchFence();

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
      if (h57 && typeof h57.latencyHintWhenTtfbOverBudget === 'function') {
        try { h57.latencyHintWhenTtfbOverBudget({ ttfbMs: modelTtfbMs }); } catch (_) { /* hint only */ }
      }
      if (h57 && typeof h57.recordStepLatencySampleP95 === 'function') {
        try { h57.recordStepLatencySampleP95(Date.now() - modelTurnStart); } catch (_) { /* sample only */ }
      }
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
      onEvent({ type: 'error', message: err?.message || String(err) });
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

    if (toolCalls.length && h57) {
      try {
        if (typeof h57.cutLoopIfSameObservationHashThrice === 'function') {
          const hashes = steps.map((s) => s && (s.observationHash || s.resultHash || s.hash)).filter(Boolean);
          const cut = h57.cutLoopIfSameObservationHashThrice(hashes);
          if (cut && cut.cut) {
            stoppedReason = 'obs_hash_repeat';
            onEvent({
              type: 'error',
              code: cut.code,
              message: (h57.actionableErrorHint && h57.actionableErrorHint(cut.code).hint) || 'Observación repetida.',
              retryable: false,
              iteration,
            });
            return { finalText: '', iterations: iteration, steps, stoppedReason, verificationAttempts, errorCode: 'obs_hash_repeat' };
          }
        }
        if (typeof h57.repairJsonDoubleEncodedOnce === 'function') {
          for (const call of toolCalls) {
            const raw = call?.function?.arguments;
            if (typeof raw === 'string') {
              const fix = h57.repairJsonDoubleEncodedOnce(raw);
              if (fix && fix.ok && fix.repaired && call.function) {
                call.function.arguments = typeof fix.value === 'string' ? fix.value : JSON.stringify(fix.value);
              }
            }
          }
        }
        if (typeof h57.refuseAssistantToolCallWithoutName === 'function') {
          h57.refuseAssistantToolCallWithoutName(toolCalls);
        }
        if (typeof h57.stripControlCharsFromToolName === 'function') {
          for (const call of toolCalls) {
            const n = call?.function?.name;
            if (typeof n === 'string' && call.function) {
              const cleaned = h57.stripControlCharsFromToolName(n);
              if (cleaned && cleaned.ok && cleaned.stripped) call.function.name = cleaned.name;
            }
          }
        }
      } catch (_) { /* fail-open: existing tool path still runs */ }
    }

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
        if (h57 && typeof h57.refuseFinishIfToolResultsPending === 'function') {
          try { h57.refuseFinishIfToolResultsPending({ messages }); } catch (_) { /* settle hint */ }
        }
        if (h57 && typeof h57.stopIfEmptyFinalAfterMaxRepairAttempts === 'function') {
          try { h57.stopIfEmptyFinalAfterMaxRepairAttempts({ text: finalText, repairAttempts: verificationAttempts }); } catch (_) { /* hint */ }
        }
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
      } else if (args.__parse_error) {
        result = `ERROR: tool arguments were not valid JSON: ${args.raw}`;
      } else {
        try {
          bail(iteration);
          // The per-call signal lets an in-flight execute_python/bash sandbox
          // command die WITH the Stop button, not just between tool calls.
          result = await executor(args, { signal });
        } catch (err) {
          if (signal?.aborted) bail(iteration);
          result = `ERROR: ${err?.message || String(err)}`;
        }
        lastProgressAt = Date.now();
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
      steps.push({ iteration, tool: mapped, args, ok, resultPreview: previewOf(result, 400), viaReact });
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
  }

  bail(cap);
  onEvent({ type: 'final', text: finalText, iterations: cap, label: 'Listo' });
  return { finalText, iterations: cap, steps, stoppedReason, verificationAttempts };
}

module.exports = {
  runAgentLoop,
  MAX_ITERATIONS_DEFAULT,
  MAX_VERIFICATION_RETRIES,
  MAX_TOKENS_DEFAULT,
  LLM_RETRY_MAX,
  STREAM_STALL_MS_DEFAULT,
  STREAM_STALL_CANCEL_AFTER,
  resolveAgentRunnerMaxTokens,
  isLlmCreditError,
  stallIfNoEvent20sMidStream,
  newFenceToken,
  heartbeatFence,
  stealStaleFence,
  classifyLoopError,
};
