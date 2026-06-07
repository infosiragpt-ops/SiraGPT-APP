/**
 * react-agent — an iterative Thought → Action → Observation loop over
 * a pluggable tool registry, driven by OpenAI tool/function calling.
 *
 * Shape:
 *   run(openai, { query, tools, maxSteps, maxRuntimeMs, onStepStart, onStepDone, onStep })
 *     → { finalAnswer, steps[], stoppedReason }
 *
 * Tools are plain objects:
 *   {
 *     name:         "web_search",          // stable identifier
 *     description:  "Free-text web search; returns JSON list of snippets",
 *     parameters:   { ...JSON Schema... }, // OpenAI tool-call format
 *     execute:      async (args, ctx) => result
 *   }
 *
 * The loop is bounded: at most `maxSteps` tool calls before we force a
 * `finalize` — this is the single most important safety property, since
 * a buggy tool or a confused model can otherwise drift forever.
 *
 * `onStepStart(step)` fires before tool execution, `onStepDone(step)`
 * fires after observations are available, and `onStep(step)` is kept
 * as the legacy completed-step callback. The full trace is returned
 * for logging / replay.
 *
 * Why roll a loop instead of using the Assistants API:
 *   - Assistants is a stateful resource with its own lifecycle; we want
 *     stateless, predictable runs that are easy to test and deploy.
 *   - This gives us full control over the tool-call budget, the system
 *     prompt, and the failure semantics.
 */

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

// ── Trace compaction ────────────────────────────────────────────────────
// The running `messages` array grows by one assistant message + one tool
// message per tool call, every step. On long autonomous runs (maxSteps
// 30–60) this overflows the model's context window, which surfaces as a
// hard `model_error` abort mid-task — the single most common way a
// multi-step run dies before it can finalize. Compaction caps the trace by
// summarizing OLDER complete rounds while preserving the head (system +
// query) and the most recent rounds verbatim, so the assistant→tool
// pairing the OpenAI API requires is never broken.
const DEFAULT_COMPACT_MAX_CHARS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_COMPACT_MAX_CHARS);
  return Number.isFinite(v) && v > 0 ? v : 60000; // ~15k tokens of trace
})();
const DEFAULT_COMPACT_TAIL_ROUNDS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_COMPACT_TAIL_ROUNDS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
})();
const COMPACT_DISABLED = process.env.SIRAGPT_REACT_COMPACT_DISABLED === '1';

// ── A2: parallel tool execution ──────────────────────────────────────────────
// Independent READ-ONLY / idempotent tool calls in a single step are dispatched
// concurrently (bounded) instead of strictly one-by-one. Mutating/stateful
// tools (bash, file writes, patches, browser actions, sub-agent spawns, the
// `finalize` sentinel) always run sequentially to avoid races. Observations are
// still processed in the model's original order, so tool_call_id pairing,
// error budgets and the finalize guard are unchanged.
const TOOL_PARALLEL_DISABLED = ['0', 'off', 'false', 'no'].includes(
  String(process.env.SIRAGPT_TOOL_PARALLEL || '').trim().toLowerCase()
);
const TOOL_PARALLEL_MAX = Math.max(2, Number(process.env.SIRAGPT_TOOL_PARALLEL_MAX) || 4);
const PARALLEL_SAFE_RX = /^(web_search|read_url|web_extract|deep_search|github_search|scientific_search|x_search|rag_retrieve|search_docs|search_code|get_symbol|list_files|read_file|list_dir|glob_files|code_grep|docintel|deep_analyze|memory_recall|session_search|session_list|session_history|sunat_)/i;

function isParallelSafeTool(name) {
  const n = String(name || '');
  return n !== 'finalize' && PARALLEL_SAFE_RX.test(n);
}

/**
 * Concurrently dispatch the read-only/idempotent tool calls of one step,
 * returning a Map<call.id, dispatchResult>. Mutating calls are skipped here
 * (they run inline, sequentially, in the main loop). Bounded by TOOL_PARALLEL_MAX.
 */
