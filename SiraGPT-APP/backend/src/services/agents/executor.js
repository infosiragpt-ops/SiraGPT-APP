/**
 * executor — walks a plan produced by planner.js, running each step as
 * a bounded ReAct sub-loop.
 *
 * The executor is deliberately small: it orchestrates per-step ReAct
 * invocations, accumulates observations, and emits structured progress
 * events. Everything about tool selection, retries, and finalisation
 * is delegated to react-agent so we only have one place in the
 * codebase that understands the nuances of OpenAI tool-calling.
 *
 * Re-planning (thinking=high) is handled here because it's a plan-level
 * concern: between steps, if observations diverge from assumptions,
 * we can ask the planner for an updated plan of the remaining work.
 * This is capped (MAX_REPLANS) so a shaky model can't burn the
 * session's LLM budget looping through plans.
 */

const reactAgent = require('../react-agent');
const planner = require('./planner');

const DEFAULT_STEP_MAX_STEPS = 3;   // tool calls per plan step
const MAX_REPLANS = 2;              // total re-plans allowed on thinking=high
const STEP_SUMMARY_CHARS = 800;     // how much of each step's answer to carry forward

// ─── Step runner ──────────────────────────────────────────────────────────

async function runStep(openai, step, allTools, ctx, opts) {
  const {
    model = 'gpt-4o',
    maxSteps = DEFAULT_STEP_MAX_STEPS,
    onStep = null,
  } = opts;

  // Narrow the tool set when the plan names a specific tool hint AND
  // that tool exists — this sharpens the model's focus. If the hint
  // is null or names a missing tool, expose the full tool set; the
  // ReAct model can still pick.
  let tools = allTools;
  if (step.tool_hint) {
    const hit = allTools.find(t => t.name === step.tool_hint);
    if (hit) {
      // Always include `finalize` implicitly (react-agent adds it), but
      // we also let the model use siblings if the hint turns out wrong.
      // A single-tool narrowing was too brittle in practice — plans
      // often name the wrong tool on the first pass.
      tools = allTools;
    }
  }

  const stepQuery =
    `Sub-goal (step ${step.step}): ${step.goal}\n\n` +
    (step.tool_hint ? `Hint: the most likely useful tool is "${step.tool_hint}".\n` : '') +
    `Finish this sub-goal with at most ${maxSteps} tool calls and then call finalize with the answer for this sub-goal (NOT the user's overall goal).`;

  const result = await reactAgent.run(openai, {
    query: stepQuery,
    tools,
    ctx,
    maxSteps,
    model,
    onStep: (s) => {
      if (typeof onStep === 'function') onStep({ phase: 'step', plan_step: step.step, trace: s });
    },
  });

  return {
    step: step.step,
    goal: step.goal,
    answer: result.finalAnswer || '',
    stoppedReason: result.stoppedReason,
    subSteps: result.steps?.length || 0,
  };
}

// ─── Final aggregation ────────────────────────────────────────────────────

async function finalise(openai, { goal, stepResults, model }) {
  // Ask the model to stitch step answers into a cohesive final. This
  // is a single non-tool call — the synthesiser should not decide to
  // call more tools at this point; if it wanted more data it should
  // have been in the plan.
  const messages = [
    {
      role: 'system',
      content: `You are a synthesiser. Given a user goal and an ordered list of sub-task results, produce the final markdown answer for the user. Be direct, grounded in the results, and don't add filler.`,
    },
    {
      role: 'user',
      content:
        `Goal: ${goal}\n\n` +
        `Step results:\n` +
        stepResults.map(r => `Step ${r.step} — ${r.goal}\n${(r.answer || '').slice(0, STEP_SUMMARY_CHARS)}`).join('\n\n'),
    },
  ];

  const resp = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.3,
    max_tokens: 1400,
  });

  return (resp.choices?.[0]?.message?.content || '').trim();
}

// ─── Should we re-plan? ────────────────────────────────────────────────────
//
// Conservative heuristic: re-plan when a step finished with no usable
// answer OR when its stop reason indicates a failure mode. The model
// could also decide to re-plan — but trusting the model to
// self-diagnose is a good way to loop forever, so we gate it on signal
// that something actually went sideways.

function shouldReplan(stepResult) {
  if (!stepResult) return false;
  if (!stepResult.answer || stepResult.answer.length < 10) return true;
  const bad = ['max_steps', 'model_error', 'plain_text_finalize', 'no_message'];
  return bad.includes(stepResult.stoppedReason);
}

