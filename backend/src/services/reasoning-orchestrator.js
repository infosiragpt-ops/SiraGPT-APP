'use strict';

/**
 * reasoning-orchestrator.js — the "cognitive core" decision engine.
 * ───────────────────────────────────────────────────────────────────────────
 * A single, pure, deterministic decision layer that sits in front of every
 * chat turn and answers four questions a frontier-grade assistant must answer
 * BEFORE it generates a token:
 *
 *   1. How hard is this request?        → assessDifficulty()
 *   2. How risky is it (domain)?        → assessRisk()
 *   3. Which model should run it?        → routeModel()   (intelligent routing)
 *   4. How much test-time compute +      → planCompute()  (direct / extended /
 *      verification does it deserve?       planVerification() self_consistency /
 *                                          best_of_n + faithfulness/reflection)
 *
 * The module is the SPINE that the rest of the cognitive stack plugs into:
 *   • Phase 1 (this file)  — routing + compute/verify PLAN + telemetry.
 *   • Phase 2 consumes `decision.verify` to run the faithfulness postprocessor.
 *   • Phase 3 consumes `decision.compute` to run extended/self-consistency/BoN.
 *
 * Design contract:
 *   - Pure & deterministic. No I/O, no LLM, no env mutation. Safe to call
 *     inline on the hot path for every turn (< 1 ms).
 *   - Fail-open. Any internal error returns a conservative "keep the user's
 *     model, answer directly, no extra verification" decision so wiring it can
 *     never break a chat turn.
 *   - Dependency-injectable. The two model routers are injected via `deps` so
 *     tests run fully offline and callers can swap catalogs.
 *   - Application is POLICY-GATED. By default (`mode: 'off'`) the orchestrator
 *     only RECOMMENDS — it never overrides the user's chosen model. Callers
 *     opt into application via `SIRAGPT_AUTO_ROUTING` (off|escalate|auto) or by
 *     passing an explicit `auto` sentinel model id.
 *
 * Public API:
 *   decide(input, deps?)         → CognitiveDecision
 *   assessDifficulty(input)      → { bucket, score, ... }
 *   assessRisk(prompt, intent)   → { domains, level }
 *   routeModel(input, deps?)     → { mode, selectedModel, action, ... }
 *   planCompute(ctx)             → { mode, samples, reasoningEffort, reflection }
 *   planVerification(ctx)        → { faithfulness, threshold, reflection, reason }
 *   summarizeForLog(decision)    → string (one-line telemetry)
 *   AUTO_MODEL_SENTINELS         → Set of "let the system choose" model ids
 */

let defaultComplexityRouter = null;
let defaultCatalogRouter = null;
try { defaultComplexityRouter = require('./ai/model-router'); } catch (_) { defaultComplexityRouter = null; }
try { defaultCatalogRouter = require('./ai-product-os/model-router'); } catch (_) { defaultCatalogRouter = null; }

const AUTO_MODEL_SENTINELS = new Set(['auto', 'sira-auto', 'auto-router', 'sira/auto', 'best', 'smart']);

// Routing modes:
//   off       – never override the user's model (recommend-only). DEFAULT.
//   escalate  – keep the user's model unless the task is genuinely harder than
//               it can serve AND a stronger, plan-eligible model exists. Never
//               downgrades. Conservative, high-value.
//   auto      – full automatic selection by the capability/cost scorer.
const ROUTING_MODES = new Set(['off', 'escalate', 'auto']);

// Capability weights per "need" — used to compare two models' fitness for a
// specific task without dragging in cost/latency penalties.
const CAPABILITY_WEIGHTS = Object.freeze({
  reasoning: 1.0,
  code: 0.9,
  tools: 0.7,
  long_context: 0.7,
  vision: 0.8,
});