async function prefetchParallelDispatch(registry, toolCalls, ctx, exhaustedTools) {
  const out = new Map();
  if (TOOL_PARALLEL_DISABLED || !Array.isArray(toolCalls)) return out;
  const safe = toolCalls.filter((c) => {
    const n = c && c.function && c.function.name;
    return isParallelSafeTool(n) && !(exhaustedTools && exhaustedTools.has(n)) && c.id != null;
  });
  if (safe.length < 2) return out; // nothing to gain from parallelism
  for (let i = 0; i < safe.length; i += TOOL_PARALLEL_MAX) {
    const chunk = safe.slice(i, i + TOOL_PARALLEL_MAX);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(chunk.map(async (call) => {
      try {
        const d = await dispatchTool(registry, call.function?.name, call.function?.arguments, ctx);
        return { id: call.id, d };
      } catch (e) {
        return { id: call.id, d: { error: `tool_execution_failed: ${e && e.message ? e.message : String(e)}` } };
      }
    }));
    for (const r of results) if (r && r.id != null) out.set(r.id, r.d);
  }
  return out;
}

const Ajv = require('ajv');
const { sanitizeToolParameters } = require('./ai-product-os/tool-schema-sanitizer');
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
const schemaValidatorCache = new Map();
const FINALIZE_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The final answer, in markdown.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your confidence level.' },
  },
  required: ['answer'],
  additionalProperties: false,
};
const SYSTEM_PROMPT = `You are a rigorous research agent. Solve the user's request by deciding which tool to call next, observing the result, then deciding again. Keep going until you can give a confident, well-grounded answer.

Rules:
- Prefer gathering 2–3 pieces of evidence before finalizing, unless the query is trivial.
- Do NOT fabricate tool calls — only call tools that appear in the tools list.
- When you have enough evidence, call the \`finalize\` tool with a well-structured final answer (markdown). Do NOT write the final answer as plain text in the assistant message — only via \`finalize\`.
- Every tool call must be justified by a short natural-language thought in the assistant message preceding the call.
- Keep thoughts concise (1–2 sentences). Save the depth for the final answer.`;

/**
 * Turn a plain tool object into the OpenAI tool-call schema.
 */
function toOpenAITool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      // Normalize to a cross-provider-safe JSON Schema so a tool that works
      // on GPT-4o also works on weaker / stricter backends (Llama free tier,
      // Anthropic, Gemini). See tool-schema-sanitizer.js.
      parameters: sanitizeToolParameters(tool.parameters),
    },
  };
}

function stableSchemaKey(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSchemaKey).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSchemaKey(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validatorForTool(tool) {
  const schema = tool?.parameters;
  if (!schema || typeof schema !== 'object') return null;
  const cacheKey = stableSchemaKey(schema);
  if (schemaValidatorCache.has(cacheKey)) return schemaValidatorCache.get(cacheKey);
  const validator = ajv.compile(schema);
  schemaValidatorCache.set(cacheKey, validator);
  return validator;
}

function formatValidationErrors(errors = []) {
  return errors
    .map((err) => {
      const at = err.instancePath || '/';
      const detail = err.params && err.params.missingProperty
        ? `${err.message}: ${err.params.missingProperty}`
        : err.message;
      return `${at} ${detail}`.trim();
    })
    .join('; ');
}

function validateToolArgs(tool, args) {
  let validator;
  try {
    validator = validatorForTool(tool);
  } catch (err) {
    return { ok: false, error: `invalid_tool_schema: ${err.message || err}` };
  }
  if (!validator) return { ok: true };
  const ok = validator(args);
  if (ok) return { ok: true };
  return { ok: false, error: `invalid_tool_args: ${formatValidationErrors(validator.errors)}` };
}

/**
 * Execute a single tool by name. Errors are caught and returned as a
 * structured observation so the model can read them in the next turn
 * and course-correct, rather than throwing out of the loop.
 */
async function dispatchTool(registry, name, argsRaw, ctx) {
  if (ctx?.signal?.aborted) {
    return { error: 'aborted' };
  }
  if (ctx?.toolGate && name !== 'finalize') {
    const auth = ctx.toolGate.authorize(name, ctx.toolAuthCtx || {});
    if (!auth?.ok) {
      return { error: auth?.reason || 'tool_denied' };
    }
  }
  if (ctx?.checkToolBudget && name !== 'finalize') {
    const usage = ctx.toolUsageMap || {};
    const budget = ctx.checkToolBudget(name, usage);
    if (budget && budget.ok === false) {
      return { error: budget.reason || 'tool_budget_exceeded' };
    }
    usage[name] = (Number(usage[name]) || 0) + 1;
    ctx.toolUsageMap = usage;
  }
  const tool = registry.find(t => t.name === name);
  if (!tool) {
    return { error: `unknown_tool: ${name}` };
  }
  let args = {};
  try {
    args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {});
  } catch (e) {
    return { error: `invalid_json_args: ${e.message}` };
  }
  const validation = validateToolArgs(tool, args);
  if (!validation.ok) {
    return { error: validation.error };
  }
  try {
    const result = await tool.execute(args, ctx);
    return { result };
  } catch (e) {
    return { error: `tool_execution_failed: ${e.message}` };
  }
}

