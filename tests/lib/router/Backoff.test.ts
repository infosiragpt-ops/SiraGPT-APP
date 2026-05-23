import { describe, it, expect } from 'vitest';
import { Backoff } from '../../../backend/src/router/Backoff';

describe('Backoff', () => {
  it('grows exponentially up to the cap', () => {
    const b = new Backoff({ baseDelayMs: 100, maxDelayMs: 1_000, factor: 2, rng: () => 0.5 });
    expect(b.delayFor(0)).toBe(50);
    expect(b.delayFor(1)).toBe(100);
    expect(b.delayFor(2)).toBe(200);
    expect(b.delayFor(3)).toBe(400);
    expect(b.delayFor(4)).toBe(500); // cap=1000, half=500
    expect(b.delayFor(10)).toBe(500);
  });

  it('applies full jitter via rng', () => {
    const b = new Backoff({ baseDelayMs: 100, maxDelayMs: 1_000, factor: 2, rng: () => 0 });
    expect(b.delayFor(0)).toBe(0);
    expect(b.delayFor(5)).toBe(0);
  });

  it('clamps negative attempts to 0', () => {
    const b = new Backoff({ baseDelayMs: 100, maxDelayMs: 1_000, factor: 2, rng: () => 0.5 });
    expect(b.delayFor(-3)).toBe(b.delayFor(0));
  });

  it('sleep returns immediately for zero delay', async () => {
    const b = new Backoff({ baseDelayMs: 0, maxDelayMs: 0, rng: () => 0.5 });
    const t0 = Date.now();
    await b.sleep(3);
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it('sleep rejects when signal aborts mid-flight', async () => {
    const b = new Backoff({ baseDelayMs: 1_000, maxDelayMs: 1_000, rng: () => 1 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    await expect(b.sleep(0, ac.signal)).rejects.toThrow(/aborted/);
  });
});