// Risk-domain keyword dictionaries (bilingual EN/ES). Matching any high-stakes
// domain raises the verification bar (stricter faithfulness threshold).
const RISK_DOMAINS = Object.freeze({
  legal: {
    level: 'high',
    rx: /\b(legal|law|lawsuit|contract|clause|liabilit|litigation|statute|regulation|compliance|jurisdiction|ley(es)?|jur[ií]dic|contrato|cl[áa]usula|demanda|litigio|normativ|cumplimiento|jurisdicci[óo]n)\b/i,
  },
  medical: {
    level: 'high',
    rx: /\b(medical|clinical|diagnos|patient|symptom|treatment|dosage|drug|disease|therap|m[ée]dic|cl[íi]nic|diagn[óo]stic|paciente|s[íi]ntoma|tratamiento|dosis|f[áa]rmac|enfermedad|terapia)\b/i,
  },
  financial: {
    level: 'high',
    rx: /\b(financial|invest|portfolio|valuation|tax|accounting|revenue|profit|forecast|finanzas|financier|inversi[óo]n|valoraci[óo]n|impuesto|contabilidad|ingreso|ganancia|pron[óo]stic)\b/i,
  },
  academic: {
    level: 'medium',
    rx: /\b(thesis|dissertation|peer.?review|citation|bibliography|hypothesis|methodology|tesis|disertaci[óo]n|revisi[óo]n por pares|citaci[óo]n|bibliograf[íi]a|hip[óo]tesis|metodolog[íi]a)\b/i,
  },
  scientific: {
    level: 'medium',
    // Spanish stems carry inflections (empíric-o, estadístic-as, científic-o),
    // so we allow a trailing o/a/s rather than a hard word boundary that would
    // miss the inflected forms.
    rx: /\b(scientific|experiment(o|os|al)?|empirical|datasets?|statistics?|hypothes(is|es)|doi|arxiv|cient[íi]fic[oa]s?|emp[íi]ric[oa]s?|estad[íi]stic[oa]s?|conjuntos? de datos)\b/i,
  },
});

const MATH_LOGIC_RX = /\b(solve|prove|demonstrate|derive|calculate|compute|theorem|equation|integral|derivative|probabilit|resuelve|demuestra|deriva|calcula|teorema|ecuaci[óo]n|integral|derivada|probabilidad)\b/i;

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function envRoutingMode() {
  const raw = String(process.env.SIRAGPT_AUTO_ROUTING || '').trim().toLowerCase();
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'auto') return 'auto';
  if (raw === 'escalate' || raw === 'escalation') return 'escalate';
  return 'off';
}

function isAutoSentinel(model) {
  return typeof model === 'string' && AUTO_MODEL_SENTINELS.has(model.trim().toLowerCase());
}

// ── 1. Difficulty ──────────────────────────────────────────────────────────

const BUCKET_ORDER = Object.freeze({ trivial: 0, simple: 1, moderate: 2, complex: 3 });
const ORDER_BUCKET = Object.freeze(['trivial', 'simple', 'moderate', 'complex']);

// Semantic intent → minimum difficulty bucket. A short prompt like "escribe una
// tesis de 30 páginas" is TINY by length but a COMPLEX task by intent — this is
// the core fix for length-only estimation. Bilingual-agnostic (operates on the
// normalised intent id produced by the semantic router).
const INTENT_DIFFICULTY_FLOOR = Object.freeze({
  small_talk: 'trivial',
  text_answer: 'simple',
  translation: 'simple',
  summarization: 'moderate',
  search_web: 'simple',
  research_question: 'complex',
  data_analysis: 'moderate',
  code_generation: 'moderate',
  math_solving: 'moderate',
  web_app_build: 'complex',
  spreadsheet_generation: 'moderate',
  pdf_report_generation: 'complex',
  complex_academic_document_generation: 'complex',
  agent_long_running_task: 'complex',
});

// Heavy-deliverable phrasing that signals a complex task regardless of prompt
// length (bilingual EN/ES). Matching raises the difficulty floor to 'complex'.
const HEAVY_DELIVERABLE_RX = /\b(thesis|dissertation|monograph|whitepaper|business plan|book|ebook|research paper|literature review|full report|web app|web application|website|dashboard|landing page|\d{1,3}\s?(pages?|p[áa]ginas?)|tesis|disertaci[óo]n|monograf[íi]a|plan de negocio|libro|art[íi]culo cient[íi]fic|revisi[óo]n de literatura|informe completo|aplicaci[óo]n web|sitio web|p[áa]gina web)\b/i;

