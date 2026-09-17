'use strict';

/**
 * Inference-time policy improvement using the trained reward model.
 *
 * Full PPO against a 70B policy is not what this product trains. The
 * practical RLHF win at serving time (Gao et al. 2023, InstructGPT §3.2
 * "best-of-N") is: sample candidates, score with the RM, return the
 * winner. When no RM is fitted yet we fall back to alignment-judge.
 */

const trainer = require('./trainer');
const rewardModel = require('./reward-model');
const { toFloat32 } = require('./vectors');

function isBestOfNEnabled(env = process.env) {
  const v = env.SIRAGPT_RLHF_BEST_OF_N;
  if (v == null || String(v).trim() === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

async function embedOne(embedder, text) {
  if (typeof embedder !== 'function') return null;
  try {
    const vecs = await embedder([String(text || '').slice(0, 4000)]);
    return toFloat32(vecs?.[0]);
  } catch (err) {
    console.warn('[rlhf.policy] embed failed:', err.message || err);
    return null;
  }
}

async function scoreCompletion({ prompt, response, embedder, promptEmb, responseEmb }) {
  await trainer.loadLatestActive().catch(() => null);
  if (!trainer.hasActiveModel()) {
    return { ready: false, score: 0, reason: 'no_reward_model' };
  }
  const p = promptEmb || await embedOne(embedder, prompt);
  const r = responseEmb || await embedOne(embedder, response);
  if (!p || !r) return { ready: true, score: 0, reason: 'no_embedding' };
  const s = rewardModel.score(trainer.getActive().model, p, r);
  try {
    require('./metrics').recordRmScore({
      score: s,
      used: true,
      version: trainer.getActive().version,
    });
  } catch {
    /* telemetry is optional */
  }
  return {
    ready: true,
    score: s,
    version: trainer.getActive().version,
  };
}

/**
 * Rank existing samples with the RM. Returns null when the RM is not ready
 * so callers can fall back to the LLM judge.
 */
async function rankSamples({ prompt, userRequest, samples, embedder }) {
  const text = prompt || userRequest || '';
  if (!Array.isArray(samples) || samples.length === 0) {
    return { winner: null, candidates: [], source: 'empty' };
  }
  await trainer.loadLatestActive().catch(() => null);
  if (!trainer.hasActiveModel() || typeof embedder !== 'function') return null;

  const p = await embedOne(embedder, text);
  if (!p) return null;

  const scored = [];
  for (let i = 0; i < samples.length; i++) {
    const response = samples[i];
    const asText = typeof response === 'string' ? response : JSON.stringify(response);
    const r = await embedOne(embedder, asText);
    const s = r ? rewardModel.score(trainer.getActive().model, p, r) : Number.NEGATIVE_INFINITY;
    scored.push({
      index: i,
      response,
      rm: s,
      score: { overall: s, source: 'reward_model' },
    });
  }
  scored.sort((a, b) => (b.rm - a.rm) || (a.index - b.index));
  return {
    winner: scored[0],
    candidates: scored,
    source: 'reward_model',
    version: trainer.getActive().version,
  };
}

async function pickBest(args) {
  const ranked = await rankSamples(args);
  if (ranked) return ranked;
  // Fall back to the HHH LLM judge when no RM is fitted.
  try {
    const bestOfN = require('../agents/best-of-n');
    return bestOfN.pick({
      openai: args.openai,
      userRequest: args.userRequest || args.prompt,
      samples: args.samples,
      sourceContext: args.sourceContext,
      judgeModel: args.judgeModel,
    });
  } catch (err) {
    return { winner: null, candidates: [], source: 'fallback_failed', error: err.message };
  }
}

module.exports = {
  isBestOfNEnabled,
  scoreCompletion,
  rankSamples,
  pickBest,
  hasActiveModel: trainer.hasActiveModel,
};
