'use strict';

/**
 * Jev tier steering — applies the RLCD × Jev turn judge's `model_family`
 * verdict to the Sira flash↔pro tier routing.
 *
 * The per-turn judge (rlcd/jev-turn-judge.js, TypeSafe Jev via the native
 * /v1/systemone provider) already answers, with calibrated probabilities,
 * which model family the turn needs (fast_cheap | balanced | reasoning |
 * coding | vision) and computes `actions.modelFamily.steer` — true only when
 * the user did NOT pick a model, SIRAGPT_RLCD_JEV_MODEL_STEERING is on and
 * the confidence clears SIRAGPT_RLCD_JEV_MODEL_CONFIDENCE. Until now nothing
 * consumed that bit; this module is the consumer.
 *
 * It refines the reasoning-orchestrator routing decision that ai.js already
 * knows how to apply: a reasoning/coding verdict escalates a flash-tier turn
 * to the pro tier, and a fast_cheap verdict vetoes a heuristic escalation to
 * the pro tier. Everything else stays advisory. No network calls happen
 * here — the judge already ran — and every guard the apply block enforces
 * (picker wins, plan gate, provider inference, reachability) still applies
 * downstream. Fail-open by shape: a missing/oddly-shaped judgement is a
 * no-op.
 */

// Mirrors custom-provider-client isSiraRapidoRow / isSiraProRow, applied to a
// bare model id ('deepseek-v4-flash' or 'deepseek/deepseek-v4-flash').
function isFlashTierModel(modelId) {
  const id = String(modelId || '');
  return /deepseek/i.test(id) && /v4[-_\s]?flash/i.test(id);
}

function isProTierModel(modelId) {
  const id = String(modelId || '');
  return /deepseek/i.test(id) && /v4[-_\s]?pro/i.test(id) && !/flash/i.test(id);
}

/** flash id → pro id preserving the provider shape (direct vs openrouter slug). */
function flashToProModelId(modelId, env = process.env) {
  const override = String((env && env.SIRAGPT_JEV_PRO_TARGET) || '').trim();
  if (override) return override;
  return String(modelId || '').replace(/(v4[-_]?)flash/i, '$1pro');
}

/**
 * model_family choice → Sira tier opinion.
 * reasoning/coding need the pro tier; fast_cheap is happy on flash;
 * balanced and vision express no tier opinion (vision has its own path).
 */
function mapFamilyToTier(familyChoice) {
  const family = String(familyChoice || '').trim().toLowerCase();
  if (family === 'reasoning' || family === 'coding') return 'pro';
  if (family === 'fast_cheap') return 'flash';
  return null;
}

function outcome(routing, applied, reason, family) {
  return {
    routing,
    steering: {
      applied,
      reason,
      family: family && family.choice ? family.choice : null,
      confidence: family && Number.isFinite(family.confidence) ? family.confidence : null,
      probability: family && Number.isFinite(family.probability) ? family.probability : null,
      steer: Boolean(family && family.steer),
    },
  };
}

/**
 * Refine the reasoning-orchestrator routing decision with the turn judge's
 * model-family verdict. Pure and synchronous: returns a NEW routing object
 * when it changes anything, the original otherwise, plus a `steering` report
 * for telemetry. `judged` is req._rlcdJudge (rlcd.judgeTurnWithJev output).
 *
 * ctx: { currentModel, hasImages, reachableModelIds }
 */
function refineRoutingWithJevJudgement(routing, judged, ctx = {}, env = process.env) {
  const family = judged && judged.actions && judged.actions.modelFamily
    ? judged.actions.modelFamily
    : null;
  if (!family || !family.choice) return outcome(routing, false, 'no_verdict', null);
  if (ctx.hasImages) return outcome(routing, false, 'has_images', family);

  const tier = mapFamilyToTier(family.choice);
  if (!tier) return outcome(routing, false, 'no_tier_opinion', family);
  // steer=false means advisory only (flag off, low confidence, or the user
  // picked a model): report the verdict, change nothing.
  if (!family.steer) return outcome(routing, false, 'advisory', family);

  if (tier === 'pro') {
    if (!isFlashTierModel(ctx.currentModel)) return outcome(routing, false, 'not_flash_tier', family);
    const target = flashToProModelId(ctx.currentModel, env);
    if (!isProTierModel(target)) return outcome(routing, false, 'bad_target', family);
    const reachable = ctx.reachableModelIds instanceof Set
      ? ctx.reachableModelIds
      : (Array.isArray(ctx.reachableModelIds) ? new Set(ctx.reachableModelIds) : null);
    if (reachable && !reachable.has(target)) return outcome(routing, false, 'target_unreachable', family);
    return outcome({
      ...routing,
      selectedModel: target,
      selectedProvider: null, // caller re-infers provider from the id
      changed: true,
      action: 'escalate',
      shouldApply: true,
      reason: `jev:family_${family.choice}:${Math.round((family.probability || 0) * 100) / 100}`,
    }, true, 'escalated', family);
  }

  // tier === 'flash' — veto a heuristic escalation to the pro tier only;
  // escalations to any other model (vision, long-context…) are not ours.
  if (routing && routing.shouldApply && isProTierModel(routing.selectedModel)) {
    return outcome({
      ...routing,
      selectedModel: routing.userModel || ctx.currentModel || null,
      selectedProvider: routing.userProvider || null,
      changed: false,
      action: 'keep',
      shouldApply: false,
      reason: 'jev:veto_escalation',
    }, true, 'vetoed_escalation', family);
  }
  return outcome(routing, false, 'keep', family);
}

module.exports = {
  isFlashTierModel,
  isProTierModel,
  flashToProModelId,
  mapFamilyToTier,
  refineRoutingWithJevJudgement,
};