// Build-verb + deliverable noun (bilingual). Catches "crea una web",
// "build an app", "desarrolla un dashboard" even without a semantic-intent hint.
const CREATE_DELIVERABLE_RX = /\b(crea|cre[áa]me|haz|hazme|desarrolla|monta|constru[yi]e?|dise[ñn]a|genera|build|create|develop|make|design)\s+(una?\s+|an?\s+|el\s+|the\s+|mi\s+|my\s+)?(web|app|aplicaci[óo]n|sitio|p[áa]gina|landing|dashboard|plataforma|platform|sistema|system|api|backend|frontend)\b/i;

// Task-verb floors (bilingual): a request's VERB implies a minimum complexity
// even without a semantic-intent hint and even when phrased tersely. Ordered
// high→low; the highest matching floor wins (combined via maxBucket).
const TASK_VERB_FLOORS = Object.freeze([
  { floor: 'complex', rx: /\b(investiga(r|ci[óo]n)?|research|estado del arte|state of the art|systematic review|revisi[óo]n sistem[áa]tica)\b/i },
  { floor: 'moderate', rx: /\b(resume|res[úu]men|resumir|sumariza(r)?|summari[sz]e|summary|analiza(r)?|an[áa]lisis|analy[sz]e|analysis|compara(r)?|comparativa|comparison|eval[úu]a(r)?|evaluate)\b/i },
  { floor: 'simple', rx: /\b(traduce|traducir|traducci[óo]n|translate|translation)\b/i },
]);

function maxBucket(a, b) {
  const oa = BUCKET_ORDER[a] ?? 1;
  const ob = BUCKET_ORDER[b] ?? 1;
  return ORDER_BUCKET[Math.max(oa, ob)];
}

/** Lowest difficulty this request can be, inferred from semantics (not length). */
function semanticFloor({ prompt = '', intent = null, semanticIntent = null, riskLevel = 'low' } = {}) {
  let floor = 'trivial';
  const primary = intent
    || (semanticIntent && semanticIntent.structured_intent && semanticIntent.structured_intent.intent_primary)
    || (semanticIntent && semanticIntent.intent)
    || null;
  if (primary && INTENT_DIFFICULTY_FLOOR[primary]) {
    floor = maxBucket(floor, INTENT_DIFFICULTY_FLOOR[primary]);
  }
  const text = String(prompt || '');
  if (HEAVY_DELIVERABLE_RX.test(text)) floor = maxBucket(floor, 'complex');
  if (CREATE_DELIVERABLE_RX.test(text)) floor = maxBucket(floor, 'complex');
  if (MATH_LOGIC_RX.test(text)) floor = maxBucket(floor, 'moderate');
  for (const { floor: f, rx } of TASK_VERB_FLOORS) {
    if (rx.test(text)) { floor = maxBucket(floor, f); break; }
  }
  // High-stakes domains (legal/medical/financial) deserve a capable model and
  // verification even when phrased tersely.
  if (riskLevel === 'high') floor = maxBucket(floor, 'moderate');
  // The semantic router's own contract complexity, when present.
  const contractComplexity = semanticIntent && semanticIntent.contract && semanticIntent.contract.complexity;
  if (contractComplexity === 'high') floor = maxBucket(floor, 'complex');
  else if (contractComplexity === 'medium') floor = maxBucket(floor, 'moderate');
  return floor;
}

function assessDifficulty({ prompt = '', contextSize = 0, attachments = [], intent = null, semanticIntent = null, riskLevel = 'low' } = {}, deps = {}) {
  // Respect an explicit `null` (caller forcing "no router") vs `undefined`
  // (use the bundled default).
  const router = 'complexityRouter' in deps ? deps.complexityRouter : defaultComplexityRouter;
  let base;
  if (router && typeof router.estimateComplexity === 'function') {
    try {
      base = { ...router.estimateComplexity({ prompt, contextSize, attachments }), source: 'complexity-router' };
    } catch (_) { base = null; }
  }
  if (!base) {
    // Minimal self-contained fallback if the router is unavailable.
    const text = typeof prompt === 'string' ? prompt : '';
    const len = text.length;
    let score = clamp01(len / 4000);
    let bucket = 'simple';
    if (len < 40) { bucket = 'trivial'; score = 0.05; }
    else if (score >= 0.65) bucket = 'complex';
    else if (score >= 0.35) bucket = 'moderate';
    base = { score, bucket, hasCode: false, hasComplexity: false, isTrivial: bucket === 'trivial', length: len, source: 'fallback' };
  }

  // Apply the semantic floor: the effective bucket is the harder of the
  // length-based estimate and what the task type/deliverable implies.
  const floor = semanticFloor({ prompt, intent, semanticIntent, riskLevel });
  const effectiveBucket = maxBucket(base.bucket, floor);
  if (effectiveBucket !== base.bucket) {
    base.lengthBucket = base.bucket;
    base.bucket = effectiveBucket;
    base.semanticFloor = floor;
    // Lift the numeric score to at least the floor's lower edge so downstream
    // consumers that read `score` stay consistent with the bucket.
    const floorScore = { trivial: 0.05, simple: 0.2, moderate: 0.45, complex: 0.7 }[effectiveBucket] || base.score;
    base.score = Math.max(base.score, floorScore);
    base.isTrivial = effectiveBucket === 'trivial';
  }
  return base;
}

