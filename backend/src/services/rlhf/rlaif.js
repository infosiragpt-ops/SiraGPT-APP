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
 *
 * Default OFF (SIRAGPT_RLHF_RLAIF). Rate-limited per user. Fail-open:
 * never throws into the generate path.
 */

const DEFAULT_CHOSEN_MIN = 8;
const DEFAULT_REJECTED_MAX = 4;
const DEFAULT_MAX_PER_USER = 8;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MIN_SCORE_GAP = 3;

/** userId → { count, resetAt } */
const rateWindows = new Map();

function isRlaifEnabled(env = process.env) {
  const v = env.SIRAGPT_RLHF_RLAIF;
  if (v == null || String(v).trim() === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function rlaifMaxPerUser(env = process.env) {
  const n = Number(env.SIRAGPT_RLHF_RLAIF_MAX_PER_USER);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : DEFAULT_MAX_PER_USER;
}

function rlaifWindowMs(env = process.env) {
  const n = Number(env.SIRAGPT_RLHF_RLAIF_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
}

function checkRateLimit(userId, env = process.env) {
  if (!userId) return { ok: false, reason: 'no_user' };
  const max = rlaifMaxPerUser(env);
  const windowMs = rlaifWindowMs(env);
  const now = Date.now();
  let slot = rateWindows.get(userId);
  if (!slot || now >= slot.resetAt) {
    slot = { count: 0, resetAt: now + windowMs };
    rateWindows.set(userId, slot);
  }
  if (slot.count >= max) return { ok: false, reason: 'rate_limited', remaining: 0, resetAt: slot.resetAt };
  return { ok: true, remaining: max - slot.count, resetAt: slot.resetAt };
}

function consumeRateLimit(userId, n = 1, env = process.env) {
  const gate = checkRateLimit(userId, env);
  if (!gate.ok) return gate;
  const slot = rateWindows.get(userId);
  slot.count += n;
  return { ok: true, remaining: rlaifMaxPerUser(env) - slot.count, resetAt: slot.resetAt };
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

async function maybeIngest(args = {}) {
  try {
    if (!isRlaifEnabled(args.env)) return { stored: false, reason: 'disabled' };
    const userId = args.userId;
    const rate = checkRateLimit(userId, args.env);
    if (!rate.ok) return { stored: false, reason: rate.reason };

    const labeled = await labelSynthetic(args);
    if (!labeled.label) return { stored: false, ...labeled };

    const store = require('./preference-store');
    const existing = store.dump(userId).find((e) =>
      (e.runId || e.messageId) === (args.runId || args.messageId)
    );
    if (existing && existing.source && existing.source !== 'rlaif' && existing.label !== 'unlabeled') {
      return { stored: false, reason: 'human_exists', label: existing.label };
    }

    consumeRateLimit(userId, 1, args.env);
    const recorded = await store.recordEvent({
      userId,
      chatId: args.chatId,
      messageId: args.messageId,
      runId: args.runId || args.messageId,
      agent: args.agent || 'chat',
      source: 'rlaif',
      label: labeled.label,
      promptText: args.userRequest || args.promptText,
      responseText: args.response,
      judgeScore: labeled.judgeScore,
      notes: labeled.reason || null,
      embedder: args.embedder,
    });
    return {
      stored: recorded.stored,
      label: labeled.label,
      source: 'rlaif',
      judgeScore: labeled.judgeScore,
    };
  } catch {
    return { stored: false, reason: 'fail_open' };
  }
}

/**
 * Propose a synthetic preference pair from two candidate texts for the
 * same prompt. Only commits when the HHH scores diverge enough that one
 * side is confidently better. Tagged source=rlaif.
 */
async function proposePair(args = {}) {
  try {
    if (!isRlaifEnabled(args.env)) return { stored: false, reason: 'disabled' };
    const userId = args.userId;
    if (!userId) return { stored: false, reason: 'no_user' };
    const prompt = args.prompt || args.promptText || args.userRequest || '';
    const a = args.chosenCandidate ?? args.a ?? args.left;
    const b = args.rejectedCandidate ?? args.b ?? args.right;
    if (!prompt || a == null || b == null) return { stored: false, reason: 'incomplete_pair' };

    const rate = checkRateLimit(userId, args.env);
    if (!rate.ok) return { stored: false, reason: rate.reason };

    const [scoreA, scoreB] = await Promise.all([
      labelSynthetic({ ...args, userRequest: prompt, response: a }),
      labelSynthetic({ ...args, userRequest: prompt, response: b }),
    ]);
    const overallA = Number(scoreA.judgeScore?.overall);
    const overallB = Number(scoreB.judgeScore?.overall);
    if (!Number.isFinite(overallA) || !Number.isFinite(overallB)) {
      return { stored: false, reason: 'no_score' };
    }
    const gap = Math.abs(overallA - overallB);
    const minGap = args.minScoreGap ?? DEFAULT_MIN_SCORE_GAP;
    if (gap < minGap) return { stored: false, reason: 'abstain', gap, scoreA: overallA, scoreB: overallB };

    const aWins = overallA > overallB;
    const chosenText = aWins ? a : b;
    const rejectedText = aWins ? b : a;
    const chosenScore = aWins ? scoreA.judgeScore : scoreB.judgeScore;
    const rejectedScore = aWins ? scoreB.judgeScore : scoreA.judgeScore;

    consumeRateLimit(userId, 2, args.env);
    const store = require('./preference-store');
    const { newId } = require('./vectors');
    const pairId = newId();
    const chosenMsg = aWins ? args.aMessageId : args.bMessageId;
    const rejectedMsg = aWins ? args.bMessageId : args.aMessageId;
    const chosen = await store.recordEvent({
      userId,
      chatId: args.chatId,
      agent: args.agent || 'chat',
      source: 'rlaif',
      label: 'chosen',
      pairId,
      promptText: prompt,
      responseText: chosenText,
      messageId: chosenMsg || null,
      runId: chosenMsg || null,
      judgeScore: chosenScore,
      notes: `rlaif gap=${gap}`,
      embedder: args.embedder,
    });
    const rejected = await store.recordEvent({
      userId,
      chatId: args.chatId,
      agent: args.agent || 'chat',
      source: 'rlaif',
      label: 'rejected',
      pairId,
      promptText: prompt,
      responseText: rejectedText,
      messageId: rejectedMsg || null,
      runId: rejectedMsg || null,
      judgeScore: rejectedScore,
      notes: `rlaif gap=${gap}`,
      embedder: args.embedder,
    });
    return {
      stored: !!(chosen.stored && rejected.stored),
      source: 'rlaif',
      pairId,
      gap,
      chosen: chosen.event && { id: chosen.event.id, pairId, messageId: chosen.event.messageId },
      rejected: rejected.event && { id: rejected.event.id, pairId, messageId: rejected.event.messageId },
    };
  } catch {
    return { stored: false, reason: 'fail_open' };
  }
}

function groupRecentTurns(turns) {
  const byPrompt = new Map();
  for (const t of Array.isArray(turns) ? turns : []) {
    const prompt = String(t.prompt || t.promptText || t.userRequest || '').trim();
    const response = t.response || t.responseText;
    if (!prompt || response == null) continue;
    let g = byPrompt.get(prompt);
    if (!g) {
      g = [];
      byPrompt.set(prompt, g);
    }
    g.push(t);
  }
  return byPrompt;
}

/**
 * Scan recent turns and propose at most one synthetic pair per distinct
 * prompt when human labels are scarce. Never throws.
 */
async function proposeFromRecent(args = {}) {
  try {
    if (!isRlaifEnabled(args.env)) return { stored: false, reason: 'disabled', proposed: 0 };
    const userId = args.userId;
    if (!userId) return { stored: false, reason: 'no_user', proposed: 0 };

    const rate = checkRateLimit(userId, args.env);
    if (!rate.ok) return { stored: false, reason: rate.reason, proposed: 0 };

    let turns = args.turns;
    if (!Array.isArray(turns) || turns.length === 0) {
      const store = require('./preference-store');
      await store.hydrateUser(userId).catch(() => []);
      turns = store.dump(userId)
        .filter((e) => e.source !== 'rlaif' && e.label === 'unlabeled')
        .slice(-DEFAULT_MAX_TURNS)
        .map((e) => ({
          prompt: e.promptText,
          response: e.responseText,
          messageId: e.messageId,
          chatId: e.chatId,
        }));
    }

    const groups = groupRecentTurns(turns);
    const results = [];
    const maxPairs = Math.max(1, Math.min(4, Number(args.maxPairs) || 2));
    for (const [prompt, group] of groups) {
      if (results.length >= maxPairs) break;
      if (group.length < 2) continue;
      const a = group[group.length - 2];
      const b = group[group.length - 1];
      const aText = a.response || a.responseText;
      const bText = b.response || b.responseText;
      if (String(aText) === String(bText)) continue;
      const out = await proposePair({
        ...args,
        userId,
        prompt,
        a: aText,
        b: bText,
        aMessageId: a.messageId,
        bMessageId: b.messageId,
        chatId: b.chatId || a.chatId || args.chatId,
      });
      if (out.stored) results.push(out);
    }

    return {
      stored: results.length > 0,
      source: 'rlaif',
      proposed: results.length,
      pairs: results,
    };
  } catch {
    return { stored: false, reason: 'fail_open', proposed: 0 };
  }
}

function _resetRateLimits() {
  rateWindows.clear();
}

module.exports = {
  isRlaifEnabled,
  decide,
  labelSynthetic,
  maybeIngest,
  proposePair,
  proposeFromRecent,
  checkRateLimit,
  rlaifMaxPerUser,
  rlaifWindowMs,
  DEFAULT_CHOSEN_MIN,
  DEFAULT_REJECTED_MAX,
  DEFAULT_MAX_PER_USER,
  DEFAULT_MIN_SCORE_GAP,
  _resetRateLimits,
};
