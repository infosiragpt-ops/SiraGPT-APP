'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it, beforeEach } = require('node:test');

const {
  ChannelAdapter,
  ChannelRegistry,
  ChannelMetrics,
  DedupCache,
  TelegramAdapter,
  DiscordAdapter,
  SlackAdapter,
  WhatsAppAdapter,
  KINDS,
} = require('../src/channels');

// ── DedupCache ───────────────────────────────────────────────────────────────

describe('DedupCache', () => {
  it('treats first add as fresh and second as duplicate', () => {
    const c = new DedupCache();
    assert.equal(c.add('a'), true);
    assert.equal(c.add('a'), false);
    assert.equal(c.has('a'), true);
  });

  it('expires entries after ttl', () => {
    let now = 1_000;
    const c = new DedupCache({ ttlMs: 100, now: () => now });
    c.add('a');
    now += 200;
    assert.equal(c.has('a'), false);
    assert.equal(c.add('a'), true);
  });

  it('evicts oldest when over maxSize', () => {
    const c = new DedupCache({ maxSize: 2 });
    c.add('a'); c.add('b'); c.add('c');
    assert.equal(c.has('a'), false);
    assert.equal(c.has('c'), true);
  });
});

// ── ChannelMetrics ───────────────────────────────────────────────────────────

describe('ChannelMetrics', () => {
  it('tracks counts per channel and kind', () => {
    const m = new ChannelMetrics();
    m.inc('slack', KINDS.INBOUND);
    m.inc('slack', KINDS.INBOUND);
    m.inc('slack', KINDS.ERROR);
    assert.equal(m.get('slack', KINDS.INBOUND), 2);
    assert.deepEqual(m.snapshot().slack, { inbound: 2, error: 1 });
  });
});

// ── ChannelAdapter base ──────────────────────────────────────────────────────

describe('ChannelAdapter', () => {
  it('allowlist permits all when empty', () => {
    class A extends ChannelAdapter {}
    const a = new A('x');
    assert.equal(a.isAllowed(undefined), true);
    assert.equal(a.isAllowed('any'), true);
  });

  it('allowlist enforces membership when configured', () => {
    class A extends ChannelAdapter {}
    const a = new A('x', { allowlist: ['team:eng'] });
    assert.equal(a.isAllowed('team:eng'), true);
    assert.equal(a.isAllowed('team:ops'), false);
    assert.equal(a.isAllowed(undefined), false);
  });

  it('isDuplicate reports duplicates and increments metric', () => {
    class A extends ChannelAdapter {}
    const metrics = new ChannelMetrics();
    const a = new A('x', { metrics });
    assert.equal(a.isDuplicate({ id: '1' }), false);
    assert.equal(a.isDuplicate({ id: '1' }), true);
    assert.equal(metrics.get('x', KINDS.DUPLICATE), 1);
  });
});

// ── TelegramAdapter ──────────────────────────────────────────────────────────

describe('TelegramAdapter', () => {
  it('verify accepts when no secret configured', async () => {
    const a = new TelegramAdapter({ botToken: 't' });
    assert.equal(await a.verify({ headers: {} }), true);
  });

  it('verify checks secret token header', async () => {
    const a = new TelegramAdapter({ botToken: 't', webhookSecret: 'shh' });
    assert.equal(await a.verify({ headers: { 'x-telegram-bot-api-secret-token': 'shh' } }), true);
    assert.equal(await a.verify({ headers: { 'x-telegram-bot-api-secret-token': 'no' } }), false);
  });

  it('parseInbound normalizes a message update', () => {
    const a = new TelegramAdapter({ botToken: 't' });
    const parsed = a.parseInbound({
      body: { update_id: 1, message: { message_id: 99, chat: { id: 5 }, from: { id: 7 }, text: 'hi' } },
    });
    assert.equal(parsed.id, '5:99');
    assert.equal(parsed.userId, '7');
    assert.equal(parsed.text, 'hi');
    assert.equal(parsed.channel, 'telegram');
  });

  it('sendOutbound POSTs to bot API and increments outbound metric', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 }); };
    const metrics = new ChannelMetrics();
    const a = new TelegramAdapter({ botToken: 't', fetchImpl, metrics });
    await a.sendOutbound({ chatId: '5', text: 'hi' });
    assert.match(calls[0].url, /\/bott\/sendMessage$/);
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { chat_id: '5', text: 'hi' });
    assert.equal(metrics.get('telegram', KINDS.OUTBOUND), 1);
  });

  it('isStale flips after staleThreshold without poll progress', () => {
    const a = new TelegramAdapter({ botToken: 't', staleThresholdMs: 60_000 });
    a._polling = true;
    a._lastPollAt = Date.now() - 90_000;
    assert.equal(a.isStale(), true);
  });
});

// ── DiscordAdapter ───────────────────────────────────────────────────────────

