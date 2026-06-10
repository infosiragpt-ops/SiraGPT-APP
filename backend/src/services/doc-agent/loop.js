'use strict';

/**
 * Document-agent loop — model → tool calls → sandbox execution → tool results
 * → model, until the model answers WITHOUT tool calls or the iteration cap is
 * reached (Cowork-style).
 *
 * The LLM client is INJECTED (anything OpenAI-compatible:
 * `client.chat.completions.create({ model, messages, tools, tool_choice })`).
 * Production passes an OpenRouter-backed client; tests pass a scripted fake —
 * the loop itself is fully deterministic and offline-testable.
 *
 * Events (for SSE relay): onEvent({ type, ... })
 *   iteration_start { iteration }
 *   tool_call       { iteration, tool, args, preview }
 *   tool_result     { iteration, tool, ok, preview }
 *   final           { text, iterations }
 *   error           { message }
 */

const MAX_ITERATIONS_DEFAULT = 25;

function previewOf(value, max = 200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeParseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return { __parse_error: true, raw: String(raw).slice(0, 500) }; }
}

/**
 * @param {object} opts
 * @param {{ chat: { completions: { create: Function } } }} opts.client OpenAI-compatible client
 * @param {string} opts.model
 * @param {Array} opts.messages seeded [system, user] messages (mutated in place)
 * @param {Array} opts.tools OpenAI tool definitions
 * @param {Record<string, Function>} opts.executors name → async (args) => string
 * @param {number} [opts.maxIterations]
 * @param {Function} [opts.onEvent]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ finalText: string, iterations: number, steps: Array, stoppedReason: string }>}
 */
async function runDocAgentLoop({
  client,
  model,
  messages,
  tools,
  executors,
  maxIterations = MAX_ITERATIONS_DEFAULT,
  onEvent = () => {},
  signal,
} = {}) {
  if (!client?.chat?.completions?.create) throw new Error('runDocAgentLoop: client is required');
  const cap = Math.max(1, Math.min(50, Number(maxIterations) || MAX_ITERATIONS_DEFAULT));
  const steps = [];
  let finalText = '';
  let stoppedReason = 'max_iterations';

  for (let iteration = 1; iteration <= cap; iteration += 1) {
    if (signal?.aborted) { stoppedReason = 'aborted'; break; }
    onEvent({ type: 'iteration_start', iteration });

    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto',
      });
    } catch (err) {
      onEvent({ type: 'error', message: err?.message || String(err) });
      throw err;
    }

    const msg = response?.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!toolCalls.length) {
      finalText = String(msg.content || '').trim();
      stoppedReason = 'final';
      messages.push({ role: 'assistant', content: msg.content || '' });
      onEvent({ type: 'final', text: finalText, iterations: iteration });
      return { finalText, iterations: iteration, steps, stoppedReason };
    }

    // Record the assistant turn EXACTLY as returned (required so the
    // follow-up role:"tool" messages bind to their tool_call ids).
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const name = call?.function?.name || 'unknown';
      const args = safeParseArgs(call?.function?.arguments);
      onEvent({ type: 'tool_call', iteration, tool: name, args, preview: previewOf(args.command || args.path || args) });

      let result;
      const executor = executors[name];
      if (!executor) {
        result = `ERROR: unknown tool "${name}". Available: ${Object.keys(executors).join(', ')}`;
      } else if (args.__parse_error) {
        result = `ERROR: tool arguments were not valid JSON: ${args.raw}`;
      } else {
        try {
          result = await executor(args);
        } catch (err) {
          // Executors return ERROR strings themselves; this is the belt for
          // anything that still escapes — a tool failure must NEVER kill the loop.
          result = `ERROR: ${err?.message || String(err)}`;
        }
      }

      const ok = !String(result).startsWith('ERROR:');
      steps.push({ iteration, tool: name, args, ok, resultPreview: previewOf(result, 400) });
      onEvent({ type: 'tool_result', iteration, tool: name, ok, preview: previewOf(result, 400) });
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${iteration}_${name}`,
        content: String(result),
      });
    }
  }

  onEvent({ type: 'final', text: finalText, iterations: cap });
  return { finalText, iterations: cap, steps, stoppedReason };
}

module.exports = { runDocAgentLoop, MAX_ITERATIONS_DEFAULT };
