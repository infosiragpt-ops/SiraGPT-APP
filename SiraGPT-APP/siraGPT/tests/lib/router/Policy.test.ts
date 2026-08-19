import { describe, it, expect } from 'vitest';
import {
  Policy,
  parsePolicyName,
  classifyError,
  isRetryable,
  shouldFallback,
  type ProviderProfile,
} from '../../../backend/src/router/Policy';

const PROVIDERS: ProviderProfile[] = [
  { id: 'openai', costPer1kTokens: 5, qualityScore: 90, latencyP50Ms: 800, capabilities: ['chat', 'vision', 'tools'] },
  { id: 'anthropic', costPer1kTokens: 3, qualityScore: 95, latencyP50Ms: 1200, capabilities: ['chat', 'tools'] },
  { id: 'local', costPer1kTokens: 0.1, qualityScore: 60, latencyP50Ms: 200, capabilities: ['chat'] },
];

describe('parsePolicyName', () => {
  it('accepts the three known policies', () => {
    expect(parsePolicyName('cost')).toBe('cost');
    expect(parsePolicyName('QUALITY')).toBe('quality');
    expect(parsePolicyName(' latency ')).toBe('latency');
  });

  it('falls back to quality for unknown / missing', () => {
    expect(parsePolicyName(undefined)).toBe('quality');
    expect(parsePolicyName('cheap')).toBe('quality');
  });
});

describe('Policy.rank', () => {
  it('cost policy ranks cheapest first', () => {
    const ranked = new Policy('cost').rank(PROVIDERS);
    expect(ranked).toEqual(['local', 'anthropic', 'openai']);
  });

  it('quality policy ranks highest quality first', () => {
    const ranked = new Policy('quality').rank(PROVIDERS);
    expect(ranked).toEqual(['anthropic', 'openai', 'local']);
  });

  it('latency policy ranks fastest p50 first', () => {
    const ranked = new Policy('latency').rank(PROVIDERS);
    expect(ranked).toEqual(['local', 'openai', 'anthropic']);
  });

  it('filters by required capabilities', () => {
    const ranked = new Policy('quality').rank(PROVIDERS, { capabilities: ['vision'] });
    expect(ranked).toEqual(['openai']);
  });

  it('honors deny / allow lists', () => {
    expect(new Policy('cost').rank(PROVIDERS, { denyProviders: ['local'] })).toEqual(['anthropic', 'openai']);
    expect(new Policy('cost').rank(PROVIDERS, { allowProviders: ['openai', 'anthropic'] })).toEqual(['anthropic', 'openai']);
  });

  it('priority bump beats raw policy ordering', () => {
    const withPriority = PROVIDERS.map(p => p.id === 'openai' ? { ...p, priority: 10 } : p);
    expect(new Policy('cost').rank(withPriority)).toEqual(['openai', 'local', 'anthropic']);
  });

  it('breaks ties deterministically by id', () => {
    const tie: ProviderProfile[] = [
      { id: 'beta',  costPer1kTokens: 1, qualityScore: 50, latencyP50Ms: 100, capabilities: ['chat'] },
      { id: 'alpha', costPer1kTokens: 1, qualityScore: 50, latencyP50Ms: 100, capabilities: ['chat'] },
    ];
    expect(new Policy('quality').rank(tie)).toEqual(['alpha', 'beta']);
  });

  it('reads policy from env via fromEnv', () => {
    expect(Policy.fromEnv({ SIRA_ROUTING_POLICY: 'cost' } as unknown as NodeJS.ProcessEnv).name).toBe('cost');
    expect(Policy.fromEnv({} as unknown as NodeJS.ProcessEnv).name).toBe('quality');
  });
});

describe('classifyError', () => {
  it('detects 429 / rate limit', () => {
    expect(classifyError({ status: 429 })).toBe('429');
    expect(classifyError({ code: 'rate_limit_exceeded' })).toBe('429');
    expect(classifyError({ message: 'Rate limit reached' })).toBe('429');
  });

  it('detects 5xx', () => {
    expect(classifyError({ status: 500 })).toBe('5xx');
    expect(classifyError({ statusCode: 503 })).toBe('5xx');
  });

  it('detects timeouts', () => {
    expect(classifyError({ name: 'AbortError' })).toBe('timeout');
    expect(classifyError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyError({ message: 'request timed out' })).toBe('timeout');
  });

  it('detects content-filter', () => {
    expect(classifyError({ code: 'content_filter' })).toBe('content-filter');
    expect(classifyError({ type: 'content_filter_violation' })).toBe('content-filter');
  });

  it('detects auth', () => {
    expect(classifyError({ status: 401 })).toBe('auth');
    expect(classifyError({ status: 403 })).toBe('auth');
  });

  it('returns unknown for everything else', () => {
    expect(classifyError({ status: 418 })).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
  });
});

describe('isRetryable / shouldFallback', () => {
  it('only transient classes retry', () => {
    expect(isRetryable('429')).toBe(true);
    expect(isRetryable('5xx')).toBe(true);
    expect(isRetryable('timeout')).toBe(true);
    expect(isRetryable('content-filter')).toBe(false);
    expect(isRetryable('auth')).toBe(false);
    expect(isRetryable('unknown')).toBe(false);
  });

  it('all classified errors fall back except unknown', () => {
    expect(shouldFallback('429')).toBe(true);
    expect(shouldFallback('content-filter')).toBe(true);
    expect(shouldFallback('auth')).toBe(true);
    expect(shouldFallback('unknown')).toBe(false);
  });
});