describe('DiscordAdapter', () => {
  function genKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
    return { publicKeyHex: pubRaw.toString('hex'), privateKey };
  }

  it('verify validates an Ed25519 signed body', () => {
    const { publicKeyHex, privateKey } = genKeyPair();
    const a = new DiscordAdapter({ publicKey: publicKeyHex });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ id: 'i1', type: 1 });
    const sig = crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString('hex');
    const ok = a.verify({
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      rawBody: body,
      body,
    });
    assert.equal(ok, true);
  });

  it('verify rejects tampered body', () => {
    const { publicKeyHex, privateKey } = genKeyPair();
    const a = new DiscordAdapter({ publicKey: publicKeyHex });
    const ts = '1';
    const body = JSON.stringify({ id: 'i1' });
    const sig = crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString('hex');
    const ok = a.verify({
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      rawBody: '{"id":"tampered"}',
    });
    assert.equal(ok, false);
  });

  it('parseInbound extracts id, user, channel', () => {
    const a = new DiscordAdapter({ publicKey: '00'.repeat(32) });
    const parsed = a.parseInbound({
      body: {
        id: 'int1',
        channel_id: 'ch1',
        member: { user: { id: 'u1' } },
        data: { name: 'ping', options: [{ type: 3, value: 'hello' }] },
      },
    });
    assert.equal(parsed.id, 'int1');
    assert.equal(parsed.chatId, 'ch1');
    assert.equal(parsed.userId, 'u1');
    assert.equal(parsed.text, 'hello');
  });
});

// ── SlackAdapter ─────────────────────────────────────────────────────────────

describe('SlackAdapter', () => {
  it('verify validates HMAC signature', () => {
    const a = new SlackAdapter({ signingSecret: 's3cret' });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event_id: 'e1', event: { ts: '1', text: 'hi', user: 'u', channel: 'c' } });
    const mac = 'v0=' + crypto.createHmac('sha256', 's3cret').update(`v0:${ts}:${body}`).digest('hex');
    const ok = a.verify({
      headers: { 'x-slack-signature': mac, 'x-slack-request-timestamp': ts },
      rawBody: body,
    });
    assert.equal(ok, true);
  });

  it('verify rejects stale timestamps', () => {
    const a = new SlackAdapter({ signingSecret: 's', toleranceSec: 10 });
    const ts = String(Math.floor(Date.now() / 1000) - 1000);
    const body = '{}';
    const mac = 'v0=' + crypto.createHmac('sha256', 's').update(`v0:${ts}:${body}`).digest('hex');
    assert.equal(a.verify({
      headers: { 'x-slack-signature': mac, 'x-slack-request-timestamp': ts },
      rawBody: body,
    }), false);
  });

  it('parseInbound normalizes events', () => {
    const a = new SlackAdapter({ signingSecret: 's' });
    const parsed = a.parseInbound({
      body: { event_id: 'e1', event: { ts: '1', text: 'hi', user: 'u', channel: 'c' } },
    });
    assert.equal(parsed.id, 'e1');
    assert.equal(parsed.userId, 'u');
    assert.equal(parsed.chatId, 'c');
  });

  it('parseInbound handles url_verification handshake', () => {
    const a = new SlackAdapter({ signingSecret: 's' });
    const parsed = a.parseInbound({ body: { type: 'url_verification', challenge: 'xyz' } });
    assert.equal(parsed.id, 'challenge:xyz');
  });
});

// ── WhatsAppAdapter ──────────────────────────────────────────────────────────

describe('WhatsAppAdapter', () => {
  it('verify GET handshake returns challenge', () => {
    const a = new WhatsAppAdapter({ appSecret: 'x', verifyToken: 'tok' });
    const out = a.verify({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': 'CHAL' },
    });
    assert.equal(out, 'CHAL');
  });

  it('verify POST validates X-Hub-Signature-256', () => {
    const secret = 'app-secret';
    const a = new WhatsAppAdapter({ appSecret: secret });
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wm1', from: '+1' }] } }] }] });
    const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const ok = a.verify({
      method: 'POST',
      headers: { 'x-hub-signature-256': mac },
      rawBody: body,
    });
    assert.equal(ok, true);
  });

  it('parseInbound extracts message envelope', () => {
    const a = new WhatsAppAdapter({ appSecret: 'x' });
    const parsed = a.parseInbound({
      body: { entry: [{ changes: [{ value: {
        metadata: { phone_number_id: 'p1' },
        messages: [{ id: 'wm1', from: '+1', text: { body: 'hi' } }],
      } }] }] },
    });
    assert.equal(parsed.id, 'wm1');
    assert.equal(parsed.userId, '+1');
    assert.equal(parsed.chatId, 'p1');
    assert.equal(parsed.text, 'hi');
  });
});

// ── ChannelRegistry ──────────────────────────────────────────────────────────

describe('ChannelRegistry', () => {
  it('registers and looks up adapters by name', () => {
    const r = new ChannelRegistry();
    const a = new TelegramAdapter({ botToken: 't' });
    r.register(a);
    assert.equal(r.get('telegram'), a);
    assert.equal(r.has('telegram'), true);
    assert.equal(r.list().length, 1);
  });

  it('rejects non-adapter values', () => {
    const r = new ChannelRegistry();
    assert.throws(() => r.register({ name: 'x' }), /ChannelAdapter/);
  });
});
