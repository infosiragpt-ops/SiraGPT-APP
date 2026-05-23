'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  stableStringify,
  normalizePrompt,
  shouldBypassSemanticCache,
  semanticCacheKey,
  resolveCacheTtlSeconds,
  createUpstashSemanticCache,
} = require('../src/orchestration/semantic-cache');

// ── stableStringify ────────────────────────────────────────────────

test('stableStringify produces deterministic output', () => {
  const a = stableStringify({ b: 1, a: 2 });
  const b = stableStringify({ a: 2, b: 1 });
  assert.equal(a, b);
});

test('stableStringify handles primitives', () => {
  assert.equal(stableStringify(42), '42');
  assert.equal(stableStringify('hello'), '"hello"');
  assert.equal(stableStringify(true), 'true');
  assert.equal(stableStringify(null), 'null');
});

test('stableStringify handles arrays', () => {
  assert.equal(stableStringify([3, 1, 2]), '[3,1,2]');
});

test('stableStringify handles nested objects', () => {
  const result = stableStringify({ outer: { b: 2, a: 1 } });
  assert.equal(result, '{"outer":{"a":1,"b":2}}');
});

test('stableStringify handles undefined values', () => {
  const result = stableStringify(undefined);
  assert.equal(result, undefined);
});

// ── normalizePrompt ────────────────────────────────────────────────

test('normalizePrompt lowercases and collapses whitespace', () => {
  assert.equal(normalizePrompt('  Hello   WORLD  '), 'hello world');
});

test('normalizePrompt applies NFC/NFKC normalization', () => {
  const composed = normalizePrompt('fi\uFB01');
  assert.ok(composed.includes('fi'), `expected 'fi' in '${composed}'`);
  assert.ok(!composed.includes('\uFB01'), `ligature should be decomposed`);
});

test('normalizePrompt handles empty input', () => {
  assert.equal(normalizePrompt(''), '');
  assert.equal(normalizePrompt(), '');
});

// ── shouldBypassSemanticCache ──────────────────────────────────────

test('shouldBypassSemanticCache returns true for volatile queries', () => {
  assert.equal(shouldBypassSemanticCache({ prompt: 'what is the price today' }), true);
  assert.equal(shouldBypassSemanticCache({ prompt: 'latest news' }), true);
  assert.equal(shouldBypassSemanticCache({ prompt: 'current weather' }), true);
  assert.equal(shouldBypassSemanticCache({ prompt: 'noticias de hoy' }), true);
  assert.equal(shouldBypassSemanticCache({ prompt: 'precio actual' }), true);
});

test('shouldBypassSemanticCache returns false for stable queries', () => {
  assert.equal(shouldBypassSemanticCache({ prompt: 'explain quantum mechanics' }), false);
  assert.equal(shouldBypassSemanticCache({ prompt: 'write a python function' }), false);
});

test('shouldBypassSemanticCache respects volatile flag', () => {
  assert.equal(shouldBypassSemanticCache({ volatile: true }), true);
});

test('shouldBypassSemanticCache respects ttlSeconds = 0', () => {
  assert.equal(shouldBypassSemanticCache({ ttlSeconds: 0 }), true);
});

test('shouldBypassSemanticCache handles missing params', () => {
  assert.equal(shouldBypassSemanticCache(), false);
  assert.equal(shouldBypassSemanticCache({}), false);
});

// ── semanticCacheKey ───────────────────────────────────────────────

test('semanticCacheKey produces SHA-256 key', () => {
  const key = semanticCacheKey({ prompt: 'hello', model: 'gpt-4o', temperature: 0.7 });
  assert.ok(key.startsWith('llm:semantic:'));
  // prefix (13 chars) + 64 hex chars = 77 total
  assert.equal(key.length, 13 + 64);
});

test('semanticCacheKey is deterministic', () => {
  const a = semanticCacheKey({ prompt: 'hello world', context: { user: 'alice' }, model: 'gpt-4o', temperature: 0 });
  const b = semanticCacheKey({ prompt: 'hello world', context: { user: 'alice' }, model: 'gpt-4o', temperature: 0 });
  assert.equal(a, b);
});

