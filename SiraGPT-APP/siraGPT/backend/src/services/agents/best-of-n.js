/**
 * best-of-n — multi-sample + rerank at inference time.
 *
 * Ouyang et al. 2022 trained a reward model from human preferences, then
 * used PPO to align the policy toward higher RM scores. The reward model
 * induces a RANKING over candidate outputs: for two plausible answers,
 * labeled humans pick the better one; the RM learns to predict that
 * preference.
 *
 * Without the training infrastructure, we can still capture most of the
 * alignment win at inference time: sample N candidates with varying
 * temperatures, score each with alignment-judge (the inference-time
 * labeler proxy), return the winner. "Best-of-N" is a well-studied
 * approximation — Gao et al. 2022 ("Scaling Laws for Reward Model
 * Overoptimization") show it closes most of the gap between a base
 * policy and an RLHF-trained one for low to moderate N.
 *
 * Cost: this is N generation calls + 1 judge call per candidate. We
 * recommend N in {2, 3, 4}. Beyond 4 the marginal alignment gain is
 * small and the cost is not.
 *
 * Two paths:
 *   pick({ samples, judge })          — rank existing samples
 *   generateAndPick(openai, args, N)  — do the generation + ranking
 */

const { score: judgeScore } = require('./alignment-judge');

const DEFAULT_N = 3;
const DEFAULT_MODEL = 'gpt-4o-mini';
// Varied temperatures drive genuine diversity. T=0 is one fixed try;
// higher Ts explore. The spread is wider than codegen's 0.1 step because
// we want the candidates to be GENUINELY different, not three variants
// of the same design.
const SAMPLING_TEMPERATURES = [0.2, 0.7, 1.0, 1.2];

/**
 * Rank and pick the winner from a list of candidate samples.
 *
 * @param {object} args
 * @param {object} args.openai — OpenAI-shaped client (for the judge)
 * @param {string} args.userRequest — the original ask
 * @param {Array<string|object>} args.samples — candidate responses
 * @param {string} [args.sourceContext] — retrieved chunks for honest grounding
 * @param {string} [args.judgeModel='gpt-4o-mini']
 *
 * @returns {Promise<{
 *   winner: { index: number, response: any, score: object },
 *   candidates: Array<{ index, response, score }>,
 * }>}
 *
 * If samples is empty, returns { winner: null, candidates: [] }.
 * If all samples tie, returns the first (stable).
 */
async function pick({ openai, userRequest, samples, sourceContext, judgeModel }) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { winner: null, candidates: [] };
  }
  if (samples.length === 1) {
    const s = await judgeScore({ openai, userRequest, response: samples[0], sourceContext, model: judgeModel });
    return {
      winner: { index: 0, response: samples[0], score: s },
      candidates: [{ index: 0, response: samples[0], score: s }],
    };
  }

  // Score all candidates in parallel. Deterministic judge → parallel
  // is safe (no racing on internal state).
  const scored = await Promise.all(samples.map(async (response, index) => {
    const s = await judgeScore({ openai, userRequest, response, sourceContext, model: judgeModel });
    return { index, response, score: s };
  }));

  // Sort descending by overall; stable fallback to original index on tie.
  scored.sort((a, b) => (b.score.overall - a.score.overall) || (a.index - b.index));

  return { winner: scored[0], candidates: scored };
}

/**
 * Generate N candidates at varied temperatures and rank them.
 *
 * @param {object} args.openai
 * @param {Array<{role,content}>} args.messages — the chat prompt
 * @param {number} [args.n=3]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {string} args.userRequest — forwarded to the judge
 * @param {string} [args.sourceContext]
 * @param {object} [args.completionOpts] — extra options for the chat call
 *   (response_format, tools, etc.)
 *
 * Returns the same shape as pick().
 */
async function generateAndPick({
  openai, messages, n = DEFAULT_N, model = DEFAULT_MODEL,
  userRequest, sourceContext, completionOpts = {},
  judgeModel,
}) {
  if (!openai) throw new Error('best-of-n: openai client required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('best-of-n: messages array required');
  }
  const nn = Math.max(1, Math.min(n, SAMPLING_TEMPERATURES.length));

  const picks = [];
  for (let i = 0; i < nn; i++) {
    const temperature = SAMPLING_TEMPERATURES[i];
    // Run in parallel — candidates are independent.
    picks.push(
      openai.chat.completions.create({
        model, temperature, max_tokens: 1500, messages, ...completionOpts,
      })
      .then(resp => resp.choices?.[0]?.message?.content || '')
      .catch(err => {
        // A single sample failure should NOT kill the whole batch; we
        // just drop that slot and rank what survives.
        console.warn(`[best-of-n] sample ${i} (T=${temperature}) failed:`, err.message);
        return null;
      })
    );
  }
  const raw = await Promise.all(picks);
  const samples = raw.filter(s => typeof s === 'string' && s.length > 0);

  return pick({ openai, userRequest, samples, sourceContext, judgeModel });
}

module.exports = {
  pick,
  generateAndPick,
  SAMPLING_TEMPERATURES,
  DEFAULT_N,
};
