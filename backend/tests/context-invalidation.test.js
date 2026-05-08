'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  ContextInvalidator,
  InvalidationError,
  getInvalidator,
  resetInvalidatorForTests,
  tagMatches,
} = require('../src/cache/context-invalidation');

describe('tagMatches', () => {
  it('matches exact strings', () => {
    assert.strictEqual(tagMatches('users.42', 'users.42'), true);
    assert.strictEqual(tagMatches('users.42', 'users.43'), false);
  });

  it('matches the wildcard against any tag', () => {
    assert.strictEqual(tagMatches('*', 'anything.goes'), true);
    assert.strictEqual(tagMatches('*', ''), true);
  });

  it('matches prefix-glob patterns', () => {
    assert.strictEqual(tagMatches('users.42.*', 'users.42.context'), true);
    assert.strictEqual(tagMatches('users.42.*', 'users.42.cache.deep'), true);
    assert.strictEqual(tagMatches('users.42.*', 'users.43.context'), false);
    assert.strictEqual(tagMatches('users.42.*', 'users.42'), false); // needs trailing dot
  });

  it('returns false for non-string args', () => {
    assert.strictEqual(tagMatches(null, 'x'), false);
    assert.strictEqual(tagMatches('x', null), false);
    assert.strictEqual(tagMatches(undefined, undefined), false);
  });
});

describe('ContextInvalidator — subscribe/unsubscribe', () => {
  let inv;
  beforeEach(() => { inv = new ContextInvalidator(); });

  it('rejects empty patterns array', () => {
    assert.throws(() => inv.subscribe({ patterns: [], handler: () => {} }), InvalidationError);
  });

  it('rejects missing handler', () => {
    assert.throws(() => inv.subscribe({ patterns: ['x'] }), InvalidationError);
  });

  it('rejects non-string patterns', () => {
    assert.throws(() => inv.subscribe({ patterns: ['ok', 42], handler: () => {} }), InvalidationError);
    assert.throws(() => inv.subscribe({ patterns: [''], handler: () => {} }), InvalidationError);
  });

  it('returns a handle whose unsubscribe() removes the subscription', () => {
    const handle = inv.subscribe({ patterns: ['x'], handler: () => {}, name: 's1' });
    assert.strictEqual(inv.getStats().subscribers, 1);
    assert.strictEqual(handle.unsubscribe(), true);
    assert.strictEqual(inv.getStats().subscribers, 0);
    assert.strictEqual(handle.unsubscribe(), false); // idempotent
  });

  it('unsubscribeAll clears every subscription', () => {
    inv.subscribe({ patterns: ['a'], handler: () => {} });
    inv.subscribe({ patterns: ['b'], handler: () => {} });
    inv.subscribe({ patterns: ['*'], handler: () => {} });
    assert.strictEqual(inv.unsubscribeAll(), 3);
    assert.strictEqual(inv.getStats().subscribers, 0);
  });
});

describe('ContextInvalidator — invalidate', () => {
  let inv;
  beforeEach(() => { inv = new ContextInvalidator(); });

  it('rejects empty tag', () => {
    assert.throws(() => inv.invalidate(''), InvalidationError);
    assert.throws(() => inv.invalidate(null), InvalidationError);
  });

  it('delivers to exact-match subscribers only', () => {
    let aHits = 0, bHits = 0;
    inv.subscribe({ patterns: ['cache.a'], handler: () => { aHits += 1; } });
    inv.subscribe({ patterns: ['cache.b'], handler: () => { bHits += 1; } });

    assert.strictEqual(inv.invalidate('cache.a'), 1);
    assert.strictEqual(aHits, 1);
    assert.strictEqual(bHits, 0);

    assert.strictEqual(inv.invalidate('cache.b'), 1);
    assert.strictEqual(bHits, 1);
  });

  it('delivers to wildcard subscribers for every tag', () => {
    let count = 0;
    inv.subscribe({ patterns: ['*'], handler: () => { count += 1; } });
    inv.invalidate('alpha');
    inv.invalidate('beta');
    inv.invalidate('users.42.context');
    assert.strictEqual(count, 3);
  });

  it('delivers to prefix-glob subscribers when tag falls under prefix', () => {
    let hits = 0;
    inv.subscribe({ patterns: ['users.42.*'], handler: () => { hits += 1; } });
    inv.invalidate('users.42.context');
    inv.invalidate('users.42.cache.deep');
    inv.invalidate('users.43.context');
    assert.strictEqual(hits, 2);
  });

  it('passes the event object to handlers', () => {
    let captured = null;
    inv.subscribe({ patterns: ['t'], handler: ev => { captured = ev; } });
    inv.invalidate('t', { reason: 'edit', source: 'router', metadata: { k: 1 } });
    assert.ok(captured);
    assert.strictEqual(captured.tag, 't');
    assert.strictEqual(captured.reason, 'edit');
    assert.strictEqual(captured.source, 'router');
    assert.deepStrictEqual(captured.metadata, { k: 1 });
    assert.strictEqual(typeof captured.ts, 'number');
  });

  it('counts emitted and delivered metrics correctly', () => {
    inv.subscribe({ patterns: ['a'], handler: () => {} });
    inv.subscribe({ patterns: ['a', 'b'], handler: () => {} });
    inv.subscribe({ patterns: ['c'], handler: () => {} });

    inv.invalidate('a'); // 2 deliveries
    inv.invalidate('b'); // 1 delivery
    inv.invalidate('z'); // 0 deliveries

    const s = inv.getStats();
    assert.strictEqual(s.emitted, 3);
    assert.strictEqual(s.delivered, 3);
  });

  it('invalidateMany aggregates handler invocations', () => {
    let hits = 0;
    inv.subscribe({ patterns: ['*'], handler: () => { hits += 1; } });
    const total = inv.invalidateMany(['a', 'b', 'c']);
    assert.strictEqual(total, 3);
    assert.strictEqual(hits, 3);
  });

  it('invalidateMany rejects non-array input', () => {
    assert.throws(() => inv.invalidateMany('not-an-array'), InvalidationError);
  });

  it('invalidateAll fires every subscriber regardless of tag', () => {
    const tags = [];
    inv.subscribe({ patterns: ['only.x'], handler: ev => tags.push(ev.tag) });
    inv.invalidateAll('test-flush');
    assert.strictEqual(tags.length, 1);
    assert.strictEqual(tags[0], '*');
  });
});

