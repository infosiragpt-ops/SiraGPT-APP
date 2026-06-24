/**
 * server/intelligence/core/security-gateway.ts
 *
 * Default SecurityGateway — the constitutional safety/ethics layer that wraps
 * the whole intelligence core. Deterministic, dependency-free heuristics
 * (bilingual ES/EN) that:
 *   - moderate INPUT: detect prompt-injection / jailbreak, classify refusal
 *     categories, strip credentials/secrets, and emit a verdict;
 *   - moderate OUTPUT: strip leaked secrets/financial-PII, and enforce citation
 *     discipline against the supplied grounding context (zero source
 *     hallucination — flag any citation marker that points at a non-existent
 *     source);
 *   - audit every decision into a bounded ring buffer (+ optional sink).
 *
 * Policy is conservative and fail-open: an internal error degrades to `allow`
 * with the original text rather than blocking the user.
 */

import type {
  Classification,
  GroundingContext,
} from '../ports/common';
import type {
  CitationDiscipline,
  InputModerationResult,
  OutputModerationResult,
  Redaction,
  SecurityAuditEvent,
  SecurityGateway,
  SecurityVerdict,
} from '../ports';

/* -------------------------------------------------------------------------- */
/* Pattern banks                                                              */
/* -------------------------------------------------------------------------- */

interface JailbreakPattern {
  readonly tag: string;
  readonly re: RegExp;
  readonly weight: number;
  /** Severe patterns can force a refusal on their own. */
  readonly severe?: boolean;
}

const JAILBREAK_PATTERNS: ReadonlyArray<JailbreakPattern> = [
  { tag: 'ignore_instructions', weight: 0.4, re: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|all)\b.{0,20}\b(instructions?|rules?|prompt)\b/i },
  { tag: 'ignore_instructions', weight: 0.4, re: /\b(ignora|olvida|haz caso omiso)\b.{0,30}\b(anteriores?|previas?|todas?)\b.{0,20}\b(instrucciones?|reglas?)\b/i },
  { tag: 'disable_safety', weight: 0.6, severe: true, re: /\b(disable|bypass|turn off|remove)\b.{0,20}\b(safety|guardrails?|moderation|filters?|restrictions?)\b/i },
  { tag: 'disable_safety', weight: 0.6, severe: true, re: /\b(desactiva|elimina|salta|omite)\b.{0,20}\b(seguridad|restricciones?|filtros?|moderaci[oó]n)\b/i },
  { tag: 'system_prompt_exfil', weight: 0.6, severe: true, re: /\b(reveal|show|print|repeat|leak)\b.{0,20}\b(system prompt|initial instructions|your instructions|hidden prompt)\b/i },
  { tag: 'system_prompt_exfil', weight: 0.6, severe: true, re: /\b(revela|muestra|imprime|repite)\b.{0,20}\b(prompt del sistema|instrucciones iniciales|tus instrucciones)\b/i },
  { tag: 'role_swap', weight: 0.45, re: /\b(you are now|pretend to be|act as|from now on you are)\b.{0,30}\b(dan|jailbroken|developer mode|unrestricted|no rules)\b/i },
  { tag: 'role_swap', weight: 0.45, re: /\b(ahora eres|act[uú]a como|finge ser)\b.{0,30}\b(sin reglas|sin restricciones|modo desarrollador)\b/i },
  { tag: 'override_persona', weight: 0.3, re: /\bdeveloper mode\b|\bmodo desarrollador\b|\bDAN\b/i },
];

interface RefusalPattern {
  readonly tag: string;
  readonly re: RegExp;
  readonly verdict: SecurityVerdict;
}

const REFUSAL_PATTERNS: ReadonlyArray<RefusalPattern> = [
  { tag: 'self_harm', verdict: 'route_to_human', re: /\b(how to (kill myself|commit suicide)|end my life|c[oó]mo suicidarme|quitarme la vida)\b/i },
  { tag: 'weapons_mass', verdict: 'refuse', re: /\b(build|make|synthesi[sz]e)\b.{0,30}\b(bioweapon|nerve agent|dirty bomb|nuclear device|arma biol[oó]gica|agente nervioso)\b/i },
  { tag: 'malware', verdict: 'refuse', re: /\b(write|create|build)\b.{0,30}\b(ransomware|keylogger|rootkit|botnet|self-?propagating (virus|worm))\b/i },
  { tag: 'cyber_intrusion', verdict: 'caution', re: /\b(hack into|gain unauthorized access|exploit a vulnerability in)\b/i },
];

