'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  isReliabilityWiringsEnabled,
  wireSubscribeIfEnabled,
  getWiredHoldersCount,
  resetWiringStateForTests,
} = require('../src/cache/wireup');

const {
  ContextInvalidator,
  resetInvalidatorForTests,
} = require('../src/cache/context-invalidation');

const { SingleFlight } = require('../src/cache/single-flight');

// ── isReliabilityWiringsEnabled ──────────────────────────────────────

describe('isReliabilityWiringsEnabled', () => {
  it('returns true when env var is unset (default ON)', () => {
    assert.strictEqual(isReliabilityWiringsEnabled({}), true);
  });

  it('returns true for "1" / "true" / "yes" / "on" (any case)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On', ' true ']) {
      assert.strictEqual(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), true, `value ${v}`);
    }
  });

  it('returns false for kill-switch literals "0" / "false" / "no" / "off" / "disabled"', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF', 'disabled', ' off ']) {
      assert.strictEqual(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), false, `value ${v}`);
    }
  });

  it('returns true for empty string and unknown values (fail-open)', () => {
    for (const v of ['', 'banana', 'maybe']) {
      assert.strictEqual(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), true, `value ${v}`);
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

  it('returns null and does nothing when kill-switch is engaged', () => {
    const holder = {};
    let calls = 0;
    const r = wireSubscribeIfEnabled({
      name: 't',
      patterns: ['x'],
      handler: () => { calls += 1; },
      holder,
      env: { SIRA_RELIABILITY_WIRINGS: '0' },
      getInvalidator: () => inv,
    });
    inv.invalidate('x');
    assert.strictEqual(r, null);
    assert.strictEqual(calls, 0);
  });

  it('subscribes by default when env is empty (default ON)', () => {
    const holder = {};
    let received = null;
    const r = wireSubscribeIfEnabled({
      name: 'cache',
      patterns: ['x'],
      handler: (ev) => { received = ev; },
      holder,
      env: {},
      getInvalidator: () => inv,
    });
    inv.invalidate('x');
    assert.ok(r, 'expected default-ON to subscribe');
    assert.ok(received);
  });

  it('getWiredHoldersCount tracks successful wirings', () => {
    resetWiringStateForTests();
    assert.strictEqual(getWiredHoldersCount(), 0);
    wireSubscribeIfEnabled({
      name: 'a', patterns: ['x'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' }, getInvalidator: () => inv,
    });
    wireSubscribeIfEnabled({
      name: 'b', patterns: ['x'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' }, getInvalidator: () => inv,
    });
    assert.strictEqual(getWiredHoldersCount(), 2);
    // Kill-switched call must not increment.
    wireSubscribeIfEnabled({
      name: 'c', patterns: ['x'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: 'off' }, getInvalidator: () => inv,
    });
    assert.strictEqual(getWiredHoldersCount(), 2);
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

  it('does NOT subscribe when kill-switch is engaged', () => {
    process.env.SIRA_RELIABILITY_WIRINGS = '0';
    try {
      delete require.cache[require.resolve('../src/cache/semantic')];
      delete require.cache[require.resolve('../src/cache/context-invalidation')];
      delete require.cache[require.resolve('../src/cache/wireup')];
      const { getSemanticCache, _resetSingletonForTests } = require('../src/cache/semantic');
      const { getInvalidator, resetInvalidatorForTests: reset2 } = require('../src/cache/context-invalidation');
      reset2();
      _resetSingletonForTests();
      getSemanticCache({ env: { SIRA_RELIABILITY_WIRINGS: '0' } });
      const inv = getInvalidator();
      assert.strictEqual(inv.getStats().subscribers, 0);
    } finally {
      delete process.env.SIRA_RELIABILITY_WIRINGS;
    }
  });

  it('subscribes by default when env var is unset (default ON)', () => {
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
    assert.ok(inv.getStats().subscribers >= 1, 'expected default-ON subscriber');
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
