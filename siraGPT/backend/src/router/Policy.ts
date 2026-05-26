// Provider routing policy.
//
// A Policy ranks the configured providers for a given task. The router
// then walks that ordering, applying circuit-breaker state and falling
// back on classified errors.
//
// Three built-in policies are selected by env SIRA_ROUTING_POLICY:
//   - "cost"    : cheapest cost-per-1k-tokens first
//   - "quality" : highest quality score first
//   - "latency" : lowest p50 latency first
//
// All three apply task-capability filtering first (e.g. a task that
// requests vision skips providers without a vision model). Ties break
// deterministically by provider id so ordering is stable across calls.

export type PolicyName = 'cost' | 'quality' | 'latency';

export type ErrorClass = '429' | '5xx' | 'timeout' | 'content-filter' | 'auth' | 'unknown';

export interface ProviderProfile {
  id: string;
  // Cost in USD per 1k output tokens. Lower is cheaper.
  costPer1kTokens: number;
  // Quality score, higher is better. Free-form scale (e.g. 0..100).
  qualityScore: number;
  // Median latency in ms. Lower is better.
  latencyP50Ms: number;
  // Capability tags this provider satisfies (e.g. "chat", "vision",
  // "embeddings", "tools").
  capabilities: string[];
  // Optional priority bump applied before policy ranking. Higher first.
  priority?: number;
}

export interface TaskRequirements {
  // Capabilities the task needs. All must be present in the provider.
  capabilities?: string[];
  // Hard pin: only these providers are considered (still in policy order).
  allowProviders?: string[];
  // Hard exclusion: never route to these providers.
  denyProviders?: string[];
}

const COMPARATORS: Record<PolicyName, (a: ProviderProfile, b: ProviderProfile) => number> = {
  cost: (a, b) => a.costPer1kTokens - b.costPer1kTokens,
  quality: (a, b) => b.qualityScore - a.qualityScore,
  latency: (a, b) => a.latencyP50Ms - b.latencyP50Ms,
};

export function parsePolicyName(raw: string | undefined): PolicyName {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'cost' || v === 'quality' || v === 'latency') return v;
  return 'quality';
}

export class Policy {
  readonly name: PolicyName;

  constructor(name: PolicyName = 'quality') {
    this.name = name;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Policy {
    return new Policy(parsePolicyName(env.SIRA_ROUTING_POLICY));
  }

  // Returns provider ids in attempt order: primary first, then fallbacks.
  rank(providers: ProviderProfile[], task: TaskRequirements = {}): string[] {
    const requested = new Set(task.capabilities ?? []);
    const allow = task.allowProviders ? new Set(task.allowProviders) : null;
    const deny = task.denyProviders ? new Set(task.denyProviders) : null;

    const eligible = providers.filter(p => {
      if (allow && !allow.has(p.id)) return false;
      if (deny && deny.has(p.id)) return false;
      for (const cap of requested) {
        if (!p.capabilities.includes(cap)) return false;
      }
      return true;
    });

    const cmp = COMPARATORS[this.name];
    const sorted = [...eligible].sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      const primary = cmp(a, b);
      if (primary !== 0) return primary;
      return a.id.localeCompare(b.id);
    });

    return sorted.map(p => p.id);
  }
}

// Map a thrown error to a normalized class. The router uses this to
// decide between immediate fallback (auth, content-filter), retry-then-
// fallback (429, 5xx, timeout), and rethrow (unknown non-transient).
export function classifyError(err: unknown): ErrorClass {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as { status?: number; statusCode?: number; code?: string; name?: string; message?: string; type?: string };
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const code = (e.code ?? '').toString().toLowerCase();
  const name = (e.name ?? '').toString().toLowerCase();
  const msg = (e.message ?? '').toString().toLowerCase();
  const type = (e.type ?? '').toString().toLowerCase();

  if (status === 429 || code === 'rate_limit_exceeded' || msg.includes('rate limit')) return '429';
  if (status === 401 || status === 403 || code === 'invalid_api_key' || msg.includes('unauthorized')) return 'auth';
  if (
    code === 'content_filter' ||
    type.includes('content_filter') ||
    msg.includes('content filter') ||
    msg.includes('content policy')
  ) return 'content-filter';
  if (code === 'etimedout' || name === 'aborterror' || name === 'timeouterror' || msg.includes('timed out') || msg.includes('timeout')) return 'timeout';
  if (typeof status === 'number' && status >= 500 && status < 600) return '5xx';
  return 'unknown';
}

// Whether the router should retry the same provider before falling
// back. Auth and content-filter errors won't get better with a retry.
export function isRetryable(cls: ErrorClass): boolean {
  return cls === '429' || cls === '5xx' || cls === 'timeout';
}

// Whether the error should trigger fallback to the next provider after
// (optional) retries. "unknown" surfaces to the caller untouched.
export function shouldFallback(cls: ErrorClass): boolean {
  return cls !== 'unknown';
}
