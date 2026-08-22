'use strict';

const {
  throwIfAborted,
} = require('../../utils/abort-signals');
const {
  rejectToolNameEndingWithDot,
  rejectToolCallIfNameIsObject,
  capToolArgString4096,
  refuseWriteToVarLogRun,
  redactAwsAccessKeysInResults,
  neverRetry408Timeout,
  classifyEtimedoutAsTimeout,
  classifyEconnrefusedAsUnavailable,
  capUserMessage32KiB,
  abortIfIdleOver30sMidTool,
  refuseSubagentIfNameEmpty,
} = require('./engine-adapter');
const { parseReact, looksLikeToolUnsupportedError } = require('./react');
const {
  MAX_VERIFICATION_RETRIES,
  needsVerification,
  verificationNudge,
} = require('./verify');

const MAX_ITERATIONS_DEFAULT = 25;

// Keep tool-call turns SHORT. OpenRouter charges/reserves max_tokens up
// front: with a low credit balance a 8192-token reservation gets rejected
// with 402 ("You requested up to 8192 tokens, but can only afford …") even
// though the actual turn needs a few hundred tokens. 3072 is plenty for a
// tool call + arguments and lets a low balance still complete a short loop.
const MAX_TOKENS_DEFAULT = 3072;

function resolveAgentRunnerMaxTokens(env = process.env) {
  const raw = Number(env.SIRAGPT_AGENT_RUNNER_MAX_TOKENS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(256, Math.min(8192, Math.floor(raw)));
  }
  return MAX_TOKENS_DEFAULT;
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
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch {
    return { __parse_error: true, raw: String(raw).slice(0, 500) };
  }
}

function asNativeCalls(calls, iteration) {
  return calls.map((c, idx) => ({
    id: `react_${iteration}_${idx}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
  }));
}

async function callModel({ client, model, messages, tools, signal, maxTokens }) {
  const max_tokens = maxTokens || resolveAgentRunnerMaxTokens();
  try {
    return await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens,
    }, signal ? { signal } : undefined);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (!looksLikeToolUnsupportedError(err)) throw err;
    return client.chat.completions.create({
      model,
      messages,
      max_tokens,
    }, signal ? { signal } : undefined);
  }
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
} = {}) {
  if (!client?.chat?.completions?.create) throw new Error('runAgentLoop: client is required');
  const srcExec = executors && typeof executors === 'object' ? executors : {};
  const wrappedExec = {};
  for (const k of Object.keys(srcExec)) {
    const fn = srcExec[k];
    if (typeof fn !== 'function') { wrappedExec[k] = fn; continue; }
    wrappedExec[k] = async function wrappedNoThrow(a, o) {
      try { return await fn(a, o); } catch (e) { return `ERROR: ${e && e.message ? e.message : String(e)}`; }
    };
  }
  executors = wrappedExec;
  const cap = Math.max(1, Math.min(50, Number(maxIterations) || MAX_ITERATIONS_DEFAULT));
  const steps = [];
  let finalText = '';
  let stoppedReason = 'max_iterations';
  let verificationAttempts = 0;

  // F3: a user cancel (Stop button → AbortSignal) must stop the loop AND
  // leave a trace. `bail` emits exactly one 'cancelled' stage event before
  // rethrowing so the SSE stream shows "Cancelado" instead of dying silently.
  let cancelledEmitted = false;
  const bail = (iteration) => {
    if (!signal?.aborted) return;
    if (!cancelledEmitted) {
      cancelledEmitted = true;
      try { onEvent({ type: 'cancelled', iteration, label: 'Cancelado' }); } catch (_) { /* trace only */ }
    }
    throwIfAborted(signal);
  };

  for (let iteration = 1; iteration <= cap; iteration += 1) {
    bail(iteration);
    onEvent({ type: 'iteration_start', iteration, label: 'Pensando' });

    let response;
    try {
      response = await callModel({ client, model, messages, tools, signal });
      bail(iteration);
    } catch (err) {
      if (signal?.aborted) bail(iteration);
      onEvent({ type: 'error', message: err?.message || String(err) });
      try { neverRetry408Timeout(err); } catch (_) {}
      try { classifyEtimedoutAsTimeout(err); } catch (_) {}
      try { classifyEconnrefusedAsUnavailable(err); } catch (_) {}
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

    if (!toolCalls.length) {
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
      let args = safeParseArgs(call?.function?.arguments);
      try {
        const dotN = rejectToolNameEndingWithDot(name);
        if (dotN && dotN.ok === false) {
          onEvent({ type: 'error', code: 'tool_name_dot', message: 'El nombre de la herramienta no puede terminar con un punto.', retryable: false, iteration, name });
        }
      } catch (_) {}
      try { rejectToolCallIfNameIsObject([call]); } catch (_) {}
      try {
        const capA = capToolArgString4096(args);
        if (capA && capA.args && typeof capA.args === 'object') args = capA.args;
      } catch (_) {}
      try {
        const pth = args && (args.path || args.file || args.filename || args.cwd);
        if (pth) refuseWriteToVarLogRun(pth);
      } catch (_) {}
      try { refuseSubagentIfNameEmpty({ name: mapped }); } catch (_) {}
      try { abortIfIdleOver30sMidTool({ lastEventAt: Date.now(), now: Date.now() }); } catch (_) {}
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
        const redAws = redactAwsAccessKeysInResults(result);
        if (redAws && redAws.text != null) result = redAws.text;
      } catch (_) {}
      try {
        const capU = capUserMessage32KiB(typeof result === 'string' ? result : String(result || ''));
        if (capU && capU.truncated && capU.text != null && typeof result === 'string') result = capU.text;
      } catch (_) {}
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
  resolveAgentRunnerMaxTokens,
  isLlmCreditError,
};
