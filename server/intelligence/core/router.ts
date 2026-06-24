/**
 * server/intelligence/core/router.ts
 *
 * Default ModelRouter — budget-aware model selection driven entirely by the
 * ModelRegistry. It NEVER hardcodes model ids: the candidate set always comes
 * from `registry.listModels(...)` (which, in production, reflects the live
 * OpenRouter / provider catalog). It produces:
 *   - a primary model,
 *   - an ordered, provider-diverse fallback chain,
 *   - an optional escalation target (a more capable model to jump to when the
 *     answer confidence is low).
 *
 * Pure and deterministic given the registry's output.
 */

import type {
  Classification,
  CostTier,
  Difficulty,
  LatencyTier,
  ModelDescriptor,
} from '../ports/common';
import type {
  ModelRegistry,
  ModelRouter,
  RoutingConstraints,
  RoutingDecision,
} from '../ports';

export class NoEligibleModelError extends Error {
  constructor(message = 'no eligible models available') {
    super(message);
    this.name = 'NoEligibleModelError';
  }
}

const COST_RANK: Record<CostTier, number> = { low: 0, medium: 1, high: 2 };
const LATENCY_RANK: Record<LatencyTier, number> = { fast: 0, normal: 1, slow: 2 };

function budgetForDifficulty(
  difficulty: Difficulty,
  riskHigh: boolean
): { maxCost: CostTier; maxLatency: LatencyTier } {
  if (riskHigh) return { maxCost: 'high', maxLatency: 'normal' };
  switch (difficulty) {
    case 'trivial':
    case 'simple':
      return { maxCost: 'low', maxLatency: 'fast' };
    case 'moderate':
      return { maxCost: 'medium', maxLatency: 'normal' };
    case 'complex':
    case 'expert':
    default:
      return { maxCost: 'high', maxLatency: 'normal' };
  }
}

function capabilityWeight(difficulty: Difficulty): number {
  // On hard turns, capability dominates; on easy turns, thrift dominates.
  switch (difficulty) {
    case 'trivial':
    case 'simple':
      return 6;
    case 'moderate':
      return 12;
    case 'complex':
      return 20;
    case 'expert':
    default:
      return 28;
  }
}

interface ScoredModel {
  readonly model: ModelDescriptor;
  readonly score: number;
  readonly meetsHard: boolean;
  readonly reasons: string[];
}

function scoreModel(
  model: ModelDescriptor,
  classification: Classification,
  budget: { maxCost: CostTier; maxLatency: LatencyTier },
  neededContext: number,
  preferModelId: string | undefined
): ScoredModel {
  const reasons: string[] = [];
  let score = 0;
  let meetsHard = true;

  const caps = model.capabilities;

  // --- Hard requirements -----------------------------------------------------
  if (classification.requiresVision && !caps.vision) {
    score -= 1000;
    meetsHard = false;
    reasons.push('missing-vision');
  }
  if (classification.requiresTools && !caps.tools) {
    score -= 60;
    meetsHard = false;
    reasons.push('missing-tools');
  }
  if (neededContext > model.contextWindow) {
    score -= 1000;
    meetsHard = false;
    reasons.push('context-window-too-small');
  } else {
    // Reward headroom modestly (avoids picking a model that barely fits).
    const headroom = model.contextWindow - neededContext;
    if (headroom > neededContext) score += 2;
  }

  // --- Soft capability fit ---------------------------------------------------
  const capW = capabilityWeight(classification.difficulty);
  if (classification.requiresReasoning) {
    if (caps.reasoning) {
      score += capW;
      reasons.push('reasoning-fit');
    } else {
      score -= capW * 0.6;
      reasons.push('no-reasoning');
    }
  } else if (caps.reasoning && classification.difficulty !== 'trivial') {
    score += 2; // mild bonus, reasoning rarely hurts
  }

  if (classification.requiresTools && caps.tools) {
    score += 8;
    reasons.push('tools-fit');
  }
  if (classification.intent === 'code' && caps.code) {
    score += 8;
    reasons.push('code-fit');
  }
  if (classification.requiresLongContext && caps.longContext) {
    score += 8;
    reasons.push('long-context-fit');
  }

  // --- Budget (cost / latency) ----------------------------------------------
  const costOver = COST_RANK[model.costTier] - COST_RANK[budget.maxCost];
  if (costOver > 0) {
    score -= costOver * 14;
    reasons.push(`cost-over-${costOver}`);
  } else {
    // Thrift bonus, larger on easy turns (inverse of capability weight).
    score += (28 - capW) * 0.4 * (COST_RANK[budget.maxCost] - COST_RANK[model.costTier] + 1) * 0.15;
  }

  const latOver = LATENCY_RANK[model.latencyTier] - LATENCY_RANK[budget.maxLatency];
  if (latOver > 0) {
    score -= latOver * 8;
    reasons.push(`latency-over-${latOver}`);
  } else if (model.latencyTier === 'fast') {
    score += 2;
  }

  // --- Respect the user's explicit choice -----------------------------------
  if (preferModelId && model.id === preferModelId) {
    score += 10;
    reasons.push('user-preferred');
  }

  // Tiny deterministic tie-breaker on id so ordering is stable.
  score += stableJitter(model.id);

  return { model, score, meetsHard, reasons };
}

function stableJitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h % 1000) / 1_000_000; // < 0.001, never flips a real decision
}

