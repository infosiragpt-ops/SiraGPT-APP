'use strict';

/**
 * Prompted tool calling for models WITHOUT native tools.
 *
 * Tools are described in the system prompt with their FULL JSON Schemas
 * (enums, nested objects, required fields — nothing truncated), and the
 * model calls them by writing
 *
 *   <tool_call>{"name": "calculator", "arguments": {"expression": "17*23"}}</tool_call>
 *
 * The text stream is parsed incrementally: prose outside the tags streams
 * to the user as it arrives, tags never leak. Anything the model writes
 * after a hallucinated `<tool_result` is discarded (the stream is cut), so
 * results only ever come from real tool execution. Past turns are replayed
 * in the same notation, and there is no lower step cap than native mode.
 */

const { abortError, isAbortError } = require('../errors');

const OPEN_RE = /<tool_call(\s[^>]*)?>/;
const CLOSE = '</tool_call>';
const STOP_MARKERS = ['<tool_result', '<|tool_result', '<tool_response'];
const WATCH = ['<tool_call', ...STOP_MARKERS];

function repairJson(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const attempts = [text, text.replace(/,\s*([}\]])/g, '$1')];
  for (const candidate of attempts) {
    try { return { value: JSON.parse(candidate), error: null }; } catch (_) { /* next */ }
  }
  try { JSON.parse(text); } catch (err) { return { value: null, error: err.message }; }
  return { value: null, error: 'invalid JSON' };
}

function attrName(attrs) {
  const m = /name\s*=\s*"([^"]+)"|name\s*=\s*'([^']+)'/.exec(attrs || '');
  return m ? (m[1] || m[2]) : null;
}

function interpretCall(attrs, body) {
  const fromAttr = attrName(attrs);
  const parsed = repairJson(body);
  if (parsed.error) return { name: fromAttr || 'unknown', input: {}, parseError: parsed.error };
  const v = parsed.value;
  if (fromAttr) return { name: fromAttr, input: v && typeof v === 'object' && !Array.isArray(v) ? v : {} };
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.name !== 'string') {
    return { name: 'unknown', input: {}, parseError: 'se esperaba {"name": "...", "arguments": {...}}' };
  }
  const args = v.arguments ?? v.input ?? v.parameters ?? v.args ?? {};
  if (typeof args === 'string') {
    const inner = repairJson(args);
    if (inner.error) return { name: v.name, input: {}, parseError: inner.error };
    return { name: v.name, input: inner.value || {} };
  }
  return { name: v.name, input: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
}

/** Longest suffix of `text` that is a prefix of any watched marker. */
function pendingPrefixLength(text) {
  let best = 0;
  for (const marker of WATCH) {
    for (let len = Math.min(marker.length - 1, text.length); len > best; len -= 1) {
      if (marker.startsWith(text.slice(text.length - len))) { best = len; break; }
    }
  }
  return best;
}

