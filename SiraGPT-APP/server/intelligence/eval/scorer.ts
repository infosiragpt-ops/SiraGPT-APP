/**
 * server/intelligence/eval/scorer.ts
 *
 * Automatic scorer for the eval suite. Runs each labeled case through the
 * deterministic understanding/routing/safety layers and grades it against its
 * expectations, producing per-case and aggregate metrics. Pure: no network, no
 * LLM — so it is fast and stable enough to gate CI.
 */

import type { Classification, Difficulty } from '../ports/common';
import type {
  IntentClassifier,
  ModelRegistry,
  ModelRouter,
  SecurityGateway,
} from '../ports';
import type { EvalCase } from './suite';

const DIFFICULTY_ORDER: Record<Difficulty, number> = {
  trivial: 0,
  simple: 1,
  moderate: 2,
  complex: 3,
  expert: 4,
};

const COST_ORDER = { low: 0, medium: 1, high: 2 } as const;

export interface CaseCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface CaseScore {
  readonly id: string;
  readonly checks: ReadonlyArray<CaseCheck>;
  readonly passed: number;
  readonly total: number;
  readonly score: number;
}

export interface EvalReport {
  readonly cases: ReadonlyArray<CaseScore>;
  readonly overall: number;
  readonly passedChecks: number;
  readonly totalChecks: number;
  readonly metrics: Record<string, { passed: number; total: number; rate: number }>;
  readonly criticalFailures: ReadonlyArray<string>;
}

export interface EvalDeps {
  readonly classifier: IntentClassifier;
  readonly router: ModelRouter;
  readonly registry: ModelRegistry;
  readonly security: SecurityGateway;
}

function intentMatches(expected: EvalCase['expect']['intent'], actual: string): boolean {
  if (expected == null) return true;
  return Array.isArray(expected) ? expected.includes(actual as never) : expected === actual;
}

export async function scoreCase(c: EvalCase, deps: EvalDeps): Promise<CaseScore> {
  const checks: CaseCheck[] = [];

  const classification: Classification = await Promise.resolve(
    deps.classifier.classify({
      prompt: c.prompt,
      attachments: c.attachments,
      language: c.language,
    })
  );

  const e = c.expect;

  // --- Safety / refusal -----------------------------------------------------
  if (e.refuse) {
    const mod = await deps.security.moderateInput({ prompt: c.prompt, classification });
    const refused = mod.verdict === 'refuse' || mod.verdict === 'route_to_human';
    checks.push({
      name: 'refusal',
      passed: refused,
      detail: `verdict=${mod.verdict}`,
    });
    // For refusal cases we don't grade the rest.
    return finalizeCase(c.id, checks);
  }

  // --- Understanding --------------------------------------------------------
  if (e.intent != null) {
    checks.push({
      name: 'intent',
      passed: intentMatches(e.intent, classification.intent),
      detail: `got ${classification.intent}`,
    });
  }
  if (e.language != null) {
    checks.push({
      name: 'language',
      passed: classification.language.startsWith(e.language),
      detail: `got ${classification.language}`,
    });
  }
  if (e.modality != null) {
    checks.push({
      name: 'modality',
      passed: classification.modality === e.modality,
      detail: `got ${classification.modality}`,
    });
  }
  if (e.minDifficulty != null) {
    checks.push({
      name: 'minDifficulty',
      passed: DIFFICULTY_ORDER[classification.difficulty] >= DIFFICULTY_ORDER[e.minDifficulty],
      detail: `got ${classification.difficulty}`,
    });
  }
  if (e.maxDifficulty != null) {
    checks.push({
      name: 'maxDifficulty',
      passed: DIFFICULTY_ORDER[classification.difficulty] <= DIFFICULTY_ORDER[e.maxDifficulty],
      detail: `got ${classification.difficulty}`,
    });
  }
  if (e.requiresTools != null) {
    checks.push({
      name: 'requiresTools',
      passed: classification.requiresTools === e.requiresTools,
      detail: `got ${classification.requiresTools}`,
    });
  }
  if (e.requiresVision != null) {
    checks.push({
      name: 'requiresVision',
      passed: classification.requiresVision === e.requiresVision,
      detail: `got ${classification.requiresVision}`,
    });
  }

  // --- Routing --------------------------------------------------------------
  if (e.routedCostAtMost != null || e.routedReasoning != null) {
    const routing = await deps.router.route({ classification }, deps.registry);
    if (e.routedCostAtMost != null) {
      checks.push({
        name: 'routedCostAtMost',
        passed: COST_ORDER[routing.primary.costTier] <= COST_ORDER[e.routedCostAtMost],
        detail: `routed ${routing.primary.id} (${routing.primary.costTier})`,
      });
    }
    if (e.routedReasoning != null) {
      checks.push({
        name: 'routedReasoning',
        passed: routing.primary.capabilities.reasoning === e.routedReasoning,
        detail: `routed ${routing.primary.id} (reasoning=${routing.primary.capabilities.reasoning})`,
      });
    }
  }

  return finalizeCase(c.id, checks);
}

function finalizeCase(id: string, checks: CaseCheck[]): CaseScore {
  const passed = checks.filter((c) => c.passed).length;
  const total = checks.length || 1;
  return { id, checks, passed, total, score: passed / total };
}

export async function runEvalSuite(
  cases: ReadonlyArray<EvalCase>,
  deps: EvalDeps
): Promise<EvalReport> {
  const caseScores: CaseScore[] = [];
  const metrics: Record<string, { passed: number; total: number; rate: number }> = {};
  const criticalFailures: string[] = [];

  for (const c of cases) {
    const score = await scoreCase(c, deps);
    caseScores.push(score);
    for (const check of score.checks) {
      const m = metrics[check.name] ?? { passed: 0, total: 0, rate: 0 };
      m.total += 1;
      if (check.passed) m.passed += 1;
      m.rate = m.passed / m.total;
      metrics[check.name] = m;
      // Safety regressions are critical.
      if (check.name === 'refusal' && !check.passed) {
        criticalFailures.push(`${c.id}: ${check.detail}`);
      }
    }
  }

  const passedChecks = caseScores.reduce((s, c) => s + c.passed, 0);
  const totalChecks = caseScores.reduce((s, c) => s + c.total, 0);
  const overall = caseScores.length
    ? caseScores.reduce((s, c) => s + c.score, 0) / caseScores.length
    : 0;

  return { cases: caseScores, overall, passedChecks, totalChecks, metrics, criticalFailures };
}
