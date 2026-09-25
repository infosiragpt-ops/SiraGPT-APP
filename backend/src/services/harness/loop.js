'use strict';

/**
 * Harness v2 agent loop — one provider-agnostic, Claude-style loop.
 *
 *   while the model asks for tools:
 *     stream the model turn (text / thinking / tool-input deltas),
 *     run the requested tools (independent calls in parallel),
 *     append the results and let the model continue.
 *   The final answer is plain assistant text — there is no `finalize` tool.
 *
 * Reliability: retries with exponential backoff + jitter on 429 / 5xx /
 * overloaded / dropped connections, honouring Retry-After; a turn that
 * already streamed partial output emits `turn_reset` before retrying so the
 * UI can drop the partial text. Every tool result (including validation
 * errors and timeouts) goes back to the model, which self-corrects.
 *
 * Events (onEvent), all tagged with `step`:
 *   step, text_delta, thinking_delta, tool_call_start, tool_input_delta,
 *   tool_call_end, tool_result, usage, error, turn_reset, context_trimmed, done
 */

const { createToolRegistry } = require('./tool-registry');
const { fitToContext } = require('./token-budget');
const { isAbortError, toProviderError } = require('./errors');

const DEFAULT_MAX_STEPS = Math.max(1, Number(process.env.SIRAGPT_HARNESS_MAX_STEPS) || 40);
const DEFAULT_RETRY = Object.freeze({ maxRetries: 4, baseDelayMs: 600, maxDelayMs: 20_000, maxPartialRetries: 1 });
const MAX_STEPS_NOTE = 'Se alcanzó el límite de pasos de herramientas para esta respuesta. No llames más herramientas: responde ahora al usuario con lo que ya sabes y di claramente qué quedó pendiente.';

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffDelay(attempt, retry, err) {
  if (err && Number.isFinite(err.retryAfterMs) && err.retryAfterMs >= 0) return Math.min(retry.maxDelayMs * 3, err.retryAfterMs);
  const exp = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
}

function addUsage(total, u) {
  if (!u) return total;
  total.inputTokens += u.inputTokens || 0;
  total.outputTokens += u.outputTokens || 0;
  total.cacheReadTokens += u.cacheReadTokens || 0;
  total.cacheWriteTokens += u.cacheWriteTokens || 0;
  return total;
}

