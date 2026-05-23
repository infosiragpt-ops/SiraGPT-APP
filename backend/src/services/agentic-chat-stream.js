/**
 * agentic-chat-stream — wraps the react-agent loop into the same SSE
 * contract the main chat route already speaks (`{content}` / `{replace}`
 * / `[DONE]`), so the chat UI can show a step trace + final answer
 * without any frontend changes beyond honoring the agent-task-state
 * sentinel it already renders.
 *
 * Why this module instead of inlining the loop in ai.js:
 *   - The chat route is huge and already juggles many concerns; this
 *     keeps the agentic path testable in isolation.
 *   - The same wrapper is reusable from any route that already speaks
 *     SSE in the same dialect (slash commands, regenerate, etc).
 *
 * SSE frames emitted by `runAgenticChat`:
 *   1. {replace, content}   — agent-task-state JSON sentinel block.
 *                              Re-emitted after every step transition
 *                              so the UI's AgenticStepsRenderer can
 *                              update its timeline in place.
 *   2. {type:'stage',label} — lightweight "buscando X" / "leyendo
 *                              fuente N de M" hints. The current chat
 *                              consumer ignores stage frames safely
 *                              (it only acts on content/replace), but
 *                              they're emitted for any future consumer
 *                              that wants the verbatim labels.
 *   3. {content}            — once the agent calls `finalize`, the
 *                              final markdown answer is streamed as
 *                              regular content chunks APPENDED to the
 *                              sentinel block, so the persisted bubble
 *                              ends up as `<sentinel>\n\n<answer>`.
 *
 * The caller is responsible for writing the `data: [DONE]\n\n` sentinel
 * itself (the chat route already does this after persisting the
 * message); pass `skipDoneSentinel: true` to keep parity with the
 * existing aiService.generateStream contract.
 */

const reactAgent = require('./react-agent');
const agentTools = require('./agents/agent-tools');

const SENTINEL_FENCE_OPEN = '```agent-task-state\n';
const SENTINEL_FENCE_CLOSE = '\n```';

// Bounded by spec — task #58 calls for 6 iterations max per turn.
const DEFAULT_MAX_STEPS = 6;
// Per-turn wall clock. read_url has an 8 s cap and the loop calls a few
// of them; 90 s is generous without being a UX hazard if it hangs.
const DEFAULT_MAX_RUNTIME_MS = 90 * 1000;

const STAGE_LABELS = {
  web_search: (args) => `Buscando "${truncate(args?.query, 60)}"`,
  read_url:   (args) => `Leyendo ${prettyDomain(args?.url) || 'fuente'}`,
  finalize:   () => 'Componiendo respuesta',
};

function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function prettyDomain(url) {
  if (!url) return '';
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function safeArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); }
  catch { return {}; }
}

function stageLabelFor(toolName, args) {
  const fn = STAGE_LABELS[toolName];
  if (fn) return fn(args) || toolName;
  return `Ejecutando ${toolName}`;
}

/**
 * Whether the named provider+model supports OpenAI-style tool calling.
 * The agentic loop relies on `tool_calls` in the model response, so
 * non-function-calling models (older OSS, Anthropic without the tools
 * shim, etc.) must skip this path and fall through to plain streaming.
 *
 * We intentionally keep this allowlist conservative — being wrong here
 * means turning the feature OFF for that model, not crashing.
 */
function modelSupportsFunctionCalling(provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p === 'openai') {
    return /^(gpt-4|gpt-4o|gpt-4\.1|gpt-5|o3|o4|chatgpt|gpt-3\.5-turbo-1106|gpt-3\.5-turbo-0125)/i.test(m);
  }
  if (p === 'gemini') {
    return /^gemini-(1\.5|2|2\.5)/i.test(m);
  }
  if (p === 'openrouter') {
    // OpenRouter normalises tools across providers; the safe bets are
    // the same families as above when surfaced through OpenRouter.
    return /(openai\/(gpt-4|gpt-4o|gpt-4\.1|gpt-5|o3|o4)|google\/gemini-(1\.5|2))/i.test(m);
  }
  return false;
}

/**
 * Build the initial agent-task-state JSON the frontend's
 * AgenticStepsRenderer knows how to consume. Mirrors the shape used by
 * lib/agent-task-service.ts `initialAgentState` so the existing
 * reducers / renderers work without modification.
 */
