'use strict';

/**
 * prompted-tool-calling — rung 2 of the tool-calling fallback ladder.
 *
 * Models WITHOUT native OpenAI-style function calling (direct Anthropic,
 * Mistral, older OSS hosts, anything not on the modelSupportsFunctionCalling
 * allowlist) used to be hard-excluded from the agentic chat loop. This module
 * lets ANY chat-completions model drive the react-agent loop by:
 *
 *   1. Describing the tool registry inside the system prompt with ONE strict
 *      output protocol (a fenced ```tool_call JSON block) and a worked
 *      example — per the SWE-agent ACI findings (arXiv:2405.15793): few
 *      simple actions with concise docs beat rich schemas on weak models.
 *   2. Converting the loop's canonical message trace (assistant.tool_calls +
 *      role:'tool' observations) into a provider-safe transcript: tool
 *      results become labelled user messages, past tool calls are re-rendered
 *      as fenced blocks. Providers that reject `tools`/`tool_choice`/`role:
 *      "tool"` never see them.
 *   3. Parsing the model's fenced (or bare-JSON) tool calls back into the
 *      OpenAI `tool_calls` shape the loop already understands. Lenient on
 *      input, strict on what it accepts: an object must carry a tool name
 *      (validated against the registry when provided) to count as a call.
 *
 * Forced tool choice (the loop's finalize narrowing / initialToolChoice) is
 * emulated with an explicit instruction message appended to the transcript.
 *
 * Pure, deterministic, no I/O. Everything exported for unit tests.
 */

const FENCED_CALL_RE = /```(?:tool_call|json)\s*\n?([\s\S]*?)```/gi;

const MAX_TOOL_DESC_CHARS = 220;
const MAX_SCHEMA_CHARS = 400;

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

function safeParseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

/**
 * Compact, LLM-facing one-liner for a JSON Schema: property names with type
 * and required markers. Weak models follow this far better than raw schemas.
 */
function describeSchema(parameters) {
  if (!parameters || typeof parameters !== 'object' || !parameters.properties) return '{}';
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
  const parts = Object.entries(parameters.properties).map(([key, prop]) => {
    const type = prop && prop.type ? prop.type : 'any';
    const req = required.has(key) ? '' : '?';
    return `"${key}"${req}: ${type}`;
  });
  return truncate(`{ ${parts.join(', ')} }`, MAX_SCHEMA_CHARS);
}

/**
 * System-prompt block describing the registry + the tool_call protocol.
 * @param {Array<{name:string,description:string,parameters:object}>} registry
 */
function buildPromptedToolsBlock(registry) {
  const tools = (Array.isArray(registry) ? registry : []).filter((t) => t && t.name);
  const lines = tools.map((t) => `- ${t.name}: ${truncate(t.description, MAX_TOOL_DESC_CHARS)}\n  args: ${describeSchema(t.parameters)}`);
  return [
    'TOOL-CALL PROTOCOL (this runtime has no native function calling — follow this EXACTLY):',
    'To use a tool, end your message with one fenced block per call, nothing after it:',
    '```tool_call',
    '{"tool": "<tool_name>", "args": { ... }}',
    '```',
    'Rules:',
    '- Write a 1-2 sentence thought BEFORE the block, then the block(s). No text after the last block.',
    '- "tool" must be EXACTLY one of the names listed below. "args" must be a single JSON object matching that tool\'s args.',
    '- One step at a time: emit at most 3 tool_call blocks per message, and only when they are independent.',
    '- After each call you will receive a message starting with [TOOL_RESULT]. Read it before deciding the next step.',
    '- To deliver the final answer, call the `finalize` tool the same way: {"tool": "finalize", "args": {"answer": "<markdown>"}}. Never write the final answer as plain prose without finalize.',
    '',
    'Worked example:',
    'Necesito datos actuales, así que busco primero.',
    '```tool_call',
    '{"tool": "web_search", "args": {"query": "tipo de cambio dolar peru hoy"}}',
    '```',
    '',
    'Available tools:',
    ...lines,
  ].join('\n');
}

/**
 * Scan text for balanced top-level {...} candidates (used when the model
 * forgets the fence). Returns raw JSON-looking substrings, best-effort.
 */
