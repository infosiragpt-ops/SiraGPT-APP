'use strict';

const { throwIfAborted } = require('../../utils/abort-signals');
const { parseReact, looksLikeToolUnsupportedError } = require('./react');
const {
  MAX_VERIFICATION_RETRIES,
  needsVerification,
  verificationNudge,
} = require('./verify');

const MAX_ITERATIONS_DEFAULT = 25;

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

async function callModel({ client, model, messages, tools, signal }) {
  try {
    return await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
    }, signal ? { signal } : undefined);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (!looksLikeToolUnsupportedError(err)) throw err;
    return client.chat.completions.create({
      model,
      messages,
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
  const cap = Math.max(1, Math.min(50, Number(maxIterations) || MAX_ITERATIONS_DEFAULT));
  const steps = [];
  let finalText = '';
  let stoppedReason = 'max_iterations';
  let verificationAttempts = 0;

  for (let iteration = 1; iteration <= cap; iteration += 1) {
    throwIfAborted(signal);
    onEvent({ type: 'iteration_start', iteration, label: 'Pensando' });

    let response;
    try {
      response = await callModel({ client, model, messages, tools, signal });
      throwIfAborted(signal);
    } catch (err) {
      if (signal?.aborted) throwIfAborted(signal);
      onEvent({ type: 'error', message: err?.message || String(err) });
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
      throwIfAborted(signal);
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
          throwIfAborted(signal);
          result = await executor(args);
        } catch (err) {
          if (signal?.aborted) throwIfAborted(signal);
          result = `ERROR: ${err?.message || String(err)}`;
        }
      }

      throwIfAborted(signal);
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
    }
  }

  throwIfAborted(signal);
  onEvent({ type: 'final', text: finalText, iterations: cap, label: 'Listo' });
  return { finalText, iterations: cap, steps, stoppedReason, verificationAttempts };
}

module.exports = { runAgentLoop, MAX_ITERATIONS_DEFAULT, MAX_VERIFICATION_RETRIES };
