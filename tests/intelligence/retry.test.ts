import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  backoffDelay,
  cascade,
  TimeoutError,
  withRetry,
  withTimeout,
} from '../../server/intelligence/core/retry';

describe('intelligence/retry', () => {
  it('computes deterministic full-jitter backoff', () => {
    assert.equal(backoffDelay(0, 100, 1000, () => 0.5), 50);
    assert.equal(backoffDelay(2, 100, 1000, () => 0.5), 200); // min(1000, 400)*0.5
    assert.equal(backoffDelay(10, 100, 1000, () => 0.5), 500); // capped at maxMs
  });

  it('retries transient failures then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('network blip');
        return 'ok';
      },
      { maxRetries: 5, baseMs: 0, maxMs: 0, sleep: async () => undefined }
    );
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  });

  it('does not retry when isRetryable returns false', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            attempts += 1;
            throw new Error('fatal');
          },
          { maxRetries: 5, baseMs: 0, maxMs: 0, isRetryable: () => false, sleep: async () => undefined }
        )
    );
    assert.equal(attempts, 1);
  });

  it('times out a hung operation', async () => {
    await assert.rejects(
      () => withTimeout(() => new Promise(() => undefined), 20),
      TimeoutError
    );
  });

  it('passes an abort signal to the operation', async () => {
    let sawSignal: AbortSignal | undefined;
    await withTimeout(async (signal) => {
      sawSignal = signal;
      return 'done';
    }, 1000);
    assert.ok(sawSignal instanceof AbortSignal);
  });

  it('cascades to the next candidate on failure', async () => {
    const result = await cascade(
      ['a', 'b', 'c'],
      async (candidate) => {
        if (candidate === 'a') throw new Error('a failed');
        return candidate.toUpperCase();
      }
    );
    assert.equal(result.value, 'B');
    assert.equal(result.candidate, 'b');
    assert.equal(result.fellBack, true);
  });

  it('throws the last error when every candidate fails', async () => {
    await assert.rejects(() =>
      cascade(['a', 'b'], async (c) => {
        throw new Error(`${c} failed`);
      })
    );
  });
});