// ── 2. Risk ─────────────────────────────────────────────────────────────────

function assessRisk(prompt = '', intent = null) {
  const text = String(prompt || '');
  const domains = [];
  let level = 'low';
  for (const [name, def] of Object.entries(RISK_DOMAINS)) {
    if (def.rx.test(text)) {
      domains.push(name);
      if (def.level === 'high') level = 'high';
      else if (def.level === 'medium' && level !== 'high') level = 'medium';
    }
  }
  // Intent-derived escalation (e.g. academic document generation).
  const it = String(intent || '').toLowerCase();
  if (/academic|thesis|legal|medical|research/.test(it) && level === 'low') level = 'medium';
  return { domains, level };
}

// ── 3. Intelligent model routing ─────────────────────────────────────────────

function buildNeeds({ difficulty, risk, attachments = [], contextSize = 0, semanticIntent = null }) {
  const hasImages = Array.isArray(attachments) && attachments.some((a) => {
    const mime = a && (a.mimeType || a.mime || a.type);
    return typeof mime === 'string' && mime.startsWith('image/');
  });
  const requiredTools = semanticIntent
    && semanticIntent.structured_intent
    && Array.isArray(semanticIntent.structured_intent.required_tools)
    ? semanticIntent.structured_intent.required_tools
    : [];
  const hard = difficulty.bucket === 'complex';
  const mid = difficulty.bucket === 'moderate';
  return {
    requires_reasoning: hard || (mid && (difficulty.hasComplexity || risk.level !== 'low')) || risk.level === 'high',
    requires_code: !!difficulty.hasCode,
    requires_vision: hasImages,
    requires_long_context: contextSize > 60_000 || (Array.isArray(attachments) && attachments.length >= 4),
    requires_tools: requiredTools.length > 0,
    requires_structured_outputs: false,
    hasImages,
  };
}

function complexityWord(bucket) {
  if (bucket === 'complex') return 'high';
  if (bucket === 'moderate') return 'medium';
  return 'low';
}