test('semanticCacheKey varies with prompt', () => {
  const a = semanticCacheKey({ prompt: 'hello' });
  const b = semanticCacheKey({ prompt: 'world' });
  assert.notEqual(a, b);
});

test('semanticCacheKey varies with temperature', () => {
  const a = semanticCacheKey({ prompt: 'hello', temperature: 0 });
  const b = semanticCacheKey({ prompt: 'hello', temperature: 1 });
  assert.notEqual(a, b);
});

test('semanticCacheKey handles defaults', () => {
  const key = semanticCacheKey();
  assert.ok(key.startsWith('llm:semantic:'));
});

// ── resolveCacheTtlSeconds ─────────────────────────────────────────

test('resolveCacheTtlSeconds returns default when no env set', () => {
  assert.equal(resolveCacheTtlSeconds('default', {}), 3600);
});

test('resolveCacheTtlSeconds returns per-task-type env var', () => {
  const env = { SIRAGPT_CACHE_TTL_CODE: '1800' };
  assert.equal(resolveCacheTtlSeconds('code', env), 1800);
});

test('resolveCacheTtlSeconds uses default env var as fallback', () => {
  const env = { SIRAGPT_CACHE_TTL_DEFAULT_SECONDS: '7200' };
  assert.equal(resolveCacheTtlSeconds('unknown', env), 7200);
});

test('resolveCacheTtlSeconds task-specific overrides default', () => {
  const env = {
    SIRAGPT_CACHE_TTL_DEFAULT_SECONDS: '3600',
    SIRAGPT_CACHE_TTL_SPEED: '600',
  };
  assert.equal(resolveCacheTtlSeconds('speed', env), 600);
});

test('resolveCacheTtlSeconds returns 0 for 0 ttl', () => {
  const env = { SIRAGPT_CACHE_TTL_DEFAULT_SECONDS: '0' };
  assert.equal(resolveCacheTtlSeconds('default', env), 0);
});

test('resolveCacheTtlSeconds ignores invalid values', () => {
  const env = { SIRAGPT_CACHE_TTL_DEFAULT_SECONDS: 'not-a-number' };
  assert.equal(resolveCacheTtlSeconds('default', env), 3600);
});

// ── createUpstashSemanticCache ─────────────────────────────────────

test('createUpstashSemanticCache reports disabled when no credentials', () => {
  const cache = createUpstashSemanticCache({ env: {} });
  assert.equal(cache.enabled, false);
});

test('createUpstashSemanticCache reports disabled when no fetch', () => {
  const cache = createUpstashSemanticCache({
    env: { UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't' },
    fetchImpl: null,
  });
  assert.equal(cache.enabled, false);
});

test('createUpstashSemanticCache reports enabled with credentials and fetch', () => {
  const cache = createUpstashSemanticCache({
    env: { UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't' },
    fetchImpl: () => {},
  });
  assert.equal(cache.enabled, true);
});

test('set returns false when disabled', async () => {
  const cache = createUpstashSemanticCache({ env: {} });
  const result = await cache.set('k', 'v', 60);
  assert.equal(result, false);
});

test('set returns false when ttlSeconds is 0', async () => {
  const cache = createUpstashSemanticCache({
    env: { UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't' },
    fetchImpl: () => {},
  });
  const result = await cache.set('k', 'v', 0);
  assert.equal(result, false);
});

test('get returns null when disabled', async () => {
  const cache = createUpstashSemanticCache({ env: {} });
  const result = await cache.get('k');
  assert.equal(result, null);
});

test('get returns null on fetch failure', async () => {
  const cache = createUpstashSemanticCache({
    env: { UPSTASH_REDIS_REST_URL: 'http://x', UPSTASH_REDIS_REST_TOKEN: 't' },
    fetchImpl: async () => ({ ok: false }),
  });
  const result = await cache.get('k');
  assert.equal(result, null);
});
