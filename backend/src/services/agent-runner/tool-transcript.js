'use strict';

/**
 * tool-transcript — make the message list the runner sends to an
 * OpenAI-compatible chat API structurally valid, whatever the in-flight
 * compaction / pruning / repair hooks did to it.
 *
 * Strict providers (DeepSeek native, OpenAI, Gemini, xAI) reject a transcript
 * where:
 *   - a `role: "tool"` message does not answer a preceding assistant
 *     `tool_calls` entry ("Messages with role 'tool' must be a response to a
 *     preceding message with 'tool_calls'" — the production failure of
 *     2026-09-02 once the runner left OpenRouter);
 *   - an assistant `tool_calls` message is not followed by one tool message
 *     per call id before the next turn;
 *   - a tool message lacks `tool_call_id`.
 *
 * The runner's context-budget compaction (`compactUntilTokenBudget`, keep 6)
 * and the F7 image messages interleaved between parallel tool results can
 * all produce those shapes. This normaliser is pure and provider-agnostic:
 * it returns a NEW array for the request payload and never mutates the
 * runner's own state.
 *
 *   - orphan tool results are downgraded to a user message
 *     `[TOOL_RESULT <name>] …` (the information survives, the shape is legal);
 *   - missing results for a pending call id get a synthetic tool message;
 *   - non-tool messages interleaved inside a tool-result group are deferred
 *     until the group is complete;
 *   - assistant messages with an empty `tool_calls` array lose the field.
 */

const OMITTED_RESULT = '(resultado omitido: el historial fue compactado; repite la herramienta si lo necesitas)';

function isToolMessage(m) {
  return Boolean(m) && m.role === 'tool';
}

function callIds(m) {
  if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return [];
  return m.tool_calls.map((c) => (c && typeof c.id === 'string' ? c.id : '')).filter(Boolean);
}

function callName(m, id) {
  const call = Array.isArray(m && m.tool_calls) ? m.tool_calls.find((c) => c && c.id === id) : null;
  return (call && call.function && call.function.name) || 'tool';
}

function orphanToUser(m) {
  const label = m.name || m.tool_name || 'tool';
  const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content);
  return { role: 'user', content: `[TOOL_RESULT ${label}]\n${body}` };
}

/**
 * @param {Array<object>} messages
 * @returns {{ messages: Array<object>, repaired: number }}
 */
function normalizeToolTranscript(messages) {
  const src = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const out = [];
  let repaired = 0;
  let i = 0;
  while (i < src.length) {
    const m = src[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const ids = callIds(m);
      if (!ids.length) {
        // Empty / id-less tool_calls: send a plain assistant turn.
        const { tool_calls: _drop, ...rest } = m;
        out.push({ ...rest, content: typeof rest.content === 'string' ? rest.content : (rest.content == null ? '' : rest.content) });
        repaired += 1;
        i += 1;
        continue;
      }
      out.push(m);
      const pending = new Set(ids);
      const results = [];
      const deferred = [];
      let j = i + 1;
      // Collect this call group's results; anything else (image data
      // messages, nudges) waits until the group is complete. Stop at the
      // next assistant turn.
      while (j < src.length && src[j].role !== 'assistant') {
        const n = src[j];
        if (isToolMessage(n)) {
          if (n.tool_call_id && pending.has(n.tool_call_id)) {
            pending.delete(n.tool_call_id);
            results.push(n);
          } else if (!n.tool_call_id && pending.size === 1) {
            // Legacy shape without ids: bind it to the only open call.
            const id = [...pending][0];
            pending.delete(id);
            results.push({ ...n, tool_call_id: id });
            repaired += 1;
          } else {
            deferred.push(orphanToUser(n));
            repaired += 1;
          }
        } else {
          deferred.push(n);
        }
        j += 1;
      }
      for (const id of pending) {
        results.push({ role: 'tool', tool_call_id: id, content: `[${callName(m, id)}] ${OMITTED_RESULT}` });
        repaired += 1;
      }
      // Keep the provider's expected order: results in call order.
      const order = new Map(ids.map((id, idx) => [id, idx]));
      results.sort((a, b) => (order.get(a.tool_call_id) ?? 0) - (order.get(b.tool_call_id) ?? 0));
      out.push(...results, ...deferred);
      i = j;
      continue;
    }
    if (isToolMessage(m)) {
      // No open call group: orphan.
      out.push(orphanToUser(m));
      repaired += 1;
      i += 1;
      continue;
    }
    out.push(m);
    i += 1;
  }
  return { messages: out, repaired };
}

/** True for the strict-provider errors this module exists to prevent. */
function isToolTranscriptError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /must be a response to a preceding message with 'tool_calls'|must be followed by tool messages|tool_call_id|preceding message with 'tool_calls'|no tool call with id|unexpected role 'tool'/.test(msg);
}

module.exports = { normalizeToolTranscript, isToolTranscriptError, OMITTED_RESULT };