/** Weighted capability index for a catalog model given task needs. */
function fitnessFor(model, needs) {
  if (!model || !model.capabilities) return null;
  const caps = model.capabilities;
  let num = 0;
  let den = 0;
  for (const [cap, baseW] of Object.entries(CAPABILITY_WEIGHTS)) {
    const needFactor =
      (cap === 'reasoning' && needs.requires_reasoning) ||
      (cap === 'code' && needs.requires_code) ||
      (cap === 'vision' && needs.requires_vision) ||
      (cap === 'long_context' && needs.requires_long_context) ||
      (cap === 'tools' && needs.requires_tools)
        ? 1.0
        : 0.25;
    const w = baseW * needFactor;
    num += (Number(caps[cap]) || 0) * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

function toIdSet(v) {
  if (!v) return null;
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  return null;
}

/**
 * Post-filter a routing decision against the set of currently-reachable model
 * ids (provider configured + not aspirational). Backward-compatible: when no
 * `reachableModelIds` is supplied the decision is returned untouched. When the
 * chosen target isn't reachable, fall back to the first reachable alternative,
 * else keep the user's model (never route to a dead id).
 */
function filterReachable(base, input) {
  const set = toIdSet(input && input.reachableModelIds);
  if (!set || !base.changed || !base.selectedModel) return base;
  if (set.has(base.selectedModel)) return base; // target reachable as-is
  const userModel = base.userModel;
  for (const alt of Array.isArray(base.alternatives) ? base.alternatives : []) {
    const id = typeof alt === 'string' ? alt : (alt && alt.id);
    if (id && id !== userModel && set.has(id)) {
      base.selectedModel = id;
      base.selectedProvider = null; // caller re-infers provider from the id
      base.reason = `${base.reason}:reroute_reachable`;
      return base;
    }
  }
  // No reachable target → keep the user's model rather than route to a dead id.
  base.selectedModel = userModel;
  base.selectedProvider = base.userProvider;
  base.changed = false;
  base.shouldApply = false;
  base.action = 'keep';
  base.reason = `${base.reason}:no_reachable_target`;
  return base;
}

const PENALTY_THRESHOLD = Number(process.env.SIRAGPT_ROUTING_PENALTY_THRESHOLD) || 0.4;
const PENALTY_MARGIN = Number(process.env.SIRAGPT_ROUTING_PENALTY_MARGIN) || 0.1;

/** Resolve a {modelId: penalty} map from a precomputed object or a provider fn. */
function resolveModelPenalties(input) {
  if (input && input.modelPenalties && typeof input.modelPenalties === 'object') return input.modelPenalties;
  if (input && typeof input.penaltyProvider === 'function') {
    try {
      const p = input.penaltyProvider({
        intent: input.intent,
        difficulty: input.difficulty && input.difficulty.bucket ? input.difficulty.bucket : input.difficulty,
      });
      return p && typeof p === 'object' ? p : null;
    } catch (_) { return null; }
  }
  return null;
}

/**
 * Outcome-based learning: if the chosen target has a poor track record
 * (penalty ≥ threshold) for this signature, switch to a meaningfully
 * lower-penalty candidate (recommended or alternative), reachable if a reachable
 * set is supplied. If the best candidate is the user's own model, this keeps it.
 * Backward-compatible: no penalties → unchanged.
 */
function applyPenalties(base, input) {
  const penalties = resolveModelPenalties(input);
  if (!penalties || !base.changed || !base.selectedModel) return base;
  const selPenalty = Number(penalties[base.selectedModel]) || 0;
  if (selPenalty < PENALTY_THRESHOLD) return base;
  const reachable = toIdSet(input && input.reachableModelIds);
  const userModel = base.userModel;
  // Look for a better CAPABLE candidate (recommended + alternatives) — never the
  // user's own model here, so an untested model with no penalty data can't beat
  // a capable model on a "0 vs 0.05" tie. The user model is only a last resort.
  const candidates = [];
  if (base.recommendedModel) candidates.push(base.recommendedModel);
  for (const a of Array.isArray(base.alternatives) ? base.alternatives : []) {
    candidates.push(typeof a === 'string' ? a : (a && a.id));
  }
  let best = null;
  let bestP = selPenalty - PENALTY_MARGIN;
  for (const id of candidates) {
    if (!id || id === base.selectedModel || id === userModel) continue;
    if (reachable && !reachable.has(id)) continue;
    const p = Number(penalties[id]) || 0;
    if (p < bestP) { bestP = p; best = id; }
  }
  if (best) {
    base.selectedModel = best;
    base.selectedProvider = null; // caller re-infers provider from the id
    base.changed = best !== userModel;
    base.shouldApply = base.changed;
    base.reason = `${base.reason}:deprioritized(${selPenalty}->${Math.round(bestP * 1000) / 1000})`;
  } else {
    // No acceptable capable alternative → don't escalate to a known-bad model;
    // fall back to the user's chosen model.
    base.selectedModel = userModel;
    base.selectedProvider = base.userProvider;
    base.changed = false;
    base.shouldApply = false;
    base.action = 'keep';
    base.reason = `${base.reason}:penalty_no_alt`;
  }
  return base;
}

function routeModel(input = {}, deps = {}) {
  const catalog = 'catalogRouter' in deps ? deps.catalogRouter : defaultCatalogRouter;
  const userModel = String(input.userModel || '').trim();
  const userProvider = input.userProvider || null;
  const plan = input.plan || 'FREE';
  const difficulty = input.difficulty || assessDifficulty(input, deps);
  const risk = input.risk || assessRisk(input.prompt, input.intent);
  const needs = buildNeeds({
    difficulty, risk, attachments: input.attachments, contextSize: input.contextSize, semanticIntent: input.semanticIntent,
  });

  // Resolve the effective mode: explicit override → auto sentinel → env.
  let mode = ROUTING_MODES.has(input.routingMode) ? input.routingMode : envRoutingMode();
  const autoRequested = isAutoSentinel(userModel);
  if (autoRequested) mode = 'auto';

  const base = {
    mode,
    userModel: userModel || null,
    userProvider,
    needs,
    recommendedModel: null,
    recommendedProvider: null,
    recommendedScore: 0,
    alternatives: [],
    selectedModel: userModel || null,
    selectedProvider: userProvider,
    changed: false,
    action: 'keep',
    reason: 'routing_disabled',
    shouldApply: false,
  };

  if (!catalog || typeof catalog.select !== 'function') {
    base.reason = 'catalog_unavailable';
    return base;
  }

  let selection;
  try {
    selection = catalog.select({
      task: input.intent || 'text_answer',
      complexity: complexityWord(difficulty.bucket),
      requires_reasoning: needs.requires_reasoning,
      requires_code: needs.requires_code,
      requires_tools: needs.requires_tools,
      requires_vision: needs.requires_vision,
      requires_long_context: needs.requires_long_context,
      requires_structured_outputs: needs.requires_structured_outputs,
      max_cost: difficulty.bucket === 'trivial' || difficulty.bucket === 'simple'
        ? 'low'
        : (difficulty.bucket === 'complex' || risk.level === 'high' ? 'high' : 'medium'),
      latency: difficulty.bucket === 'trivial' || difficulty.bucket === 'simple' ? 'fast' : 'normal',
      language: input.language || 'es',
      user_plan: plan,
      prefer: autoRequested ? undefined : (userModel || undefined),
    });
  } catch (_) {
    base.reason = 'selection_failed';
    return base;
  }

  if (!selection || !selection.model || !selection.model.id) {
    base.reason = 'no_eligible_model';
    return base;
  }

  base.recommendedModel = selection.model.id;
  base.recommendedProvider = selection.model.provider || null;
  base.recommendedScore = selection.score || 0;
  base.alternatives = Array.isArray(selection.alternatives) ? selection.alternatives : [];

  // ── Decide the final model per mode ────────────────────────────────────
  if (mode === 'off') {
    base.action = 'keep';
    base.reason = userModel ? 'recommend_only' : 'no_user_model';
    base.shouldApply = false;
    return base;
  }

  if (mode === 'auto') {
    const changed = base.recommendedModel !== userModel;
    base.selectedModel = base.recommendedModel;
    base.selectedProvider = base.recommendedProvider;
    base.changed = changed;
    base.action = autoRequested ? 'auto_select' : (changed ? 'auto_select' : 'keep');
    base.reason = `auto:${selection.rationale ? 'scored' : 'selected'}`;
    base.shouldApply = changed;
    return applyPenalties(filterReachable(base, input), input);
  }

  // mode === 'escalate' — only move UP for genuinely harder tasks.
  const userCatalog = catalog.getModel ? catalog.getModel(userModel) : null;
  const recCatalog = catalog.getModel ? catalog.getModel(base.recommendedModel) : selection.model;
  const userFitness = userCatalog ? fitnessFor(userCatalog, needs) : null;
  const recFitness = recCatalog ? fitnessFor(recCatalog, needs) : null;
  const planEligible = !catalog.isPlanEligible
    || (recCatalog && catalog.isPlanEligible(recCatalog.plans, plan));

  const MARGIN = 0.05;
  let escalate = false;
  if (base.recommendedModel && base.recommendedModel !== userModel && planEligible) {
    if (userFitness == null) {
      // Unknown user model (not in the catalog — e.g. a mini/custom id): only
      // escalate for genuinely complex tasks OR high-stakes domains, so a
      // deliberately-chosen cheap/custom model isn't overridden on small talk.
      escalate = difficulty.bucket === 'complex' || risk.level === 'high';
    } else if (recFitness != null) {
      escalate = recFitness >= userFitness + MARGIN;
    }
  }

  if (escalate) {
    base.selectedModel = base.recommendedModel;
    base.selectedProvider = base.recommendedProvider;
    base.changed = true;
    base.action = 'escalate';
    base.reason = `escalate:${difficulty.bucket}/${risk.level}`
      + (recFitness != null && userFitness != null ? `:${userFitness.toFixed(2)}→${recFitness.toFixed(2)}` : '');
    base.shouldApply = true;
  } else {
    base.action = 'keep';
    base.reason = base.recommendedModel === userModel ? 'already_optimal' : 'user_model_sufficient';
    base.shouldApply = false;
  }
  return applyPenalties(filterReachable(base, input), input);
}

// ── 4a. Test-time compute plan ────────────────────────────────────────────────

function planCompute({ difficulty, risk, intent = null, prompt = '' } = {}) {
  const bucket = difficulty ? difficulty.bucket : 'simple';
  const it = String(intent || '').toLowerCase();
  const isMathLogic = /math|solve|calc/.test(it) || MATH_LOGIC_RX.test(prompt);
  const highRisk = risk && risk.level === 'high';
  const mediumPlus = risk && (risk.level === 'high' || risk.level === 'medium');

  // Defaults: a single direct pass.
  let mode = 'direct';
  let samples = 1;
  let reasoningEffort = 'low';
  let reflection = false;

  if (bucket === 'complex' || (bucket === 'moderate' && (difficulty.hasComplexity || mediumPlus))) {
    reasoningEffort = bucket === 'complex' ? 'high' : 'medium';
    mode = 'extended';
    reflection = true;
  }

  // Self-consistency for deterministic math/logic at real difficulty.
  if (isMathLogic && (bucket === 'complex' || bucket === 'moderate')) {
    mode = 'self_consistency';
    samples = 3;
    reasoningEffort = 'high';
    reflection = true;
  } else if ((bucket === 'complex' && (highRisk || /document|academic|thesis|report/.test(it)))) {
    // Best-of-N for high-stakes long-form generation.
    mode = 'best_of_n';
    samples = highRisk ? 3 : 2;
    reasoningEffort = 'high';
    reflection = true;
  }

  return { mode, samples, reasoningEffort, reflection };
}

// User-controlled effort override. The composer exposes a Bajo/Medio/Extra/Max
// effort picker (Claude-style); when the user picks one, it FORCES the compute
// plan instead of letting planCompute auto-decide from difficulty/risk. Returns
// null for unknown levels so the caller keeps the auto plan. Drives the
// test-time-compute reasoning directive (works across every model/provider).
const EFFORT_ALIASES = Object.freeze({
  bajo: 'low', low: 'low', minimo: 'low', 'mínimo': 'low', fast: 'low', rapido: 'low', 'rápido': 'low',
  medio: 'medium', medium: 'medium', normal: 'medium', balanced: 'medium',
  extra: 'high', alto: 'high', high: 'high', deep: 'high',
  max: 'max', maximo: 'max', 'máximo': 'max', maximum: 'max', ultra: 'max',
});

function normalizeEffortLevel(level) {
  const key = String(level || '').trim().toLowerCase();
  return EFFORT_ALIASES[key] || null;
}

function computeForEffort(level) {
  const norm = normalizeEffortLevel(level);
  if (!norm) return null;
  switch (norm) {
    case 'low':
      // Fast path: a single direct pass, no extended reasoning directive.
      return { mode: 'direct', samples: 1, reasoningEffort: 'low', reflection: false };
    case 'medium':
      return { mode: 'extended', samples: 1, reasoningEffort: 'medium', reflection: true };
    case 'high':
      return { mode: 'extended', samples: 1, reasoningEffort: 'high', reflection: true };
    case 'max':
      // Strongest streaming-safe directive: ask for multiple internal approaches
      // and reconcile (self-consistency) at high effort.
      return { mode: 'self_consistency', samples: 3, reasoningEffort: 'high', reflection: true };
    default:
      return null;
  }
}

// ── 4b. Verification plan ─────────────────────────────────────────────────────

function planVerification({ difficulty, risk, hasGrounding = false } = {}) {
  const bucket = difficulty ? difficulty.bucket : 'simple';
  const highRisk = risk && risk.level === 'high';
  const baseThreshold = Number.parseFloat(process.env.SIRAGPT_FAITHFULNESS_THRESHOLD || '0.55');
  const threshold = highRisk ? Math.max(baseThreshold, 0.6) : baseThreshold;

  // Faithfulness check pays off when there's grounding to check against and the
  // task is non-trivial, or whenever the domain is high-stakes.
  const faithfulness = (hasGrounding && bucket !== 'trivial') || highRisk;
  const reflection = bucket === 'complex' || highRisk;

  let reason = 'none';
  if (faithfulness && reflection) reason = 'grounded_and_complex';
  else if (faithfulness) reason = hasGrounding ? 'grounded_context' : 'high_risk_domain';
  else if (reflection) reason = 'complex_ungrounded';

  return { faithfulness, threshold: Math.round(threshold * 100) / 100, reflection, reason };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

function decide(input = {}, deps = {}) {
  try {
    const intent = input.intent
      || (input.semanticIntent && input.semanticIntent.intent)
      || (input.semanticIntent && input.semanticIntent.structured_intent && input.semanticIntent.structured_intent.intent_primary)
      || null;

    // Risk is computed first (it only needs prompt + intent) so it can lift the
    // difficulty floor for high-stakes domains.
    const risk = assessRisk(input.prompt, intent);
    const difficulty = assessDifficulty({ ...input, intent, riskLevel: risk.level }, deps);
    const routing = routeModel({ ...input, intent, difficulty, risk }, deps);
    const compute = planCompute({ difficulty, risk, intent, prompt: input.prompt });
    const verify = planVerification({ difficulty, risk, hasGrounding: !!input.hasGrounding });

    const decision = {
      ok: true,
      intent,
      difficulty: {
        bucket: difficulty.bucket,
        score: Math.round((difficulty.score || 0) * 100) / 100,
        hasCode: !!difficulty.hasCode,
        hasComplexity: !!difficulty.hasComplexity,
      },
      risk,
      routing,
      compute,
      verify,
    };
    decision.telemetry = buildTelemetry(decision);
    return decision;
  } catch (err) {
    // Fail-open: conservative no-op decision that changes nothing.
    return {
      ok: false,
      error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      intent: input.intent || null,
      difficulty: { bucket: 'unknown', score: 0, hasCode: false, hasComplexity: false },
      risk: { domains: [], level: 'low' },
      routing: {
        mode: 'off',
        userModel: input.userModel || null,
        userProvider: input.userProvider || null,
        selectedModel: input.userModel || null,
        selectedProvider: input.userProvider || null,
        changed: false,
        action: 'keep',
        reason: 'orchestrator_error',
        shouldApply: false,
        recommendedModel: null,
        alternatives: [],
      },
      compute: { mode: 'direct', samples: 1, reasoningEffort: 'low', reflection: false },
      verify: { faithfulness: false, threshold: 0.55, reflection: false, reason: 'error' },
      telemetry: 'reasoning-orchestrator error (fail-open)',
    };
  }
}

function buildTelemetry(decision) {
  const r = decision.routing || {};
  const c = decision.compute || {};
  const v = decision.verify || {};
  return {
    diff: decision.difficulty.bucket,
    score: decision.difficulty.score,
    risk: decision.risk.level,
    domains: decision.risk.domains.join('|') || '-',
    mode: r.mode,
    action: r.action,
    user_model: r.userModel || '-',
    rec_model: r.recommendedModel || '-',
    sel_model: r.selectedModel || '-',
    changed: !!r.changed,
    compute: c.mode,
    samples: c.samples,
    verify_faith: !!v.faithfulness,
    verify_reflect: !!v.reflection,
  };
}

function summarizeForLog(decision) {
  if (!decision) return '[reasoning-orchestrator] (no decision)';
  const t = decision.telemetry || buildTelemetry(decision);
  return `[reasoning-orchestrator] diff=${t.diff}(${t.score}) risk=${t.risk}/${t.domains} `
    + `route=${t.mode}:${t.action} ${t.user_model}→${t.sel_model} rec=${t.rec_model} `
    + `compute=${t.compute}x${t.samples} verify=${t.verify_faith ? 'faith' : '-'}${t.verify_reflect ? '+reflect' : ''}`;
}

module.exports = {
  decide,
  assessDifficulty,
  assessRisk,
  routeModel,
  planCompute,
  computeForEffort,
  normalizeEffortLevel,
  planVerification,
  summarizeForLog,
  buildNeeds,
  fitnessFor,
  AUTO_MODEL_SENTINELS,
  ROUTING_MODES,
  RISK_DOMAINS,
};
