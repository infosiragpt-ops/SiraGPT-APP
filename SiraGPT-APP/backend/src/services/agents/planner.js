/**
 * planner — LLM-driven decomposer that turns a user goal into an
 * ordered plan of sub-tasks.
 *
 * Why a separate planner at all? The ReAct loop in react-agent.js
 * mixes reasoning and execution in every step — the model decides
 * "what's my next tool call" based on a short thought. For simple
 * questions that's fine, but for multi-step workflows ("find X,
 * compare it with Y, write a summary") the first-order thought tends
 * to be local — the model dives into the first subproblem and may
 * never plan the others.
 *
 * Explicitly separating planning from execution, a well-studied pattern in
 * the survey literature — Plan-and-Execute, ReWOO, LLMCompiler — buys us:
 *
 *   1. Visibility: the plan is JSON, streamable to the UI.
 *   2. Determinism: the executor runs steps in order; the model
 *      doesn't have to re-derive the structure each turn.
 *   3. Tool-budget efficiency: a step has a narrow sub-goal, so fewer
 *      ReAct iterations are needed to satisfy it.
 *   4. Re-planning: on thinking=high, the executor can invoke the
 *      planner again mid-run with new observations if the initial
 *      plan looks wrong.
 *
 * The planner itself makes exactly ONE LLM call and returns a plain
 * object. It does not call tools. That's deliberate — mixing tool
 * use into planning defeats the purpose of separating them.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_STEPS = 8;
const MIN_STEPS = 1;

// ─── Prompt ────────────────────────────────────────────────────────────────

function buildPlannerPrompt(tools) {
  const toolsBlock = tools.length === 0
    ? '(no tools available — plan a single step that produces the answer directly)'
    : tools.map(t => `- ${t.name}: ${t.description}`).join('\n');

  return `You are a planning assistant. Given a user goal and a tool set, produce an ordered plan of sub-tasks that a downstream executor will run one at a time.

Reply with STRICT JSON of this shape:
{
  "plan": [
    { "step": 1, "goal": "<one-sentence sub-goal>", "tool_hint": "<optional tool name>" },
    ...
  ],
  "rationale": "<one sentence on why this plan>"
}

Rules:
- Output JSON only — no markdown, no prose outside the JSON.
- Plans should have ${MIN_STEPS}–${MAX_STEPS} steps. Prefer fewer steps; only split when sub-tasks truly need different tools or context.
- "tool_hint" is advisory — the executor may use a different tool or no tool. Leave it null if the step is reasoning-only.
- A "goal" is a sub-task the executor can finish with a small tool budget (≤ 3 tool calls). Don't make a step too broad.
- The final step must produce the answer to the user goal; do not add a "summarise" step after the answer is ready.
- Do NOT call tools yourself in this response — only describe what the executor should do.

Available tools:
${toolsBlock}`;
}

// ─── JSON extraction (duplicated intentionally) ────────────────────────────
// Rather than importing agent-core just for extractJSON, we inline a
// simpler version here. The planner does ONE call with json_object
// mode so a direct JSON.parse is almost always enough; fall back to a
// fence strip if a model goes off-script.

function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  return null;
}

// ─── Validation ────────────────────────────────────────────────────────────

function validatePlan(parsed) {
  if (!parsed || !Array.isArray(parsed.plan)) {
    return { ok: false, reason: 'response missing "plan" array' };
  }
  if (parsed.plan.length === 0) {
    return { ok: false, reason: 'empty plan' };
  }
  if (parsed.plan.length > MAX_STEPS) {
    // Soft enforcement: truncate rather than fail. A 12-step plan is
    // still useful up to step 8; refusing it forces the model into
    // another call that might not be better.
    parsed.plan = parsed.plan.slice(0, MAX_STEPS);
  }
  for (let i = 0; i < parsed.plan.length; i++) {
    const s = parsed.plan[i];
    if (!s || typeof s.goal !== 'string' || s.goal.length < 3) {
      return { ok: false, reason: `step ${i + 1} missing/invalid "goal"` };
    }
    s.step = i + 1; // normalise step numbers regardless of what the model sent
    if (s.tool_hint !== null && s.tool_hint !== undefined && typeof s.tool_hint !== 'string') {
      s.tool_hint = null;
    }
  }
  return { ok: true, plan: parsed };
}

// ─── Main ──────────────────────────────────────────────────────────────────

/**
 * Produce a plan for `goal`.
 *
 * @param {object} openai — OpenAI client
 * @param {object} opts
 * @param {string} opts.goal — the user's request
 * @param {Array}  [opts.tools=[]] — [{ name, description }]
 * @param {string} [opts.model='gpt-4o-mini']
 * @param {object} [opts.context]  — prior observations to feed in on re-plan
 *
 * @returns {Promise<{
 *   plan:      Array<{ step: number, goal: string, tool_hint: string|null }>,
 *   rationale: string,
 *   rawTokens: number,
 * }>}
 *
 * Throws on LLM errors (caller decides how to fallback — usually by
 * downgrading thinking level to 'low' and running bare ReAct instead).
 */
async function plan(openai, { goal, tools = [], model = DEFAULT_MODEL, context = null }) {
  if (!openai) throw new Error('planner.plan: openai client required');
  if (!goal) throw new Error('planner.plan: goal required');

  const system = buildPlannerPrompt(tools);
  const messages = [{ role: 'system', content: system }];

  if (context) {
    // Re-plan mode: previous step results are given back as a user
    // message so the model can incorporate them without us having to
    // re-send the whole transcript.
    messages.push({
      role: 'user',
      content: `Original goal: ${goal}\n\nProgress so far:\n${JSON.stringify(context, null, 2)}\n\nProduce an updated plan for the remaining work. If the original plan is still fine, repeat the remaining steps verbatim.`,
    });
  } else {
    messages.push({ role: 'user', content: goal });
  }

  const resp = await openai.chat.completions.create({
    model,
    messages,
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 900,
  });

  const raw = resp.choices?.[0]?.message?.content || '';
  const parsed = extractJSON(raw);
  const check = validatePlan(parsed);
  if (!check.ok) {
    throw new Error(`planner: invalid response — ${check.reason}. Raw: ${raw.slice(0, 300)}`);
  }
  return {
    plan: check.plan.plan,
    rationale: typeof check.plan.rationale === 'string' ? check.plan.rationale : '',
    rawTokens: resp.usage?.total_tokens || 0,
  };
}

module.exports = {
  plan,
  buildPlannerPrompt,
  validatePlan,
  extractJSON,
  MAX_STEPS,
  MIN_STEPS,
};
