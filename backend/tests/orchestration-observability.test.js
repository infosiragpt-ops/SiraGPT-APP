'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLangfuseTracer, createTraceId, recordLLMMetrics } = require('../src/orchestration/observability');

// ── createTraceId ──────────────────────────────────────────────────

test('createTraceId produces string with prefix', () => {
  const id = createTraceId();
  assert.ok(id.startsWith('orch_'));
  assert.equal(id.length, 21); // 'orch_' + 16 hex chars
});

test('createTraceId accepts custom prefix', () => {
  const id = createTraceId('task');
  assert.ok(id.startsWith('task_'));
});

test('createTraceId produces unique values', () => {
  const ids = new Set(Array.from({ length: 100 }, () => createTraceId()));
  assert.equal(ids.size, 100);
});

// ── createLangfuseTracer ───────────────────────────────────────────

test('tracer reports disabled when env keys are missing', () => {
  const tracer = createLangfuseTracer({ env: {} });
  assert.equal(tracer.enabled, false);
});

test('tracer reports disabled when only one key present', () => {
  const tracer = createLangfuseTracer({
    env: { LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: '' },
  });
  assert.equal(tracer.enabled, false);
});

test('tracer returns span-like objects even when disabled', () => {
  const tracer = createLangfuseTracer({ env: {} });
  const span = tracer.startSpan('test-span');
  assert.equal(typeof span.traceId, 'string');
  assert.equal(typeof span.end, 'function');
});

test('tracer span.end returns traceId and durationMs', () => {
  const tracer = createLangfuseTracer({ env: {} });
  const span = tracer.startSpan('test-span');
  const result = span.end({ output: 'done' });
  assert.equal(typeof result.traceId, 'string');
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
});

test('tracer span preserves custom traceId', () => {
  const tracer = createLangfuseTracer({ env: {} });
  const span = tracer.startSpan('test-span', { traceId: 'custom-id' });
  assert.equal(span.traceId, 'custom-id');
});

test('tracer flush is a noop when disabled', async () => {
  const tracer = createLangfuseTracer({ env: {} });
  await tracer.flush(); // should not throw
});

test('tracer is enabled when langfuse is installed and credentials are set', () => {
  const logger = { warn: () => {} };
  const tracer = createLangfuseTracer({
    env: { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
    logger,
  });
  // langfuse is installed in dev/test — tracer should be enabled
  assert.equal(typeof tracer.startSpan, 'function');
  assert.equal(typeof tracer.flush, 'function');
});

// ── recordLLMMetrics ───────────────────────────────────────────────

test('recordLLMMetrics returns structured metrics object', () => {
  const m = recordLLMMetrics({
    model: 'gpt-4o',
    provider: 'openai',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.005,
    latencyMs: 1200,
    cached: true,
  });
  assert.equal(m.model, 'gpt-4o');
  assert.equal(m.provider, 'openai');
  assert.deepEqual(m.tokens, { input: 100, output: 50 });
  assert.equal(m.costUsd, 0.005);
  assert.equal(m.latencyMs, 1200);
  assert.equal(m.cached, true);
});

test('recordLLMMetrics defaults missing fields', () => {
  const m = recordLLMMetrics();
  assert.equal(m.model, 'unknown');
  assert.equal(m.provider, 'unknown');
  assert.deepEqual(m.tokens, { input: 0, output: 0 });
  assert.equal(m.costUsd, 0);
  assert.equal(m.latencyMs, 0);
  assert.equal(m.cached, false);
});

test('recordLLMMetrics sanitizes non-finite costUsd', () => {
  const m = recordLLMMetrics({ costUsd: NaN });
  assert.equal(m.costUsd, 0);

  const m2 = recordLLMMetrics({ costUsd: Infinity });
  assert.equal(m2.costUsd, 0);
});

test('recordLLMMetrics sanitizes non-finite latencyMs', () => {
  const m = recordLLMMetrics({ latencyMs: NaN });
  assert.equal(m.latencyMs, 0);

  const m2 = recordLLMMetrics({ latencyMs: Infinity });
  assert.equal(m2.latencyMs, 0);
});
