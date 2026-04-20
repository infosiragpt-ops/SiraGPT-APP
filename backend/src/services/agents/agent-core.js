/**
 * agent-core — generic LLM-based agent with the four-component
 * architecture from Liu et al., "Large Language Model-Based Agents for
 * Software Engineering: A Survey" (2024), §2.1 and §5.1:
 *
 *   Planning   — decompose a goal into sub-steps and schedule them
 *   Memory     — record thoughts, actions, observations across turns
 *   Perception — ingest inputs (we only support text here)
 *   Action     — invoke external tools to change/read the environment
 *
 * Concretely this is a ReAct loop (Yao et al., 2023):
 *   while not done and n < maxIters:
 *     think = LLM(system + memory + goal)              # plan
 *     if think.tool: obs = tools[think.tool](think.args)   # act + perceive
 *     memory.append({ think, tool, args, obs })            # memorise
 *     if think.final: return think.final
 *
 * Design choices:
 * - Tool schemas are passed to the LLM as a JSON description rather
 *   than via provider-specific "function calling" because we want the
 *   same agent code to work across OpenAI, Anthropic, and Azure without
 *   per-provider branches. We pay a small output-parsing cost for it.
 * - Parsing tolerates code-fenced JSON, leading prose, and one level of
 *   nested objects — LLMs drift, the code around them shouldn't.
 * - Memory is an append-only scratchpad bounded by maxIters. If a
 *   specialist needs long-horizon memory it should layer something on
 *   top (gist-memory.js is a good companion).
 * - We NEVER throw from inside the loop. Tool errors become observations
 *   the LLM can react to; LLM errors end the loop with the last partial
 *   state. Specialists report structured success/failure.
 */

const DEFAULT_MAX_ITERS = 8;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0.1;
const MAX_OBSERVATION_CHARS = 4000;

// ─── System prompt template ────────────────────────────────────────────────

function buildSystemPrompt({ role, toolSpecs, finalSchema }) {
  const toolsBlock = toolSpecs.length === 0
    ? '(no tools available — respond directly with a final answer)'
    : toolSpecs.map(t => `- ${t.name}: ${t.description}\n  args: ${JSON.stringify(t.schema || {})}`).join('\n');

  const finalBlock = finalSchema
    ? `\n\nWhen you are ready to finish, reply with:\n${JSON.stringify({ final: finalSchema }, null, 2)}`
    : `\n\nWhen you are ready to finish, reply with:\n{"final": "<your final answer>"}`;

  return `${role}

On each turn, reply with STRICT JSON of one of these shapes:
{"thought":"<one sentence on what to do next>","tool":"<tool_name>","args":{...}}
{"thought":"<one sentence>","final":<your result>}

Available tools:
${toolsBlock}
${finalBlock}

Rules:
- Output JSON only. No markdown, no prose outside the JSON.
- Prefer calling a tool when you need data. Prefer finalising when you have enough.
- If a tool errors, read the observation and try a different approach.`;
}

// ─── JSON extraction (robust) ──────────────────────────────────────────────

function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  // Direct parse first — fastest path, works for well-behaved models.
  try { return JSON.parse(trimmed); } catch {}

  // Strip code fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  // Fall back to grabbing the first balanced {...} block. We balance
  // naively — good enough because tool args rarely contain nested JSON
  // strings with escaped braces.
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = trimmed.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

// ─── Memory / trace ────────────────────────────────────────────────────────

class AgentTrace {
  constructor() { this.steps = []; }
  append(step) { this.steps.push({ ...step, at: Date.now() }); }
  toMessages() {
    // Render the trace as an alternating user/assistant scratchpad so the
    // next turn sees the history. We keep it terse — long trace text is
    // the single biggest reason agents run out of context.
    return this.steps.flatMap((s, i) => {
      const msgs = [];
      if (s.think) msgs.push({ role: 'assistant', content: JSON.stringify({ thought: s.think, ...(s.tool ? { tool: s.tool, args: s.args } : {}) }) });
      if (s.observation !== undefined) {
        const obs = typeof s.observation === 'string'
          ? s.observation
          : JSON.stringify(s.observation);
        msgs.push({ role: 'user', content: `Observation: ${obs.slice(0, MAX_OBSERVATION_CHARS)}` });
      }
      return msgs;
    });
  }
}

