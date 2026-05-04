/**
 * llm-response-cache — pins the normalization rules + cache key
 * derivation. Three properties matter:
 *
 *   1. Normalization is conservative. Trivial variants collapse
 *      ("Hello!", "hello", "HELLO ") but semantically distinct
 *      prompts stay distinct.
 *
 *   2. Tenant isolation. User A's prompt and User B's identical
 *      prompt produce DIFFERENT keys.
 *
 *   3. Provider / model / temperature / system-prompt all
 *      participate in the key. A change to any of them must
 *      bust the cache — otherwise a different model would
 *      replay another's answer.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCacheConfig,
  normalizePrompt,
  buildCacheKey,
  hashSystemPrompt,
  createInMemoryCache,
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
} = require("../src/services/cache/llm-response-cache");

describe("resolveCacheConfig", () => {
  test("disabled by default", () => {
    assert.equal(resolveCacheConfig({}).enabled, false);
  });

  test("SEMANTIC_CACHE_ENABLED=true activates", () => {
    assert.equal(resolveCacheConfig({ SEMANTIC_CACHE_ENABLED: 'true' }).enabled, true);
  });

  test("TTL clamps to [MIN, MAX]", () => {
    assert.equal(resolveCacheConfig({ SEMANTIC_CACHE_TTL_SECONDS: '1' }).ttlSeconds, MIN_TTL_SECONDS);
    assert.equal(
      resolveCacheConfig({ SEMANTIC_CACHE_TTL_SECONDS: String(7 * 24 * 3600) }).ttlSeconds,
      MAX_TTL_SECONDS,
    );
  });

  test("default TTL is 1 hour", () => {
    assert.equal(resolveCacheConfig({}).ttlSeconds, DEFAULT_TTL_SECONDS);
  });
});

describe("normalizePrompt", () => {
  test("lowercases", () => {
    assert.equal(normalizePrompt('Hello World'), 'hello world');
  });

  test("collapses runs of whitespace", () => {
    assert.equal(normalizePrompt('hello   world\n\n\nthere'), 'hello world there');
  });

  test("strips trailing punctuation", () => {
    assert.equal(normalizePrompt('Hello!'), 'hello');
    assert.equal(normalizePrompt('Hello???'), 'hello');
    assert.equal(normalizePrompt('Hello.'), 'hello');
  });

  test("trims leading / trailing whitespace", () => {
    assert.equal(normalizePrompt('  hello  '), 'hello');
  });

  test("the four variants of 'Hello' all collide on one key", () => {
    const a = normalizePrompt('Hello');
    const b = normalizePrompt('hello!');
    const c = normalizePrompt('  HELLO  ');
    const d = normalizePrompt('hello.');
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(c, d);
  });

  test("does NOT collapse semantically distinct prompts", () => {
    assert.notEqual(normalizePrompt('Is X good?'), normalizePrompt('Why is X good?'));
    assert.notEqual(normalizePrompt('Hello'), normalizePrompt('Goodbye'));
  });

  test("non-string input returns empty string (defensive)", () => {
    assert.equal(normalizePrompt(undefined), '');
    assert.equal(normalizePrompt(null), '');
    assert.equal(normalizePrompt(42), '');
  });
});

describe("hashSystemPrompt", () => {
  test("'sys:none' for empty / missing", () => {
    assert.equal(hashSystemPrompt(undefined), 'sys:none');
    assert.equal(hashSystemPrompt(''), 'sys:none');
  });

  test("deterministic for identical content", () => {
    assert.equal(hashSystemPrompt('Be helpful'), hashSystemPrompt('Be helpful'));
  });

  test("different content → different hash (Custom GPTs do not collide)", () => {
    assert.notEqual(hashSystemPrompt('Be helpful'), hashSystemPrompt('Be terse'));
  });
});

describe("buildCacheKey", () => {
  test("returns null without userId or prompt", () => {
    assert.equal(buildCacheKey({}), null);
    assert.equal(buildCacheKey({ userId: 'u-1' }), null);
    assert.equal(buildCacheKey({ prompt: 'hi' }), null);
  });

  test("two users with the same prompt get DIFFERENT keys", () => {
    const a = buildCacheKey({ userId: 'u-A', model: 'gpt-4', prompt: 'hello' });
    const b = buildCacheKey({ userId: 'u-B', model: 'gpt-4', prompt: 'hello' });
    assert.notEqual(a, b);
  });

  test("same user, same prompt, different model → different keys", () => {
    const a = buildCacheKey({ userId: 'u-1', model: 'gpt-4', prompt: 'hello' });
    const b = buildCacheKey({ userId: 'u-1', model: 'gpt-3.5', prompt: 'hello' });
    assert.notEqual(a, b);
  });

  test("same user, same prompt, different provider → different keys", () => {
    const a = buildCacheKey({ userId: 'u-1', provider: 'openai', model: 'gpt-4', prompt: 'hi' });
    const b = buildCacheKey({ userId: 'u-1', provider: 'anthropic', model: 'gpt-4', prompt: 'hi' });
    assert.notEqual(a, b);
  });

  test("same user, prompt, model, but different system prompt → different keys", () => {
    const base = { userId: 'u-1', model: 'gpt-4', prompt: 'hello' };
    const a = buildCacheKey({ ...base, systemPrompt: 'Be helpful' });
    const b = buildCacheKey({ ...base, systemPrompt: 'Be terse' });
    assert.notEqual(a, b);
  });

  test("temperature variants collide when rounded to 1dp (0.700001 == 0.7)", () => {
    const base = { userId: 'u-1', model: 'gpt-4', prompt: 'hello' };
    const a = buildCacheKey({ ...base, temperature: 0.7 });
    const b = buildCacheKey({ ...base, temperature: 0.700001 });
    assert.equal(a, b);
  });

  test("temperature variants do NOT collide across the 1dp boundary (0.7 vs 0.8)", () => {
    const base = { userId: 'u-1', model: 'gpt-4', prompt: 'hello' };
    const a = buildCacheKey({ ...base, temperature: 0.7 });
    const b = buildCacheKey({ ...base, temperature: 0.8 });
    assert.notEqual(a, b);
  });

  test("normalization variants of the prompt collide on one key", () => {
    const base = { userId: 'u-1', model: 'gpt-4' };
    const a = buildCacheKey({ ...base, prompt: 'Hello!' });
    const b = buildCacheKey({ ...base, prompt: '  hello.  ' });
    assert.equal(a, b);
  });

  test("missing temperature → 'na' segment, still a valid key", () => {
    const key = buildCacheKey({ userId: 'u-1', model: 'gpt-4', prompt: 'hello' });
    assert.ok(key && key.includes('|t:na|'));
  });
});

describe("createInMemoryCache — store contract", () => {
  test("put / get round-trip", async () => {
    const cache = createInMemoryCache();
    await cache.put('k1', { stdout: 'hello' });
    assert.deepEqual(await cache.get('k1'), { stdout: 'hello' });
  });

  test("expired entry returns null", async () => {
    let fakeTime = 1_000_000;
    const cache = createInMemoryCache({ ttlSeconds: 60, now: () => fakeTime });
    await cache.put('k1', { value: 'x' });
    fakeTime += 30 * 1000;
    assert.notEqual(await cache.get('k1'), null);
    fakeTime += 60 * 1000;
    assert.equal(await cache.get('k1'), null);
  });

  test("custom per-call TTL is honored", async () => {
    let fakeTime = 1_000_000;
    const cache = createInMemoryCache({ ttlSeconds: 3600, now: () => fakeTime });
    await cache.put('short', { value: 'x' }, 10);
    fakeTime += 11 * 1000;
    assert.equal(await cache.get('short'), null);
  });

  test("FIFO eviction when bounded by maxEntries", async () => {
    const cache = createInMemoryCache({ ttlSeconds: 3600, maxEntries: 2 });
    await cache.put('a', 1);
    await cache.put('b', 2);
    await cache.put('c', 3);
    // 'a' was the oldest, must be evicted.
    assert.equal(await cache.get('a'), null);
    assert.equal(await cache.get('b'), 2);
    assert.equal(await cache.get('c'), 3);
  });

  test("re-put of an existing key does NOT trigger eviction", async () => {
    const cache = createInMemoryCache({ ttlSeconds: 3600, maxEntries: 2 });
    await cache.put('a', 1);
    await cache.put('b', 2);
    await cache.put('a', 11); // updates 'a', not adds a new key
    assert.equal(await cache.get('a'), 11);
    assert.equal(await cache.get('b'), 2);
  });
});
