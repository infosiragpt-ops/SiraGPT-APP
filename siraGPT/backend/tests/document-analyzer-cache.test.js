'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-analyzer-cache');
const { computeHash, makeKey, get, set, has, stats, reset, memoize, _internal } = engine;

test('computeHash produces stable 24-char hex digest', () => {
  const h = computeHash('hello world');
  assert.equal(h.length, 24);
  assert.equal(h, computeHash('hello world'));
});

test('computeHash differs across different inputs', () => {
  assert.notEqual(computeHash('a'), computeHash('b'));
});

test('makeKey composes analyzer + hash', () => {
  const k = makeKey('kpi', '0123456789abcdef0123');
  assert.equal(k, 'kpi|0123456789abcdef0123');
});

test('set / get / has roundtrip', () => {
  reset();
  set('foo', { value: 42 });
  assert.equal(has('foo'), true);
  assert.deepEqual(get('foo'), { value: 42 });
});

test('get on missing key returns undefined and increments misses', () => {
  reset();
  assert.equal(get('missing'), undefined);
  assert.equal(stats().misses, 1);
});

test('hit ratio tracked correctly', () => {
  reset();
  set('hot', 'v');
  get('hot');
  get('hot');
  get('cold');
  const s = stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(s.ratio > 0.5);
});

test('reset clears state and counters', () => {
  set('foo', 1);
  reset();
  assert.equal(stats().size, 0);
  assert.equal(stats().hits, 0);
});

test('LRU eviction respects MAX_ENTRIES ceiling', () => {
  reset();
  for (let i = 0; i < _internal.MAX_ENTRIES + 50; i++) set(`k${i}`, i);
  assert.ok(stats().size <= _internal.MAX_ENTRIES);
  // Oldest should be gone.
  assert.equal(get('k0'), undefined);
});

test('memoize caches deterministic function results', () => {
  reset();
  let calls = 0;
  const fn = (text) => { calls++; return `out:${text}`; };
  const cached = memoize('test', fn);
  assert.equal(cached('abc'), 'out:abc');
  assert.equal(cached('abc'), 'out:abc');
  assert.equal(cached('abc'), 'out:abc');
  assert.equal(calls, 1, 'function only ran once');
});

test('memoize separates analyzers by name', () => {
  reset();
  const a = memoize('A', (t) => `A:${t}`);
  const b = memoize('B', (t) => `B:${t}`);
  assert.equal(a('x'), 'A:x');
  assert.equal(b('x'), 'B:x');
  assert.equal(stats().size, 2);
});

test('memoize: rest args do not affect cache key', () => {
  reset();
  let lastExtra = null;
  const fn = (text, extra) => { lastExtra = extra; return text; };
  const cached = memoize('rest', fn);
  cached('A', 'first');
  cached('A', 'second');
  assert.equal(lastExtra, 'first'); // second call hit cache, fn not re-invoked
});

test('memoize throws on non-function input', () => {
  assert.throws(() => memoize('x', 42), /function/);
});

test('non-string text hashes consistently', () => {
  assert.equal(computeHash(null), computeHash(undefined));
  assert.equal(computeHash(null).length, 24);
});
