/**
 * server/intelligence/adapters/security.adapter.ts
 *
 * SecurityGateway port that enriches the self-contained core gateway with the
 * existing backend safety detectors:
 *   - prompt-injection-detector  (heuristic jailbreak/injection scoring)
 *   - refusal-safety-router      (policy verdict routing)
 *
 * The core gateway already provides PII redaction, citation discipline and
 * audit; this adapter raises the verdict / jailbreak confidence when the
 * backend detectors agree, giving defense-in-depth. Dependency-injectable and
 * fail-open — if the backend detectors are unavailable, behavior is identical
 * to the core gateway.
 */

import type { Classification, GroundingContext } from '../ports/common';
import type {
  InputModerationResult,
  OutputModerationResult,
  SecurityAuditEvent,
  SecurityGateway,
  SecurityVerdict,
} from '../ports';
import {
  createDefaultSecurityGateway,
  type SecurityGatewayOptions,
  type SecurityGatewayWithAudit,
} from '../core/security-gateway';
import { loadBackendModule } from './backend-bridge';

export interface InjectionDetectorLike {
  detect?: (text: string) => {
    detected?: boolean;
    confidence?: number;
    patterns?: ReadonlyArray<string>;
  };
}

export interface RefusalRouterLike {
  classify?: (input: { prompt: string }) => {
    verdict?: string;
    triggers?: ReadonlyArray<string>;
  };
}

export interface BackendSecurityDeps extends SecurityGatewayOptions {
  readonly injectionDetector?: InjectionDetectorLike | null;
  readonly refusalRouter?: RefusalRouterLike | null;
}

const VERDICT_RANK: Record<SecurityVerdict, number> = {
  allow: 0,
  caution: 1,
  redact: 2,
  route_to_human: 3,
  refuse: 4,
};

function normalizeVerdict(v: string | undefined): SecurityVerdict | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s === 'allow' || s === 'caution' || s === 'redact' || s === 'refuse') return s;
  if (s === 'route_to_human') return 'route_to_human';
  return null;
}

function maxVerdict(a: SecurityVerdict, b: SecurityVerdict): SecurityVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

export function createBackendSecurityGateway(
  deps: BackendSecurityDeps = {}
): SecurityGatewayWithAudit {
  const base = createDefaultSecurityGateway(deps);

  const injectionDetector =
    deps.injectionDetector ??
    loadBackendModule<InjectionDetectorLike>(
      'backend/src/services/ai/prompt-injection-detector'
    );
  const refusalRouter =
    deps.refusalRouter ??
    loadBackendModule<RefusalRouterLike>('backend/src/services/refusal-safety-router');

  async function moderateInput(input: {
    prompt: string;
    classification?: Classification;
    context?: GroundingContext;
  }): Promise<InputModerationResult> {
    const result = await base.moderateInput(input);
    let verdict = result.verdict;
    let jailbreakConfidence = result.jailbreakConfidence;
    const categories = [...result.categories];

    try {
      const inj = injectionDetector?.detect?.(input.prompt);
      if (inj) {
        const conf = typeof inj.confidence === 'number' ? inj.confidence : 0;
        jailbreakConfidence = Math.max(jailbreakConfidence, conf);
        if (inj.detected) {
          categories.push('backend:prompt_injection');
          verdict = maxVerdict(verdict, conf >= 0.7 ? 'refuse' : 'caution');
        }
      }
    } catch {
      /* fail-open */
    }

    try {
      const ref = refusalRouter?.classify?.({ prompt: input.prompt });
      const refVerdict = normalizeVerdict(ref?.verdict);
      if (refVerdict) {
        categories.push(`backend:refusal_${refVerdict}`);
        verdict = maxVerdict(verdict, refVerdict);
      }
    } catch {
      /* fail-open */
    }

    if (verdict === result.verdict && jailbreakConfidence === result.jailbreakConfidence) {
      return result;
    }
    return {
      ...result,
      verdict,
      jailbreakConfidence,
      categories,
      rationale:
        verdict === 'allow'
          ? result.rationale
          : `${result.rationale}; backend-detectors raised verdict to ${verdict}`,
    };
  }

  async function moderateOutput(input: {
    output: string;
    classification?: Classification;
    context?: GroundingContext;
  }): Promise<OutputModerationResult> {
    return base.moderateOutput(input);
  }

  function audit(event: SecurityAuditEvent): void {
    base.audit(event);
  }

  return { moderateInput, moderateOutput, audit, recentAudit: base.recentAudit };
}
