/**
 * Tests for channels/discord.js — Discord interactions adapter.
 *
 * Verify Ed25519-signed interactions, parse the slash-command envelope,
 * and exercise the outbound POST + retry-after path.
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

const { DiscordAdapter } = require('../src/channels/discord');
const { ChannelMetrics, KINDS } = require('../src/channels/metrics');

// Generate a fresh Ed25519 key pair so we can sign test payloads as if
// they came from Discord. Public key is hex-encoded (Discord format).
const { publicKey: PUB_OBJ, privateKey: PRIV_OBJ } = crypto.generateKeyPairSync('ed25519');
const PUB_KEY_RAW = PUB_OBJ.export({ format: 'jwk' });
// JWK 'x' is base64url; convert to hex for our adapter.
const PUB_HEX = Buffer.from(PUB_KEY_RAW.x, 'base64url').toString('hex');

function signPayload(ts, body) {
  const msg = Buffer.concat([Buffer.from(ts), Buffer.from(body)]);
  return crypto.sign(null, msg, PRIV_OBJ).toString('hex');
}

function makeAdapter(overrides = {}) {
  return new DiscordAdapter({
    publicKey: PUB_HEX,
    botToken: 'discord-bot-token',
    metrics: new ChannelMetrics(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 'm1' }) }),
    ...overrides,
  });
}

describe('DiscordAdapter · constructor', () => {
  it('throws when publicKey is missing', () => {
    assert.throws(() => new DiscordAdapter({}), /requires publicKey/);
  });

  it('stores publicKey + botToken + apiBase', () => {
    const a = new DiscordAdapter({
      publicKey: PUB_HEX,
      botToken: 'b',
      apiBase: 'https://custom.discord.example/v10',
    });
    assert.equal(a.publicKey, PUB_HEX);
    assert.equal(a.botToken, 'b');
    assert.equal(a.apiBase, 'https://custom.discord.example/v10');
  });

  it('default apiBase is discord v10', () => {
    const a = new DiscordAdapter({ publicKey: PUB_HEX });
    assert.equal(a.apiBase, 'https://discord.com/api/v10');
  });

  it('name="discord", extends ChannelAdapter', () => {
    const a = new DiscordAdapter({ publicKey: PUB_HEX });
    assert.equal(a.name, 'discord');
  });
});

describe('DiscordAdapter · verify (Ed25519)', () => {
  it('returns false when X-Signature-Ed25519 header is missing', () => {
    const a = makeAdapter();
    const out = a.verify({ headers: { 'x-signature-timestamp': '1' }, body: {} });
    assert.equal(out, false);
    assert.equal(a.metrics.get('discord', KINDS.VERIFY_FAIL), 1);
  });

  it('returns false when X-Signature-Timestamp header is missing', () => {
    const a = makeAdapter();
    const out = a.verify({ headers: { 'x-signature-ed25519': 'aa' }, body: {} });
    assert.equal(out, false);
  });

  it('verifies a freshly-signed interaction (rawBody string)', () => {
    const a = makeAdapter();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 1 });
    const sig = signPayload(ts, body);
    const req = {
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      rawBody: body,
    };
    assert.equal(a.verify(req), true);
    assert.equal(a.metrics.get('discord', KINDS.VERIFY_FAIL), 0);
  });

  it('rawBody Buffer is accepted', () => {
    const a = makeAdapter();
    const ts = '1234567890';
    const body = JSON.stringify({ type: 1 });
    const sig = signPayload(ts, body);
    const req = {
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      rawBody: Buffer.from(body, 'utf8'),
    };
    assert.equal(a.verify(req), true);
  });

  it('falls back to JSON.stringify(req.body) when no rawBody', () => {
    const a = makeAdapter();
    const ts = '1234567890';
    const bodyObj = { type: 2, id: 'abc' };
    const body = JSON.stringify(bodyObj);
    const sig = signPayload(ts, body);
    const req = {
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      body: bodyObj,
    };
    assert.equal(a.verify(req), true);
  });

  it('rejects tampered signature', () => {
    const a = makeAdapter();
    const ts = '1234567890';
    const body = '{}';
    const sig = signPayload(ts, body);
    const tampered = sig.slice(0, -2) + (sig.slice(-2) === 'ff' ? '00' : 'ff');
    const req = {
      headers: { 'x-signature-ed25519': tampered, 'x-signature-timestamp': ts },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
    assert.equal(a.metrics.get('discord', KINDS.VERIFY_FAIL), 1);
  });

  it('rejects request signed with a different key', () => {
    const a = makeAdapter();
    const ts = '1234567890';
    const body = '{}';
    // Sign with a brand-new key — not the one the adapter knows about.
    const { privateKey: otherPriv } = crypto.generateKeyPairSync('ed25519');
    const sig = crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), otherPriv).toString('hex');
    const req = {
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
  });

  it('rejects body mutated AFTER signing', () => {
    const a = makeAdapter();
    const ts = '1234567890';
    const body = JSON.stringify({ type: 1, evil: false });
    const sig = signPayload(ts, body);
    const evilBody = JSON.stringify({ type: 1, evil: true });
    const req = {
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      rawBody: evilBody,
    };
    assert.equal(a.verify(req), false);
  });

  it('caches the public key object across calls (no exception on re-verify)', () => {
    const a = makeAdapter();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{}';
    const sig = signPayload(ts, body);
    const req = {
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      rawBody: body,
    };
    assert.equal(a.verify(req), true);
    assert.equal(a.verify(req), true);
  });
});

describe('DiscordAdapter · parseInbound', () => {
  const a = makeAdapter();

  it('returns null when interaction id is missing', () => {
    assert.equal(a.parseInbound({ body: {} }), null);
  });

  it('parses an interaction with member.user.id (guild context)', () => {
    const out = a.parseInbound({
      body: {
        id: 'INT-1',
        channel_id: 'C-1',
        member: { user: { id: 'U-guild' } },
        data: { name: '/ask' },
      },
    });
    assert.equal(out.id, 'INT-1');
    assert.equal(out.userId, 'U-guild');
    assert.equal(out.chatId, 'C-1');
    assert.equal(out.text, '/ask');
  });

  it('falls back to interaction.user.id (DM context)', () => {
    const out = a.parseInbound({
      body: {
        id: 'INT-2',
        channel_id: 'D-1',
        user: { id: 'U-dm' },
        data: { name: '/help' },
      },
    });
    assert.equal(out.userId, 'U-dm');
  });

  it('extracts the first type=3 option as the text', () => {
    const out = a.parseInbound({
      body: {
        id: 'INT-3',
        channel_id: 'C',
        user: { id: 'U' },
        data: {
          name: '/ask',
          options: [
            { type: 1, name: 'sub' },
            { type: 3, name: 'q', value: 'what is the meaning of life' },
          ],
        },
      },
    });
    assert.equal(out.text, 'what is the meaning of life');
  });

  it('falls back to data.name when no options[]', () => {
    const out = a.parseInbound({
      body: { id: 'INT-4', channel_id: 'C', user: { id: 'U' }, data: { name: '/ping' } },
    });
    assert.equal(out.text, '/ping');
  });

  it('returns "" when neither options nor name present', () => {
    const out = a.parseInbound({
      body: { id: 'INT-5', channel_id: 'C', user: { id: 'U' }, data: {} },
    });
    assert.equal(out.text, '');
  });

  it('JSON-string body is parsed', () => {
    const out = a.parseInbound({
      body: JSON.stringify({ id: 'INT-6', channel_id: 'C', user: { id: 'U' }, data: { name: '/x' } }),
    });
    assert.equal(out.id, 'INT-6');
  });

  it('invokes accessGroupResolver and stores the result', () => {
    const a2 = makeAdapter({
      accessGroupResolver: (i) => `g-${i.guild_id || 'dm'}`,
    });
    const out = a2.parseInbound({
      body: { id: 'INT-7', channel_id: 'C', guild_id: 'G-42', user: { id: 'U' }, data: { name: '/x' } },
    });
    assert.equal(out.accessGroup, 'g-G-42');
  });
});

describe('DiscordAdapter · sendOutbound', () => {
  it('throws when chatId missing', async () => {
    const a = makeAdapter();
    await assert.rejects(() => a.sendOutbound({ text: 'hi' }), /requires chatId/);
  });

  it('throws when botToken missing', async () => {
    const a = makeAdapter({ botToken: null });
    await assert.rejects(
      () => a.sendOutbound({ chatId: 'C', text: 'hi' }),
      /requires botToken/,
    );
  });

  it('POSTs to /channels/<id>/messages with Bot auth', async () => {
    let captured;
    const a = makeAdapter({
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => ({ id: 'm1' }) };
      },
    });
    await a.sendOutbound({ chatId: 'C-42', text: 'hi' });
    assert.equal(captured.url, 'https://discord.com/api/v10/channels/C-42/messages');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.authorization, 'Bot discord-bot-token');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.content, 'hi');
    assert.equal(a.metrics.get('discord', KINDS.OUTBOUND), 1);
  });

  it('merges msg.extra into the body (e.g. embeds, components)', async () => {
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
      extra: { embeds: [{ title: 'x' }], allowed_mentions: { parse: [] } },
    });
    const body = JSON.parse(captured.body);
    assert.deepEqual(body.embeds, [{ title: 'x' }]);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
  });

  it('throws on non-ok HTTP status, increments KINDS.ERROR', async () => {
    const a = makeAdapter({
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'Missing Permissions' }) }),
    });
    await assert.rejects(
      () => a.sendOutbound({ chatId: 'C', text: 't' }),
      /discord send failed: 403/,
    );
    assert.equal(a.metrics.get('discord', KINDS.ERROR), 1);
  });
});
