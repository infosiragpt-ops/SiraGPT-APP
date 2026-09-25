'use strict';

/**
 * Context-window aware history budgeting for the harness loop.
 *
 * Token counts are estimated (chars / 3.5 — slightly pessimistic for
 * Spanish text and JSON, so we trim before the provider rejects). Trimming
 * order, cheapest information first:
 *   1. clear the oldest tool RESULTS (keeping the latest ones intact),
 *   2. drop whole leading conversation rounds (a round starts at a user
 *      message that is not a tool-result carrier),
 *   3. hard-cap the remaining oversized tool results.
 *
 * Models with preserved thinking (Claude Fable 5.x / Opus 5.5) reject an
 * edited history, so callers pass `appendOnly: true`: nothing is edited
 * and the result reports `overflow` instead.
 */

const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1_600;
const CLEARED_MARKER = (n) => `[resultado anterior omitido para ahorrar contexto: ${n} caracteres]`;

function estimateTextTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function blockTokens(block) {
  if (!block) return 0;
  if (typeof block === 'string') return estimateTextTokens(block);
  switch (block.type) {
    case 'text': return estimateTextTokens(block.text);
    case 'thinking': return estimateTextTokens(block.text) + (block.signature ? 60 : 0);
    case 'image': return IMAGE_TOKENS;
    case 'tool_call': return estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input || {})) + 8;
    case 'tool_result': return estimateTextTokens(block.content) + 8;
    default: return estimateTextTokens(JSON.stringify(block));
  }
}

function estimateMessageTokens(message) {
  if (!message) return 0;
  const content = message.content;
  const base = 4;
  if (typeof content === 'string') return base + estimateTextTokens(content);
  if (!Array.isArray(content)) return base;
  return base + content.reduce((sum, b) => sum + blockTokens(b), 0);
}

function estimateToolsTokens(tools = []) {
  return (tools || []).reduce((sum, t) => sum + estimateTextTokens(t.name) + estimateTextTokens(t.description) + estimateTextTokens(JSON.stringify(t.input_schema || {})) + 10, 0);
}

function estimateRequestTokens({ system = '', messages = [], tools = [] } = {}) {
  return estimateTextTokens(system) + estimateToolsTokens(tools) + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
}

function isRoundStart(message) {
  if (!message || message.role !== 'user') return false;
  const content = message.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((b) => b && b.type !== 'tool_result');
}

/**
 * @param {object} args
 * @param {Array}  args.messages       canonical harness messages
 * @param {string} [args.system]
 * @param {Array}  [args.tools]
 * @param {number} args.contextWindow  model context window in tokens
 * @param {number} [args.reserveOutput] tokens kept free for the answer
 * @param {number} [args.keepRecentToolResults] newest tool results never cleared
 * @param {boolean} [args.appendOnly]  never edit history (preserved thinking)
 * @returns {{ messages: Array, tokens: number, budget: number, trimmed: boolean, overflow: boolean, actions: string[] }}
 */
function fitToContext({ messages = [], system = '', tools = [], contextWindow = 128_000, reserveOutput = 8_192, keepRecentToolResults = 2, appendOnly = false } = {}) {
  const budget = Math.max(1_024, Math.floor(contextWindow * 0.92) - reserveOutput);
  const fixed = estimateTextTokens(system) + estimateToolsTokens(tools);
  let working = messages;
  const total = () => fixed + working.reduce((s, m) => s + estimateMessageTokens(m), 0);
  let tokens = total();
  const actions = [];
  if (tokens <= budget) return { messages: working, tokens, budget, trimmed: false, overflow: false, actions };
  if (appendOnly) return { messages: working, tokens, budget, trimmed: false, overflow: true, actions: ['append_only'] };

  working = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content }));

  // 1) Clear oldest tool results, newest `keepRecentToolResults` stay intact.
  const resultRefs = [];
  working.forEach((m, mi) => {
    if (m.role === 'tool' && Array.isArray(m.content)) m.content.forEach((b, bi) => { if (b.type === 'tool_result') resultRefs.push([mi, bi]); });
  });
  const clearable = resultRefs.slice(0, Math.max(0, resultRefs.length - keepRecentToolResults));
  for (const [mi, bi] of clearable) {
    if (tokens <= budget) break;
    const block = working[mi].content[bi];
    const len = String(block.content || '').length;
    if (len < 200) continue;
    block.content = CLEARED_MARKER(len);
    block.cleared = true;
    tokens = total();
    actions.push('clear_tool_result');
  }

  // 2) Drop whole leading rounds, always keeping the last round.
  while (tokens > budget) {
    const starts = [];
    working.forEach((m, i) => { if (isRoundStart(m)) starts.push(i); });
    if (starts.length < 2) break;
    working = working.slice(starts[1]);
    tokens = total();
    actions.push('drop_round');
  }

  // 3) Hard-cap oversized tool results that remain (newest round).
  if (tokens > budget) {
    for (const m of working) {
      if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (tokens <= budget) break;
        const text = String(b.content || '');
        const overChars = Math.ceil((tokens - budget) * CHARS_PER_TOKEN);
        if (text.length <= 2_000) continue;
        const keep = Math.max(2_000, text.length - overChars - 200);
        b.content = `${text.slice(0, keep)}\n…[truncado para caber en el contexto: ${text.length - keep} caracteres omitidos]`;
        tokens = total();
        actions.push('cap_tool_result');
      }
    }
  }
  return { messages: working, tokens, budget, trimmed: actions.length > 0, overflow: tokens > budget, actions };
}

module.exports = {
  CHARS_PER_TOKEN,
  estimateTextTokens,
  estimateMessageTokens,
  estimateToolsTokens,
  estimateRequestTokens,
  fitToContext,
};
