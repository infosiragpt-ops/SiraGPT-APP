/**
 * Tests for cache/wireup.js — gates reliability-foundation integrations
 * behind the SIRA_RELIABILITY_WIRINGS env flag with a once-guard.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  isReliabilityWiringsEnabled,
  wireSubscribeIfEnabled,
  getWiredHoldersCount,
  resetWiringStateForTests,
} = require('../src/cache/wireup');

beforeEach(() => {
  resetWiringStateForTests();
});

// ── isReliabilityWiringsEnabled ────────────────────────────────

describe('isReliabilityWiringsEnabled · default-on posture', () => {
  it('returns true when env var is unset', () => {
    assert.equal(isReliabilityWiringsEnabled({}), true);
  });

  it('returns true when env var is empty string', () => {
    assert.equal(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: '' }), true);
  });

  it('returns true for any non-kill-switch value', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'enabled', 'arbitrary']) {
      assert.equal(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), true);
    }
  });
});

describe('isReliabilityWiringsEnabled · kill-switch values', () => {
  it('returns false for "0"', () => {
    assert.equal(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: '0' }), false);
  });

  it('returns false for "false" / "no" / "off" / "disabled"', () => {
    for (const v of ['false', 'no', 'off', 'disabled']) {
      assert.equal(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), false);
    }
  });

  it('case-insensitive kill switch (FALSE, OFF, Disabled)', () => {
    for (const v of ['FALSE', 'OFF', 'Disabled', 'No']) {
      assert.equal(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: v }), false);
    }
  });

  it('whitespace around kill-switch value still flips off', () => {
    assert.equal(isReliabilityWiringsEnabled({ SIRA_RELIABILITY_WIRINGS: '  off  ' }), false);
  });

  it('defaults to process.env when no env arg passed', () => {
    const prev = process.env.SIRA_RELIABILITY_WIRINGS;
    delete process.env.SIRA_RELIABILITY_WIRINGS;
    try {
      assert.equal(isReliabilityWiringsEnabled(), true);
    } finally {
      if (prev !== undefined) process.env.SIRA_RELIABILITY_WIRINGS = prev;
    }
  });
});

// ── wireSubscribeIfEnabled · input guards ─────────────────────

describe('wireSubscribeIfEnabled · input guards', () => {
  function validArgs(overrides = {}) {
    return {
      name: 'cache.x',
      patterns: ['x:*'],
      handler: () => {},
      holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => 'handle-1' }),
      ...overrides,
    };
  }

  it('returns null when reliability wirings are disabled', () => {
    const out = wireSubscribeIfEnabled(validArgs({
      env: { SIRA_RELIABILITY_WIRINGS: 'off' },
    }));
    assert.equal(out, null);
  });

  it('returns null when handler is missing or non-function', () => {
    assert.equal(wireSubscribeIfEnabled(validArgs({ handler: null })), null);
    assert.equal(wireSubscribeIfEnabled(validArgs({ handler: 'not-fn' })), null);
  });

  it('returns null when patterns is missing / empty / non-array', () => {
    assert.equal(wireSubscribeIfEnabled(validArgs({ patterns: undefined })), null);
    assert.equal(wireSubscribeIfEnabled(validArgs({ patterns: [] })), null);
    assert.equal(wireSubscribeIfEnabled(validArgs({ patterns: 'not-array' })), null);
  });

  it('returns null when name is missing / empty / non-string', () => {
    assert.equal(wireSubscribeIfEnabled(validArgs({ name: '' })), null);
    assert.equal(wireSubscribeIfEnabled(validArgs({ name: undefined })), null);
    assert.equal(wireSubscribeIfEnabled(validArgs({ name: 123 })), null);
  });

  it('returns null when same holder is already wired (once-guard)', () => {
    const holder = {};
    const first = wireSubscribeIfEnabled(validArgs({ holder }));
    assert.equal(first, 'handle-1');
    const second = wireSubscribeIfEnabled(validArgs({ holder }));
    assert.equal(second, null);
  });

  it('allows different holders to wire independently', () => {
    const h1 = {}, h2 = {};
    assert.equal(wireSubscribeIfEnabled(validArgs({ holder: h1 })), 'handle-1');
    assert.equal(wireSubscribeIfEnabled(validArgs({ holder: h2 })), 'handle-1');
  });

  it('null holder skips the once-guard (each call wires)', () => {
    assert.equal(wireSubscribeIfEnabled(validArgs({ holder: null })), 'handle-1');
    assert.equal(wireSubscribeIfEnabled(validArgs({ holder: null })), 'handle-1');
  });
});

// ── wireSubscribeIfEnabled · failure handling ─────────────────

describe('wireSubscribeIfEnabled · failure handling', () => {
  it('returns null when getInvalidator throws', () => {
    const out = wireSubscribeIfEnabled({
      name: 'cache.x',
      patterns: ['x'],
      handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => { throw new Error('boom'); },
    });
    assert.equal(out, null);
  });

  it('returns null when invalidator is not an object', () => {
    const out = wireSubscribeIfEnabled({
      name: 'cache.x',
      patterns: ['x'],
      handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => null,
    });
    assert.equal(out, null);
  });

  it('returns null when invalidator lacks .subscribe', () => {
    const out = wireSubscribeIfEnabled({
      name: 'cache.x',
      patterns: ['x'],
      handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ /* no subscribe */ }),
    });
    assert.equal(out, null);
  });

  it('returns null when subscribe throws', () => {
    const out = wireSubscribeIfEnabled({
      name: 'cache.x',
      patterns: ['x'],
      handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => { throw new Error('sub fail'); } }),
    });
    assert.equal(out, null);
  });

  it('holder NOT marked wired when subscribe fails (failure is non-fatal but does not advance state)', () => {
    const holder = {};
    wireSubscribeIfEnabled({
      name: 'cache.x',
      patterns: ['x'],
      handler: () => {},
      holder,
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => { throw new Error('sub fail'); } }),
    });
    // A retry with a working subscriber should succeed.
    const retry = wireSubscribeIfEnabled({
      name: 'cache.x',
      patterns: ['x'],
      handler: () => {},
      holder,
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => 'handle-2' }),
    });
    assert.equal(retry, 'handle-2');
  });
});

