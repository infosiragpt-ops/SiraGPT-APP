'use strict';

/**
 * RLCD façade — two independent surfaces, one module:
 *
 *   1. Decision ledger (#722): intent_triage / execution_lane / model_route /
 *      compute_mode. Flag `SIRAGPT_RLCD_ENABLED` (default ON).
 *   2. Document analysis (#721): confidence trailer, defer, Brier/ECE on
 *      document thumbs. Flag `SIRAGPT_RLCD_DOCUMENTS` (default OFF).
 *
 * Fail-open. A telemetry problem must never change a reply. No GPU PPO.
 */

const ledger = require('./decision-ledger');
const flags = require('./flags');
const confidence = require('./confidence');
const deferPolicy = require('./defer-policy');
const calibration = require('./calibration');
const prompt = require('./prompt');
const evidence = require('./evidence');
const claims = require('./claims');
const contrastive = require('./contrastive');
const evalHarness = require('./eval-harness');

// ---------------------------------------------------------------------------
// #722 — typed-decision ledger
// ---------------------------------------------------------------------------

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
        const conf = triage.action === 'ask' ? ambiguity : 1 - ambiguity;
        const id = ledger.recordDecision({ kind: 'intent_triage', choice: triage.action, confidence: conf, signature: sig, chatId, meta: { source: triage.source || null } });
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
        const conf = Math.max(0.5, Math.min(1, 0.5 + distance * 2));
        const id = ledger.recordDecision({ kind: 'compute_mode', choice: cognitive.compute.mode, confidence: conf, signature: sig, chatId, meta: { bucket: cognitive.difficulty.bucket || null } });
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