/* -------------------------------------------------------------------------- */
/* PII / secrets                                                              */
/* -------------------------------------------------------------------------- */

interface PiiRule {
  readonly type: string;
  readonly re: RegExp;
  /** `secret` => always stripped; `financial` => stripped from output. */
  readonly severity: 'secret' | 'financial' | 'contact' | 'network';
}

const PII_RULES: ReadonlyArray<PiiRule> = [
  { type: 'api_key', severity: 'secret', re: /\b(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { type: 'private_key', severity: 'secret', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { type: 'jwt', severity: 'secret', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: 'credit_card', severity: 'financial', re: /\b(?:\d[ -]?){15,16}\b/g },
  { type: 'ssn', severity: 'financial', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'iban', severity: 'financial', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g },
  { type: 'email', severity: 'contact', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { type: 'ipv4', severity: 'network', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

function placeholder(type: string): string {
  return `[REDACTED_${type.toUpperCase()}]`;
}

function applyRedactions(
  text: string,
  shouldStrip: (rule: PiiRule) => boolean
): { text: string; redactions: Redaction[] } {
  let out = text;
  const redactions: Redaction[] = [];
  for (const rule of PII_RULES) {
    const matches = out.match(rule.re);
    if (!matches || matches.length === 0) continue;
    redactions.push({ type: rule.type, count: matches.length });
    if (shouldStrip(rule)) {
      out = out.replace(rule.re, placeholder(rule.type));
    }
  }
  return { text: out, redactions };
}

/* -------------------------------------------------------------------------- */
/* Citation discipline                                                        */
/* -------------------------------------------------------------------------- */

const CITATION_MARKER = /\[(?:source|fuente)\s*:?\s*(\d+)\]|\[(\d{1,3})\]/gi;

function checkCitations(
  output: string,
  classification: Classification | undefined,
  context: GroundingContext | undefined
): CitationDiscipline {
  const sourceCount = context?.sources.length ?? 0;
  const groundedIntent =
    classification != null &&
    ['research', 'search', 'analyze', 'compare', 'review'].includes(classification.intent);
  const required = groundedIntent && sourceCount > 0;

  const issues: string[] = [];
  const cited: number[] = [];
  let m: RegExpExecArray | null;
  CITATION_MARKER.lastIndex = 0;
  while ((m = CITATION_MARKER.exec(output)) != null) {
    const n = Number.parseInt(m[1] ?? m[2] ?? '', 10);
    if (Number.isFinite(n)) cited.push(n);
  }

  // Zero source hallucination: every cited index must exist in the context.
  for (const n of cited) {
    if (n < 1 || n > sourceCount) {
      issues.push(`cites source [${n}] which does not exist (only ${sourceCount} provided)`);
    }
  }

  const satisfied = required ? cited.some((n) => n >= 1 && n <= sourceCount) && issues.length === 0 : issues.length === 0;
  if (required && cited.length === 0) {
    issues.push('grounded answer is missing citation markers to the provided sources');
  }

  return { required, satisfied, issues };
}

/* -------------------------------------------------------------------------- */
/* Gateway                                                                    */
/* -------------------------------------------------------------------------- */

function verdictRank(v: SecurityVerdict): number {
  const order: Record<SecurityVerdict, number> = {
    allow: 0,
    caution: 1,
    redact: 2,
    route_to_human: 3,
    refuse: 4,
  };
  return order[v];
}

function maxVerdict(a: SecurityVerdict, b: SecurityVerdict): SecurityVerdict {
  return verdictRank(a) >= verdictRank(b) ? a : b;
}

export interface SecurityGatewayOptions {
  /** Receives every audit event (e.g. to forward to Langfuse). */
  readonly auditSink?: (event: SecurityAuditEvent) => void;
  /** Size of the in-memory audit ring buffer. */
  readonly auditBufferSize?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
  /** Jailbreak confidence at/above which severe patterns force a refusal. */
  readonly refuseThreshold?: number;
}

export interface SecurityGatewayWithAudit extends SecurityGateway {
  /** Read back recent audit events (most-recent last). */
  recentAudit(): ReadonlyArray<SecurityAuditEvent>;
}

export function createDefaultSecurityGateway(
  options: SecurityGatewayOptions = {}
): SecurityGatewayWithAudit {
  const now = options.now ?? (() => Date.now());
  const bufferSize = Math.max(16, options.auditBufferSize ?? 256);
  const refuseThreshold = options.refuseThreshold ?? 0.55;
  const buffer: SecurityAuditEvent[] = [];

  function audit(event: SecurityAuditEvent): void {
    buffer.push(event);
    if (buffer.length > bufferSize) buffer.shift();
    if (options.auditSink) {
      try {
        options.auditSink(event);
      } catch {
        /* never let an audit sink break the request */
      }
    }
  }

  async function moderateInput(input: {
    prompt: string;
    classification?: Classification;
    context?: GroundingContext;
  }): Promise<InputModerationResult> {
    try {
      const prompt = String(input?.prompt ?? '');
      const categories: string[] = [];
      let verdict: SecurityVerdict = 'allow';

      // Jailbreak / injection scoring.
      let jbScore = 0;
      let severe = false;
      for (const p of JAILBREAK_PATTERNS) {
        if (p.re.test(prompt)) {
          jbScore += p.weight;
          categories.push(`jailbreak:${p.tag}`);
          if (p.severe) severe = true;
        }
      }
      const jailbreakConfidence = Math.min(1, jbScore);
      if (severe && jailbreakConfidence >= refuseThreshold) {
        verdict = maxVerdict(verdict, 'refuse');
      } else if (jailbreakConfidence > 0) {
        verdict = maxVerdict(verdict, 'caution');
      }

      // Refusal categories.
      for (const r of REFUSAL_PATTERNS) {
        if (r.re.test(prompt)) {
          categories.push(`policy:${r.tag}`);
          verdict = maxVerdict(verdict, r.verdict);
        }
      }

      // Strip credentials/secrets from the prompt that flows downstream; report
      // (but pass through) the user's own contact/network PII so the assistant
      // can still help them with their own data.
      const { text: sanitizedPrompt, redactions } = applyRedactions(
        prompt,
        (rule) => rule.severity === 'secret'
      );
      if (redactions.some((r) => ['api_key', 'private_key', 'jwt'].includes(r.type))) {
        verdict = maxVerdict(verdict, 'redact');
        categories.push('secret_in_prompt');
      }

      const rationale =
        verdict === 'allow'
          ? 'no policy signals detected'
          : `verdict=${verdict}; ${categories.join(', ')}`;

      return {
        verdict,
        categories,
        jailbreakConfidence,
        sanitizedPrompt,
        redactions,
        rationale,
      };
    } catch (e) {
      // Fail-open.
      return {
        verdict: 'allow',
        categories: ['error'],
        jailbreakConfidence: 0,
        sanitizedPrompt: String(input?.prompt ?? ''),
        redactions: [],
        rationale: `moderation error (fail-open): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async function moderateOutput(input: {
    output: string;
    classification?: Classification;
    context?: GroundingContext;
  }): Promise<OutputModerationResult> {
    try {
      const output = String(input?.output ?? '');
      // Strip secrets always; strip financial PII from model output (it must
      // never emit card/ssn/iban numbers); pass through contact/network PII.
      const { text: sanitizedOutput, redactions } = applyRedactions(
        output,
        (rule) => rule.severity === 'secret' || rule.severity === 'financial'
      );

      const citationDiscipline = checkCitations(
        output,
        input.classification,
        input.context
      );

      let verdict: SecurityVerdict = 'allow';
      if (redactions.some((r) => ['api_key', 'private_key', 'jwt', 'credit_card', 'ssn', 'iban'].includes(r.type))) {
        verdict = maxVerdict(verdict, 'redact');
      }
      if (citationDiscipline.required && !citationDiscipline.satisfied) {
        verdict = maxVerdict(verdict, 'caution');
      }

      const rationale =
        verdict === 'allow' && citationDiscipline.issues.length === 0
          ? 'clean output'
          : `verdict=${verdict}; citation_issues=${citationDiscipline.issues.length}`;

      return {
        verdict,
        sanitizedOutput,
        redactions,
        citationDiscipline,
        rationale,
      };
    } catch (e) {
      return {
        verdict: 'allow',
        sanitizedOutput: String(input?.output ?? ''),
        redactions: [],
        citationDiscipline: { required: false, satisfied: true, issues: [] },
        rationale: `moderation error (fail-open): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  function recentAudit(): ReadonlyArray<SecurityAuditEvent> {
    return [...buffer];
  }

  return { moderateInput, moderateOutput, audit, recentAudit };
}
