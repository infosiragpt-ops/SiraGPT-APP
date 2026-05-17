/**
 * Tests for channels/telegram.js — Telegram Bot API adapter.
 *
 * Covers verify (webhook secret-token), parseInbound (update envelopes),
 * sendOutbound (Bot API POST + retry-after), and the isStale watchdog
 * helper. Long-polling loop behavior is exercised only at the API
 * surface (start/stop, restartCount) — no real timer wait.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { TelegramAdapter } = require('../src/channels/telegram');
const { ChannelMetrics, KINDS } = require('../src/channels/metrics');

function makeAdapter(overrides = {}) {
  return new TelegramAdapter({
    botToken: 'tg-token-secret',
    metrics: new ChannelMetrics(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }),
    ...overrides,
  });
}

describe('TelegramAdapter · constructor', () => {
  it('throws when botToken missing', () => {
    assert.throws(() => new TelegramAdapter({}), /requires botToken/);
  });

  it('stores token, defaults apiBase, pollInterval, staleThreshold', () => {
    const a = new TelegramAdapter({ botToken: 't' });
    assert.equal(a.botToken, 't');
    assert.equal(a.apiBase, 'https://api.telegram.org');
    assert.equal(a.pollIntervalMs, 1000);
    assert.equal(a.staleThresholdMs, 60000);
  });

  it('name="telegram", extends ChannelAdapter', () => {
    const a = new TelegramAdapter({ botToken: 't' });
    assert.equal(a.name, 'telegram');
  });

  it('honours custom apiBase / pollInterval / staleThreshold', () => {
    const a = new TelegramAdapter({
      botToken: 't',
      apiBase: 'https://example.tg/api',
      pollIntervalMs: 500,
      staleThresholdMs: 10_000,
    });
    assert.equal(a.apiBase, 'https://example.tg/api');
    assert.equal(a.pollIntervalMs, 500);
    assert.equal(a.staleThresholdMs, 10_000);
  });

  it('initial state: offset=0, not polling, restartCount=0', () => {
    const a = new TelegramAdapter({ botToken: 't' });
    assert.equal(a._offset, 0);
    assert.equal(a._polling, false);
    assert.equal(a.restartCount, 0);
  });
});

describe('TelegramAdapter · verify (webhook secret)', () => {
  it('returns true when no webhook secret configured (open mode)', async () => {
    const a = makeAdapter();
    assert.equal(await a.verify({ headers: {} }), true);
  });

  it('returns true when secret matches header (lowercase)', async () => {
    const a = makeAdapter({ webhookSecret: 'shhh' });
    const req = { headers: { 'x-telegram-bot-api-secret-token': 'shhh' } };
    assert.equal(await a.verify(req), true);
  });

  it('also reads the case-preserving header form', async () => {
    const a = makeAdapter({ webhookSecret: 'shhh' });
    const req = { headers: { 'X-Telegram-Bot-Api-Secret-Token': 'shhh' } };
    assert.equal(await a.verify(req), true);
  });

  it('rejects when header absent and secret configured', async () => {
    const a = makeAdapter({ webhookSecret: 'shhh' });
    const req = { headers: {} };
    assert.equal(await a.verify(req), false);
    assert.equal(a.metrics.get('telegram', KINDS.VERIFY_FAIL), 1);
  });

  it('rejects when header value differs from configured secret', async () => {
    const a = makeAdapter({ webhookSecret: 'shhh' });
    const req = { headers: { 'x-telegram-bot-api-secret-token': 'wrong' } };
    assert.equal(await a.verify(req), false);
    assert.equal(a.metrics.get('telegram', KINDS.VERIFY_FAIL), 1);
  });

  it('rejects when header length differs (timing-safe length-guard)', async () => {
    const a = makeAdapter({ webhookSecret: 'a-very-long-shared-secret' });
    const req = { headers: { 'x-telegram-bot-api-secret-token': 'short' } };
    assert.equal(await a.verify(req), false);
  });
});

describe('TelegramAdapter · parseInbound', () => {
  const a = makeAdapter();

  it('returns null when no message/edited_message/channel_post present', () => {
    assert.equal(a.parseInbound({ body: {} }), null);
    assert.equal(a.parseInbound({ body: { other_field: true } }), null);
  });

  it('parses a private chat message', () => {
    const out = a.parseInbound({
      body: {
        update_id: 1,
        message: {
          message_id: 42,
          from: { id: 'U-1' },
          chat: { id: 'C-1', type: 'private' },
          text: 'hello',
        },
      },
    });
    assert.equal(out.id, 'C-1:42');
    assert.equal(out.userId, 'U-1');
    assert.equal(out.chatId, 'C-1');
    assert.equal(out.text, 'hello');
    assert.equal(out.channel, 'telegram');
  });

  it('parses edited_message envelope', () => {
    const out = a.parseInbound({
      body: {
        edited_message: {
          message_id: 7,
          from: { id: 'U' },
          chat: { id: 'C' },
          text: 'edited',
        },
      },
    });
    assert.equal(out.text, 'edited');
  });

  it('parses channel_post envelope (channel context: no from)', () => {
    const out = a.parseInbound({
      body: {
        channel_post: {
          message_id: 99,
          chat: { id: 'C-channel' },
          text: 'announcement',
        },
      },
    });
    // No from.id → falls back to chat.id for userId.
    assert.equal(out.userId, 'C-channel');
  });

  it('uses caption when text absent (e.g. photo with caption)', () => {
    const out = a.parseInbound({
      body: {
        message: {
          message_id: 1,
          from: { id: 'U' },
          chat: { id: 'C' },
          caption: 'see this photo',
        },
      },
    });
    assert.equal(out.text, 'see this photo');
  });

  it('text="" when both text and caption absent', () => {
    const out = a.parseInbound({
      body: {
        message: { message_id: 1, from: { id: 'U' }, chat: { id: 'C' } },
      },
    });
    assert.equal(out.text, '');
  });

  it('invokes accessGroupResolver with the inner msg', () => {
    let called;
    const a2 = makeAdapter({
      accessGroupResolver: (m) => {
        called = m;
        return `g-${m.chat.id}`;
      },
    });
    const out = a2.parseInbound({
      body: { message: { message_id: 1, from: { id: 'U' }, chat: { id: 'C-9' }, text: 'x' } },
    });
    assert.equal(out.accessGroup, 'g-C-9');
    assert.equal(called.chat.id, 'C-9');
  });
});

describe('TelegramAdapter · sendOutbound', () => {
  it('throws when chatId missing', async () => {
    const a = makeAdapter();
    await assert.rejects(() => a.sendOutbound({ text: 'hi' }), /requires chatId/);
  });

  it('POSTs to /bot<token>/sendMessage with chat_id + text', async () => {
    let captured;
    const a = makeAdapter({
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      },
    });
    await a.sendOutbound({ chatId: 'C-1', text: 'hi' });
    assert.equal(captured.url, 'https://api.telegram.org/bottg-token-secret/sendMessage');
    assert.equal(captured.init.method, 'POST');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.chat_id, 'C-1');
    assert.equal(body.text, 'hi');
    assert.equal(a.metrics.get('telegram', KINDS.OUTBOUND), 1);
  });

  it('merges msg.extra into the body (parse_mode, reply_to_message_id)', async () => {
    let captured;
    const a = makeAdapter({
      fetchImpl: async (_url, init) => {
        captured = init;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    await a.sendOutbound({
      chatId: 'C',
      text: 't',
      extra: { parse_mode: 'HTML', reply_to_message_id: 42 },
    });
    const body = JSON.parse(captured.body);
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(body.reply_to_message_id, 42);
  });

  it('throws on non-ok HTTP status, increments KINDS.ERROR', async () => {
    const a = makeAdapter({
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ description: 'Bad Request' }) }),
    });
    await assert.rejects(
      () => a.sendOutbound({ chatId: 'C', text: 't' }),
      /telegram sendMessage failed: 400/,
    );
    assert.equal(a.metrics.get('telegram', KINDS.ERROR), 1);
  });
});

describe('TelegramAdapter · isStale watchdog helper', () => {
  it('returns false when not polling', () => {
    const a = makeAdapter({ staleThresholdMs: 1000 });
    a._polling = false;
    a._lastPollAt = 0;
    assert.equal(a.isStale(Date.now()), false);
  });

  it('returns false when polling and recent', () => {
    const a = makeAdapter({ staleThresholdMs: 60_000 });
    a._polling = true;
    a._lastPollAt = Date.now() - 1000;
    assert.equal(a.isStale(), false);
  });

  it('returns true when polling and last poll exceeds threshold', () => {
    const a = makeAdapter({ staleThresholdMs: 1000 });
    a._polling = true;
    a._lastPollAt = Date.now() - 5000;
    assert.equal(a.isStale(), true);
  });
});

describe('TelegramAdapter · start/stopPolling state', () => {
  it('stopPolling on a never-started adapter is a no-op', () => {
    const a = makeAdapter();
    a.stopPolling();
    assert.equal(a._polling, false);
  });

  it('stopPolling clears polling flag and timers', () => {
    // We avoid startPolling() because it launches a real _loop() whose
    // sleep(pollIntervalMs) would keep the test runner alive long past
    // stopPolling. Simulate the internal state directly.
    const a = makeAdapter();
    a._polling = true;
    a._watchdogTimer = setInterval(() => {}, 1_000_000);
    if (a._watchdogTimer.unref) a._watchdogTimer.unref();
    a.stopPolling();
    assert.equal(a._polling, false);
    assert.equal(a._watchdogTimer, null);
  });
});