// ── wireSubscribeIfEnabled · forwarding ───────────────────────

describe('wireSubscribeIfEnabled · forwarding', () => {
  it('passes name, patterns, handler to invalidator.subscribe', () => {
    let captured;
    const handler = () => {};
    wireSubscribeIfEnabled({
      name: 'cache.foo',
      patterns: ['foo:*', 'bar:*'],
      handler,
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: (args) => { captured = args; return 'h'; } }),
    });
    assert.equal(captured.name, 'cache.foo');
    assert.deepEqual(captured.patterns, ['foo:*', 'bar:*']);
    assert.strictEqual(captured.handler, handler);
  });

  it('returns whatever subscribe returned (handle passthrough)', () => {
    const out = wireSubscribeIfEnabled({
      name: 'cache.x',
      patterns: ['x'],
      handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => ({ id: 'h-42', close: () => {} }) }),
    });
    assert.deepEqual(out, { id: 'h-42', close: out.close });
  });
});

// ── getWiredHoldersCount + resetWiringStateForTests ────────────

describe('getWiredHoldersCount + resetWiringStateForTests', () => {
  it('starts at 0', () => {
    assert.equal(getWiredHoldersCount(), 0);
  });

  it('increments on each successful wire', () => {
    wireSubscribeIfEnabled({
      name: 'a', patterns: ['x'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => 'h' }),
    });
    wireSubscribeIfEnabled({
      name: 'b', patterns: ['y'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => 'h' }),
    });
    assert.equal(getWiredHoldersCount(), 2);
  });

  it('does NOT increment when wiring is disabled', () => {
    wireSubscribeIfEnabled({
      name: 'a', patterns: ['x'], handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: 'off' },
      getInvalidator: () => ({ subscribe: () => 'h' }),
    });
    assert.equal(getWiredHoldersCount(), 0);
  });

  it('does NOT increment when subscribe throws (state stays consistent)', () => {
    wireSubscribeIfEnabled({
      name: 'a', patterns: ['x'], handler: () => {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => { throw new Error('x'); } }),
    });
    assert.equal(getWiredHoldersCount(), 0);
  });

  it('resetWiringStateForTests clears the count + WeakSet', () => {
    wireSubscribeIfEnabled({
      name: 'a', patterns: ['x'], handler: () => {}, holder: {},
      env: { SIRA_RELIABILITY_WIRINGS: '1' },
      getInvalidator: () => ({ subscribe: () => 'h' }),
    });
    assert.equal(getWiredHoldersCount(), 1);
    resetWiringStateForTests();
    assert.equal(getWiredHoldersCount(), 0);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/cache/wireup');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'getWiredHoldersCount', 'isReliabilityWiringsEnabled',
      'resetWiringStateForTests', 'wireSubscribeIfEnabled',
    ]);
  });
});