function freshState() {
  return {
    meta: { goal: '', model: '', tools: ['web_search', 'read_url'] },
    steps: [],
    artifacts: [],
    approvals: [],
    checkpoints: [],
    qualityGates: [],
    repairs: [],
    finalText: '',
    done: false,
  };
}

function serializeSentinel(state) {
  // The renderer round-trips this through JSON.parse, so we deliberately
  // cap the payload — long observation strings would otherwise inflate
  // the persisted message body without helping the UI.
  return SENTINEL_FENCE_OPEN + JSON.stringify(state) + SENTINEL_FENCE_CLOSE;
}

async function writeSse(res, payload) {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* socket gone */
  }
}

/**
 * Run an agentic chat turn end-to-end and stream the result over `res`.
 *
 * @param {object}  opts
 * @param {object}  opts.openai     — instantiated OpenAI client (provides chat.completions.create)
 * @param {string}  opts.model      — concrete model id, e.g. "gpt-4o-mini"
 * @param {string}  opts.userQuery  — the user's prompt for this turn
 * @param {Array}   opts.history    — prior chat messages [{role,content}]
 * @param {object}  opts.res        — express Response, already SSE-headered
 * @param {AbortSignal} [opts.signal]
 * @param {number}  [opts.maxSteps=6]
 * @param {number}  [opts.maxRuntimeMs=90000]
 * @param {boolean} [opts.skipDoneSentinel=true]
 * @param {object}  [opts.toolsOverride] — for tests; defaults to
 *                                          [web_search, read_url] from agent-tools.
 * @returns {Promise<{finalAnswer:string, stoppedReason:string, steps:Array}>}
 */
