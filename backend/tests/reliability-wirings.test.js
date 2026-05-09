'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  isReliabilityWiringsEnabled,
  wireSubscribeIfEnabled,
  resetWiringStateForTests,
} = require('../src/cache/wireup');

const {
  ContextInvalidator,
  resetInvalidatorForTests,
} = require('../src/cache/context-invalidation');

const { SingleFlight } = require('../src/cache/single-flight');

// ── isReliabilityWiringsEnabled ──────────────────────────────────────

describe('isReliabilityWiringsEnabled', () => {
  it('returns false when env var is unset', () => {
    assert.strictEqual(isReliabilityWiringsEnabled({}), false);
  });

  it('returns true for "1" / "true" / "yes" / "on" (any case)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On', ' true ']) {
      assert.strictEqual(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), true, `value ${v}`);
    }
  });

  it('returns false for "0" / "false" / random strings', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'off', '', 'banana']) {
      assert.strictEqual(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), false, `value ${v}`);
    }
  });
});

// ── wireSubscribeIfEnabled ───────────────────────────────────────────

describe('wireSubscribeIfEnabled', () => {
  let inv;
  beforeEach(() => {
    resetWiringStateForTests();
    inv = new ContextInvalidator();
  });

  it('returns null and does nothing when flag is off', () => {
    const holder = {};
    let calls = 0;
    const r = wireSubscribeIfEnabled({
      name: 't',
      patterns: ['x'],
      handler: () => { calls += 1; },
      holder,
      env: {},
      getInvalidator: () => inv,
    });
    inv.invalidate('x');
    assert.strictEqual(r, null);
    assert.strictEqual(calls, 0);
  });

  it('subscribes when flag is on; handler fires on matching tag', () => {
    const holder = {};
    let received = null;
    const r = wireSubscribeIfEnabled({
      name: 'cache',
      patterns: ['context.*'],
      handler: (ev) => { received = ev; },
      holder,
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => inv,
    });
    assert.ok(r, 'expected a handle');
    inv.invalidate('context.user.42', { reason: 'edit' });
    assert.ok(received);
    assert.strictEqual(received.tag, 'context.user.42');
    assert.strictEqual(received.reason, 'edit');
  });

  it('once-guard: a second wire call with the same holder is a no-op', () => {
    const holder = {};
    const r1 = wireSubscribeIfEnabled({
      name: 'cache',
      patterns: ['x'],
      handler: () => {},
      holder,
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => inv,
    });
    const r2 = wireSubscribeIfEnabled({
      name: 'cache',
      patterns: ['x'],
      handler: () => {},
      holder,
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => inv,
    });
    assert.ok(r1);
    assert.strictEqual(r2, null);
    assert.strictEqual(inv.getStats().subscribers, 1);
  });

  it('different holders both subscribe (independent caches)', () => {
    const r1 = wireSubscribeIfEnabled({
      name: 'cacheA', patterns: ['x'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' }, getInvalidator: () => inv,
    });
    const r2 = wireSubscribeIfEnabled({
      name: 'cacheB', patterns: ['x'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' }, getInvalidator: () => inv,
    });
    assert.ok(r1);
    assert.ok(r2);
    assert.strictEqual(inv.getStats().subscribers, 2);
  });

  it('returns null on bad arguments', () => {
    const env = { SIRA_RELIABILITY_WIRINGS: '1' };
    assert.strictEqual(wireSubscribeIfEnabled({ env, getInvalidator: () => inv, name: '', patterns: ['x'], handler: () => {} }), null);
    assert.strictEqual(wireSubscribeIfEnabled({ env, getInvalidator: () => inv, name: 'n', patterns: [], handler: () => {} }), null);
    assert.strictEqual(wireSubscribeIfEnabled({ env, getInvalidator: () => inv, name: 'n', patterns: ['x'], handler: 42 }), null);
  });

  it('degrades silently when getInvalidator throws (defensive)', () => {
    const r = wireSubscribeIfEnabled({
      name: 'n',
      patterns: ['x'],
      handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => { throw new Error('bad'); },
    });
    assert.strictEqual(r, null);
  });

  it('degrades silently when subscribe throws (defensive)', () => {
    const fakeInv = { subscribe: () => { throw new Error('subscribe boom'); } };
    const r = wireSubscribeIfEnabled({
      name: 'n',
      patterns: ['x'],
      handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => fakeInv,
    });
    assert.strictEqual(r, null);
  });
});

// ── End-to-end: semantic.js / llm-cache.js subscribe behavior ────────

describe('integration — semantic and llm-cache subscribe to invalidator under flag', () => {
  beforeEach(() => {
    resetWiringStateForTests();
    resetInvalidatorForTests();
  });

  it('semantic.getSemanticCache subscribes when flag is set', () => {
    process.env.SIRA_RELIABILITY_WIRINGS = '1';
    try {
      // Load fresh modules — semantic.js will read the env at first
      // getSemanticCache call.
      delete require.cache[require.resolve('../src/cache/semantic')];
      delete require.cache[require.resolve('../src/cache/context-invalidation')];
      delete require.cache[require.resolve('../src/cache/wireup')];
      const { getSemanticCache, _resetSingletonForTests } = require('../src/cache/semantic');
      const { getInvalidator, resetInvalidatorForTests: reset2 } = require('../src/cache/context-invalidation');
      reset2();
      _resetSingletonForTests();
      const sem = getSemanticCache({ env: process.env });
      assert.ok(sem);
      const inv = getInvalidator();
      assert.ok(inv.getStats().subscribers >= 1, 'expected semantic-cache subscriber');
    } finally {
      delete process.env.SIRA_RELIABILITY_WIRINGS;
    }
  });

  it('llm-cache.getCache subscribes when flag is set', () => {
    process.env.SIRA_RELIABILITY_WIRINGS = '1';
    try {
      delete require.cache[require.resolve('../src/cache/llm-cache')];
      delete require.cache[require.resolve('../src/cache/context-invalidation')];
      delete require.cache[require.resolve('../src/cache/wireup')];
      const { getCache, _resetSingletonForTests } = require('../src/cache/llm-cache');
      const { getInvalidator, resetInvalidatorForTests: reset2 } = require('../src/cache/context-invalidation');
      reset2();
      _resetSingletonForTests();
      const cache = getCache({ env: process.env });
      assert.ok(cache);
      const inv = getInvalidator();
      assert.ok(inv.getStats().subscribers >= 1, 'expected llm-cache subscriber');
    } finally {
      delete process.env.SIRA_RELIABILITY_WIRINGS;
    }
  });

  it('does NOT subscribe when flag is unset (default path)', () => {
    delete process.env.SIRA_RELIABILITY_WIRINGS;
    delete require.cache[require.resolve('../src/cache/semantic')];
    delete require.cache[require.resolve('../src/cache/context-invalidation')];
    delete require.cache[require.resolve('../src/cache/wireup')];
    const { getSemanticCache, _resetSingletonForTests } = require('../src/cache/semantic');
    const { getInvalidator, resetInvalidatorForTests: reset2 } = require('../src/cache/context-invalidation');
    reset2();
    _resetSingletonForTests();
    getSemanticCache({ env: { /* no flag */ } });
    const inv = getInvalidator();
    assert.strictEqual(inv.getStats().subscribers, 0);
  });
});

// ── single-flight dedup proof ────────────────────────────────────────

describe('single-flight dedup demonstration', () => {
  it('coalesces concurrent calls under the same key', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const work = () => {
      calls += 1;
      return new Promise(r => setTimeout(() => r('result'), 20));
    };
    const ps = [sf.do('k', work), sf.do('k', work), sf.do('k', work), sf.do('k', work)];
    const results = await Promise.all(ps);
    assert.strictEqual(calls, 1, 'expected exactly one underlying call');
    assert.deepStrictEqual(results, ['result', 'result', 'result', 'result']);
  });
});