function extractBareJsonObjects(text) {
  const out = [];
  const s = String(text || '');
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function toToolCall(obj, index) {
  if (!obj || typeof obj !== 'object') return null;
  const name = obj.tool || obj.name || (obj.function && (obj.function.name || obj.function)) || null;
  if (!name || typeof name !== 'string') return null;
  const rawArgs = obj.args != null ? obj.args : (obj.arguments != null ? obj.arguments : (obj.parameters != null ? obj.parameters : {}));
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
  return {
    id: `call_prompted_${index}_${name}`.slice(0, 60),
    type: 'function',
    function: { name, arguments: args },
  };
}

/**
 * Whether content looks like it carries a prompted tool call (cheap check).
 */
function hasPromptedToolCalls(content) {
  const s = String(content || '');
  return /```(?:tool_call|json)/i.test(s) || /"tool"\s*:\s*"/.test(s);
}

/**
 * Parse fenced ```tool_call / ```json blocks (or bare JSON objects carrying a
 * "tool" key) into OpenAI-shaped tool_calls. When `knownNames` is provided,
 * objects naming an unregistered tool are ignored — that keeps ordinary JSON
 * the model quotes in prose from being mistaken for a call.
 *
 * @returns {{toolCalls: Array, cleanedContent: string}}
 */
function parsePromptedToolCalls(content, knownNames = null) {
  const text = String(content == null ? '' : content);
  const known = knownNames instanceof Set ? knownNames : (Array.isArray(knownNames) ? new Set(knownNames) : null);
  const toolCalls = [];
  let cleaned = text;

  // `requireKnown=false`: any syntactically-valid tool_call is consumed (its
  // markup must be stripped from the visible answer — an explicit ```tool_call```
  // fence is protocol, not prose) but only REGISTERED tools are added to
  // toolCalls. `requireKnown=true` is the conservative mode for bare JSON, where
  // a stray prose object with a "tool" key should be left alone unless it names
  // a real tool. Fixes raw tool_call markup leaking into the user's answer when
  // the model named an unknown/misspelled tool.
  const handle = (rawJson, requireKnown) => {
    let obj;
    try { obj = JSON.parse(rawJson); } catch { return false; }
    const call = toToolCall(obj, toolCalls.length);
    if (!call) return false;
    const isKnown = !known || known.has(call.function.name);
    if (requireKnown && !isKnown) return false;
    if (isKnown) toolCalls.push(call);
    return true;
  };

  FENCED_CALL_RE.lastIndex = 0;
  let m;
  const consumedFences = [];
  while ((m = FENCED_CALL_RE.exec(text)) !== null) {
    if (handle((m[1] || '').trim(), false)) consumedFences.push(m[0]);
  }
  for (const fence of consumedFences) cleaned = cleaned.replace(fence, ' ');

  if (toolCalls.length === 0) {
    for (const candidate of extractBareJsonObjects(text)) {
      if (!/"(?:tool|name)"\s*:/.test(candidate)) continue;
      if (handle(candidate, true)) cleaned = cleaned.replace(candidate, ' ');
    }
  }

  cleaned = cleaned.replace(/```\s*```/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { toolCalls, cleanedContent: cleaned };
}

/**
 * Convert the loop's canonical messages (assistant.tool_calls + role:'tool')
 * into a transcript every chat-completions provider accepts:
 *   - assistant tool calls are re-rendered as fenced tool_call blocks,
 *   - role:'tool' observations become user messages labelled with the tool
 *     name (resolved via the preceding assistant's call ids),
 *   - an optional forced-tool instruction is appended (emulates tool_choice).
 */
function toPromptedTranscript(messages, { forceToolName = null } = {}) {
  const idToName = new Map();
  const out = [];
  for (const msg of (Array.isArray(messages) ? messages : [])) {
    if (!msg || !msg.role) continue;
    if (msg.role === 'assistant') {
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const c of calls) {
        if (c && c.id && c.function && c.function.name) idToName.set(c.id, c.function.name);
      }
      const blocks = calls.map((c) => {
        const payload = { tool: c.function && c.function.name, args: safeParseArgs(c.function && c.function.arguments) };
        return '```tool_call\n' + JSON.stringify(payload) + '\n```';
      });
      const body = [String(msg.content || '').trim(), ...blocks].filter(Boolean).join('\n');
      out.push({ role: 'assistant', content: body || '(continuando)' });
      continue;
    }
    if (msg.role === 'tool') {
      const toolName = idToName.get(msg.tool_call_id) || 'tool';
      out.push({ role: 'user', content: `[TOOL_RESULT ${toolName}]\n${String(msg.content || '')}` });
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }
  if (forceToolName) {
    out.push({
      role: 'user',
      content: `[SYSTEM] You MUST now respond with exactly one \`\`\`tool_call block invoking "${forceToolName}" (a one-line thought before it is allowed, nothing after it).`,
    });
  }
  return out;
}

// ── Tool capping for prompted mode ─────────────────────────────────────────
// Weak / non-native models depend on harness quality far more than flagships:
// a ~70-tool catalog rendered as prose overwhelms them. Keep a small, ordered
// core (search → read → docs → create) plus any pinned intent tools.
const PROMPTED_MAX_TOOLS_DEFAULT = 10;
const PROMPTED_PREFERRED_ORDER = Object.freeze([
  'web_search', 'read_url', 'web_extract',
  'rag_retrieve', 'search_docs', 'docintel_analyze',
  'python_exec', 'create_document',
  'generate_image', 'create_chart', 'create_mermaid_diagram',
  'generate_video', 'generate_speech', 'generate_music',
  'memory_recall', 'session_search',
]);

function promptedMaxTools() {
  const v = Number(process.env.SIRAGPT_PROMPTED_MAX_TOOLS);
  return Number.isFinite(v) && v >= 4 ? Math.floor(v) : PROMPTED_MAX_TOOLS_DEFAULT;
}

/**
 * Deterministically cap a toolset for prompted mode. `pinned` names (media
 * intent tool, forced initial tool, file tools) are always kept first.
 */
function capToolsForPrompted(tools, { pinned = [], max = promptedMaxTools() } = {}) {
  const list = (Array.isArray(tools) ? tools : []).filter((t) => t && t.name);
  if (list.length <= max) return list;
  const byName = new Map(list.map((t) => [t.name, t]));
  const kept = new Map();
  for (const name of pinned) {
    if (byName.has(name) && !kept.has(name)) kept.set(name, byName.get(name));
  }
  for (const name of PROMPTED_PREFERRED_ORDER) {
    if (kept.size >= max) break;
    if (byName.has(name) && !kept.has(name)) kept.set(name, byName.get(name));
  }
  for (const t of list) {
    if (kept.size >= max) break;
    if (!kept.has(t.name)) kept.set(t.name, t);
  }
  return Array.from(kept.values());
}

module.exports = {
  buildPromptedToolsBlock,
  parsePromptedToolCalls,
  hasPromptedToolCalls,
  toPromptedTranscript,
  capToolsForPrompted,
  promptedMaxTools,
  // Exposed for unit tests:
  describeSchema,
  extractBareJsonObjects,
  PROMPTED_PREFERRED_ORDER,
  PROMPTED_MAX_TOOLS_DEFAULT,
};