function ledgerStats({ admin = false } = {}) {
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

// ---------------------------------------------------------------------------
// #721 — document-analysis confidence / defer / Brier+ECE
// ---------------------------------------------------------------------------

function isDocumentEnabled(env) {
  return flags.isDocumentEnabled(env);
}

function isDocumentAgent(agent) {
  return String(agent || '') === 'document';
}

function resolveDocumentAgent(args = {}) {
  if (args.agent) return String(args.agent);
  try {
    const { preferenceAgent } = require('../document-analysis-rlhf');
    return preferenceAgent({ files: args.files, prompt: args.prompt });
  } catch {
    return '';
  }
}

function extractThin(files) {
  return confidence.extractionChars(files) < 400;
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function prepareDocumentTurn(raw = {}) {
  try {
    const args = asObject(raw);
    const env = args.env || process.env;
    if (!flags.isDocumentEnabled(env)) {
      calibration.recordSkip();
      return { applied: false, block: '', reason: 'disabled' };
    }
    if (!isDocumentAgent(resolveDocumentAgent(args))) {
      return { applied: false, block: '', reason: 'not_document' };
    }
    const language = args.language || 'es';
    const block = flags.isPromptEnabled(env)
      ? prompt.buildRlcdPromptBlock({ language })
      : '';
    const predicted = confidence.heuristicConfidence({
      prompt: args.prompt,
      files: args.files,
      calibration: args.calibration,
    });
    const ev = evidence.scoreEvidence({
      text: args.prompt,
      files: args.files,
      hits: args.hits,
    });
    return {
      applied: true,
      block,
      predictedConfidence: predicted.confidence,
      predictedBin: confidence.binFor(predicted.confidence),
      extractionThin: extractThin(args.files),
      evidence: evidence.publicEvidence(ev),
      reason: 'ok',
    };
  } catch {
    return { applied: false, block: '', reason: 'fail_open' };
  }
}

function finalizeAnswer(raw = {}) {
  try {
    const args = asObject(raw);
    const env = args.env || process.env;
    if (!flags.isDocumentEnabled(env)) {
      return {
        text: String(args.text || ''),
        metadata: null,
        deferred: false,
        reason: 'disabled',
      };
    }
    if (!isDocumentAgent(resolveDocumentAgent(args))) {
      return {
        text: String(args.text || ''),
        metadata: null,
        deferred: false,
        reason: 'not_document',
      };
    }
    let threshold = args.threshold;
    if (threshold == null && flags.isAutoThresholdEnabled(env)) {
      try {
        const rec = calibration.recommendThreshold(
          flags.deferThreshold(env),
          { ...calibration.snapshot(), minN: flags.minAutoSamples(env) },
        );
        if (rec && rec.usable) threshold = rec.threshold;
      } catch { /* keep configured threshold */ }
    }
    const score = confidence.scoreConfidence({
      text: args.text,
      prompt: args.prompt,
      files: args.files,
      hits: args.hits,
      calibration: args.calibration || (args.predicted && {
        confidence: args.predicted.predictedConfidence,
      }),
      scrub: args.scrub,
    });
    const extractionEmpty = args.extractionEmpty === true
      || (score.evidence && score.evidence.emptyExtract)
      || confidence.extractionChars(args.files) === 0;
    const decision = deferPolicy.decideDefer({
      confidence: score.confidence,
      extractionEmpty,
      recentDeferRate: calibration.recentDeferRate(),
      text: score.cleanedText,
      env,
      threshold,
      maxRate: args.maxRate,
    });
    const applied = deferPolicy.applyPolicy({
      text: score.cleanedText,
      decision,
      score,
      language: args.language || 'es',
      phrase: flags.isPhraseEnabled(env),
    });
    let finalText = applied.text;
    if (!applied.deferred && flags.isPhraseEnabled(env) && score.claims) {
      const claimLine = claims.compactClaimPhrase({
        language: args.language || 'es',
        claims: score.claims,
      });
      if (claimLine && !finalText.includes(claimLine)) {
        finalText = `${finalText}\n\n${claimLine}`;
      }
    }
    calibration.recordTurn({ deferred: applied.deferred, scored: true });
    const metadata = {
      v: 3,
      confidence: score.confidence,
      rawConfidence: score.rawConfidence,
      bin: score.bin,
      source: score.source,
      deferred: applied.deferred === true,
      reason: decision.reason,
      adjusted: score.adjusted === true,
      evidence: evidence.publicEvidence(score.evidence),
      claims: claims.publicClaims(score.claims),
    };
    return {
      text: finalText,
      metadata,
      score,
      decision,
      deferred: applied.deferred,
      reason: decision.reason,
    };
  } catch {
    const fallback = asObject(raw);
    return {
      text: String(fallback.text || ''),
      metadata: null,
      deferred: false,
      reason: 'fail_open',
    };
  }
}

function buildJudgeScore(existing, rlcdPayload) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  if (!rlcdPayload) return Object.keys(base).length ? base : null;
  const prev = base.rlcd && typeof base.rlcd === 'object' ? base.rlcd : {};
  base.rlcd = {
    ...prev,
    ...rlcdPayload,
  };
  return base;
}

function payloadFromScore(score, { outcome, source, weight } = {}) {
  if (!score || score.confidence == null) return null;
  return {
    confidence: score.confidence,
    rawConfidence: score.rawConfidence,
    bin: score.bin,
    source: score.source,
    outcome: outcome || undefined,
    deferred: score.deferred === true,
    feedbackSource: source || undefined,
    weight: weight || undefined,
    adjusted: score.adjusted === true,
    evidence: evidence.publicEvidence(score.evidence),
    claims: score.claims ? {
      n: score.claims.n,
      supported: score.claims.supported,
      inferred: score.claims.inferred,
      supportRate: score.claims.supportRate,
    } : undefined,
  };
}

function resolveScore(args = {}) {
  const meta = args.metadata && args.metadata.rlcd ? args.metadata.rlcd : args.rlcd || null;
  if (meta && meta.confidence != null) {
    return {
      confidence: confidence.round2(confidence.clamp01(meta.confidence) ?? 0.5),
      rawConfidence: meta.rawConfidence,
      bin: meta.bin || confidence.binFor(meta.confidence),
      source: meta.source || 'metadata',
      rationale: meta.rationale || '',
      deferred: meta.deferred === true,
      evidence: meta.evidence || null,
      claims: meta.claims || null,
      adjusted: meta.adjusted === true,
    };
  }
  return confidence.scoreConfidence({
    text: args.response || args.text,
    prompt: args.prompt || args.request,
    files: args.files,
    hits: args.hits,
    calibration: args.calibration,
    scrub: args.scrub,
  });
}

function recordFromThumb(raw = {}) {
  try {
    const args = asObject(raw);
    if (!flags.isDocumentEnabled(args.env || process.env)) {
      return { recorded: false, reason: 'disabled', judgeScore: args.judgeScore || null };
    }
    if (args.agent && !isDocumentAgent(args.agent)) {
      return { recorded: false, reason: 'not_document', judgeScore: args.judgeScore || null };
    }
    const helpful = args.helpful;
    if (typeof helpful !== 'boolean') {
      return { recorded: false, reason: 'no_label', judgeScore: args.judgeScore || null };
    }
    const score = resolveScore(args);
    const outcome = helpful ? 'correct' : 'incorrect';
    const recorded = calibration.recordOutcome({
      confidence: score.confidence,
      outcome,
      bin: score.bin,
      agent: args.agent || 'document',
      source: args.source || 'explicit',
      scoreSource: score.source,
      evidenceQuality: score.evidence && score.evidence.quality,
      supportRate: score.claims && score.claims.supportRate,
    });
    const payload = payloadFromScore(score, { outcome, source: args.source || 'explicit' });
    return {
      recorded: recorded.recorded,
      outcome,
      judgeScore: buildJudgeScore(args.judgeScore, payload),
      score,
    };
  } catch {
    return { recorded: false, reason: 'fail_open', judgeScore: asObject(raw).judgeScore || null };
  }
}

function recordFromRegenerate(raw = {}) {
  try {
    const args = asObject(raw);
    if (!flags.isDocumentEnabled(args.env || process.env)) {
      return { recorded: false, reason: 'disabled' };
    }
    if (args.agent && !isDocumentAgent(args.agent)) {
      return { recorded: false, reason: 'not_document' };
    }
    const priorText = args.priorResponse || args.prior || '';
    const priorMeta = args.priorMetadata || null;
    const score = resolveScore({
      response: priorText,
      metadata: priorMeta,
      prompt: args.prompt,
      files: args.files,
      hits: args.hits,
    });
    if (!priorText && !(priorMeta && priorMeta.rlcd)) {
      return { recorded: false, reason: 'no_prior' };
    }
    const recorded = calibration.recordOutcome({
      confidence: score.confidence,
      outcome: 'incorrect',
      bin: score.bin,
      agent: args.agent || 'document',
      source: 'regenerate',
      scoreSource: score.source,
      evidenceQuality: score.evidence && score.evidence.quality,
      supportRate: score.claims && score.claims.supportRate,
    });
    return {
      recorded: recorded.recorded,
      outcome: 'incorrect',
      weight: recorded.weight,
      judgeScore: buildJudgeScore(args.judgeScore, payloadFromScore(score, {
        outcome: 'incorrect',
        source: 'regenerate',
        weight: recorded.weight,
      })),
      score,
    };
  } catch {
    return { recorded: false, reason: 'fail_open' };
  }
}

function documentStats({ contrastiveCount } = {}) {
  try {
    const snap = calibration.snapshot();
    const configured = flags.deferThreshold();
    const rec = calibration.recommendThreshold(configured, {
      ...snap,
      minN: flags.minAutoSamples(),
    });
    const auto = flags.isAutoThresholdEnabled();
    return {
      enabled: flags.isDocumentEnabled(),
      threshold: configured,
      recommendedThreshold: rec.threshold,
      thresholdAdvice: rec.reason,
      thresholdDelta: rec.delta,
      autoThreshold: auto,
      effectiveThreshold: auto && rec.usable ? rec.threshold : configured,
      maxDeferRate: flags.maxDeferRate(),
      phrase: flags.isPhraseEnabled(),
      prompt: flags.isPromptEnabled(),
      meaning: 'calibrated_decisions',
      ...snap,
      contrastivePairs: Number.isFinite(contrastiveCount) ? contrastiveCount : snap.contrastivePairs,
    };
  } catch {
    return { enabled: false, n: 0, brier: null, ece: null };
  }
}

function exportDocumentPairs(events, opts) {
  try {
    return contrastive.buildDocumentPairs(events, opts);
  } catch {
    return [];
  }
}

function runDocumentEval(rows, opts = {}) {
  try {
    return evalHarness.runEval(rows, {
      finalize: (args) => finalizeAnswer(args),
      ...opts,
    });
  } catch {
    return { n: 0, passed: 0, failed: 0, ok: false, cases: [] };
  }
}

function stats(opts = {}) {
  const ledgerSnap = ledgerStats(opts);
  return { ...ledgerSnap, documents: documentStats() };
}

function reset() {
  try { ledger.reset(); } catch { /* optional */ }
  try { calibration.reset(); } catch { /* optional */ }
}

const documents = {
  isEnabled: isDocumentEnabled,
  prepareDocumentTurn,
  finalizeAnswer,
  recordFromThumb,
  recordFromRegenerate,
  buildJudgeScore,
  exportDocumentPairs,
  runDocumentEval,
  stats: documentStats,
  reset: () => { try { calibration.reset(); } catch { /* optional */ } },
};

module.exports = {
  // #722 ledger
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
  reset,
  // #721 documents
  documents,
  isDocumentEnabled,
  prepareDocumentTurn,
  finalizeAnswer,
  recordFromThumb,
  recordFromRegenerate,
  buildJudgeScore,
  exportDocumentPairs,
  runDocumentEval,
  documentStats,
  flags,
  confidence,
  deferPolicy,
  calibration,
  prompt,
  evidence,
  claims,
  contrastive,
  evalHarness,
};
