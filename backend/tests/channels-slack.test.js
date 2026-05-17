/**
 * Tests for channels/slack.js — Slack Events API adapter.
 *
 * Focus areas:
 *   1. constructor invariants (signingSecret required)
 *   2. verify() — HMAC + timestamp window
 *   3. parseInbound() — URL verification handshake AND event envelopes
 *   4. sendOutbound() — fetch wiring + error path + retry-after
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

const { SlackAdapter } = require('../src/channels/slack');
const { ChannelMetrics, KINDS } = require('../src/channels/metrics');

const SIGNING_SECRET = 'unit-test-signing-secret';

function makeAdapter(overrides = {}) {
  return new SlackAdapter({
    signingSecret: SIGNING_SECRET,
    botToken: 'xoxb-test-bot-token',
    metrics: new ChannelMetrics(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), headers: { get: () => null } }),
    ...overrides,
  });
}

function signRequest(body, ts = Math.floor(Date.now() / 1000)) {
  const base = `v0:${ts}:${body}`;
  const sig = `v0=${crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')}`;
  return { sig, ts };
}

describe('SlackAdapter · constructor', () => {
  it('throws if signingSecret missing', () => {
    assert.throws(() => new SlackAdapter({}), /requires signingSecret/);
  });

  it('stores signingSecret + botToken + apiBase', () => {
    const a = new SlackAdapter({
      signingSecret: 's',
      botToken: 'b',
      apiBase: 'https://custom.slack.example/api',
    });
    assert.equal(a.signingSecret, 's');
    assert.equal(a.botToken, 'b');
    assert.equal(a.apiBase, 'https://custom.slack.example/api');
  });

  it('default apiBase is https://slack.com/api', () => {
    const a = new SlackAdapter({ signingSecret: 's' });
    assert.equal(a.apiBase, 'https://slack.com/api');
  });

  it('default toleranceSec is 300', () => {
    const a = new SlackAdapter({ signingSecret: 's' });
    assert.equal(a.toleranceSec, 300);
  });

  it('honours custom toleranceSec including 0', () => {
    const a = new SlackAdapter({ signingSecret: 's', toleranceSec: 0 });
    assert.equal(a.toleranceSec, 0);
  });

  it('extends ChannelAdapter with name="slack"', () => {
    const a = new SlackAdapter({ signingSecret: 's' });
    assert.equal(a.name, 'slack');
  });
});

describe('SlackAdapter · verify', () => {
  it('returns false when signature header is missing', () => {
    const a = makeAdapter();
    const req = { headers: { 'x-slack-request-timestamp': '1234567890' }, body: {} };
    assert.equal(a.verify(req), false);
    assert.equal(a.metrics.get('slack', KINDS.VERIFY_FAIL), 1);
  });

  it('returns false when timestamp header is missing', () => {
    const a = makeAdapter();
    const req = { headers: { 'x-slack-signature': 'v0=deadbeef' }, body: {} };
    assert.equal(a.verify(req), false);
  });

  it('returns false when timestamp is older than tolerance', () => {
    const a = makeAdapter({ toleranceSec: 60 });
    const oldTs = Math.floor(Date.now() / 1000) - 3600; // 1h old
    const body = JSON.stringify({ type: 'event_callback' });
    const { sig } = signRequest(body, oldTs);
    const req = {
      headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(oldTs) },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
  });

  it('returns false when timestamp is too far in the future', () => {
    const a = makeAdapter({ toleranceSec: 60 });
    const futureTs = Math.floor(Date.now() / 1000) + 3600;
    const body = JSON.stringify({ type: 'event_callback' });
    const { sig } = signRequest(body, futureTs);
    const req = {
      headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(futureTs) },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
  });

  it('returns false on non-numeric timestamp', () => {
    const a = makeAdapter();
    const req = {
      headers: { 'x-slack-signature': 'v0=abc', 'x-slack-request-timestamp': 'not-a-number' },
      body: {},
    };
    assert.equal(a.verify(req), false);
  });

  it('returns true for a freshly-signed request with rawBody', () => {
    const a = makeAdapter();
    const body = JSON.stringify({ type: 'event_callback', event_id: 'EvX' });
    const { sig, ts } = signRequest(body);
    const req = {
      headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) },
      rawBody: body,
    };
    assert.equal(a.verify(req), true);
    assert.equal(a.metrics.get('slack', KINDS.VERIFY_FAIL), 0);
  });

  it('falls back to JSON.stringify(req.body) when rawBody is absent', () => {
    const a = makeAdapter();
    const bodyObj = { type: 'event_callback', event_id: 'EvX' };
    const body = JSON.stringify(bodyObj);
    const { sig, ts } = signRequest(body);
    const req = {
      headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) },
      body: bodyObj,
    };
    assert.equal(a.verify(req), true);
  });

  it('rawBody can be a Buffer', () => {
    const a = makeAdapter();
    const body = JSON.stringify({ type: 'event_callback' });
    const { sig, ts } = signRequest(body);
    const req = {
      headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) },
      rawBody: Buffer.from(body, 'utf8'),
    };
    assert.equal(a.verify(req), true);
  });

  it('rejects a tampered signature (same length, wrong bytes)', () => {
    const a = makeAdapter();
    const body = JSON.stringify({});
    const { sig, ts } = signRequest(body);
    // Flip the last hex char.
    const tampered = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
    const req = {
      headers: { 'x-slack-signature': tampered, 'x-slack-request-timestamp': String(ts) },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
    assert.equal(a.metrics.get('slack', KINDS.VERIFY_FAIL), 1);
  });

  it('rejects when signature length differs (timing-safe length-guard)', () => {
    const a = makeAdapter();
    const body = JSON.stringify({});
    const { ts } = signRequest(body);
    const req = {
      headers: { 'x-slack-signature': 'v0=short', 'x-slack-request-timestamp': String(ts) },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
  });
});

describe('SlackAdapter · parseInbound', () => {
  const a = makeAdapter();

  it('returns a challenge envelope for type=url_verification', () => {
    const out = a.parseInbound({
      body: { type: 'url_verification', challenge: 'CHALLENGE_ABC' },
    });
    assert.equal(out.id, 'challenge:CHALLENGE_ABC');
    assert.equal(out.channel, 'slack');
    assert.deepEqual(out.raw, { type: 'url_verification', challenge: 'CHALLENGE_ABC' });
  });

  it('parses event envelope with event_id (preferred) for the id', () => {
    const out = a.parseInbound({
      body: {
        event_id: 'Ev01',
        event: { ts: '1234.5678', user: 'U1', channel: 'C1', text: 'hi' },
      },
    });
    assert.equal(out.id, 'Ev01');
    assert.equal(out.userId, 'U1');
    assert.equal(out.chatId, 'C1');
    assert.equal(out.text, 'hi');
  });

  it('falls back to "channel:ts" composite id when event_id absent', () => {
    const out = a.parseInbound({
      body: { event: { ts: '1.2', user: 'U', channel: 'C', text: '' } },
    });
    assert.equal(out.id, 'C:1.2');
  });

  it('returns null when neither event_id nor event.ts are present', () => {
    const out = a.parseInbound({ body: { event: {} } });
    assert.equal(out, null);
  });

  it('JSON-string body is parsed as JSON', () => {
    const out = a.parseInbound({
      body: JSON.stringify({
        event_id: 'Ev99',
        event: { ts: '1.2', user: 'U', channel: 'C', text: 'parsed' },
      }),
    });
    assert.equal(out.id, 'Ev99');
    assert.equal(out.text, 'parsed');
  });

  it('invokes accessGroupResolver and stores its result', () => {
    const a2 = makeAdapter({
      accessGroupResolver: (event) => `group-for-${event.channel}`,
    });
    const out = a2.parseInbound({
      body: { event_id: 'Ev1', event: { ts: '1.2', channel: 'C42' } },
    });
    assert.equal(out.accessGroup, 'group-for-C42');
  });

  it('omits accessGroup when no resolver supplied', () => {
    const out = a.parseInbound({
      body: { event_id: 'Ev1', event: { ts: '1.2', channel: 'C' } },
    });
    assert.equal(out.accessGroup, undefined);
  });
});

describe('SlackAdapter · sendOutbound', () => {
  it('throws when chatId missing', async () => {
    const a = makeAdapter();
    await assert.rejects(() => a.sendOutbound({ text: 'hi' }), /requires chatId/);
  });

  it('throws when botToken missing', async () => {
    const a = makeAdapter({ botToken: null });
    await assert.rejects(
      () => a.sendOutbound({ chatId: 'C1', text: 'hi' }),
      /requires botToken/,
    );
  });

  it('POSTs to chat.postMessage with bearer token + JSON body', async () => {
    let captured;
    const a = makeAdapter({
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: '1.2' }), headers: { get: () => null } };
      },
    });
    const out = await a.sendOutbound({ chatId: 'C1', text: 'hello' });
    assert.equal(captured.url, 'https://slack.com/api/chat.postMessage');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.authorization, 'Bearer xoxb-test-bot-token');
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body, { channel: 'C1', text: 'hello' });
    assert.deepEqual(out, { ok: true, ts: '1.2' });
    assert.equal(a.metrics.get('slack', KINDS.OUTBOUND), 1);
  });

  it('merges extra into the request body', async () => {
    let captured;
    const a = makeAdapter({
      fetchImpl: async (_url, init) => {
        captured = init;
        return { ok: true, status: 200, json: async () => ({ ok: true }), headers: { get: () => null } };
      },
    });
    await a.sendOutbound({ chatId: 'C', text: 't', extra: { thread_ts: '1.0', mrkdwn: false } });
    const body = JSON.parse(captured.body);
    assert.equal(body.thread_ts, '1.0');
    assert.equal(body.mrkdwn, false);
  });

  it('throws when slack response body.ok === false', async () => {
    const a = makeAdapter({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
        headers: { get: () => null },
      }),
    });
    await assert.rejects(
      () => a.sendOutbound({ chatId: 'C', text: 't' }),
      /channel_not_found/,
    );
    assert.equal(a.metrics.get('slack', KINDS.ERROR), 1);
  });

  it('throws on HTTP error status', async () => {
    const a = makeAdapter({
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        headers: { get: () => null },
      }),
    });
    await assert.rejects(
      () => a.sendOutbound({ chatId: 'C', text: 't' }),
      /slack postMessage failed: 500/,
    );
  });
});