/**
 * Rough char-count of a message array. We use chars (not a tokenizer) on
 * purpose: it's dependency-free, deterministic, and a 4:1 char:token ratio
 * is a safe over-estimate that keeps us comfortably under context limits.
 */
function estimateMessagesChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      total += String(m && m.content ? m.content : '').length;
    }
  }
  return total;
}

/**
 * Condense a single tool observation (the JSON content of a `role:'tool'`
 * message) into a one-line gist: keep error codes verbatim, otherwise list
 * the top-level result keys. Never throws.
 */
function summarizeObservation(content) {
  let str = content;
  if (typeof str !== 'string') {
    try { str = JSON.stringify(str); } catch { return 'unserializable'; }
  }
  let obj = null;
  try { obj = JSON.parse(str); } catch { /* not JSON — fall through */ }
  if (obj && typeof obj === 'object') {
    if (obj.error) return `error=${String(obj.error).slice(0, 100)}`;
    const keys = Object.keys(obj).slice(0, 8);
    return keys.length ? `ok keys=[${keys.join(',')}]` : 'ok';
  }
  return String(str).slice(0, 120).replace(/\s+/g, ' ').trim();
}

/**
 * Summarize one "round" — an assistant message plus the tool messages that
 * answer its tool_calls — into a compact line: the thought (truncated) and
 * each `toolName→gist`.
 */
function summarizeRound(round) {
  const assistant = round.find((m) => m && m.role === 'assistant');
  const thought = assistant && typeof assistant.content === 'string'
    ? assistant.content.trim().slice(0, 140)
    : '';
  const calls = assistant && Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  const toolMsgs = round.filter((m) => m && m.role === 'tool');
  const parts = [];
  for (let i = 0; i < calls.length; i += 1) {
    const name = calls[i] && calls[i].function ? calls[i].function.name : 'tool';
    const obs = toolMsgs[i] ? summarizeObservation(toolMsgs[i].content) : '(no observation)';
    parts.push(`${name}→${obs}`);
  }
  const callSummary = parts.join('; ') || (thought ? '' : '(no tool calls)');
  if (thought && callSummary) return `${thought} | ${callSummary}`;
  return thought || callSummary;
}

/**
 * Compact a ReAct message trace so it fits a char budget without breaking
 * the OpenAI assistant→tool pairing invariant.
 *
 * Strategy:
 *   - Preserve the HEAD verbatim: every leading message up to (but not
 *     including) the first assistant turn — i.e. the system prompt and the
 *     user query.
 *   - Split the remainder into rounds at each assistant message. A round is
 *     [assistant, ...its tool/user replies], which is the atomic unit the
 *     API needs kept together.
 *   - Keep the last `tailRounds` rounds verbatim (recent context the model
 *     is actively reasoning over).
 *   - Replace the older middle rounds with ONE summary `user` message that
 *     lists what was already done, so the model keeps continuity but pays a
 *     fraction of the tokens.
 *
 * Returns the original array (same reference) when no compaction is needed
 * or when it would not actually shrink the payload — callers can cheaply
 * detect a no-op via identity.
 */
function compactMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length < 4) return messages;
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? opts.maxChars
    : DEFAULT_COMPACT_MAX_CHARS;
  const tailRounds = Number.isFinite(opts.tailRounds) && opts.tailRounds >= 1
    ? Math.floor(opts.tailRounds)
    : DEFAULT_COMPACT_TAIL_ROUNDS;

  if (estimateMessagesChars(messages) <= maxChars) return messages;

  // Head: leading non-assistant messages (system + first user query).
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd].role !== 'assistant') headEnd += 1;
  if (headEnd === 0) return messages; // malformed (no head) — leave untouched
  const head = messages.slice(0, headEnd);
  const rest = messages.slice(headEnd);

  // Split the rest into rounds at assistant boundaries.
  const rounds = [];
  let current = null;
  for (const m of rest) {
    if (m.role === 'assistant') {
      if (current) rounds.push(current);
      current = [m];
    } else if (current) {
      current.push(m);
    } else {
      current = [m];
    }
  }
  if (current) rounds.push(current);

  if (rounds.length <= tailRounds) return messages; // not enough history to fold
  const tail = rounds.slice(rounds.length - tailRounds);
  const middle = rounds.slice(0, rounds.length - tailRounds);
  if (middle.length === 0) return messages;

  const lines = middle.map((round, idx) => `  ${idx + 1}. ${summarizeRound(round)}`);
  const summaryMessage = {
    role: 'user',
    content:
      `[CONTEXTO COMPACTADO] Para no exceder la ventana de contexto se resumieron `
      + `${middle.length} pasos previos (las herramientas y observaciones recientes se `
      + `conservan completas abajo). Resumen de lo ya hecho:\n${lines.join('\n')}\n`
      + `Continúa desde aquí sin repetir trabajo ya realizado.`,
  };

  const compacted = head.concat([summaryMessage], ...tail);
  // Only adopt the compacted form if it genuinely shrinks the payload.
  if (estimateMessagesChars(compacted) >= estimateMessagesChars(messages)) return messages;
  return compacted;
}

/**
 * Build an honest, reason-aware degraded answer for a run that stopped
 * without finalizing and produced no answer of its own. Keeps the user from
 * ever receiving a silent empty "completed" message.
 */
function buildDegradedAnswer(stoppedReason) {
  const reason = String(stoppedReason || '');
  if (reason.startsWith('runtime_budget')) {
    return 'No alcancé a completar la tarea dentro del tiempo disponible. Te dejo lo procesado hasta ahora; si necesitas el resultado completo, vuelve a intentarlo o acota la solicitud.';
  }
  if (reason.startsWith('model_error')) {
    return 'Hubo un problema temporal con el modelo y no pude completar la respuesta. Por favor vuelve a intentarlo; si el problema persiste, reformula la solicitud.';
  }
  if (reason === 'aborted') {
    return 'La tarea se canceló antes de completarse.';
  }
  if (reason === 'no_message') {
    return 'El modelo no devolvió una respuesta utilizable. Por favor vuelve a intentarlo o reformula la solicitud.';
  }
  // max_steps, empty reason, guard-blocked, anything else.
  return 'No logré cerrar la tarea dentro del presupuesto de pasos disponible. Te respondo con lo que alcancé a determinar; si necesitas más profundidad, reformula la solicitud o divídela en partes más pequeñas.';
}

/**
 * Run the ReAct loop.
 *
 * @param {OpenAI} openai — an instantiated OpenAI client
 * @param {object} opts
 * @param {string} opts.query
 * @param {Array<Tool>} opts.tools
 * @param {number} [opts.maxSteps=8]
 * @param {function} [opts.onStep]
 * @param {object}   [opts.ctx]            passed as 2nd arg to every tool.execute
 * @param {string}   [opts.model="gpt-4o"] model to drive the loop
 * @param {string}   [opts.extraSystem]   appended to the system prompt (query-specific guidance)
 * @param {function} [opts.finalizeGuard] validates finalize calls before allowing termination
 * @param {string}   [opts.initialToolChoice] optional tool name to force on the first model step
 */