describe('ContextInvalidator — idempotency', () => {
  let inv;
  beforeEach(() => { inv = new ContextInvalidator({ dedupeWindow: 3 }); });

  it('suppresses duplicate emissions sharing an idempotencyKey', () => {
    let hits = 0;
    inv.subscribe({ patterns: ['x'], handler: () => { hits += 1; } });
    inv.invalidate('x', { idempotencyKey: 'op-1' });
    inv.invalidate('x', { idempotencyKey: 'op-1' });
    inv.invalidate('x', { idempotencyKey: 'op-1' });
    assert.strictEqual(hits, 1);
    assert.strictEqual(inv.getStats().suppressedDuplicates, 2);
  });

  it('different idempotencyKeys do not collide', () => {
    let hits = 0;
    inv.subscribe({ patterns: ['x'], handler: () => { hits += 1; } });
    inv.invalidate('x', { idempotencyKey: 'a' });
    inv.invalidate('x', { idempotencyKey: 'b' });
    assert.strictEqual(hits, 2);
  });

  it('drops oldest keys once dedupeWindow is exceeded', () => {
    let hits = 0;
    inv.subscribe({ patterns: ['x'], handler: () => { hits += 1; } });
    // Window of 3: keys 1..4 → key 1 is evicted, then re-emitting key 1 hits.
    inv.invalidate('x', { idempotencyKey: '1' });
    inv.invalidate('x', { idempotencyKey: '2' });
    inv.invalidate('x', { idempotencyKey: '3' });
    inv.invalidate('x', { idempotencyKey: '4' });
    inv.invalidate('x', { idempotencyKey: '1' }); // re-issues since '1' was evicted
    assert.strictEqual(hits, 5);
  });
});

describe('ContextInvalidator — handler errors', () => {
  let inv;
  beforeEach(() => { inv = new ContextInvalidator(); });

  it('synchronous handler throws are caught and counted', () => {
    inv.subscribe({ patterns: ['x'], name: 'bad', handler: () => { throw new Error('boom'); } });
    inv.invalidate('x');
    assert.strictEqual(inv.getStats().handlerErrors, 1);
    const log = inv.getLog();
    assert.ok(log.some(e => e.tag === '_handler_error' && e.source === 'bad'));
  });

  it('a failing handler does not stop later subscribers', () => {
    let secondCalled = false;
    inv.subscribe({ patterns: ['x'], handler: () => { throw new Error('first'); } });
    inv.subscribe({ patterns: ['x'], handler: () => { secondCalled = true; } });
    inv.invalidate('x');
    assert.strictEqual(secondCalled, true);
  });

  it('async handler rejections are caught (no unhandled rejection)', async () => {
    inv.subscribe({ patterns: ['x'], name: 'async-bad', handler: async () => { throw new Error('async boom'); } });
    inv.invalidate('x');
    // Allow microtask queue to drain.
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(inv.getStats().handlerErrors, 1);
  });
});

describe('ContextInvalidator — log buffer', () => {
  it('caps the log at logCapacity', () => {
    const inv = new ContextInvalidator({ logCapacity: 5 });
    for (let i = 0; i < 12; i++) inv.invalidate(`tag.${i}`);
    const log = inv.getLog();
    assert.strictEqual(log.length, 5);
    // Oldest retained should be tag.7 (12 - 5).
    assert.strictEqual(log[0].tag, 'tag.7');
    assert.strictEqual(log[4].tag, 'tag.11');
  });
});

describe('ContextInvalidator — singleton', () => {
  it('returns the same instance on repeated calls', () => {
    resetInvalidatorForTests();
    const a = getInvalidator();
    const b = getInvalidator();
    assert.strictEqual(a, b);
    resetInvalidatorForTests();
    const c = getInvalidator();
    assert.notStrictEqual(a, c);
  });
});
