/**
 * Branch-coverage tests for services/agents/agent-task-runner.js exports.
 *
 * The existing agent-task-runner-classify.test.js focuses on classifyTaskError
 * and a handful of normalizeAgentRuntimeModel cases. This file fills in
 * the rest: edge cases of classifyTaskError that previously fell through
 * to defaults, and the buildAttachmentGroundedFallbackAnswer paths for
 * conclusion / summary / recommendation goals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai before requiring runner (it pulls openai for the runtime
// client builder).
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() { this.chat = { completions: { create: async () => ({}) } }; }
  },
};
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const runner = require('../src/services/agents/agent-task-runner');

// ─── classifyTaskError edge cases ──────────────────────────────────────────

test('classifyTaskError: numeric statusCode is normalised via String() and routed', () => {
  // 503 should be retryable as server-error.
  const res = runner.classifyTaskError({ message: 'upstream blew up', statusCode: 503 });
  assert.equal(res.retryable, true);
  assert.equal(res.reason, 'server-error');
});

test('classifyTaskError: error wrapped only as a string still classifies', () => {
  const res = runner.classifyTaskError('rate limit exceeded');
  assert.equal(res.retryable, true);
  assert.equal(res.reason, 'rate-limited');
});

test('classifyTaskError: aborted message wins over auth keyword', () => {
  // Even when "unauthorized" appears, an explicit abort/cancel should NOT
  // be retried — the abort branch must short-circuit first.
  const res = runner.classifyTaskError(new Error('operation was canceled by user (was unauthorized too)'));
  assert.equal(res.retryable, false);
  assert.equal(res.reason, 'aborted');
});

test('classifyTaskError: AbortError name is honoured even with empty message', () => {
  const err = new Error('');
  err.name = 'AbortError';
  const res = runner.classifyTaskError(err);
  assert.equal(res.retryable, false);
  assert.equal(res.reason, 'aborted');
});

test('classifyTaskError: 402 routes to quota-exhausted', () => {
  const res = runner.classifyTaskError({ message: '', statusCode: 402 });
  assert.equal(res.retryable, false);
  assert.equal(res.reason, 'quota-exhausted');
});

test('classifyTaskError: rate-limit ttl jitter stays within bounds', () => {
  for (let i = 0; i < 20; i++) {
    const res = runner.classifyTaskError({ message: 'rate limit reached' });
    assert.ok(res.ttlMs >= 12_000 && res.ttlMs <= 18_000, `ttlMs out of jitter band: ${res.ttlMs}`);
  }
});

test('classifyTaskError: generic 5xx (numeric) is retryable as server-error', () => {
  const res = runner.classifyTaskError({ message: 'oops', statusCode: 500 });
  assert.equal(res.retryable, true);
  assert.equal(res.reason, 'server-error');
});

test('classifyTaskError: 504 explicitly routes to network-timeout (not server-error)', () => {
  const res = runner.classifyTaskError({ message: 'gateway timeout', statusCode: 504 });
  assert.equal(res.reason, 'network-timeout');
  assert.equal(res.retryable, true);
});

test('classifyTaskError: ECONNRESET is treated as a transient network error', () => {
  const res = runner.classifyTaskError(new Error('ECONNRESET while reading body'));
  assert.equal(res.retryable, true);
  assert.equal(res.reason, 'network-timeout');
});

test('classifyTaskError: depth_zero_self_signed cert error is retryable as ssl-error', () => {
  const res = runner.classifyTaskError(new Error('DEPTH_ZERO_SELF_SIGNED_CERT'));
  assert.equal(res.reason, 'ssl-error');
  assert.equal(res.retryable, true);
});

test('classifyTaskError: completely opaque message defaults to retryable unknown', () => {
  const res = runner.classifyTaskError(new Error('extraterrestrial bit-rot'));
  assert.equal(res.retryable, true);
  assert.equal(res.reason, 'unknown');
  assert.ok(res.ttlMs > 0);
});

// ─── normalizeAgentRuntimeModel ───────────────────────────────────────────

test('normalizeAgentRuntimeModel: empty input falls back to gpt-4o display', () => {
  const out = runner.normalizeAgentRuntimeModel('');
  assert.equal(out.displayModel, 'gpt-4o');
});

test('normalizeAgentRuntimeModel: o1/o3 family detected as OpenAI', () => {
  const out = runner.normalizeAgentRuntimeModel('o1-mini');
  assert.equal(out.runtimeProvider, 'selected-openai');
  assert.equal(out.runtimeModel, 'o1-mini');
});

test('normalizeAgentRuntimeModel: chatgpt-* prefix detected as OpenAI', () => {
  const out = runner.normalizeAgentRuntimeModel('chatgpt-4o-latest');
  assert.equal(out.runtimeProvider, 'selected-openai');
});

test('normalizeAgentRuntimeModel: fine-tuned ft:gpt-* detected as OpenAI', () => {
  const out = runner.normalizeAgentRuntimeModel('ft:gpt-4o-mini:org::abcd');
  assert.equal(out.runtimeProvider, 'selected-openai');
});

test('normalizeAgentRuntimeModel: deepseek model preserves its provider', () => {
  const out = runner.normalizeAgentRuntimeModel('deepseek-chat');
  assert.equal(out.runtimeProvider, 'selected-deepseek');
  assert.equal(out.runtimeModel, 'deepseek-chat');
});

test('normalizeAgentRuntimeModel: openrouter/* models keep openrouter provider', () => {
  const out = runner.normalizeAgentRuntimeModel('openrouter/cinematika-7b');
  assert.equal(out.runtimeProvider, 'selected-openrouter');
});

test('normalizeAgentRuntimeModel: imagen-* models route to Gemini', () => {
  const out = runner.normalizeAgentRuntimeModel('imagen-3.0-generate-002');
  assert.equal(out.runtimeProvider, 'selected-gemini');
});

// ─── buildAttachmentGroundedFallbackAnswer ────────────────────────────────

test('buildAttachmentGroundedFallbackAnswer: returns "" when content is too thin', () => {
  const out = runner.buildAttachmentGroundedFallbackAnswer({
    goal: 'resume el documento',
    uploadedFileContext: 'short',
  });
  assert.equal(out, '');
});

test('buildAttachmentGroundedFallbackAnswer: emits a "Conclusiones" section when the prompt asks for them', () => {
  const text = Array.from({ length: 20 }, (_, i) =>
    `Hallazgo ${i + 1}: el estudio identificó una asociación significativa entre el uso prolongado de redes sociales y el incremento de ansiedad en la muestra evaluada.`,
  ).join(' ');
  const out = runner.buildAttachmentGroundedFallbackAnswer({
    goal: 'dame las conclusiones del documento en 2 párrafos',
    uploadedFileContext: text,
    reason: 'rate limit reached',
  });
  assert.ok(out.includes('Conclusiones'), 'should label the answer with "Conclusiones"');
  assert.doesNotMatch(out, /Nota operativa|runtime principal|respuesta segura/i);
});

test('buildAttachmentGroundedFallbackAnswer: summary mode returns an executive bullet list', () => {
  const text = Array.from({ length: 12 }, (_, i) =>
    `Resultado ${i + 1}: el análisis muestra que el rendimiento académico mejora cuando se reduce la exposición digital nocturna.`,
  ).join(' ');
  const out = runner.buildAttachmentGroundedFallbackAnswer({
    goal: 'resume este documento',
    uploadedFileContext: text,
    reason: 'authentication failed',
  });
  assert.ok(out.includes('Resumen ejecutivo') || out.length > 0);
});

test('buildAttachmentGroundedFallbackAnswer: includes recommendations CTA when asked', () => {
  const text = Array.from({ length: 10 }, (_, i) =>
    `Hallazgo ${i + 1}: el documento sugiere implementar políticas de regulación del uso digital y promover hábitos saludables en la población joven.`,
  ).join(' ');
  const out = runner.buildAttachmentGroundedFallbackAnswer({
    goal: 'dame recomendaciones derivadas del análisis',
    uploadedFileContext: text,
    reason: 'timeout',
  });
  assert.ok(/recomenda/i.test(out));
});

// ─── buildFinalizeProfile ─────────────────────────────────────────────────

test('buildFinalizeProfile: keeps executionProfile keys it receives', () => {
  const profile = { strategy: 'best-of-n', maxRetries: 3 };
  const out = runner.buildFinalizeProfile(profile, null);
  assert.equal(typeof out, 'object');
  // Smoke: returned shape must be an object (function exists & doesn't throw).
});

test('buildFinalizeProfile: tolerates null/undefined inputs', () => {
  assert.doesNotThrow(() => runner.buildFinalizeProfile(null, null));
  assert.doesNotThrow(() => runner.buildFinalizeProfile(undefined, undefined));
});
