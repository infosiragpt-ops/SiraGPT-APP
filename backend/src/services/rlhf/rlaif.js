'use strict';

/**
 * RLAIF — Reinforcement Learning from AI Feedback.
 *
 * Bai et al. 2022 (Constitutional AI) showed that an HHH rubric judge can
 * stand in for human labelers when human volume is low. We reuse
 * alignment-judge (the same InstructGPT HHH rubric) and only commit a
 * synthetic label when the judge is confident:
 *
 *   overall >= chosenMin  → chosen
 *   overall <= rejectedMax → rejected
 *   otherwise              → abstain (do not pollute the RM)
 *
 * Synthetic rows are tagged source='rlaif' and are excluded from DPO
 * export unless the caller passes includeRlaif=true. Human labels always
 * overwrite RLAIF on the same runId.
 */

const DEFAULT_CHOSEN_MIN = 8;
const DEFAULT_REJECTED_MAX = 4;

function isRlaifEnabled(env = process.env) {
  const v = env.SIRAGPT_RLHF_RLAIF;
  if (v == null || String(v).trim() === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function decide(score, opts = {}) {
  if (!score || typeof score.overall !== 'number') {
    return { label: null, reason: 'no_score' };
  }
  const chosenMin = opts.chosenMin ?? DEFAULT_CHOSEN_MIN;
  const rejectedMax = opts.rejectedMax ?? DEFAULT_REJECTED_MAX;
  if (score.overall >= chosenMin) return { label: 'chosen', reason: 'high_hhh' };
  if (score.overall <= rejectedMax) return { label: 'rejected', reason: 'low_hhh' };
  return { label: null, reason: 'abstain' };
}

async function labelSynthetic({ openai, userRequest, response, sourceContext, model, opts } = {}) {
  const judge = require('../agents/alignment-judge');
  const score = await judge.score({
    openai, userRequest, response, sourceContext, model,
  });
  const decision = decide(score, opts);
  return { ...decision, judgeScore: score };
}

async function maybeIngest(args) {
  if (!isRlaifEnabled()) return { stored: false, reason: 'disabled' };
  const labeled = await labelSynthetic(args);
  if (!labeled.label) return { stored: false, ...labeled };
  const store = require('./preference-store');
  const recorded = await store.recordEvent({
    userId: args.userId,
    chatId: args.chatId,
    messageId: args.messageId,
    runId: args.runId || args.messageId,
    agent: args.agent || 'chat',
    source: 'rlaif',
    label: labeled.label,
    promptText: args.userRequest || args.promptText,
    responseText: args.response,
    judgeScore: labeled.judgeScore,
    embedder: args.embedder,
  });
  return { stored: recorded.stored, label: labeled.label, judgeScore: labeled.judgeScore };
}

module.exports = {
  isRlaifEnabled,
  decide,
  labelSynthetic,
  maybeIngest,
  DEFAULT_CHOSEN_MIN,
  DEFAULT_REJECTED_MAX,
};