// ─── Main run() ────────────────────────────────────────────────────────────

/**
 * Run an agent to completion against a goal.
 *
 * @param {object} args
 * @param {object} args.openai — OpenAI-shaped client (required)
 * @param {string} args.role — the agent's role / persona
 * @param {string} args.goal — the task description (user-facing)
 * @param {Array}  [args.tools=[]] — [{ name, description, schema, handler(args, ctx) }]
 * @param {number} [args.maxIters=8]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.temperature=0.1]
 * @param {object} [args.context={}] — opaque object forwarded to tool.handler as ctx
 * @param {object} [args.finalSchema] — optional shape hint for the final answer
 *
 * @returns {Promise<{
 *   final: any|null,          // whatever the agent put under "final"
 *   trace: Array,             // full step-by-step record
 *   iterations: number,
 *   terminatedBy: 'final'|'maxIters'|'error'
 * }>}
 */
async function run({
  openai, role, goal, tools = [],
  maxIters = DEFAULT_MAX_ITERS, model = DEFAULT_MODEL, temperature = DEFAULT_TEMPERATURE,
  context = {}, finalSchema = null,
}) {
  if (!openai) throw new Error('agent-core.run: openai client is required');
  if (!goal) throw new Error('agent-core.run: goal is required');

  const toolSpecs = tools.map(t => ({ name: t.name, description: t.description, schema: t.schema }));
  const toolByName = new Map(tools.map(t => [t.name, t]));

  const system = buildSystemPrompt({
    role: role || 'You are a helpful software engineering assistant.',
    toolSpecs,
    finalSchema,
  });

  const trace = new AgentTrace();
  let terminatedBy = 'maxIters';
  let final = null;
  let n = 0;

  for (n = 1; n <= maxIters; n++) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Goal: ${goal}` },
      ...trace.toMessages(),
    ];

    let raw;
    try {
      const resp = await openai.chat.completions.create({
        model, temperature, max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages,
      });
      raw = resp.choices?.[0]?.message?.content || '';
    } catch (err) {
      trace.append({ error: `LLM call failed: ${err.message}` });
      terminatedBy = 'error';
      break;
    }

    const parsed = extractJSON(raw);
    if (!parsed) {
      // Couldn't parse — inject an observation and let the model recover.
      trace.append({ think: '(unparseable output)', observation: 'Your last reply was not valid JSON. Reply again with STRICT JSON only.' });
      continue;
    }

    if (parsed.final !== undefined) {
      final = parsed.final;
      trace.append({ think: parsed.thought || '', final });
      terminatedBy = 'final';
      break;
    }

    const toolName = parsed.tool;
    const tool = toolName ? toolByName.get(toolName) : null;
    if (!tool) {
      trace.append({
        think: parsed.thought || '',
        tool: toolName || null,
        args: parsed.args,
        observation: toolName ? `Unknown tool "${toolName}". Available: ${toolSpecs.map(t => t.name).join(', ')}` : 'No tool specified. Either call a tool or return {"final": ...}.',
      });
      continue;
    }

    let observation;
    try {
      observation = await tool.handler(parsed.args || {}, context);
    } catch (err) {
      observation = { error: err.message || 'tool error' };
    }

    trace.append({
      think: parsed.thought || '',
      tool: toolName,
      args: parsed.args,
      observation,
    });
  }

  return {
    final,
    trace: trace.steps,
    iterations: n > maxIters ? maxIters : n,
    terminatedBy,
  };
}

module.exports = {
  run,
  AgentTrace,
  extractJSON,
  buildSystemPrompt,
  DEFAULT_MAX_ITERS,
  DEFAULT_MODEL,
};
