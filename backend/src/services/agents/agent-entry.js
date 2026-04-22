/**
 * agent-entry — single programmatic entry point for running the agent
 * outside an HTTP request.
 *
 * The /api/agent/run route still owns the SSE streaming / SSE framing
 * for interactive callers. This module is the analogue for non-HTTP
 * callers — scheduled jobs, webhooks, session_spawn, admin tooling.
 * Keeping the two paths separate means the HTTP route doesn't have to
 * synthesise a fake request to run the agent internally.
 *
 * The entry point loads skills, applies the session policy, picks
 * ReAct vs planner-executor based on `thinking`, and returns the
 * structured result object. It does NOT read req.user or touch any
 * HTTP objects.
 */

const OpenAI = require('openai');
const reactAgent = require('../react-agent');
const executor = require('./executor');
const skills = require('../skills');

/**
 * Run the agent for a specific user, returning when the run finishes.
 *
 * @param {object} opts
 * @param {string|number} opts.userId
 * @param {string} opts.prompt
 * @param {'low'|'medium'|'high'} [opts.thinking='low']
 * @param {'main'|'sandbox'} [opts.mode='sandbox'] — non-interactive runs
 *                                                  default to sandbox.
 * @param {string[]} [opts.skillIds] — restrict visible skills
 * @param {string} [opts.collection='default']
 * @param {number} [opts.maxSteps=8]
 * @param {string} [opts.model='gpt-4o']
 * @param {string} [opts.source] — free-form tag for logs ("cron:job_x").
 *
 * @returns {Promise<{
 *   answer: string,
 *   plan?: Array,
 *   stoppedReason: string,
 *   steps?: Array,
 *   source?: string,
 * }>}
 */
async function runAgent(opts) {
  const {
    userId, prompt,
    thinking = 'low',
    mode = 'sandbox',
    skillIds = null,
    collection = 'default',
    maxSteps,
    model = 'gpt-4o',
    source = 'internal',
  } = opts;

  if (!userId) throw new Error('agent-entry.runAgent: userId required');
  if (!prompt) throw new Error('agent-entry.runAgent: prompt required');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const ctx = { openai, userId, collection, source };

  const { skills: loaded } = skills.get();
  const chosen = skillIds
    ? Array.from(loaded.values()).filter(s => skillIds.includes(s.id))
    : Array.from(loaded.values());
  const policy = skills.createPolicy({ mode });
  const { skills: wrapped } = skills.wrapSkillsWithPolicy(chosen, policy);
  const tools = wrapped.map(s => skills.toReactTool(s));

  if (thinking === 'low') {
    const r = await reactAgent.run(openai, {
      query: prompt, tools, ctx, maxSteps, model,
    });
    return {
      answer: r.finalAnswer || '',
      stoppedReason: r.stoppedReason,
      steps: r.steps,
      source,
    };
  }

  const r = await executor.run(openai, {
    goal: prompt, tools, thinking,
    executorModel: model, ctx,
  });
  return {
    answer: r.finalAnswer || '',
    plan: r.plan,
    stoppedReason: r.stoppedReason,
    steps: r.stepResults,
    source,
  };
}

module.exports = { runAgent };
