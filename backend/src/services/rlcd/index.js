'use strict';

/**
 * RLCD façade for the routes: turn-level helpers around the decision ledger.
 * Everything is fail-open — a telemetry problem must never change a reply.
 */

const ledger = require('./decision-ledger');

function isEnabled(env = process.env) {
  const v = String(env.SIRAGPT_RLCD_ENABLED ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function isLaneSteeringEnabled(env = process.env) {
  if (!isEnabled(env)) return false;
  const v = String(env.SIRAGPT_RLCD_LANE_STEERING ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function laneThreshold(env = process.env) {
  const n = Number(env.SIRAGPT_RLCD_LANE_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.6;
}

function signatureFor({ intent, difficulty, model } = {}) {
  const bucket = difficulty && typeof difficulty === 'object' ? difficulty.bucket : difficulty;
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase() || 'unknown';
  return `${norm(intent)}|${norm(bucket)}|${norm(model)}`;
}

/**
 * Record the turn's typed decisions once the cognitive decision and triage
 * are known. Returns the decision ids (stamped on req by the caller).
 */
function recordTurnDecisions({ chatId, triage, cognitive, model } = {}) {
  const ids = [];
  if (!isEnabled()) return ids;
  try {
    const sig = signatureFor({ intent: cognitive && cognitive.intent, difficulty: cognitive && cognitive.difficulty, model });
    if (triage && triage.action) {
      const ambiguity = Number.isFinite(Number(triage.score)) ? Math.max(0, Math.min(1, Number(triage.score))) : null;
      if (ambiguity != null) {
        // Triage score is the ambiguity of the request; the stated confidence
        // in `execute` is its complement, in `ask` the ambiguity itself.
        const confidence = triage.action === 'ask' ? ambiguity : 1 - ambiguity;
        const id = ledger.recordDecision({ kind: 'intent_triage', choice: triage.action, confidence, signature: sig, chatId, meta: { source: triage.source || null } });
        if (id) ids.push(id);
      }
    }
    if (cognitive && cognitive.routing) {
      const r = cognitive.routing;
      const score = Number(r.recommendedScore);
      if (r.selectedModel && Number.isFinite(score) && score > 0) {
        const id = ledger.recordDecision({ kind: 'model_route', choice: r.selectedModel, confidence: Math.min(1, score), signature: sig, chatId, meta: { action: r.action || null, changed: Boolean(r.changed) } });
        if (id) ids.push(id);
      }
    }
    if (cognitive && cognitive.compute && cognitive.compute.mode && cognitive.difficulty) {
      const dscore = Number(cognitive.difficulty.score);
      if (Number.isFinite(dscore)) {
        // Confidence that the chosen compute mode fits: high when the
        // difficulty estimate is far from the bucket boundaries.
        const distance = Math.min(Math.abs(dscore - 0.35), Math.abs(dscore - 0.65));
        const confidence = Math.max(0.5, Math.min(1, 0.5 + distance * 2));
        const id = ledger.recordDecision({ kind: 'compute_mode', choice: cognitive.compute.mode, confidence, signature: sig, chatId, meta: { bucket: cognitive.difficulty.bucket || null } });
        if (id) ids.push(id);
      }
    }
    if (chatId && ids.length) ledger.markTurn(chatId, ids);
  } catch { /* fail-open */ }
  return ids;
}

/**
 * Execution-lane decision. `heuristicAgentic` is what the regex/document
 * gates decided; `codeConfidence` is detectCodeTaskIntent's confidence that
 * the turn needs tools. The calibrated probability may force the agentic
 * loop when the heuristics said no.
 */
function decideExecutionLane({ chatId, heuristicAgentic, codeConfidence, isCodeTask, signature = null, env = process.env } = {}) {
  const out = { agentic: Boolean(heuristicAgentic), forced: false, calibrated: null, raw: null, decisionId: null, reason: heuristicAgentic ? 'heuristic' : 'plain' };
  if (!isEnabled(env)) return out;
  try {
    const raw = Number.isFinite(Number(codeConfidence)) ? Math.max(0, Math.min(1, Number(codeConfidence))) : null;
    if (raw != null) {
      const cal = ledger.calibrated('execution_lane', raw);
      out.raw = raw;
      out.calibrated = cal.calibrated;
      if (!heuristicAgentic && isCodeTask && isLaneSteeringEnabled(env)) {
        ledger.noteLane({ consulted: true });
        if (cal.calibrated != null && cal.calibrated >= laneThreshold(env)) {
          out.agentic = true;
          out.forced = true;
          out.reason = 'calibrated';
          ledger.noteLane({ forced: true });
        }
      }
      const id = ledger.recordDecision({
        kind: 'execution_lane',
        choice: out.agentic ? 'agentic' : 'plain',
        confidence: out.agentic ? raw : 1 - raw,
        signature,
        chatId,
        meta: { forced: out.forced, heuristic: Boolean(heuristicAgentic) },
      });
      out.decisionId = id;
    }
  } catch { /* fail-open */ }
  return out;
}

function recordOutcome(args) {
  if (!isEnabled()) return 0;
  return ledger.recordOutcome(args);
}

/** Thumb from POST /chats/messages/:id/feedback. */
function recordThumb({ messageId, feedback, metadata } = {}) {
  if (!isEnabled()) return 0;
  const label = String(feedback || '').toLowerCase() === 'liked' ? 'liked' : 'disliked';
  const ids = metadata && metadata.rlcd && Array.isArray(metadata.rlcd.decisions) ? metadata.rlcd.decisions : null;
  return ledger.recordOutcome({ messageId, decisionIds: ids && ids.length ? ids : null, outcome: label, source: 'thumb' });
}

function stats({ admin = false } = {}) {
  const s = ledger.snapshot();
  const base = {
    enabled: isEnabled(),
    laneSteering: isLaneSteeringEnabled(),
    laneThreshold: laneThreshold(),
    decisions: s.decisions,
    outcomes: s.outcomes,
    kinds: ledger.DECISION_KINDS,
    reliability: s.reliability.map((r) => ({ kind: r.kind, samples: r.samples, ece: r.ece, brier: r.brier, accuracy: r.accuracy })),
  };
  if (!admin) return base;
  return { ...base, outcomesUnmatched: s.outcomesUnmatched, pending: s.pending, byKind: s.byKind, byOutcome: s.byOutcome, lane: s.lane, reliabilityBins: s.reliability };
}

module.exports = {
  ledger,
  isEnabled,
  isLaneSteeringEnabled,
  laneThreshold,
  signatureFor,
  recordTurnDecisions,
  decideExecutionLane,
  recordOutcome,
  recordThumb,
  stats,
  toPrometheusText: ledger.toPrometheusText,
  snapshot: ledger.snapshot,
  load: ledger.load,
  reset: ledger.reset,
};