function capabilityRank(model: ModelDescriptor): number {
  const c = model.capabilities;
  return (
    (c.reasoning ? 4 : 0) +
    (c.longContext ? 2 : 0) +
    (c.tools ? 1 : 0) +
    (c.code ? 1 : 0) +
    COST_RANK[model.costTier] + // higher tier ~ more capable, used as a proxy
    Math.min(4, Math.floor(model.contextWindow / 100_000))
  );
}

function pickProviderDiverseFallbacks(
  ranked: ReadonlyArray<ScoredModel>,
  primary: ModelDescriptor,
  limit: number
): ModelDescriptor[] {
  const out: ModelDescriptor[] = [];
  const seenProviders = new Set<string>([primary.provider]);
  // First pass: prefer different providers for resilience.
  for (const s of ranked) {
    if (out.length >= limit) break;
    if (s.model.id === primary.id) continue;
    if (!s.meetsHard) continue;
    if (seenProviders.has(s.model.provider)) continue;
    out.push(s.model);
    seenProviders.add(s.model.provider);
  }
  // Second pass: fill remaining slots with next-best regardless of provider.
  if (out.length < limit) {
    for (const s of ranked) {
      if (out.length >= limit) break;
      if (s.model.id === primary.id) continue;
      if (!s.meetsHard) continue;
      if (out.some((m) => m.id === s.model.id)) continue;
      out.push(s.model);
    }
  }
  return out;
}

export interface DefaultRouterOptions {
  readonly fallbackChainLength?: number;
}

export function createDefaultRouter(
  options: DefaultRouterOptions = {}
): ModelRouter {
  const fallbackChainLength = Math.max(0, options.fallbackChainLength ?? 2);

  async function route(
    input: { classification: Classification; constraints?: RoutingConstraints },
    registry: ModelRegistry
  ): Promise<RoutingDecision> {
    const { classification } = input;
    const constraints = input.constraints ?? {};

    const all = await registry.listModels({
      plan: constraints.plan,
      onlyReachable: true,
    });

    const blocklist = new Set(constraints.blocklist ?? []);
    let candidates = all.filter((m) => !blocklist.has(m.id));

    if (candidates.length === 0) {
      // Fail-open: if the registry yielded nothing but the user named a model,
      // synthesize a minimal descriptor so the request can still proceed.
      if (constraints.preferModelId) {
        const synthetic = syntheticDescriptor(constraints.preferModelId);
        return {
          primary: synthetic,
          fallbacks: [],
          rationale: `registry-empty; honoring requested model ${synthetic.id}`,
          score: 0,
          changedFromRequested: false,
        };
      }
      throw new NoEligibleModelError();
    }

    const riskHigh = classification.riskLevel === 'high';
    const budget = {
      maxCost: constraints.maxCostTier ?? budgetForDifficulty(classification.difficulty, riskHigh).maxCost,
      maxLatency:
        constraints.maxLatencyTier ??
        budgetForDifficulty(classification.difficulty, riskHigh).maxLatency,
    };

    // Context the window must hold: history + prompt + reserved output.
    const neededContext =
      classification.estimatedContextTokens + classification.estimatedOutputTokens;

    const scored = candidates
      .map((m) => scoreModel(m, classification, budget, neededContext, constraints.preferModelId))
      .sort((a, b) => b.score - a.score);

    // Honor the user's explicit model choice when it is eligible and meets the
    // hard requirements (the platform default is to respect the user's pick;
    // capability/budget scoring drives auto-selection + the fallback order).
    const preferredScored = constraints.preferModelId
      ? scored.find((s) => s.model.id === constraints.preferModelId && s.meetsHard)
      : undefined;

    // Otherwise prefer the top-scored hard-requirement-satisfying model.
    const primaryScored = preferredScored ?? scored.find((s) => s.meetsHard) ?? scored[0];
    const primary = primaryScored.model;

    const fallbacks = pickProviderDiverseFallbacks(scored, primary, fallbackChainLength);

    // Escalation target: the most capable distinct model, used when the
    // produced answer's confidence is low. Only meaningful when escalation is
    // allowed and a strictly-more-capable model exists.
    let escalation: ModelDescriptor | undefined;
    const allowEscalation = constraints.allowEscalation !== false;
    if (allowEscalation) {
      const primaryCap = capabilityRank(primary);
      const moreCapable = [...candidates]
        .filter((m) => m.id !== primary.id && capabilityRank(m) > primaryCap)
        .sort((a, b) => capabilityRank(b) - capabilityRank(a));
      if (moreCapable.length > 0) escalation = moreCapable[0];
    }

    const changedFromRequested =
      !!constraints.preferModelId && constraints.preferModelId !== primary.id;

    const rationale =
      `picked ${primary.id} (score ${primaryScored.score.toFixed(2)}; ` +
      `${primaryScored.reasons.join(', ') || 'baseline'}); ` +
      `budget cost<=${budget.maxCost} latency<=${budget.maxLatency}; ` +
      `fallbacks ${fallbacks.map((f) => f.id).join('>') || 'none'}` +
      (escalation ? `; escalate->${escalation.id}` : '');

    return {
      primary,
      fallbacks,
      escalation,
      rationale,
      score: primaryScored.score,
      changedFromRequested,
    };
  }

  return { route };
}

/** Minimal, conservative descriptor for a model id we know nothing about. */
export function syntheticDescriptor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'unknown',
    contextWindow: 8_192,
    capabilities: {
      reasoning: false,
      code: false,
      tools: false,
      vision: false,
      longContext: false,
    },
    costTier: 'medium',
    latencyTier: 'normal',
    reachable: true,
  };
}
