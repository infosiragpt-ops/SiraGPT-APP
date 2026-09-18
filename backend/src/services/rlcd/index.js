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
// eval-harness is lazy: its default fixture lives under tests/ (dockerignored).
// A top-level require here used to crash production boot when the JSON was absent.

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

function isMediaSteeringEnabled(env = process.env) {
  if (!isEnabled(env)) return false;
  const v = String(env.SIRAGPT_RLCD_MEDIA_STEERING ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function mediaForceThreshold(env = process.env) {
  const n = Number(env.SIRAGPT_RLCD_MEDIA_FORCE_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.6;
}

function mediaAskThreshold(env = process.env) {
  const n = Number(env.SIRAGPT_RLCD_MEDIA_ASK_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.35;
}

const MEDIA_KIND_LABEL = { image: 'una imagen', video: 'un video', music: 'una canción', audio: 'un audio', 'image-edit': 'la edición de la imagen' };

/**
 * Raw confidence that the user wants a media generation, from the
 * deterministic detector. Fuzzy-repaired text ("cre aun aimgen") is a
 * weaker signal than a clean match; a bare noun is weaker than a verb+noun.
 */
function rawMediaConfidence(intent) {
  if (!intent || !intent.kind) return null;
  let raw = intent.confidence === 'high' ? 0.9 : intent.confidence === 'medium' ? 0.55 : 0.25;
  if (intent.repaired) raw -= 0.15;
  if (intent.reason === 'noun-only') raw -= 0.05;
  return Math.max(0.05, Math.min(0.98, raw));
}

/**
 * Media-intent decision (RLCD). Turns the detector's label into a typed
 * decision with a calibrated probability and three actions:
 *   force → route the turn into the agentic loop with the media tools;
 *   ask   → the certainty is middling: ask the user before generating;
 *   none  → plain chat.
 * The probability is calibrated against what happened after earlier media
 * decisions (tool success/failure, thumbs, regenerate), so a detector that
 * over-fires on some phrasing loses its force over time — and vice versa.
 */
function decideMediaIntent({ chatId, text, intent = null, hasImageAttachment = false, signature = null, env = process.env } = {}) {
  const out = { kind: null, tool: null, action: 'none', force: false, ask: false, question: null, raw: null, calibrated: null, decisionId: null, repaired: false };
  if (!isEnabled(env)) return out;
  try {
    let detected = intent;
    if (!detected) {
      // eslint-disable-next-line global-require
      const { detectMediaIntents } = require('../agents/media-intent');
      detected = (detectMediaIntents(String(text || ''), { hasImageAttachment: Boolean(hasImageAttachment) }) || [])[0] || null;
    }
    if (!detected || !detected.kind) return out;
    const raw = rawMediaConfidence(detected);
    const cal = ledger.calibrated('media_intent', raw);
    out.kind = detected.kind;
    out.tool = detected.tool || null;
    out.raw = raw;
    out.calibrated = cal.calibrated;
    out.repaired = Boolean(detected.repaired);
    if (isMediaSteeringEnabled(env)) {
      if (cal.calibrated >= mediaForceThreshold(env)) {
        out.action = 'force';
        out.force = true;
      } else if (cal.calibrated >= mediaAskThreshold(env)) {
        out.action = 'ask';
        out.ask = true;
        const label = MEDIA_KIND_LABEL[detected.kind] || 'ese contenido';
        const subject = String(text || '').trim().slice(0, 120);
        out.question = `¿Quieres que genere ${label}${subject ? ` a partir de «${subject}»` : ''}? Responde «sí» para crearla o dime qué necesitas.`;
      }
    }
    const id = ledger.recordDecision({
      kind: 'media_intent',
      choice: out.action === 'none' ? 'chat' : `${out.action}:${detected.kind}`,
      confidence: raw,
      signature,
      chatId,
      meta: { tool: out.tool, repaired: out.repaired, detectorConfidence: detected.confidence || null, calibrated: cal.calibrated },
    });
    out.decisionId = id;
    if (chatId && id) ledger.appendTurn(chatId, [id]);
  } catch { /* fail-open */ }
  return out;
}

const MEDIA_VOCAB = /\b(imagen|imagenes|imágenes|foto|fotos|logo|logotipo|dibuj\w*|ilustra\w*|póster|poster|cartel|banner|retrato|render|v[ií]deo|clip|animaci[oó]n|canci[oó]n|m[uú]sica|beat|jingle|melod[ií]a|voz|locuci[oó]n|audio|narra\w*|image|images|picture|photo|drawing|illustration|logo|video|song|music|voice|speech|narration)\b/i;

/**
 * Re-decide the media intent with TypeSafe Jev when the heuristic is not
 * already confident. Async and fail-open: returns `base` untouched when Jev
 * is disabled/unconfigured, the text has no media vocabulary, or the call
 * fails. A refined decision is recorded as its own ledger entry
 * (meta.source = 'jev', meta.supersedes = heuristic id) so both predictors
 * are scored against the same outcome.
 */
async function refineMediaIntentWithJev(base, { chatId, text, history = [], hasImageAttachment = false, signature = null, env = process.env } = {}) {
  if (!base || !isEnabled(env)) return base;
  try {
    // eslint-disable-next-line global-require
    const jev = require('./jev-decider');
    if (!jev.isJevEnabled(env)) return base;
    const msg = String(text || '');
    const heuristicSure = base.action === 'force' && Number(base.raw) >= 0.85 && !base.repaired;
    if (heuristicSure) return base;
    if (!base.kind && !MEDIA_VOCAB.test(msg)) return base;
    const answer = await jev.askJevMediaIntent({ text: msg, history, hasImageAttachment, env });
    if (!answer) return base;
    const merged = jev.mergeJevDecision(base, answer, {
      ledger,
      forceThreshold: mediaForceThreshold(env),
      askThreshold: mediaAskThreshold(env),
      steering: isMediaSteeringEnabled(env),
      text: msg,
    });
    const id = ledger.recordDecision({
      kind: 'media_intent',
      choice: merged.action === 'none' ? 'chat' : `${merged.action}:${merged.kind}`,
      confidence: merged.raw,
      signature,
      chatId,
      meta: { source: 'jev', tool: merged.tool, supersedes: base.decisionId || null, jevTool: answer.tool, jevConfidence: answer.confidence, model: answer.model, latencyMs: answer.latencyMs, calibrated: merged.calibrated },
    });
    merged.decisionId = id;
    merged.heuristicDecisionId = base.decisionId || null;
    if (chatId && id) ledger.appendTurn(chatId, [id]);
    return merged;
  } catch { return base; }
}

/**
 * Fase 2a — per-turn Jev judge. Runs BEFORE this turn's decisions are
 * recorded so the satisfaction signal scores the *previous* turn (lastByChat
 * still points at it). Records intent_triage / compute_mode / model_route
 * decisions with meta.source='jev'; the execution_lane decision is recorded
 * later by `applyJevLane` once the heuristic lane is known. Fail-open: null.
 */
async function judgeTurnWithJev({ chatId, text, history = [], previousAnswer = null, hasImage = false, hasDocs = false, fileNames = [], userPickedModel = false, userSetEffort = false, heuristicAsk = false, signature = null, env = process.env } = {}) {
  if (!isEnabled(env)) return null;
  try {
    // eslint-disable-next-line global-require
    const cfg = require('./config').describe(env);
    if (!cfg.flags.jevJudge.value || !cfg.flags.jev.value) return null;
    // eslint-disable-next-line global-require
    const judge = require('./jev-turn-judge');
    const judgement = await judge.judgeTurn({ text, history, previousAnswer, hasImage, hasDocs, fileNames, env });
    if (!judgement) return null;
    const actions = judge.applyTurnJudgement(judgement, { userPickedModel, userSetEffort, heuristicAgentic: false, heuristicAsk, ledger, env });
    const out = { judgement, actions, decisionIds: [], satisfactionOutcome: null, question: null };
    // Satisfaction → outcome for the previous turn of this chat.
    if (cfg.flags.jevSatisfaction.value && actions.satisfaction && chatId) {
      const n = ledger.recordOutcome({ chatId, outcome: actions.satisfaction, source: 'jev_satisfaction' });
      if (n > 0) out.satisfactionOutcome = actions.satisfaction;
    }
    const askChoice = actions.ask ? 'ask' : (actions.vetoAsk ? 'execute_veto' : 'execute');
    const idT = ledger.recordDecision({
      kind: 'intent_triage',
      choice: askChoice,
      confidence: actions.ask ? actions.raw.ask : 1 - (actions.raw.ask || 0),
      signature,
      chatId,
      meta: { source: 'jev', lane: judgement.lane.choice, needsContext: judgement.needsContext, model: judgement.model, latencyMs: judgement.latencyMs },
    });
    if (idT) out.decisionIds.push(idT);
    if (actions.webSearch) {
      const w = actions.webSearch;
      const idW = ledger.recordDecision({
        kind: 'web_search_intent',
        choice: `${w.need}:${w.force ? 'force' : (w.suggest ? 'suggest' : 'advisory')}:${w.source}`,
        confidence: w.need === 'no_web' ? 1 - (actions.raw.webSearch || 0) : (actions.raw.webSearch || 0),
        signature,
        chatId,
        meta: { source: 'jev', need: w.need, tool: w.tool, freshness: w.freshness, model: judgement.model, latencyMs: judgement.latencyMs },
      });
      if (idW) out.decisionIds.push(idW);
    }
    if (judgement.depth && judgement.depth.label) {
      const idC = ledger.recordDecision({
        kind: 'compute_mode',
        choice: `${judgement.depth.label}${actions.computeLevel ? `:${actions.computeLevel}` : ':advisory'}`,
        confidence: judgement.depth.confidence,
        signature,
        chatId,
        meta: { source: 'jev', score: judgement.depth.score, applied: Boolean(actions.computeLevel) },
      });
      if (idC) out.decisionIds.push(idC);
    }
    if (judgement.modelFamily) {
      const idM = ledger.recordDecision({
        kind: 'model_route',
        choice: `family:${judgement.modelFamily.choice}`,
        confidence: judgement.modelFamily.probability,
        signature,
        chatId,
        meta: { source: 'jev', advisory: true, userPickedModel },
      });
      if (idM) out.decisionIds.push(idM);
    }
    if (actions.ask) out.question = judge.clarifyQuestion(judgement);
    return out;
  } catch { return null; }
}

/**
 * Fase 2a — apply the judge's lane opinion once the heuristic lane is known.
 * Mutates `lane` ({agentic, forced, reason}) and records an execution_lane
 * decision (meta.source='jev'). Returns the decision id or null.
 */
function applyJevLane(lane, judged, { heuristicAgentic = false, chatId = null, signature = null, env = process.env } = {}) {
  if (!lane || !judged || !judged.judgement || !isEnabled(env)) return null;
  try {
    // eslint-disable-next-line global-require
    const judge = require('./jev-turn-judge');
    const a = judge.applyTurnJudgement(judged.judgement, { heuristicAgentic, ledger, env });
    let choice = 'agree';
    if (a.forceAgentic && !lane.agentic) { lane.agentic = true; lane.forced = true; lane.reason = 'jev'; choice = 'force_agentic'; }
    // A turn that REQUIRES current web sources needs the tool loop: the plain
    // stream cannot search. Same guard as the lane force (never overrides a
    // heuristic agentic veto — that path is off by default).
    else if (a.webSearch && a.webSearch.force && !lane.agentic) { lane.agentic = true; lane.forced = true; lane.reason = 'jev_web'; choice = 'force_agentic_web'; }
    else if (a.vetoAgentic && lane.agentic && lane.forced !== true) { lane.agentic = false; lane.vetoed = true; lane.reason = 'jev_veto'; choice = 'veto_agentic'; }
    const pAgent = Number(judged.judgement.lane.probabilities.tools_agent) || 0;
    const id = ledger.recordDecision({
      kind: 'execution_lane',
      choice: `${choice}:${judged.judgement.lane.choice}`,
      confidence: lane.agentic ? pAgent : 1 - pAgent,
      signature,
      chatId,
      meta: { source: 'jev', heuristicAgentic, laneChoice: judged.judgement.lane.choice },
    });
    if (chatId && id) ledger.appendTurn(chatId, [id]);
    return id;
  } catch { return null; }
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
    mediaSteering: isMediaSteeringEnabled(),
    mediaThresholds: { force: mediaForceThreshold(), ask: mediaAskThreshold() },
    decisions: s.decisions,
    outcomes: s.outcomes,
    kinds: ledger.DECISION_KINDS,
    reliability: s.reliability.map((r) => ({ kind: r.kind, samples: r.samples, ece: r.ece, brier: r.brier, accuracy: r.accuracy })),
  };
  if (!admin) return base;
  // eslint-disable-next-line global-require
  const persistence = require('./persistence');
  // eslint-disable-next-line global-require
  const config = require('./config');
  return {
    ...base,
    outcomesUnmatched: s.outcomesUnmatched,
    pending: s.pending,
    byKind: s.byKind,
    byOutcome: s.byOutcome,
    lane: s.lane,
    reliabilityBins: s.reliability,
    config: config.describe(),
    persistence: persistence.status(),
  };
}

function recentDecisions(opts = {}) {
  return ledger.recentDecisions(opts);
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

function getEvalHarness() {
  // eslint-disable-next-line global-require
  return require('./eval-harness');
}

function runDocumentEval(rows, opts = {}) {
  try {
    return getEvalHarness().runEval(rows, {
      finalize: (args) => finalizeAnswer(args),
      ...opts,
    });
  } catch {
    return {
      n: 0,
      passed: 0,
      failed: 0,
      ok: false,
      skipped: true,
      reason: 'eval_unavailable',
      cases: [],
    };
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
  decideMediaIntent,
  refineMediaIntentWithJev,
  judgeTurnWithJev,
  applyJevLane,
  isMediaSteeringEnabled,
  mediaForceThreshold,
  mediaAskThreshold,
  rawMediaConfidence,
  recordOutcome,
  recordThumb,
  recentDecisions,
  stats,
  get persistence() { return require('./persistence'); },
  get config() { return require('./config'); },
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
  get evalHarness() { return getEvalHarness(); },
};
