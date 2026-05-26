'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createToolCallIdempotency,
  hashArgs,
  stableStringify,
} = require('../src/services/agents/tool-call-idempotency');

describe('stableStringify', () => {
  test('object key order does not affect output', () => {
    assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  });
  test('arrays preserve order', () => {
    assert.notEqual(stableStringify([1, 2, 3]), stableStringify([3, 2, 1]));
  });
  test('functions and undefined are normalized', () => {
    assert.equal(stableStringify(undefined), 'undefined');
    assert.equal(stableStringify(() => 1), '"<fn>"');
  });
  test('null is its own canonical form', () => {
    assert.equal(stableStringify(null), 'null');
  });
});

describe('hashArgs', () => {
  test('same tool + same args hash equally', () => {
    assert.equal(hashArgs('t', { a: 1 }), hashArgs('t', { a: 1 }));
  });
  test('different tool name produces different hash', () => {
    assert.notEqual(hashArgs('a', {}), hashArgs('b', {}));
  });
  test('semantically equal args collide', () => {
    assert.equal(hashArgs('t', { a: 1, b: 2 }), hashArgs('t', { b: 2, a: 1 }));
  });
});

describe('createToolCallIdempotency — runOnce coalescing', () => {
  test('first call runs, second call returns cached value', async () => {
    let calls = 0;
    const id = createToolCallIdempotency({ ttlMs: 60_000, now: () => 0 });
    const v1 = await id.runOnce('search', { q: 'x' }, async () => { calls += 1; return 'r'; });
    const v2 = await id.runOnce('search', { q: 'x' }, async () => { calls += 1; return 'r2'; });
    assert.equal(v1, 'r');
    assert.equal(v2, 'r');
    assert.equal(calls, 1);
  });

  test('different args run independently', async () => {
    let calls = 0;
    const id = createToolCallIdempotency({ ttlMs: 60_000, now: () => 0 });
    await id.runOnce('search', { q: 'x' }, async () => { calls += 1; return 'a'; });
    await id.runOnce('search', { q: 'y' }, async () => { calls += 1; return 'b'; });
    assert.equal(calls, 2);
  });

  test('concurrent identical calls single-flight onto one runner invocation', async () => {
    let calls = 0;
    const id = createToolCallIdempotency({ ttlMs: 60_000, now: () => 0 });
    const runner = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return 'shared';
    };
    const [a, b, c] = await Promise.all([
      id.runOnce('t', { k: 1 }, runner),
      id.runOnce('t', { k: 1 }, runner),
      id.runOnce('t', { k: 1 }, runner),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b, c], ['shared', 'shared', 'shared']);
    assert.equal(id.snapshot().coalesced, 2);
  });

  test('cached rejection: second call throws the same error without re-running', async () => {
    let calls = 0;
    const id = createToolCallIdempotency({ ttlMs: 60_000, now: () => 0 });
    const err = new Error('boom');
    const runner = async () => { calls += 1; throw err; };
    await assert.rejects(id.runOnce('t', {}, runner), /boom/);
    await assert.rejects(id.runOnce('t', {}, runner), /boom/);
    assert.equal(calls, 1);
  });
});

describe('createToolCallIdempotency — TTL', () => {
  test('expired entries trigger a re-run', async () => {
    let calls = 0;
    let t = 0;
    const id = createToolCallIdempotency({ ttlMs: 100, now: () => t });
    await id.runOnce('t', {}, async () => { calls += 1; return 'r'; });
    t = 200;
    await id.runOnce('t', {}, async () => { calls += 1; return 'r'; });
    assert.equal(calls, 2);
  });
});

describe('createToolCallIdempotency — LRU eviction', () => {
  test('exceeding maxEntries evicts oldest', async () => {
    const id = createToolCallIdempotency({ ttlMs: 60_000, maxEntries: 2, now: () => 0 });
    await id.runOnce('t', { a: 1 }, async () => 'a');
    await id.runOnce('t', { a: 2 }, async () => 'b');
    await id.runOnce('t', { a: 3 }, async () => 'c'); // evicts a:1
    assert.equal(id.snapshot().size, 2);
    assert.equal(id.snapshot().evictions >= 1, true);
  });

  test('hits move entries to the end (LRU touch)', async () => {
    const id = createToolCallIdempotency({ ttlMs: 60_000, maxEntries: 2, now: () => 0 });
    await id.runOnce('t', { a: 1 }, async () => 'a');
    await id.runOnce('t', { a: 2 }, async () => 'b');
    await id.runOnce('t', { a: 1 }, async () => 'a-not-called'); // touches a:1
    let calls = 0;
    await id.runOnce('t', { a: 3 }, async () => { calls += 1; return 'c'; }); // evicts a:2
    // a:1 still present — re-call should hit cache
    await id.runOnce('t', { a: 1 }, async () => { calls += 1; return 'reborn'; });
    assert.equal(calls, 1);
  });
});

describe('createToolCallIdempotency — invalidation', () => {
  test('invalidate(tool) clears every entry for that tool', async () => {
    const id = createToolCallIdempotency({ ttlMs: 60_000, now: () => 0 });
    await id.runOnce('a', { x: 1 }, async () => 'r');
    await id.runOnce('a', { x: 2 }, async () => 'r');
    await id.runOnce('b', {}, async () => 'r');
    const removed = id.invalidate('a');
    assert.equal(removed, 2);
    assert.equal(id.snapshot().size, 1);
  });

  test('invalidate(tool, args) clears only the specific entry', async () => {
    const id = createToolCallIdempotency({ ttlMs: 60_000, now: () => 0 });
    await id.runOnce('a', { x: 1 }, async () => 'r');
    await id.runOnce('a', { x: 2 }, async () => 'r');
    assert.equal(id.invalidate('a', { x: 1 }), 1);
    assert.equal(id.snapshot().size, 1);
  });
});

describe('createToolCallIdempotency — guards', () => {
  test('rejects empty toolName', async () => {
    const id = createToolCallIdempotency({});
    await assert.rejects(id.runOnce('', {}, async () => 1), TypeError);
  });
  test('rejects non-function runner', async () => {
    const id = createToolCallIdempotency({});
    await assert.rejects(id.runOnce('t', {}, 'nope'), TypeError);
  });
});