function createToolCallStreamParser({ onText = () => {}, onCall = () => {}, idPrefix = 'ptc' } = {}) {
  let buffer = '';
  let inside = null; // { attrs }
  let stopped = false;
  let seq = 0;
  const segments = [];

  function pushText(text) {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.type === 'text') last.text += text; else segments.push({ type: 'text', text });
    onText(text);
  }

  function emitCall(attrs, body) {
    seq += 1;
    const call = { type: 'tool_call', id: `${idPrefix}_${Date.now().toString(36)}_${seq}`, ...interpretCall(attrs, body) };
    if (!call.parseError) delete call.parseError;
    segments.push(call);
    onCall(call);
  }

  const OPEN_PREFIX = '<tool_call';
  const MAX_TAG_CHARS = 300;

  function earliestStop() {
    let best = Infinity;
    for (const m of STOP_MARKERS) { const i = buffer.indexOf(m); if (i !== -1 && i < best) best = i; }
    return best;
  }

  function process() {
    while (!stopped && buffer) {
      if (!inside) {
        const stopIdx = earliestStop();
        const openIdx = buffer.indexOf(OPEN_PREFIX);
        if (stopIdx !== Infinity && (openIdx === -1 || stopIdx < openIdx)) {
          pushText(buffer.slice(0, stopIdx));
          buffer = '';
          stopped = true;
          return;
        }
        if (openIdx !== -1) {
          const next = buffer[openIdx + OPEN_PREFIX.length];
          if (next === undefined) {
            pushText(buffer.slice(0, openIdx));
            buffer = buffer.slice(openIdx);
            return;
          }
          if (next === '>' || /\s/.test(next)) {
            const rest = buffer.slice(openIdx);
            const open = OPEN_RE.exec(rest);
            if (open && open.index === 0) {
              pushText(buffer.slice(0, openIdx));
              inside = { attrs: open[1] || '' };
              buffer = rest.slice(open[0].length);
              continue;
            }
            if (rest.length <= MAX_TAG_CHARS && rest.indexOf('>') === -1) {
              pushText(buffer.slice(0, openIdx));
              buffer = rest;
              return;
            }
          }
          // Not a tag ("<tool_callx", or an unterminated monster): plain text.
          pushText(buffer.slice(0, openIdx + 1));
          buffer = buffer.slice(openIdx + 1);
          continue;
        }
        const hold = pendingPrefixLength(buffer);
        pushText(buffer.slice(0, buffer.length - hold));
        buffer = buffer.slice(buffer.length - hold);
        return;
      }
      const close = buffer.indexOf(CLOSE);
      if (close === -1) return;
      emitCall(inside.attrs, buffer.slice(0, close));
      inside = null;
      buffer = buffer.slice(close + CLOSE.length);
    }
  }

  return {
    feed(text) { if (!stopped && text) { buffer += text; process(); } return stopped; },
    end() {
      if (stopped) return segments;
      if (inside) {
        const parsed = interpretCall(inside.attrs, buffer);
        seq += 1;
        segments.push({ type: 'tool_call', id: `${idPrefix}_${Date.now().toString(36)}_${seq}`, ...parsed, ...(parsed.parseError ? { parseError: `llamada incompleta: ${parsed.parseError}` } : {}) });
        onCall(segments[segments.length - 1]);
      } else if (buffer) {
        pushText(buffer);
      }
      buffer = '';
      inside = null;
      return segments;
    },
    get stopped() { return stopped; },
    get segments() { return segments; },
  };
}

function toolsPrompt(tools) {
  const lines = [
    '# Tools',
    'You can call the tools below. To call one, write EXACTLY this block (you may write several blocks in one reply to run independent calls in parallel):',
    '<tool_call>{"name": "<tool name>", "arguments": { ...arguments matching the tool input schema... }}</tool_call>',
    'Rules:',
    '- The content between the tags must be a single valid JSON object. Do not wrap it in code fences.',
    '- After your tool_call blocks, STOP writing. The system runs the tools and replies with <tool_result> blocks. Never write <tool_result> yourself and never invent results.',
    '- When you have everything you need, answer the user normally, without any tool_call block.',
    '- If a result says error, read it, fix the arguments and try again, or explain the problem to the user.',
    '',
    '## Available tools',
  ];
  for (const t of tools) {
    lines.push(`### ${t.name}`);
    if (t.description) lines.push(t.description);
    lines.push(`Input schema: ${JSON.stringify(t.input_schema || { type: 'object', properties: {} })}`);
    lines.push('');
  }
  return lines.join('\n');
}

function serializeCall(b) {
  return `<tool_call>${JSON.stringify({ name: b.name, arguments: b.input || {} })}</tool_call>`;
}

function escapeResult(text) {
  return String(text == null ? '' : text).replace(/<\/tool_result>/g, '</tool_result_>');
}

