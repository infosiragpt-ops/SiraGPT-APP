'use strict';

// Verifies that the direct OpenAI REST calls in ai-service.js (made through
// axios, not the OpenAI SDK client) carry a bounded timeout so a stalled
// connection cannot hang the request indefinitely.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const axios = require('axios');
const service = require('../src/services/ai-service');
const chatLatencyPolicy = require('../src/services/chat-latency-policy');
const { classifyProviderError } = require('../src/services/ai-product-os/litellm-gateway');

describe('ai-service direct OpenAI HTTP calls — bounded timeout', () => {
  test('exposes a sane, clamped default timeout constant', () => {
    const t = service.OPENAI_HTTP_TIMEOUT_MS;
    assert.equal(typeof t, 'number');
    assert.ok(Number.isFinite(t));
    assert.ok(t >= 1_000 && t <= 600_000, `timeout ${t} out of [1s, 10min]`);
  });

  test('uploadFileToContainer passes timeout to axios.post', async (t) => {
    let captured = null;
    t.mock.method(axios, 'post', async (_url, _form, config) => {
      captured = config;
      return { data: { id: 'file_test' } };
    });

    // Real temp file so fs.createReadStream() inside the method succeeds.
    const tmp = path.join(os.tmpdir(), `sira-ai-svc-timeout-${process.pid}.txt`);
    fs.writeFileSync(tmp, 'hello');
    try {
      const result = await service.uploadFileToContainer(tmp, 'container_abc');
      assert.deepEqual(result, { id: 'file_test' });
      assert.ok(captured, 'axios.post should have been called');
      assert.equal(captured.timeout, service.OPENAI_HTTP_TIMEOUT_MS);
      assert.ok(captured.timeout > 0);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

describe('chat critical-path latency policy', () => {
  test('short generic turns skip remote semantic enrichment', () => {
    assert.equal(chatLatencyPolicy.shouldUseSemanticEnrichment({ prompt: 'hola' }), false);
    assert.equal(chatLatencyPolicy.shouldUseSemanticEnrichment({ prompt: 'Responde únicamente: OK' }), false);
    assert.equal(chatLatencyPolicy.shouldUseSemanticEnrichment({ prompt: '¿Cómo estás?' }), false);
  });

  test('personal, attached, and substantial turns retain semantic enrichment', () => {
    assert.equal(chatLatencyPolicy.shouldUseSemanticEnrichment({ prompt: '¿Cuál es mi empresa?' }), true);
    assert.equal(chatLatencyPolicy.shouldUseSemanticEnrichment({ prompt: 'resume esto', files: [{ id: 'f1' }] }), true);
    assert.equal(chatLatencyPolicy.shouldUseSemanticEnrichment({
      prompt: 'x'.repeat(chatLatencyPolicy.SHORT_TURN_MAX_CHARS + 1),
    }), true);
  });

  test('semantic enrichment has a bounded fail-open deadline', async () => {
    const warnings = [];
    const started = Date.now();
    const result = await chatLatencyPolicy.resolveWithinBudget(new Promise(() => {}), {
      fallback: ['fallback'],
      budgetMs: 25,
      label: 'test-enrichment',
      logger: { warn: (line) => warnings.push(line) },
    });

    assert.deepEqual(result, ['fallback']);
    assert.ok(Date.now() - started < 500, 'deadline should not stall the request');
    assert.equal(warnings.length, 1);
  });

  test('quota-exhausted 429 is terminal while burst rate-limit remains retryable', () => {
    const exhausted = new Error('You exceeded your current quota, please check your plan and billing details.');
    exhausted.status = 429;
    exhausted.code = 'insufficient_quota';
    const exhaustedResult = classifyProviderError(exhausted);
    assert.equal(exhaustedResult.error_class, 'quota_exhausted');
    assert.equal(exhaustedResult.retryable, false);

    const burst = new Error('Rate limit reached, retry later');
    burst.status = 429;
    const burstResult = classifyProviderError(burst);
    assert.equal(burstResult.error_class, 'rate_limit');
    assert.equal(burstResult.retryable, true);
  });

  test('default fallback chain crosses provider before retrying the failed provider', () => {
    const keys = ['FALLBACK_MODELS', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    delete process.env.FALLBACK_MODELS;
    process.env.GEMINI_API_KEY = 'test-gemini';
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek';
    process.env.OPENROUTER_API_KEY = 'test-openrouter';
    try {
      const chain = service.__test.getFallbackChain('OpenRouter');
      assert.equal(chain[0], 'gemini-2.5-flash');
      assert.ok(chain.indexOf('gpt-4o-mini') < chain.indexOf('moonshotai/kimi-k2.6'));
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test('generate route applies the enrichment budget and skips default medium on trivial turns', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
    assert.match(source, /chatLatencyPolicy\.resolveWithinBudget/);
    assert.match(source, /__defaultMediumOnTrivial/);
  });
});
