/**
 * react-agent — an iterative Thought → Action → Observation loop over
 * a pluggable tool registry, driven by OpenAI tool/function calling.
 *
 * Shape:
 *   run(openai, { query, tools, maxSteps, onStep })
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
 * `onStep(step)` fires for every Thought / Action / Observation triple,
 * so a caller can stream progress to the UI. The full trace is also
 * returned, for logging / replay.
 *
 * Why roll a loop instead of using the Assistants API:
 *   - Assistants is a stateful resource with its own lifecycle; we want
 *     stateless, predictable runs that are easy to test and deploy.
 *   - This gives us full control over the tool-call budget, the system
 *     prompt, and the failure semantics.
 */

const DEFAULT_MAX_STEPS = 8;
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

/**
 * Execute a single tool by name. Errors are caught and returned as a
 * structured observation so the model can read them in the next turn
 * and course-correct, rather than throwing out of the loop.
 */
async function dispatchTool(registry, name, argsRaw, ctx) {
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
 */
async function run(openai, opts) {
  const {
    query,
    tools,
    maxSteps = DEFAULT_MAX_STEPS,
    onStep = () => {},
    ctx = {},
    model = 'gpt-4o',
    extraSystem = '',
  } = opts;

  if (!query) throw new Error('react-agent: query is required');
  if (!Array.isArray(tools)) throw new Error('react-agent: tools must be an array');

  // `finalize` is always present. Even if a caller forgets to include
  // it in their toolset, the agent still has a way to terminate
  // cleanly — otherwise we'd have to resort to forced stops.
  const registry = tools.concat([{
    name: 'finalize',
    description: 'Emit the final answer to the user and stop. Call this when you have enough evidence.',
    parameters: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The final answer, in markdown.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your confidence level.' },
      },
      required: ['answer'],
      additionalProperties: false,
    },
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

  for (let step = 0; step < maxSteps; step++) {
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
      });
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
      // contract (must use finalize) — we treat the plain content as
      // the final answer but flag the unusual termination.
      finalAnswer = thought || '(agent returned empty message)';
      stoppedReason = 'plain_text_finalize';
      steps.push({ step, thought, actions: [] });
      onStep({ step, thought, actions: [] });
      break;
    }

    const stepRecord = { step, thought, actions: [] };
    let finalized = false;

    for (const call of toolCalls) {
      const toolName = call.function?.name;
      const dispatch = await dispatchTool(registry, toolName, call.function?.arguments, ctx);

      const observation = dispatch.error
        ? { error: dispatch.error }
        : dispatch.result;

      stepRecord.actions.push({ tool: toolName, args: call.function?.arguments || '', observation });

      // Feed the observation back as a tool message so the next model
      // call sees what happened. OpenAI requires tool messages to
      // reference the originating tool_call_id.
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(observation).slice(0, 8000), // cap to avoid blowing context
      });

      if (toolName === 'finalize' && !dispatch.error) {
        finalAnswer = dispatch.result?.answer || '';
        stoppedReason = 'finalized';
        finalized = true;
        break;
      }
    }

    steps.push(stepRecord);
    onStep(stepRecord);

    if (finalized) break;
  }

  return { finalAnswer, steps, stoppedReason };
}

module.exports = { run, DEFAULT_MAX_STEPS, SYSTEM_PROMPT };
