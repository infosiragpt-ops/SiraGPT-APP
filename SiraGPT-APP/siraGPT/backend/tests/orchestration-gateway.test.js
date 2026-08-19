'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TASK_TYPES,
  configuredProviders,
  detectTaskType,
} = require('../src/orchestration/llm-routing.config');
const {
  LLMGateway,
  classifyRateLimit,
  jitteredBackoff,
  scoreProvider,
} = require('../src/orchestration/llm-gateway');
const {
  bucketName,
  createSSEReplayBuffer,
  enabled: r2Enabled,
  needsFreshWebContext,
  resolveCacheTtlSeconds,
  semanticCacheKey,
  shouldBypassSemanticCache,
} = require('../src/orchestration');

test('detectTaskType routes common SirAGPT workloads without UI input', () => {
  assert.equal(detectTaskType({ requestedCapability: 'embeddings' }), TASK_TYPES.EMBEDDINGS);
  assert.equal(detectTaskType({ files: [{ mimeType: 'image/png' }] }), TASK_TYPES.MULTIMODAL);
  assert.equal(detectTaskType({ prompt: 'debug this TypeScript repo' }), TASK_TYPES.CODE);
  assert.equal(detectTaskType({ prompt: 'razonamiento profundo para mi tesis' }), TASK_TYPES.DEEP_REASONING);
  assert.equal(detectTaskType({ prompt: 'dame un resumen breve y rapido' }), TASK_TYPES.SPEED);
});

test('configuredProviders only returns providers with configured keys', () => {
  const providers = configuredProviders({
    OPENROUTER_API_KEY: 'or-key',
    GOOGLE_AI_API_KEY: 'google-key',
  }).map(provider => provider.id);

  assert.deepEqual(providers, ['openrouter', 'google']);
});

test('gateway candidates prefer task hints and preserve configured fallback cascade', () => {
  const gateway = new LLMGateway({
    env: {
      OPENROUTER_API_KEY: 'or-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      DEEPSEEK_API_KEY: 'deepseek-key',
    },
  });

  const candidates = gateway.candidatesFor(TASK_TYPES.DEEP_REASONING);
  assert.equal(candidates[0].providerId, 'anthropic');
  assert.equal(candidates[0].model, 'claude-opus-4-7');
  assert.ok(candidates.some(candidate => candidate.providerId === 'openrouter'));
  assert.ok(candidates.some(candidate => candidate.providerId === 'deepseek'));
});

test('rate limit metadata is parsed from status and retry headers', () => {
  const limit = classifyRateLimit({
    status: 429,
    headers: {
      'retry-after': '2',
      'x-ratelimit-remaining': '0',
    },
  });

  assert.equal(limit.limited, true);
  assert.equal(limit.retryAfterMs, 2000);
});

test('provider scoring favors low latency for speed tasks', () => {
  const slowHighQuality = { score: { quality: 0.99, latency: 0.1, cost: 0.4 } };
  const fastLowerQuality = { score: { quality: 0.7, latency: 0.95, cost: 0.7 } };

  assert.ok(
    scoreProvider(fastLowerQuality, TASK_TYPES.SPEED) > scoreProvider(slowHighQuality, TASK_TYPES.SPEED),
  );
});

test('jitteredBackoff respects retry-after caps', () => {
  assert.equal(jitteredBackoff(1, 20_000), 15_000);
  assert.equal(jitteredBackoff(1, 500), 500);
});

test('semantic cache hashes normalized prompts and bypasses volatile questions', () => {
  const keyA = semanticCacheKey({ prompt: '  Hola   Mundo ', context: { b: 2, a: 1 }, model: 'gpt-4o', temperature: 0.2 });
  const keyB = semanticCacheKey({ prompt: 'hola mundo', context: { a: 1, b: 2 }, model: 'gpt-4o', temperature: 0.2 });
  assert.equal(keyA, keyB);
  assert.equal(resolveCacheTtlSeconds('code', { SIRAGPT_CACHE_TTL_CODE: '120' }), 120);
  assert.equal(shouldBypassSemanticCache({ prompt: 'precio actual hoy', ttlSeconds: 3600 }), true);
});

test('SSE replay buffer returns only events after Last-Event-ID', () => {
  const buffer = createSSEReplayBuffer({ maxEvents: 3 });
  const first = buffer.push('message', { a: 1 });
  buffer.push('message', { a: 2 });
  const replay = buffer.since(first.id);
  assert.equal(replay.length, 1);
  assert.deepEqual(replay[0].data, { a: 2 });
});

test('fresh web context detector triggers transparent Tavily/Exa use cases', () => {
  assert.equal(needsFreshWebContext('últimos papers de IA 2026'), true);
  assert.equal(needsFreshWebContext('explica el teorema de Pitágoras'), false);
});

test('R2 accepts requested R2_BUCKET_NAME variable without frontend changes', () => {
  const env = {
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'test-value',
    R2_BUCKET_NAME: 'siragpt-artifacts',
  };
  assert.equal(bucketName(env), 'siragpt-artifacts');
  assert.equal(r2Enabled(env), true);
});