/** Rewrite canonical history into text-only messages in the prompted notation. */
function toPromptedMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const content = [];
      let text = '';
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === 'thinking') content.push(b);
        else if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_call') text += (text && !text.endsWith('\n') ? '\n' : '') + serializeCall(b);
      }
      if (text) content.push({ type: 'text', text });
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const text = (m.content || []).filter((b) => b && b.type === 'tool_result').map((b) => (
        `<tool_result id="${b.toolCallId}" name="${b.name || ''}" status="${b.isError ? 'error' : 'ok'}">\n${escapeResult(b.content)}\n</tool_result>`
      )).join('\n');
      out.push({ role: 'user', content: [{ type: 'text', text }] });
    } else {
      out.push(m);
    }
  }
  return out;
}

function createPromptedXmlAdapter({ inner, name = 'prompted-xml' } = {}) {
  if (!inner || typeof inner.streamTurn !== 'function') throw new TypeError('prompted-xml needs an inner text adapter');

  async function streamTurn(args) {
    const { system, messages, tools = [], toolChoice, signal, emit = () => {}, model } = args;
    const useTools = Array.isArray(tools) && tools.length > 0 && toolChoice !== 'none';
    const fullSystem = useTools ? [system, toolsPrompt(tools)].filter(Boolean).join('\n\n') : system;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw abortError();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    let thinking = '';
    const parser = createToolCallStreamParser({
      onText: (text) => emit({ type: 'text_delta', text }),
      onCall: (call) => {
        emit({ type: 'tool_call_start', id: call.id, name: call.name });
        emit({ type: 'tool_call_end', id: call.id, name: call.name, input: call.input, parseError: call.parseError || null });
      },
    });
    let result = null;
    let cutByUs = false;
    try {
      result = await inner.streamTurn({
        ...args,
        system: fullSystem,
        messages: toPromptedMessages(messages),
        tools: [],
        toolChoice: undefined,
        signal: controller.signal,
        emit: (ev) => {
          if (ev.type === 'text_delta') {
            if (!useTools) { parser.segments.push({ type: 'text', text: ev.text }); emit(ev); return; }
            const stopped = parser.feed(ev.text);
            if (stopped && !cutByUs) { cutByUs = true; controller.abort(); }
          } else if (ev.type === 'thinking_delta') {
            thinking += ev.text;
            emit(ev);
          } else if (ev.type !== 'tool_call_start' && ev.type !== 'tool_input_delta' && ev.type !== 'tool_call_end') {
            emit(ev);
          }
        },
      });
    } catch (err) {
      // We cut the stream ourselves after a hallucinated <tool_result>: the
      // parsed prefix is the turn. Any other failure (or a caller abort) is real.
      if (!cutByUs || (signal && signal.aborted) || !(isAbortError(err) || controller.signal.aborted)) throw err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    const segments = useTools ? parser.end() : parser.segments.reduce((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && last.type === 'text' && s.type === 'text') last.text += s.text; else acc.push({ ...s });
      return acc;
    }, []);
    const content = [];
    const innerThinking = result && Array.isArray(result.content) ? result.content.filter((b) => b.type === 'thinking') : [];
    if (innerThinking.length) content.push(...innerThinking);
    else if (thinking) content.push({ type: 'thinking', text: thinking, origin: { adapter: inner.name, model } });
    for (const s of segments) if (!(s.type === 'text' && !s.text)) content.push(s);
    const hasCalls = content.some((b) => b.type === 'tool_call');
    const stopReason = hasCalls ? 'tool_use' : ((result && result.stopReason) || 'end_turn');
    return { content, stopReason: stopReason === 'tool_use' && !hasCalls ? 'end_turn' : stopReason, usage: (result && result.usage) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }

  return { name, provider: inner.provider, streamTurn, prompted: true, appendOnlyHistory: () => false };
}

module.exports = { createPromptedXmlAdapter, createToolCallStreamParser, toolsPrompt, toPromptedMessages, interpretCall };
