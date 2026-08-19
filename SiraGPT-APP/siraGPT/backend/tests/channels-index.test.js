/**
 * Tests for channels/index.js — ChannelRegistry + barrel exports.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const channels = require('../src/channels');
const {
  ChannelAdapter,
  ChannelRegistry,
  DedupCache,
  ChannelMetrics,
  TelegramAdapter,
  DiscordAdapter,
  SlackAdapter,
  WhatsAppAdapter,
  sharedMetrics,
  KINDS,
} = channels;

describe('channels/index.js · barrel exports', () => {
  it('re-exports ChannelAdapter', () => {
    assert.equal(typeof ChannelAdapter, 'function');
    assert.equal(ChannelAdapter.name, 'ChannelAdapter');
  });

  it('re-exports the four adapter classes', () => {
    assert.equal(typeof TelegramAdapter, 'function');
    assert.equal(typeof DiscordAdapter, 'function');
    assert.equal(typeof SlackAdapter, 'function');
    assert.equal(typeof WhatsAppAdapter, 'function');
  });

  it('every adapter class extends ChannelAdapter', () => {
    // Construction may need params, so use prototype chain check.
    assert.ok(TelegramAdapter.prototype instanceof ChannelAdapter);
    assert.ok(DiscordAdapter.prototype instanceof ChannelAdapter);
    assert.ok(SlackAdapter.prototype instanceof ChannelAdapter);
    assert.ok(WhatsAppAdapter.prototype instanceof ChannelAdapter);
  });

  it('re-exports DedupCache + ChannelMetrics', () => {
    assert.equal(typeof DedupCache, 'function');
    assert.equal(typeof ChannelMetrics, 'function');
  });

  it('re-exports sharedMetrics + KINDS', () => {
    assert.ok(sharedMetrics instanceof ChannelMetrics);
    assert.equal(typeof KINDS, 'object');
  });
});

describe('ChannelRegistry', () => {
  // Minimal concrete adapter for tests (overrides the abstract hooks).
  class FakeAdapter extends ChannelAdapter {
    constructor(name) { super(name); }
    async verify() { return true; }
    async parseInbound() { return null; }
    async sendOutbound() { return {}; }
  }

  it('starts empty', () => {
    const r = new ChannelRegistry();
    assert.deepEqual(r.list(), []);
    assert.equal(r.has('slack'), false);
    assert.equal(r.get('slack'), undefined);
  });

  it('register() throws when given a non-ChannelAdapter', () => {
    const r = new ChannelRegistry();
    assert.throws(() => r.register({}), /expects a ChannelAdapter/);
    assert.throws(() => r.register(null), /expects a ChannelAdapter/);
    assert.throws(() => r.register('slack'), /expects a ChannelAdapter/);
  });

  it('register() stores and returns the adapter', () => {
    const r = new ChannelRegistry();
    const a = new FakeAdapter('slack');
    const ret = r.register(a);
    assert.strictEqual(ret, a, 'register returns the adapter for chaining');
    assert.equal(r.has('slack'), true);
    assert.strictEqual(r.get('slack'), a);
  });

  it('list() returns all registered adapters', () => {
    const r = new ChannelRegistry();
    const a = new FakeAdapter('slack');
    const b = new FakeAdapter('discord');
    r.register(a);
    r.register(b);
    const all = r.list();
    assert.equal(all.length, 2);
    assert.ok(all.includes(a));
    assert.ok(all.includes(b));
  });

  it('register() with same name replaces the prior entry (last-wins)', () => {
    const r = new ChannelRegistry();
    const a1 = new FakeAdapter('slack');
    const a2 = new FakeAdapter('slack');
    r.register(a1);
    r.register(a2);
    assert.strictEqual(r.get('slack'), a2, 'second register call wins');
    assert.equal(r.list().length, 1, 'no duplicate entries');
  });

  it('get() returns undefined for an unregistered name', () => {
    const r = new ChannelRegistry();
    r.register(new FakeAdapter('slack'));
    assert.equal(r.get('telegram'), undefined);
  });

  it('list() returns a fresh array each call (caller may mutate)', () => {
    const r = new ChannelRegistry();
    r.register(new FakeAdapter('slack'));
    const a = r.list();
    const b = r.list();
    assert.notStrictEqual(a, b, 'expected distinct array instances');
    a.length = 0;
    assert.equal(r.list().length, 1, 'caller mutation must not affect registry');
  });
});
