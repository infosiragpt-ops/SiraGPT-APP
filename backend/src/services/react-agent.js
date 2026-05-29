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
const Ajv = require('ajv');
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
      parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: true },
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
  const MAX_TOOL_ERRORS = 5; // consecutive errors → abort

  for (let step = 0; step < maxSteps; step++) {
    if (ctx?.signal?.aborted) {
      stoppedReason = 'aborted';
      break;
    }
    if (Date.now() - startedAt > maxRuntimeMs) {
      stoppedReason = 'runtime_budget_exhausted';
      break;
    }

    // If we're at the last step, force a finalize by narrowing the
    // tool choice — the model can't keep exploring past the budget.
    const isLast = step === maxSteps - 1;
    const toolChoice = isLast
      ? { type: 'function', function: { name: 'finalize' } }
      : 'auto';

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
      const dispatch = await dispatchTool(registry, toolName, call.function?.arguments, ctx);

      let observation = dispatch.error
        ? { error: dispatch.error }
        : dispatch.result;

      // Track consecutive tool errors per tool to prevent infinite loops
      if (dispatch.error) {
        const errCount = (toolErrorBudget.get(toolName) || 0) + 1;
        toolErrorBudget.set(toolName, errCount);
        if (errCount >= MAX_TOOL_ERRORS) {
          stoppedReason = `tool_error_limit:${toolName}`;
          finalAnswer = `No se pudo completar la tarea: la herramienta ${toolName} falló ${errCount} veces consecutivas.`;
          finalized = true;
          break;
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

  return { finalAnswer, steps, stoppedReason };
}

module.exports = { run, DEFAULT_MAX_STEPS, DEFAULT_MAX_RUNTIME_MS, SYSTEM_PROMPT };