// ─── Main ──────────────────────────────────────────────────────────────────

/**
 * Run a planner-executor loop.
 *
 * @param {object} openai
 * @param {object} opts
 * @param {string} opts.goal
 * @param {Array}  opts.tools — react-agent-shaped tools (the caller's job)
 * @param {'medium'|'high'} [opts.thinking='medium'] — high enables re-plan
 * @param {string} [opts.plannerModel='gpt-4o-mini']
 * @param {string} [opts.executorModel='gpt-4o']
 * @param {number} [opts.stepMaxSteps=3]
 * @param {function} [opts.onStep] — called with structured events:
 *    { phase: 'plan', plan, rationale }
 *    { phase: 'step', plan_step, trace } (from react-agent)
 *    { phase: 'replan', plan, rationale }
 *    { phase: 'synthesis' }
 * @param {object} [opts.ctx] — forwarded to every tool.execute
 *
 * @returns {Promise<{
 *   finalAnswer: string,
 *   plan: Array,
 *   stepResults: Array,
 *   replans: number,
 *   stoppedReason: string,
 * }>}
 */
async function run(openai, opts) {
  const {
    goal, tools = [],
    thinking = 'medium',
    plannerModel = 'gpt-4o-mini',
    executorModel = 'gpt-4o',
    stepMaxSteps = DEFAULT_STEP_MAX_STEPS,
    onStep = null,
    ctx = {},
  } = opts;

  if (!openai) throw new Error('executor.run: openai required');
  if (!goal) throw new Error('executor.run: goal required');

  const safeOnStep = (evt) => {
    if (typeof onStep !== 'function') return;
    try { onStep(evt); } catch { /* swallow: streaming must not break the run */ }
  };

  let { plan, rationale } = await planner.plan(openai, {
    goal, tools: tools.map(t => ({ name: t.name, description: t.description })),
    model: plannerModel,
  });
  safeOnStep({ phase: 'plan', plan, rationale });

  const stepResults = [];
  let replans = 0;
  let stoppedReason = 'finalized';

  for (let i = 0; i < plan.length; i++) {
    const stepSpec = plan[i];

    let stepResult;
    try {
      stepResult = await runStep(openai, stepSpec, tools, ctx, {
        model: executorModel, maxSteps: stepMaxSteps, onStep: safeOnStep,
      });
    } catch (err) {
      stepResult = {
        step: stepSpec.step, goal: stepSpec.goal,
        answer: '', stoppedReason: `error: ${err.message}`, subSteps: 0,
      };
    }
    stepResults.push(stepResult);

    if (thinking === 'high' && replans < MAX_REPLANS && shouldReplan(stepResult) && i < plan.length - 1) {
      // Re-plan the REMAINING work using prior results as context.
      try {
        const replanned = await planner.plan(openai, {
          goal,
          tools: tools.map(t => ({ name: t.name, description: t.description })),
          model: plannerModel,
          context: {
            completed: stepResults,
            remainingOriginal: plan.slice(i + 1),
          },
        });
        replans++;
        plan = [...stepResults.map(r => ({ step: r.step, goal: r.goal, tool_hint: null })), ...replanned.plan];
        // Re-number the new steps so they continue after the ones we
        // already ran.
        const base = stepResults.length;
        for (let j = 0; j < replanned.plan.length; j++) {
          plan[base + j].step = base + j + 1;
        }
        safeOnStep({ phase: 'replan', plan: replanned.plan, rationale: replanned.rationale });
        i = base - 1; // the for-loop will ++ to base; next iter runs the first new step
      } catch {
        // If re-planning itself fails, stop trying and continue with
        // the original plan — better a partial answer than none.
        replans = MAX_REPLANS;
      }
    }
  }

  safeOnStep({ phase: 'synthesis' });
  let finalAnswer;
  try {
    finalAnswer = await finalise(openai, { goal, stepResults, model: executorModel });
  } catch (err) {
    // Synthesis failure: return the last step's answer as a best-effort
    // so the user isn't left with nothing. Flag the stoppedReason so
    // the UI can surface that something went wrong at the tail.
    finalAnswer = stepResults[stepResults.length - 1]?.answer || '';
    stoppedReason = `synthesis_error: ${err.message}`;
  }

  return { finalAnswer, plan, stepResults, replans, stoppedReason };
}

module.exports = {
  run,
  runStep,
  finalise,
  shouldReplan,
  DEFAULT_STEP_MAX_STEPS,
  MAX_REPLANS,
};