async function run(openai, opts) {
  const {
    query,
    tools,
    maxSteps = DEFAULT_MAX_STEPS,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
    onStepStart = () => {},
    onStepDone = () => {},
    onStep = () => {},
    ctx = {},
    model = 'gpt-4o',
    extraSystem = '',
    finalizeGuard = null,
    initialToolChoice = null,
    compactMaxChars = DEFAULT_COMPACT_MAX_CHARS,
    compactTailRounds = DEFAULT_COMPACT_TAIL_ROUNDS,
    onCompact = () => {},
  } = opts;

  if (!query) throw new Error('react-agent: query is required');
  if (!Array.isArray(tools)) throw new Error('react-agent: tools must be an array');

  // `finalize` is always present. Even if a caller forgets to include
  // it in their toolset, the agent still has a way to terminate
  // cleanly — otherwise we'd have to resort to forced stops.
  const registry = tools.concat([{
    name: 'finalize',
    description: 'Emit the final answer to the user and stop. Call this when you have enough evidence.',
    parameters: FINALIZE_TOOL_PARAMETERS,
    execute: async (args) => args, // pass-through; the loop reads this and terminates
  }]);

  const toolsSchema = registry.map(toOpenAITool);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + (extraSystem ? `\n\n${extraSystem}` : '') },
    { role: 'user',   content: query },
  ];

  const steps = [];
  let finalAnswer = null;
  let stoppedReason = 'max_steps';
  const startedAt = Date.now();

  // Prevent infinite loops when tools fail silently and the model
  // keeps making the same call. Track tool error frequency per step.
  const toolErrorBudget = new Map();
  const MAX_TOOL_ERRORS = 5; // consecutive errors → declare the tool unavailable
  // Tools that burned through their error budget. Instead of hard-aborting
  // the whole task (which dead-ends the user with "tool X failed N times in a
  // row"), we mark the tool unavailable, tell the model to answer without it,
  // and let it finalize from whatever it has. The finalize guard is told too
  // (via unavailableTools) so a required-but-broken tool stops blocking
  // termination forever. This keeps a single chat thread usable when one tool
  // (e.g. docintel_retrieve on an image or a text-less document) keeps failing.
  const exhaustedTools = new Set();

  for (let step = 0; step < maxSteps; step++) {
    if (ctx?.signal?.aborted) {
      stoppedReason = 'aborted';
      break;
    }
    if (Date.now() - startedAt > maxRuntimeMs) {
      stoppedReason = 'runtime_budget_exhausted';
      break;
    }

    // Keep the trace under the context budget. At the top of an iteration
    // the array always ends on a complete round (every assistant turn from
    // the previous step already has its tool replies appended), so folding
    // older rounds here can never orphan a tool message.
    if (!COMPACT_DISABLED) {
      const compacted = compactMessages(messages, {
        maxChars: compactMaxChars,
        tailRounds: compactTailRounds,
      });
      if (compacted !== messages && compacted.length < messages.length) {
        const removed = messages.length - compacted.length;
        messages.length = 0;
        messages.push(...compacted);
        try {
          onCompact({ step, removedMessages: removed, chars: estimateMessagesChars(messages) });
        } catch { /* telemetry must never break the loop */ }
      }
    }

    // If we're at the last step, force a finalize by narrowing the
    // tool choice — the model can't keep exploring past the budget.
    const isLast = step === maxSteps - 1;
    const shouldForceInitialTool =
      step === 0
      && initialToolChoice
      && registry.some((tool) => tool && tool.name === initialToolChoice);
    const toolChoice = isLast
      ? { type: 'function', function: { name: 'finalize' } }
      : (shouldForceInitialTool ? { type: 'function', function: { name: initialToolChoice } } : 'auto');

    let resp;
    try {
      resp = await openai.chat.completions.create({
        model,
        messages,
        tools: toolsSchema,
        tool_choice: toolChoice,
        temperature: 0.3,
      }, ctx?.signal ? { signal: ctx.signal } : undefined);
    } catch (err) {
      stoppedReason = `model_error: ${err.message}`;
      break;
    }

    const choice = resp.choices?.[0];
    const msg = choice?.message;
    if (!msg) { stoppedReason = 'no_message'; break; }

    // Persist the thought + any tool_calls so the NEXT turn has full
    // context — this is how the model "sees" its own trace.
    messages.push(msg);

    const toolCalls = msg.tool_calls || [];
    const thought = (msg.content || '').trim();

    if (toolCalls.length === 0) {
      // Model decided to answer in-place. That's a violation of the
      // contract (must use finalize). When a finalizeGuard is active,
      // do not let plain text bypass deterministic tool-use gates;
      // feed a repair instruction back into the loop instead.
      const plainStepRecord = { step, thought, actions: [] };
      if (typeof finalizeGuard === 'function') {
        let guard;
        try {
          guard = await finalizeGuard({
            answer: thought || '',
            confidence: null,
            steps: steps.concat([plainStepRecord]),
            currentStep: plainStepRecord,
            unavailableTools: Array.from(exhaustedTools),
            ctx,
          });
        } catch (err) {
          guard = { ok: false, message: `finalize guard failed: ${err.message || err}` };
        }
        if (!guard?.ok) {
          steps.push(plainStepRecord);
          onStep(plainStepRecord);
          onStepDone(plainStepRecord);
          messages.push({
            role: 'user',
            content: JSON.stringify({
              error: 'plain_text_finalize_guard_failed',
              message: guard?.message || 'Plain-text finalization blocked by execution policy.',
              missingTools: guard?.missingTools || [],
              requiredTools: guard?.requiredTools || [],
              repairInstructions: guard?.repairInstructions || 'Call the missing tools, inspect observations, then call finalize.',
            }),
          });
          continue;
        }
      }
      // With no guard, preserve legacy behavior for simple providers.
      finalAnswer = thought || '(agent returned empty message)';
      stoppedReason = 'plain_text_finalize';
      steps.push(plainStepRecord);
      onStep(plainStepRecord);
      onStepDone(plainStepRecord);
      break;
    }

    const stepRecord = { step, thought, actions: [] };
    onStepStart({
      step,
      thought,
      actions: toolCalls.map(call => ({
        tool: call.function?.name,
        args: call.function?.arguments || '',
      })),
    });
    let finalized = false;

    // A2: pre-dispatch the independent read-only tool calls of this step
    // concurrently. Their results are consumed in original order below, so
    // nothing about ordering, budgets, or the finalize guard changes.
    let prefetched = new Map();
    if (!ctx?.signal?.aborted) {
      try {
        prefetched = await prefetchParallelDispatch(registry, toolCalls, ctx, exhaustedTools);
        if (prefetched.size > 1) {
          console.log(`[react-agent] parallel-dispatched ${prefetched.size} read-only tools (step ${step})`);
        }
      } catch (_prefetchErr) { prefetched = new Map(); }
    }

    for (const call of toolCalls) {
      if (ctx?.signal?.aborted) {
        stoppedReason = 'aborted';
        finalized = true;
        break;
      }
      if (Date.now() - startedAt > maxRuntimeMs) {
        stoppedReason = 'runtime_budget_exhausted';
        finalized = true;
        break;
      }

      const toolName = call.function?.name;

      // A tool that already exhausted its error budget is unavailable: do not
      // re-invoke it (it would just fail again, wasting latency/credits).
      // Feed back a clear instruction so the model pivots to another tool or
      // finalizes with what it has.
      if (toolName !== 'finalize' && exhaustedTools.has(toolName)) {
        const observation = {
          error: 'tool_unavailable',
          tool: toolName,
          message: `The tool "${toolName}" is unavailable for this task after repeated failures. Do not call it again. Answer the user directly with the information you already have (use other tools or your own reasoning), then call finalize.`,
        };
        stepRecord.actions.push({ tool: toolName, args: call.function?.arguments || '', observation });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(observation).slice(0, 8000),
        });
        continue;
      }

      const dispatch = prefetched.has(call.id)
        ? prefetched.get(call.id)
        : await dispatchTool(registry, toolName, call.function?.arguments, ctx);

      let observation = dispatch.error
        ? { error: dispatch.error }
        : dispatch.result;

      // Track consecutive tool errors per tool to prevent infinite loops.
      if (dispatch.error) {
        const errCount = (toolErrorBudget.get(toolName) || 0) + 1;
        toolErrorBudget.set(toolName, errCount);
        if (errCount >= MAX_TOOL_ERRORS && toolName !== 'finalize') {
          // Degrade gracefully instead of dead-ending the task: declare the
          // tool unavailable and let the model finalize from what it has. The
          // finalize guard waives this tool (see unavailableTools below) so a
          // required-but-broken tool no longer blocks termination.
          exhaustedTools.add(toolName);
          stoppedReason = `tool_unavailable:${toolName}`;
          observation = {
            error: 'tool_unavailable',
            tool: toolName,
            failures: errCount,
            lastError: dispatch.error,
            message: `The tool "${toolName}" failed ${errCount} times in a row and is now unavailable. Stop calling it. Provide the best possible answer to the user directly (use other tools or your own reasoning), then call finalize.`,
          };
        }
      } else {
        toolErrorBudget.delete(toolName);
      }

      if (toolName === 'finalize' && !dispatch.error && typeof finalizeGuard === 'function') {
        const proposedAction = { tool: toolName, args: call.function?.arguments || '', observation };
        const proposedSteps = steps.concat([{ ...stepRecord, actions: stepRecord.actions.concat([proposedAction]) }]);
        let guard;
        try {
          guard = await finalizeGuard({
            answer: dispatch.result?.answer || '',
            confidence: dispatch.result?.confidence || null,
            steps: proposedSteps,
            currentStep: stepRecord,
            unavailableTools: Array.from(exhaustedTools),
            ctx,
          });
        } catch (err) {
          guard = { ok: false, message: `finalize guard failed: ${err.message || err}` };
        }
        if (!guard?.ok) {
          observation = {
            error: 'finalize_guard_failed',
            message: guard?.message || 'Finalization blocked by execution policy.',
            missingTools: guard?.missingTools || [],
            requiredTools: guard?.requiredTools || [],
            repairInstructions: guard?.repairInstructions || 'Run the missing tool calls, then call finalize again.',
          };
        }
      }

      stepRecord.actions.push({ tool: toolName, args: call.function?.arguments || '', observation });

      // Feed the observation back as a tool message so the next model
      // call sees what happened. OpenAI requires tool messages to
      // reference the originating tool_call_id.
      let obsStr;
      try {
        obsStr = JSON.stringify(observation);
      } catch {
        obsStr = JSON.stringify({ error: 'non_serializable_tool_output', type: typeof observation });
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: obsStr.slice(0, 8000), // cap to avoid blowing context
      });

      if (toolName === 'finalize' && !dispatch.error && !observation.error) {
        finalAnswer = dispatch.result?.answer || '';
        stoppedReason = 'finalized';
        finalized = true;
        break;
      }
    }

    steps.push(stepRecord);
    onStep(stepRecord);
    onStepDone(stepRecord);

    if (finalized) break;
  }

  // Safety net: NEVER return an empty/null answer. A run can stop without a
  // real finalize for many reasons — exhausted tools, max_steps, runtime
  // budget, a model error, a guard that kept rejecting. In every one of those
  // cases the old code returned `finalAnswer = null`, which on the task path
  // surfaced as a `status:'completed'` message with no body (the `if
  // (finalMarkdown)` gate dropped it). Always hand back a short, honest
  // degraded answer so the caller has something real to show.
  if (finalAnswer == null || String(finalAnswer).trim() === '') {
    if (exhaustedTools.size > 0) {
      const toolList = Array.from(exhaustedTools).join(', ');
      finalAnswer = `No pude usar ${toolList} en esta tarea (falló de forma repetida). Te respondo con la información disponible; si necesitas más precisión, vuelve a intentarlo o reformula la solicitud.`;
      if (!stoppedReason || stoppedReason === 'max_steps') {
        stoppedReason = `degraded_no_finalize:${toolList}`;
      }
    } else {
      finalAnswer = buildDegradedAnswer(stoppedReason);
      if (!stoppedReason || stoppedReason === 'max_steps') {
        stoppedReason = stoppedReason || 'degraded_no_finalize';
      }
    }
  }

  return { finalAnswer, steps, stoppedReason, exhaustedTools: Array.from(exhaustedTools) };
}

module.exports = {
  run,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_RUNTIME_MS,
  SYSTEM_PROMPT,
  // Exported for unit testing + reuse by other loops (agent-core, executor).
  compactMessages,
  estimateMessagesChars,
  DEFAULT_COMPACT_MAX_CHARS,
  DEFAULT_COMPACT_TAIL_ROUNDS,
  // A2: parallel tool execution (exported for tests).
  isParallelSafeTool,
  prefetchParallelDispatch,
  TOOL_PARALLEL_MAX,
};
