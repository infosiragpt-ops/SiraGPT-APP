'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LLMGateway } = require('../src/orchestration/llm-gateway');

test('LLMGateway aborts while waiting for retry backoff', async () => {
  const gateway = new LLMGateway({ env: {}, cache: null, tracer: null });
  let calls = 0;

  gateway.candidatesFor = () => [{
    providerId: 'test-provider',
    model: 'test-model',
    provider: { id: 'test-provider' },
  }];
  gateway.getBreaker = () => ({
    async fire() {
      calls += 1;
      if (calls === 1) {
        const err = new Error('rate limited');
        err.status = 429;
        err.headers = { 'retry-after': '0.2' };
        throw err;
      }
      return { ok: true };
    },
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('caller cancelled')), 20);

  await assert.rejects(
    gateway.complete({ messages: [{ role: 'user', content: 'hello' }], signal: controller.signal }),
    /caller cancelled/,
  );
  assert.equal(calls, 1, 'must not retry after caller cancellation during backoff');
});
