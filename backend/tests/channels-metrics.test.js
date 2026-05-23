/**
 * Tests for channels/metrics.js — per-channel counter registry.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { ChannelMetrics, KINDS, sharedMetrics } = require('../src/channels/metrics');

describe('ChannelMetrics · inc + get', () => {
  it('starts at 0 for every key', () => {
    const m = new ChannelMetrics();
    assert.equal(m.get('slack', KINDS.INBOUND), 0);
    assert.equal(m.get('discord', KINDS.ERROR), 0);
  });

  it('increments by 1 by default', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND);
    m.inc('slack', KINDS.INBOUND);
    assert.equal(m.get('slack', KINDS.INBOUND), 2);
  });

  it('increments by N when supplied', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.OUTBOUND, 5);
    m.inc('slack', KINDS.OUTBOUND, 3);
    assert.equal(m.get('slack', KINDS.OUTBOUND), 8);
  });

  it('namespaces by channel — different channels do not collide', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND);
    m.inc('discord', KINDS.INBOUND);
    assert.equal(m.get('slack', KINDS.INBOUND), 1);
    assert.equal(m.get('discord', KINDS.INBOUND), 1);
  });

  it('namespaces by kind — different kinds on same channel do not collide', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND);
    m.inc('slack', KINDS.ERROR);
    assert.equal(m.get('slack', KINDS.INBOUND), 1);
    assert.equal(m.get('slack', KINDS.ERROR), 1);
  });

  it('handles negative increments (decrement)', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND, 5);
    m.inc('slack', KINDS.INBOUND, -2);
    assert.equal(m.get('slack', KINDS.INBOUND), 3);
  });
});

describe('ChannelMetrics · snapshot()', () => {
  it('returns an empty object for an empty registry', () => {
    const m = new ChannelMetrics();
    assert.deepEqual(m.snapshot(), {});
  });

  it('groups counters by channel', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND, 3);
    m.inc('slack', KINDS.OUTBOUND, 7);
    m.inc('discord', KINDS.INBOUND, 2);
    const snap = m.snapshot();
    assert.deepEqual(snap, {
      slack: { inbound: 3, outbound: 7 },
      discord: { inbound: 2 },
    });
  });

  it('snapshot is a copy — does not share mutable state with the registry', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND, 1);
    const snap = m.snapshot();
    snap.slack.inbound = 999;
    assert.equal(m.get('slack', KINDS.INBOUND), 1, 'snapshot mutation must not affect the registry');
  });
});

describe('ChannelMetrics · reset()', () => {
  it('clears every counter', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND);
    m.inc('discord', KINDS.ERROR, 5);
    m.reset();
    assert.equal(m.get('slack', KINDS.INBOUND), 0);
    assert.equal(m.get('discord', KINDS.ERROR), 0);
    assert.deepEqual(m.snapshot(), {});
  });
});

describe('KINDS enum', () => {
  it('exposes exactly the documented kind set', () => {
    assert.deepEqual({ ...KINDS }, {
      INBOUND: 'inbound',
      OUTBOUND: 'outbound',
      DUPLICATE: 'duplicate',
      VERIFY_FAIL: 'verify_fail',
      ERROR: 'error',
      WATCHDOG_RESTART: 'watchdog_restart',
    });
  });

  it('is frozen to prevent runtime mutation', () => {
    assert.throws(() => { KINDS.NEW_KIND = 'x'; }, TypeError);
  });
});

describe('sharedMetrics singleton', () => {
  it('is a ChannelMetrics instance', () => {
    assert.ok(sharedMetrics instanceof ChannelMetrics);
  });

  it('reset clears whatever the test session has accumulated', () => {
    sharedMetrics.inc('test-channel', KINDS.INBOUND, 42);
    assert.equal(sharedMetrics.get('test-channel', KINDS.INBOUND), 42);
    sharedMetrics.reset();
    assert.equal(sharedMetrics.get('test-channel', KINDS.INBOUND), 0);
  });
});
