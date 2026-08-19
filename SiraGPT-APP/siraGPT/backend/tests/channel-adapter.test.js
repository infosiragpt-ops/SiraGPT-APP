/**
 * Tests for channels/channel-adapter.js — base class shared by
 * Slack/Discord/Telegram/WhatsApp adapters.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { ChannelAdapter } = require('../src/channels/channel-adapter');
const { ChannelMetrics, KINDS } = require('../src/channels/metrics');
const { DedupCache } = require('../src/channels/dedup-cache');

describe('ChannelAdapter · constructor', () => {
  it('requires a name', () => {
    assert.throws(() => new ChannelAdapter(''), /requires a name/);
    assert.throws(() => new ChannelAdapter(undefined), /requires a name/);
    assert.throws(() => new ChannelAdapter(null), /requires a name/);
  });

  it('stores name on the instance', () => {
    const a = new ChannelAdapter('slack');
    assert.equal(a.name, 'slack');
  });

  it('defaults dedup to a fresh DedupCache', () => {
    const a = new ChannelAdapter('slack');
    assert.ok(a.dedup instanceof DedupCache);
  });

  it('accepts a custom dedup cache', () => {
    const customDedup = new DedupCache({ ttlMs: 10 });
    const a = new ChannelAdapter('slack', { dedup: customDedup });
    assert.strictEqual(a.dedup, customDedup);
  });

  it('defaults metrics to sharedMetrics singleton', () => {
    const { sharedMetrics } = require('../src/channels/metrics');
    const a = new ChannelAdapter('slack');
    assert.strictEqual(a.metrics, sharedMetrics);
  });

  it('accepts a custom metrics registry', () => {
    const m = new ChannelMetrics();
    const a = new ChannelAdapter('slack', { metrics: m });
    assert.strictEqual(a.metrics, m);
  });

  it('defaults fetchImpl to globalThis.fetch', () => {
    const a = new ChannelAdapter('slack');
    assert.strictEqual(a.fetchImpl, globalThis.fetch);
  });

  it('accepts a custom fetch impl', () => {
    const myFetch = () => Promise.resolve();
    const a = new ChannelAdapter('slack', { fetchImpl: myFetch });
    assert.strictEqual(a.fetchImpl, myFetch);
  });

  it('builds an allowlist Set from the option array', () => {
    const a = new ChannelAdapter('slack', { allowlist: ['team-a', 'team-b'] });
    assert.ok(a.allowlist instanceof Set);
    assert.equal(a.allowlist.size, 2);
  });

  it('default allowlist is empty', () => {
    const a = new ChannelAdapter('slack');
    assert.equal(a.allowlist.size, 0);
  });
});

describe('ChannelAdapter · isAllowed', () => {
  it('allows everyone when allowlist is empty', () => {
    const a = new ChannelAdapter('slack');
    assert.equal(a.isAllowed(undefined), true);
    assert.equal(a.isAllowed(''), true);
    assert.equal(a.isAllowed('anyone'), true);
  });

  it('rejects missing accessGroup when allowlist is non-empty', () => {
    const a = new ChannelAdapter('slack', { allowlist: ['team-a'] });
    assert.equal(a.isAllowed(undefined), false);
    assert.equal(a.isAllowed(''), false);
    assert.equal(a.isAllowed(null), false);
  });

  it('allows accessGroup that matches the allowlist', () => {
    const a = new ChannelAdapter('slack', { allowlist: ['team-a', 'team-b'] });
    assert.equal(a.isAllowed('team-a'), true);
    assert.equal(a.isAllowed('team-b'), true);
  });

  it('rejects accessGroup not in the allowlist (closed by default)', () => {
    const a = new ChannelAdapter('slack', { allowlist: ['team-a'] });
    assert.equal(a.isAllowed('team-c'), false);
  });

  it('matching is exact (case-sensitive)', () => {
    const a = new ChannelAdapter('slack', { allowlist: ['Team-A'] });
    assert.equal(a.isAllowed('team-a'), false);
    assert.equal(a.isAllowed('Team-A'), true);
  });
});

describe('ChannelAdapter · isDuplicate', () => {
  it('returns false when parsed is null/undefined', () => {
    const a = new ChannelAdapter('slack');
    assert.equal(a.isDuplicate(null), false);
    assert.equal(a.isDuplicate(undefined), false);
  });

  it('returns false when parsed has no id', () => {
    const a = new ChannelAdapter('slack');
    assert.equal(a.isDuplicate({}), false);
    assert.equal(a.isDuplicate({ id: '' }), false);
  });

  it('returns false for first occurrence of a new id', () => {
    const a = new ChannelAdapter('slack');
    assert.equal(a.isDuplicate({ id: 'm-1' }), false);
  });

  it('returns true for second occurrence of the same id', () => {
    const a = new ChannelAdapter('slack');
    a.isDuplicate({ id: 'm-1' });
    assert.equal(a.isDuplicate({ id: 'm-1' }), true);
  });

  it('namespaces dedup by channel name (no cross-channel collision)', () => {
    const dedup = new DedupCache();
    const slack = new ChannelAdapter('slack', { dedup });
    const discord = new ChannelAdapter('discord', { dedup });
    // Same shared dedup cache; same id from each channel must NOT collide.
    assert.equal(slack.isDuplicate({ id: 'm-1' }), false);
    assert.equal(discord.isDuplicate({ id: 'm-1' }), false);
    assert.equal(slack.isDuplicate({ id: 'm-1' }), true);
    assert.equal(discord.isDuplicate({ id: 'm-1' }), true);
  });

  it('bumps the duplicate counter on each dup hit', () => {
    const m = new ChannelMetrics();
    const a = new ChannelAdapter('slack', { metrics: m });
    a.isDuplicate({ id: 'm-1' });  // first → not dup, no inc
    a.isDuplicate({ id: 'm-1' });  // dup
    a.isDuplicate({ id: 'm-1' });  // dup
    assert.equal(m.get('slack', KINDS.DUPLICATE), 2);
  });

  it('does NOT bump duplicate counter on fresh ids', () => {
    const m = new ChannelMetrics();
    const a = new ChannelAdapter('slack', { metrics: m });
    a.isDuplicate({ id: 'm-1' });
    a.isDuplicate({ id: 'm-2' });
    assert.equal(m.get('slack', KINDS.DUPLICATE), 0);
  });
});

describe('ChannelAdapter · hook abstractness', () => {
  it('verify() throws if not overridden', async () => {
    const a = new ChannelAdapter('slack');
    await assert.rejects(() => a.verify({}), /verify\(\) not implemented for slack/);
  });

  it('parseInbound() throws if not overridden', async () => {
    const a = new ChannelAdapter('discord');
    await assert.rejects(
      () => a.parseInbound({}),
      /parseInbound\(\) not implemented for discord/,
    );
  });

  it('sendOutbound() throws if not overridden', async () => {
    const a = new ChannelAdapter('telegram');
    await assert.rejects(
      () => a.sendOutbound({ text: 'hi' }),
      /sendOutbound\(\) not implemented for telegram/,
    );
  });
});
