import { describe, it, expect, vi } from 'vitest';
import {
  ProviderRouter,
  Policy,
  Backoff,
  NoProviderAvailableError,
  type ProviderHandler,
  type ProviderProfile,
} from '../../../backend/src/router';

type Req = { prompt: string };
type Res = { text: string };

function profile(id: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id,
    costPer1kTokens: 5,
    qualityScore: 80,
    latencyP50Ms: 500,
    capabilities: ['chat'],
    ...overrides,
  };
}

function mockHandler(id: string, impl: ProviderHandler<Req, Res>['invoke']): ProviderHandler<Req, Res> {
  return { id, invoke: vi.fn(impl) as ProviderHandler<Req, Res>['invoke'] };
}

// Zero-delay backoff so tests don't wait on jitter.
const noWait = new Backoff({ baseDelayMs: 0, maxDelayMs: 0, rng: () => 0 });

describe('ProviderRouter', () => {
  it('routes to the highest-policy provider on success', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const a = mockHandler('a', async () => ({ text: 'A' }));
    const b = mockHandler('b', async () => ({ text: 'B' }));
    router.register({ profile: profile('a', { qualityScore: 90 }), handler: a });
    router.register({ profile: profile('b', { qualityScore: 70 }), handler: b });

    const r = await router.route({ prompt: 'hi' });
    expect(r.providerId).toBe('a');
    expect(r.value.text).toBe('A');
    expect(b.invoke).not.toHaveBeenCalled();
  });

  it('retries 5xx then succeeds without fallback', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    let calls = 0;
    const flaky = mockHandler('flaky', async () => {
      calls++;
      if (calls < 3) {
        const e: Error & { status?: number } = new Error('boom');
        e.status = 503;
        throw e;
      }
      return { text: 'ok' };
    });
    router.register({ profile: profile('flaky'), handler: flaky });

    const r = await router.route({ prompt: 'x' }, { maxRetriesPerProvider: 3 });
    expect(r.providerId).toBe('flaky');
    expect(r.attempts).toBe(3);
    expect(r.fallbacks).toBe(0);
  });

  it('falls back on 429 after retry budget exhausts', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const primary = mockHandler('primary', async () => {
      const e: Error & { status?: number } = new Error('rl');
      e.status = 429;
      throw e;
    });
    const fallback = mockHandler('fallback', async () => ({ text: 'recovered' }));
    router.register({ profile: profile('primary', { qualityScore: 99 }), handler: primary });
    router.register({ profile: profile('fallback', { qualityScore: 1 }), handler: fallback });

    const r = await router.route({ prompt: 'x' }, { maxRetriesPerProvider: 1 });
    expect(r.providerId).toBe('fallback');
    expect(r.fallbacks).toBe(1);
    // primary tried twice (initial + 1 retry), then fallback once.
    expect((primary.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect((fallback.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('does not retry auth failures — falls back immediately', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const primary = mockHandler('primary', async () => {
      const e: Error & { status?: number } = new Error('no key');
      e.status = 401;
      throw e;
    });
    const fallback = mockHandler('fallback', async () => ({ text: 'ok' }));
    router.register({ profile: profile('primary', { qualityScore: 99 }), handler: primary });
    router.register({ profile: profile('fallback'), handler: fallback });

    const r = await router.route({ prompt: 'x' }, { maxRetriesPerProvider: 5 });
    expect(r.providerId).toBe('fallback');
    expect((primary.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('content-filter falls back without retry', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const primary = mockHandler('primary', async () => {
      const e: Error & { code?: string } = new Error('blocked');
      e.code = 'content_filter';
      throw e;
    });
    const fallback = mockHandler('fallback', async () => ({ text: 'ok' }));
    router.register({ profile: profile('primary', { qualityScore: 99 }), handler: primary });
    router.register({ profile: profile('fallback'), handler: fallback });

    const r = await router.route({ prompt: 'x' });
    expect(r.providerId).toBe('fallback');
    expect((primary.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('rethrows unknown errors instead of falling back', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const primary = mockHandler('primary', async () => {
      throw new Error('weird custom thing');
    });
    const fallback = mockHandler('fallback', async () => ({ text: 'ok' }));
    router.register({ profile: profile('primary', { qualityScore: 99 }), handler: primary });
    router.register({ profile: profile('fallback'), handler: fallback });

    await expect(router.route({ prompt: 'x' })).rejects.toThrow(/weird custom/);
    expect((fallback.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('throws NoProviderAvailableError when every provider exhausts', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const a = mockHandler('a', async () => {
      const e: Error & { status?: number } = new Error('rl');
      e.status = 429;
      throw e;
    });
    const b = mockHandler('b', async () => {
      const e: Error & { status?: number } = new Error('rl');
      e.status = 429;
      throw e;
    });
    router.register({ profile: profile('a'), handler: a });
    router.register({ profile: profile('b'), handler: b });

    await expect(router.route({ prompt: 'x' }, { maxRetriesPerProvider: 0 })).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('opens the breaker after threshold and routes around it', async () => {
    let now = 1_000_000;
    const router = new ProviderRouter<Req, Res>({
      policy: new Policy('quality'),
      backoff: noWait,
      breaker: { failureThreshold: 2, resetTimeoutMs: 10_000, halfOpenMaxCalls: 1 },
      clock: () => now,
    });
    const bad = mockHandler('bad', async () => {
      const e: Error & { status?: number } = new Error('5xx');
      e.status = 500;
      throw e;
    });
    const good = mockHandler('good', async () => ({ text: 'ok' }));
    router.register({ profile: profile('bad', { qualityScore: 99 }), handler: bad });
    router.register({ profile: profile('good', { qualityScore: 1 }), handler: good });

    // First call: bad fails (initial + retries), then fallback succeeds.
    await router.route({ prompt: '1' }, { maxRetriesPerProvider: 1 });
    expect(router.getCircuitState('bad')).toBe('OPEN');

    const badCallsAfterOpen = (bad.invoke as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await router.route({ prompt: '2' });
    expect(r.providerId).toBe('good');
    // Bad was skipped — no new invocations.
    expect((bad.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBe(badCallsAfterOpen);

    // Advance past resetTimeout — breaker enters HALF_OPEN; success closes it.
    now += 11_000;
    (bad.invoke as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ text: 'recovered' }));
    const r2 = await router.route({ prompt: '3' });
    expect(r2.providerId).toBe('bad');
    expect(router.getCircuitState('bad')).toBe('CLOSED');
  });

  it('a failed half-open probe re-opens the breaker', async () => {
    let now = 0;
    const router = new ProviderRouter<Req, Res>({
      policy: new Policy('quality'),
      backoff: noWait,
      breaker: { failureThreshold: 1, resetTimeoutMs: 1_000, halfOpenMaxCalls: 1 },
      clock: () => now,
    });
    const bad = mockHandler('bad', async () => {
      const e: Error & { status?: number } = new Error('5xx');
      e.status = 500;
      throw e;
    });
    router.register({ profile: profile('bad'), handler: bad });

    await expect(router.route({ prompt: '1' }, { maxRetriesPerProvider: 0 })).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(router.getCircuitState('bad')).toBe('OPEN');

    now += 2_000; // past cooldown; next attempt becomes HALF_OPEN probe
    await expect(router.route({ prompt: '2' }, { maxRetriesPerProvider: 0 })).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(router.getCircuitState('bad')).toBe('OPEN');
  });

  it('respects per-attempt timeout and surfaces it as a timeout class', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const slow = mockHandler('slow', async (_req, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 1_000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('timed out');
          (e as Error & { name: string }).name = 'TimeoutError';
          reject(e);
        });
      });
      return { text: 'never' };
    });
    const fast = mockHandler('fast', async () => ({ text: 'ok' }));
    router.register({ profile: profile('slow', { qualityScore: 99 }), handler: slow });
    router.register({ profile: profile('fast'), handler: fast });

    const r = await router.route({ prompt: 'x' }, { perAttemptTimeoutMs: 20, maxRetriesPerProvider: 0 });
    expect(r.providerId).toBe('fast');
  });

  it('records metrics for requests, errors, fallbacks', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    let n = 0;
    const a = mockHandler('a', async () => {
      n++;
      if (n === 1) {
        const e: Error & { status?: number } = new Error('5xx');
        e.status = 500;
        throw e;
      }
      return { text: 'ok' };
    });
    router.register({ profile: profile('a'), handler: a });

    await router.route({ prompt: '1' }, { maxRetriesPerProvider: 1 });
    const m = router.getMetrics().find(x => x.providerId === 'a')!;
    expect(m.requests).toBe(2);
    expect(m.successes).toBe(1);
    expect(m.failures).toBe(1);
    expect(m.errorsByClass['5xx']).toBe(1);
  });

  it('respects task capability filtering at the policy layer', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const visionOnly = mockHandler('vision', async () => ({ text: 'pic' }));
    const textOnly = mockHandler('text', async () => ({ text: 'word' }));
    router.register({ profile: profile('vision', { qualityScore: 1, capabilities: ['chat', 'vision'] }), handler: visionOnly });
    router.register({ profile: profile('text', { qualityScore: 99, capabilities: ['chat'] }), handler: textOnly });

    const r = await router.route({ prompt: 'see this' }, { task: { capabilities: ['vision'] } });
    expect(r.providerId).toBe('vision');
  });

  it('aborts in-flight when external signal aborts', async () => {
    const router = new ProviderRouter<Req, Res>({ policy: new Policy('quality'), backoff: noWait });
    const slow = mockHandler('slow', async (_r, ctx) => {
      await new Promise<void>((_, reject) => {
        ctx.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          (e as Error & { name: string }).name = 'AbortError';
          reject(e);
        });
      });
      return { text: 'never' };
    });
    router.register({ profile: profile('slow'), handler: slow });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    await expect(router.route({ prompt: 'x' }, { signal: ac.signal, maxRetriesPerProvider: 0 })).rejects.toThrow();
  });
});