/** Group calls: consecutive parallel-safe calls run together; others alone. */
function planBatches(calls, registry) {
  const batches = [];
  let current = [];
  for (const call of calls) {
    const tool = registry.get(call.name);
    if (tool && tool.parallelSafe) current.push(call);
    else {
      if (current.length) { batches.push(current); current = []; }
      batches.push([call]);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * @param {object} opts
 * @param {object} opts.adapter        from adapters/index createAdapter().adapter
 * @param {string} opts.model
 * @param {string} [opts.system]
 * @param {Array}  opts.messages       canonical history ending with the user turn
 * @param {object|Array} [opts.tools]  tool registry or array of tool definitions
 * @param {{level?: string, explicit?: boolean}} [opts.effort]
 * @param {number} [opts.maxSteps]
 * @param {number} [opts.maxTokens]    per-turn output cap
 * @param {number} [opts.contextWindow]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onEvent]
 * @param {object} [opts.toolContext]  passed to every tool run(input, ctx)
 * @param {object} [opts.retry]
 * @param {Function} [opts.sleep]      test seam
 */
async function runAgentLoop(opts = {}) {
  const {
    adapter,
    model,
    system = '',
    effort = {},
    maxSteps = DEFAULT_MAX_STEPS,
    maxTokens = 16_384,
    contextWindow = 128_000,
    signal = null,
    onEvent = () => {},
    toolContext = {},
    sleep = sleepAbortable,
  } = opts;
  if (!adapter || typeof adapter.streamTurn !== 'function') throw new TypeError('runAgentLoop needs an adapter');
  const retry = { ...DEFAULT_RETRY, ...(opts.retry || {}) };
  const registry = opts.tools && typeof opts.tools.execute === 'function' ? opts.tools : createToolRegistry(Array.isArray(opts.tools) ? opts.tools : []);
  const toolDefs = registry.definitions();
  const history = [...(opts.messages || [])];
  const startIndex = history.length;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const startedAt = Date.now();
  let step = 0;
  let stopReason = null;
  let lastError = null;
  let toolCallCount = 0;
  let firstTokenMs = null;

  const emit = (ev) => {
    try { onEvent({ ...ev, step }); } catch (_) { /* observers never break the loop */ }
  };

  const appendOnly = typeof adapter.appendOnlyHistory === 'function' ? adapter.appendOnlyHistory(model) : false;

  async function modelTurn(toolChoice) {
    const fitted = fitToContext({ messages: history, system, tools: toolDefs, contextWindow, reserveOutput: maxTokens, appendOnly });
    if (fitted.trimmed || fitted.overflow) emit({ type: 'context_trimmed', actions: fitted.actions, tokens: fitted.tokens, budget: fitted.budget, overflow: fitted.overflow });
    let attempt = 0;
    let partialRetries = 0;
    for (;;) {
      let emitted = false;
      try {
        const result = await adapter.streamTurn({
          model,
          system,
          messages: fitted.messages,
          tools: toolDefs,
          effort,
          maxTokens,
          toolChoice,
          signal,
          emit: (ev) => {
            if (ev.type === 'text_delta' || ev.type === 'thinking_delta' || ev.type === 'tool_call_start') {
              emitted = true;
              if (firstTokenMs == null) firstTokenMs = Date.now() - startedAt;
            }
            emit(ev);
          },
        });
        return result;
      } catch (rawErr) {
        if (isAbortError(rawErr) || (signal && signal.aborted)) throw rawErr;
        const err = toProviderError(rawErr, adapter.provider);
        const canRetry = err.retryable && attempt < retry.maxRetries && (!emitted || partialRetries < retry.maxPartialRetries);
        if (!canRetry) throw err;
        const delayMs = backoffDelay(attempt, retry, err);
        attempt += 1;
        if (emitted) { partialRetries += 1; emit({ type: 'turn_reset', reason: 'retry' }); }
        emit({ type: 'error', message: err.message, status: err.status || null, retrying: true, attempt, delayMs });
        await sleep(delayMs, signal);
      }
    }
  }

  try {
    for (;;) {
      if (signal && signal.aborted) { stopReason = 'aborted'; break; }
      step += 1;
      const finalTurn = step > maxSteps;
      emit({ type: 'step', index: step, final: finalTurn });
      const result = await modelTurn(finalTurn ? 'none' : 'auto');
      addUsage(usage, result.usage);
      emit({ type: 'usage', usage: result.usage || null });
      // On the forced final turn any stray tool call is dropped so the
      // transcript never ends on an unanswered tool_use.
      const content = (result.content || []).filter((b) => !(finalTurn && b && b.type === 'tool_call'));
      const assistant = { role: 'assistant', content };
      history.push(assistant);
      const calls = finalTurn ? [] : assistant.content.filter((b) => b && b.type === 'tool_call');

      if (!calls.length) {
        stopReason = finalTurn ? 'max_steps' : (result.stopReason === 'tool_use' ? 'end_turn' : result.stopReason || 'end_turn');
        break;
      }

      const results = new Array(calls.length);
      const indexOf = new Map(calls.map((c, i) => [c, i]));
      for (const batch of planBatches(calls, registry)) {
        if (signal && signal.aborted) break;
        await Promise.all(batch.map(async (call) => {
          const res = await registry.execute(call, { ...toolContext, signal, model });
          toolCallCount += 1;
          results[indexOf.get(call)] = res;
          emit({ type: 'tool_result', id: call.id, name: call.name, input: call.input, content: res.content, isError: res.isError, durationMs: res.durationMs });
        }));
      }
      if (signal && signal.aborted) {
        // Keep the transcript valid: every tool_call gets a result.
        history.push({ role: 'tool', content: calls.map((c, i) => results[i] ? { type: 'tool_result', toolCallId: c.id, name: c.name, content: results[i].content, isError: results[i].isError } : { type: 'tool_result', toolCallId: c.id, name: c.name, content: 'interrumpido por el usuario', isError: true }) });
        stopReason = 'aborted';
        break;
      }
      history.push({
        role: 'tool',
        content: calls.map((c, i) => ({ type: 'tool_result', toolCallId: c.id, name: c.name, content: results[i].content, isError: results[i].isError })),
      });
      if (step >= maxSteps) history.push({ role: 'user', content: [{ type: 'text', text: MAX_STEPS_NOTE }] });
    }
  } catch (err) {
    if (isAbortError(err) || (signal && signal.aborted)) stopReason = 'aborted';
    else {
      lastError = err;
      stopReason = 'error';
      emit({ type: 'error', message: err.message, status: err.status || null, code: err.code || null, retrying: false });
    }
  }

  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  const finalText = textOf(lastAssistant);
  const summary = {
    stopReason,
    finalText,
    steps: step,
    toolCalls: toolCallCount,
    usage,
    durationMs: Date.now() - startedAt,
    firstTokenMs,
  };
  emit({ type: 'done', ...summary });
  return { ...summary, messages: history, newMessages: history.slice(startIndex), error: lastError };
}

module.exports = { runAgentLoop, planBatches, backoffDelay, DEFAULT_MAX_STEPS, MAX_STEPS_NOTE };