async function runAgenticChat(opts) {
  const {
    openai,
    model,
    userQuery,
    history = [],
    res,
    signal,
    maxSteps = DEFAULT_MAX_STEPS,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
    skipDoneSentinel = true,
    toolsOverride = null,
  } = opts || {};

  if (!openai) throw new Error('runAgenticChat: openai client is required');
  if (!model)  throw new Error('runAgenticChat: model is required');
  if (!userQuery) throw new Error('runAgenticChat: userQuery is required');
  if (!res) throw new Error('runAgenticChat: res is required');

  const tools = toolsOverride || [
    // react-agent expects {name,description,parameters,execute(args,ctx)};
    // agent-tools entries use {schema,handler}. Adapt them inline.
    adaptAgentTool(agentTools.web_search, {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Search query, 2-12 keywords.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 15, description: 'How many hits to return. Default 5.' },
        locale:     { type: 'string', description: 'BCP-47 hint, e.g. "es-es".' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    adaptAgentTool(agentTools.read_url, {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'Absolute http(s) URL to read.' },
        maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Markdown cap. Default 12000.' },
      },
      required: ['url'],
      additionalProperties: false,
    }),
  ];

  const state = freshState();
  state.meta.goal = truncate(userQuery, 160);
  state.meta.model = model;

  // Initial sentinel — gives the UI an immediate step indicator even
  // before the first model call returns.
  state.steps.push({
    id: 'agentic-start',
    label: 'Analizando la pregunta',
    icon: 'thought',
    status: 'running',
    toolCalls: [],
  });
  await writeSse(res, { replace: true, content: serializeSentinel(state) });

  // Build the prompt: prior chat history (already context-fit by the
  // caller) becomes the agent's extraSystem so the loop sees the
  // conversation but doesn't re-stream every turn.
  const historyForPrompt = (history || [])
    .filter(m => m && typeof m === 'object' && typeof m.content !== 'undefined')
    .slice(-8) // last few turns is plenty — keeps the prompt budget honest
    .map(m => {
      const role = String(m.role || '').toLowerCase();
      const tag = role === 'assistant' ? 'ASSISTANT' : (role === 'system' ? 'SYSTEM' : 'USER');
      const txt = typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content)
          ? m.content.map(p => (p && p.type === 'text') ? p.text : '').join(' ')
          : '');
      return `${tag}: ${truncate(txt, 800)}`;
    })
    .join('\n');

  const extraSystem = [
    'Responde SIEMPRE en español, con tono profesional y cercano. No uses emojis.',
    'Cuando la pregunta requiera información reciente, hechos verificables o cifras concretas, USA `web_search` y luego `read_url` sobre los 1-3 mejores resultados antes de finalizar.',
    'Cita las fuentes al final del mensaje como una lista markdown de enlaces (`- [Título](url)`).',
    historyForPrompt ? `\nConversación previa (recortada):\n${historyForPrompt}` : '',
  ].filter(Boolean).join('\n');

  let stepCounter = 0;
  const result = await reactAgent.run(openai, {
    query: userQuery,
    tools,
    model,
    maxSteps,
    maxRuntimeMs,
    extraSystem,
    ctx: { signal },
    onStepStart: async (stepRec) => {
      stepCounter += 1;
      // Mark the previous synthetic step done.
      const last = state.steps[state.steps.length - 1];
      if (last && last.status === 'running') last.status = 'done';

      // Project each tool call as its own visible step so the timeline
      // reads "buscando X → leyendo fuente N → componiendo respuesta".
      const actions = Array.isArray(stepRec?.actions) ? stepRec.actions : [];
      if (actions.length === 0) {
        state.steps.push({
          id: `step-${stepCounter}-think`,
          label: 'Pensando',
          icon: 'thought',
          status: 'running',
          toolCalls: [],
        });
      } else {
        actions.forEach((a, idx) => {
          const args = safeArgs(a?.args);
          const label = stageLabelFor(a?.tool, args);
          state.steps.push({
            id: `step-${stepCounter}-${idx}`,
            label,
            icon: 'thought',
            status: 'running',
            toolCalls: [{ tool: a?.tool || 'unknown' }],
          });
          // Lightweight stage event for any consumer that listens.
          writeSse(res, { type: 'stage', label, tool: a?.tool || 'unknown' });
        });
      }
      await writeSse(res, { replace: true, content: serializeSentinel(state) });
    },
    onStepDone: async (stepRec) => {
      // Walk the actions in reverse and attach status to the most-recent
      // matching running step so an output lines up with its start.
      const actions = Array.isArray(stepRec?.actions) ? stepRec.actions : [];
      for (let i = actions.length - 1; i >= 0; i--) {
        const a = actions[i];
        for (let j = state.steps.length - 1; j >= 0; j--) {
          const s = state.steps[j];
          if (s.status !== 'running') continue;
          if ((s.toolCalls[0] && s.toolCalls[0].tool) !== a?.tool) continue;
          const obs = a?.observation || {};
          const ok = !obs?.error;
          s.status = ok ? 'done' : 'error';
          s.toolCalls[0].output = { ok };
          break;
        }
      }
      await writeSse(res, { replace: true, content: serializeSentinel(state) });
    },
  });

  // Mark any leftover running steps as done — react-agent guarantees a
  // finalize on the last step, but defensive coding keeps stale running
  // states from leaking into the persisted sentinel.
  for (const s of state.steps) if (s.status === 'running') s.status = 'done';
  state.done = true;

  const finalAnswer = (result?.finalAnswer || '').trim()
    || 'No pude generar una respuesta verificable. Intenta reformular la pregunta.';
  state.finalText = finalAnswer;

  // Emit the final sentinel + the answer body in two frames so the UI
  // shows the completed timeline AND the streamed answer below it.
  await writeSse(res, {
    replace: true,
    content: serializeSentinel(state) + '\n\n' + finalAnswer,
  });

  if (!skipDoneSentinel) {
    if (!res.writableEnded) {
      try { res.write('data: [DONE]\n\n'); } catch { /* socket gone */ }
    }
  }

  return {
    finalAnswer,
    stoppedReason: result?.stoppedReason || 'finalized',
    steps: result?.steps || [],
  };
}

/**
 * Adapt an entry from `agent-tools` ({name, schema, handler}) to the
 * shape react-agent expects ({name, description, parameters, execute}).
 *
 * We supply explicit JSON Schemas here (rather than reading from the
 * skill manifest) because react-agent's OpenAI tool adapter expects
 * a full schema and the agent-tools entries only carry hint strings.
 */
function adaptAgentTool(tool, jsonSchema) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema,
    execute: async (args, _ctx) => tool.handler(args, _ctx),
  };
}

/**
 * Read the runtime feature flag for the agentic chat path. Read each
 * invocation (not cached) so operators can flip it without restarting
 * the backend — a requirement for safe rollout of an unproven feature.
 */
function isEnabled() {
  const v = String(process.env.AGENTIC_TOOLS_IN_CHAT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

module.exports = {
  runAgenticChat,
  isEnabled,
  modelSupportsFunctionCalling,
  // Exposed for tests:
  _internal: {
    freshState,
    serializeSentinel,
    stageLabelFor,
    adaptAgentTool,
    SENTINEL_FENCE_OPEN,
    SENTINEL_FENCE_CLOSE,
  },
};
