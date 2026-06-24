/**
 * server/intelligence/config.ts
 *
 * Env-driven configuration for the intelligence core. Mirrors the repo
 * convention of reading `process.env` directly (no central config object
 * exists in the backend) while keeping all reads in one typed place.
 *
 * The entire core is gated behind `SIRAGPT_INTELLIGENCE_CORE_ENABLED` and is
 * OFF by default for a safe rollout.
 */

export type EnvLike = Record<string, string | undefined>;

export interface IntelligenceConfig {
  /** Master kill-switch. Default false. */
  readonly enabled: boolean;
  /** Hard token ceiling for the assembled context window. */
  readonly maxContextTokens: number;
  /** Tokens reserved for the model's output (kept free in the window). */
  readonly reserveOutputTokens: number;
  /** Keep at least this many recent turns verbatim during compaction. */
  readonly minRecentMessages: number;
  /** Default cost ceiling for routing when the turn is cheap. */
  readonly defaultMaxCostTier: 'low' | 'medium' | 'high';
  /** Allow the router to escalate past the user's model on hard/low-conf turns. */
  readonly allowEscalation: boolean;
  /** Confidence under which we escalate to the more-capable model. */
  readonly escalationConfidenceThreshold: number;
  /** Retry policy for transient model failures. */
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** Per-attempt timeout for a model call. */
  readonly attemptTimeoutMs: number;
  /** Prompt cache TTL. */
  readonly promptCacheTtlMs: number;
  /** A/B experiment id active for the composed prompt (empty = none). */
  readonly promptExperiment: string;
  /** Memory recall fan-out (top-k). */
  readonly memoryRecallK: number;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return dflt;
}

function int(v: string | undefined, dflt: number): number {
  if (v == null || v === '') return dflt;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function num(v: string | undefined, dflt: number): number {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function costTier(
  v: string | undefined,
  dflt: 'low' | 'medium' | 'high'
): 'low' | 'medium' | 'high' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  return dflt;
}

/**
 * Resolve the intelligence-core configuration from the environment.
 * Pure: same env in ⇒ same config out.
 */
export function loadIntelligenceConfig(
  env: EnvLike = process.env as EnvLike
): IntelligenceConfig {
  return {
    enabled: bool(env.SIRAGPT_INTELLIGENCE_CORE_ENABLED, false),
    maxContextTokens: int(env.SIRAGPT_INTELLIGENCE_MAX_CONTEXT_TOKENS, 24_000),
    reserveOutputTokens: int(env.SIRAGPT_INTELLIGENCE_RESERVE_OUTPUT_TOKENS, 2_048),
    minRecentMessages: int(env.SIRAGPT_INTELLIGENCE_MIN_RECENT_MESSAGES, 4),
    defaultMaxCostTier: costTier(env.SIRAGPT_INTELLIGENCE_DEFAULT_COST_TIER, 'medium'),
    allowEscalation: bool(env.SIRAGPT_INTELLIGENCE_ALLOW_ESCALATION, true),
    escalationConfidenceThreshold: num(
      env.SIRAGPT_INTELLIGENCE_ESCALATION_CONFIDENCE,
      0.55
    ),
    maxRetries: int(env.SIRAGPT_INTELLIGENCE_MAX_RETRIES, 2),
    retryBaseMs: int(env.SIRAGPT_INTELLIGENCE_RETRY_BASE_MS, 250),
    retryMaxMs: int(env.SIRAGPT_INTELLIGENCE_RETRY_MAX_MS, 8_000),
    attemptTimeoutMs: int(env.SIRAGPT_INTELLIGENCE_ATTEMPT_TIMEOUT_MS, 60_000),
    promptCacheTtlMs: int(env.SIRAGPT_INTELLIGENCE_PROMPT_CACHE_TTL_MS, 600_000),
    promptExperiment: String(env.SIRAGPT_INTELLIGENCE_PROMPT_EXPERIMENT ?? '').trim(),
    memoryRecallK: int(env.SIRAGPT_INTELLIGENCE_MEMORY_RECALL_K, 5),
  };
}

/** Convenience: is the intelligence core enabled for this environment? */
export function isIntelligenceCoreEnabled(
  env: EnvLike = process.env as EnvLike
): boolean {
  return bool(env.SIRAGPT_INTELLIGENCE_CORE_ENABLED, false);
}
