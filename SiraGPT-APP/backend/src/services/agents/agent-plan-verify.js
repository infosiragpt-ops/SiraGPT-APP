'use strict';

/**
 * agent-plan-verify — the two missing Claude-Code harness behaviours for the
 * agentic chat loop:
 *
 *  1. createPlanTool(): `update_plan`, a visible, updatable todo list. The
 *     model calls it FIRST on multi-step tasks and again as steps complete;
 *     the plan renders live in the existing timeline (a pinned synthetic
 *     step whose `reasoning` is the checklist — zero frontend changes).
 *     Plan-then-execute with a persistent, visible plan is the pattern that
 *     keeps long agentic runs coherent (structured notes survive context
 *     pressure; the user sees WHAT the agent intends before it acts).
 *
 *  2. createAnswerVerifier(): evaluator-optimizer finalize guard — the
 *     "verify" of gather → act → VERIFY → repeat. Before a finalize is
 *     accepted, one cheap LLM judge pass scores the draft against the user
 *     query (answers the question? fabricated claims? incomplete?). A
 *     failing draft is rejected ONCE with concrete repair instructions; the
 *     loop repairs and re-finalizes. Bounded by design: max one rejection
 *     per run, fail-open on any error, skipped for trivial turns.
 *     Env: SIRAGPT_AGENT_VERIFY=0|off disables.
 *
 *  composeFinalizeGuards() chains the deterministic execution-profile gate
 *  (rules first — cheapest, most robust) with the LLM judge (last).
 */

const VERIFY_MIN_ANSWER_CHARS = 300;
const VERIFY_MIN_QUERY_CHARS = 25;
const VERIFY_MAX_ANSWER_CHARS = 6000;
const VERIFY_TIMEOUT_MS = (() => {
  const v = Number(process.env.SIRAGPT_AGENT_VERIFY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 12000;
})();

function verifyEnabled() {
  const v = String(process.env.SIRAGPT_AGENT_VERIFY || '').trim().toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}

const PLAN_STEP_ID = 'plan';
const PLAN_STATUS_GLYPH = { done: '✓', in_progress: '▸', pending: '·' };

/**
 * Build the `update_plan` tool bound to one agentic run's timeline state.
 * @param {object} opts
 * @param {() => object} opts.getState   returns the agent-task-state object
 * @param {() => Promise<void>} opts.emit  re-emits the sentinel to the client
 */
function createPlanTool({ getState, emit }) {
  return {
    name: 'update_plan',
    description:
      'Create or update your visible task plan (the user sees it live). Call FIRST on any multi-step task with the full plan, then call again whenever a step completes or the plan changes. Keep 3–7 short steps. status: pending | in_progress | done.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short imperative step, max ~8 words.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['title', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    execute: async ({ steps }) => {
      const normalized = (Array.isArray(steps) ? steps : [])
        .slice(0, 10)
        .map((s) => ({
          title: String(s?.title || '').slice(0, 80).trim() || '(paso)',
          status: ['pending', 'in_progress', 'done'].includes(s?.status) ? s.status : 'pending',
        }));
      if (normalized.length === 0) return { error: 'empty_plan' };

      const checklist = normalized
        .map((s) => `${PLAN_STATUS_GLYPH[s.status]} ${s.title}`)
        .join('\n');
      const allDone = normalized.every((s) => s.status === 'done');

      try {
        const state = getState();
        if (state && Array.isArray(state.steps)) {
          let planStep = state.steps.find((s) => s && s.id === PLAN_STEP_ID);
          if (!planStep) {
            planStep = { id: PLAN_STEP_ID, label: 'Plan', icon: 'thought', status: 'running', toolCalls: [] };
            state.steps.push(planStep);
          }
          planStep.reasoning = checklist;
          planStep.status = allDone ? 'done' : 'running';
          await emit();
        }
      } catch (_) { /* the plan must never crash the run */ }

      return {
        ok: true,
        plan: normalized,
        note: allDone
          ? 'Plan complete. Finalize with the answer.'
          : 'Plan updated and visible to the user. Execute the next in_progress step.',
      };
    },
  };
}

function extractJsonObject(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

/**
 * Evaluator-optimizer guard. Returns a react-agent finalizeGuard fn:
 * ({ answer }) => { ok, message?, repairInstructions? }.
 */
function createAnswerVerifier({ openai, model, userQuery }) {
  let rejections = 0;
  return async ({ answer }) => {
    if (!verifyEnabled()) return { ok: true };
    const draft = String(answer || '');
    const query = String(userQuery || '');
    // Trivial turns: not worth an extra model call.
    if (draft.length < VERIFY_MIN_ANSWER_CHARS || query.length < VERIFY_MIN_QUERY_CHARS) return { ok: true };
    // Bounded: one repair cycle per run. A second rejection would mostly
    // burn budget (react-agent's own breaker caps at 3 anyway).
    if (rejections >= 1) return { ok: true };

    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { try { ctl.abort(new Error('verify_timeout')); } catch (_) { /* noop */ } }, VERIFY_TIMEOUT_MS);
      let resp;
      try {
        resp = await openai.chat.completions.create({
          model,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You are a strict answer reviewer inside an AI assistant. Judge ONLY whether the draft is ready to send. '
                + 'Fail it ONLY for concrete, fixable problems: (a) it does not actually answer what was asked, '
                + '(b) it contains claims that look fabricated or unsupported by the work done, '
                + '(c) it promises content it does not include (missing sections/steps), '
                + '(d) it is in the wrong language for the user. Style preferences are NOT failures. '
                + 'Respond with ONLY a JSON object: {"pass": boolean, "problems": string[], "fix": string}.',
            },
            {
              role: 'user',
              content: `USER REQUEST:\n${query.slice(0, 2000)}\n\nDRAFT ANSWER:\n${draft.slice(0, VERIFY_MAX_ANSWER_CHARS)}`,
            },
          ],
        }, { signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
      const verdict = extractJsonObject(resp?.choices?.[0]?.message?.content);
      if (!verdict || verdict.pass !== false) return { ok: true }; // fail-open
      rejections += 1;
      const problems = Array.isArray(verdict.problems) ? verdict.problems.slice(0, 5).map(String) : [];
      try { console.log(`[agent-verify] draft rejected (${problems.length} problem(s)): ${problems.join(' | ').slice(0, 200)}`); } catch (_) { /* noop */ }
      return {
        ok: false,
        message: `Quality check failed: ${problems.join('; ').slice(0, 400) || 'draft does not answer the request'}`,
        repairInstructions:
          (String(verdict.fix || '').slice(0, 500) || 'Repair the listed problems, then call finalize again with the corrected answer.')
          + ' Do not mention this internal review to the user.',
      };
    } catch (_) {
      return { ok: true }; // fail-open: verification must never block a reply
    }
  };
}

/**
 * Chain guards left-to-right; first failure wins. Returns null when no
 * guards are active so react-agent keeps its no-guard fast path.
 */
function composeFinalizeGuards(guards) {
  const active = (guards || []).filter((g) => typeof g === 'function');
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  return async (payload) => {
    for (const guard of active) {
      // eslint-disable-next-line no-await-in-loop
      const verdict = await guard(payload);
      if (!verdict?.ok) return verdict;
    }
    return { ok: true };
  };
}

module.exports = {
  createPlanTool,
  createAnswerVerifier,
  composeFinalizeGuards,
  verifyEnabled,
  PLAN_STEP_ID,
};
