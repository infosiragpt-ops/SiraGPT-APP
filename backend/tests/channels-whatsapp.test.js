/**
 * Tests for channels/whatsapp.js — Meta Cloud API adapter.
 *
 * Covers the GET handshake, POST HMAC verify, the deeply-nested
 * payload parser (entry[0].changes[0].value.messages[0]), and the
 * outbound Graph API call.
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

const { WhatsAppAdapter } = require('../src/channels/whatsapp');
const { ChannelMetrics, KINDS } = require('../src/channels/metrics');

const APP_SECRET = 'meta-app-secret-test';

function makeAdapter(overrides = {}) {
  return new WhatsAppAdapter({
    appSecret: APP_SECRET,
    verifyToken: 'verify-token-x',
    accessToken: 'meta-access-token',
    phoneNumberId: '12345',
    metrics: new ChannelMetrics(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1' }] }) }),
    ...overrides,
  });
}

function signBody(body) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

describe('WhatsAppAdapter · constructor', () => {
  it('throws when appSecret missing', () => {
    assert.throws(() => new WhatsAppAdapter({}), /requires appSecret/);
  });

  it('stores all opts; defaults apiBase to graph.facebook.com v20', () => {
    const a = new WhatsAppAdapter({ appSecret: 'x' });
    assert.equal(a.appSecret, 'x');
    assert.equal(a.apiBase, 'https://graph.facebook.com/v20.0');
    assert.equal(a.verifyToken, null);
    assert.equal(a.accessToken, null);
    assert.equal(a.phoneNumberId, null);
  });

  it('name="whatsapp"', () => {
    const a = new WhatsAppAdapter({ appSecret: 'x' });
    assert.equal(a.name, 'whatsapp');
  });
});

describe('WhatsAppAdapter · verify (GET handshake)', () => {
  it('returns the challenge value when mode=subscribe AND verify_token matches', () => {
    const a = makeAdapter();
    const req = {
      method: 'GET',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token-x',
        'hub.challenge': 'CHALLENGE-42',
      },
    };
    assert.equal(a.verify(req), 'CHALLENGE-42');
  });

  it('returns true (not the challenge) when challenge param missing but valid handshake', () => {
    const a = makeAdapter();
    const req = {
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-x' },
    };
    assert.equal(a.verify(req), true);
  });

  it('returns false on wrong verify_token (no verifyToken match)', () => {
    const a = makeAdapter();
    const req = {
      method: 'GET',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'WRONG',
        'hub.challenge': 'C',
      },
    };
    assert.equal(a.verify(req), false);
    assert.equal(a.metrics.get('whatsapp', KINDS.VERIFY_FAIL), 1);
  });

  it('returns false when hub.mode != subscribe', () => {
    const a = makeAdapter();
    const req = {
      method: 'GET',
      query: {
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'verify-token-x',
        'hub.challenge': 'C',
      },
    };
    assert.equal(a.verify(req), false);
  });

  it('returns false when no verifyToken is configured (even if request sends one)', () => {
    const a = makeAdapter({ verifyToken: null });
    const req = {
      method: 'GET',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'anything',
        'hub.challenge': 'C',
      },
    };
    assert.equal(a.verify(req), false);
  });
});

describe('WhatsAppAdapter · verify (POST HMAC)', () => {
  it('returns false when X-Hub-Signature-256 header is missing', () => {
    const a = makeAdapter();
    assert.equal(a.verify({ method: 'POST', headers: {}, body: {} }), false);
    assert.equal(a.metrics.get('whatsapp', KINDS.VERIFY_FAIL), 1);
  });

  it('returns false when header lacks the "sha256=" prefix', () => {
    const a = makeAdapter();
    const req = {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'md5=abc' },
      body: {},
    };
    assert.equal(a.verify(req), false);
  });

  it('verifies a freshly-signed body (rawBody string)', () => {
    const a = makeAdapter();
    const body = JSON.stringify({ entry: [{}] });
    const req = {
      method: 'POST',
      headers: { 'x-hub-signature-256': signBody(body) },
      rawBody: body,
    };
    assert.equal(a.verify(req), true);
    assert.equal(a.metrics.get('whatsapp', KINDS.VERIFY_FAIL), 0);
  });

  it('rawBody as Buffer is accepted', () => {
    const a = makeAdapter();
    const body = JSON.stringify({ entry: [{}] });
    const req = {
      method: 'POST',
      headers: { 'x-hub-signature-256': signBody(body) },
      rawBody: Buffer.from(body),
    };
    assert.equal(a.verify(req), true);
  });

  it('falls back to JSON.stringify(req.body) when no rawBody', () => {
    const a = makeAdapter();
    const bodyObj = { entry: [{ id: 'x' }] };
    const body = JSON.stringify(bodyObj);
    const req = {
      method: 'POST',
      headers: { 'x-hub-signature-256': signBody(body) },
      body: bodyObj,
    };
    assert.equal(a.verify(req), true);
  });

  it('rejects tampered signature (same length, wrong bytes)', () => {
    const a = makeAdapter();
    const body = JSON.stringify({});
    const sig = signBody(body);
    const tampered = sig.slice(0, -2) + (sig.slice(-2) === 'ff' ? '00' : 'ff');
    const req = {
      method: 'POST',
      headers: { 'x-hub-signature-256': tampered },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
  });

  it('rejects signatures with mismatched length (timing-safe guard)', () => {
    const a = makeAdapter();
    const body = JSON.stringify({});
    const req = {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=short' },
      rawBody: body,
    };
    assert.equal(a.verify(req), false);
  });
});

describe('WhatsAppAdapter · parseInbound', () => {
  const a = makeAdapter();

  function envelope(msg, metadataExtra = {}) {
    return {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WABA-1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'PN-1', ...metadataExtra },
            messages: [msg],
          },
          field: 'messages',
        }],
      }],
    };
  }

  it('returns null when payload has no messages', () => {
    assert.equal(a.parseInbound({ body: { entry: [{ changes: [{ value: {} }] }] } }), null);
    assert.equal(a.parseInbound({ body: {} }), null);
  });

  it('returns null instead of throwing when the JSON-string body is malformed', () => {
    assert.equal(a.parseInbound({ body: '{"entry":' }), null);
  });

  it('parses a text message', () => {
    const out = a.parseInbound({
      body: envelope({
        id: 'wamid.123',
        from: '15551234567',
        text: { body: 'hello' },
        type: 'text',
      }),
    });
    assert.equal(out.id, 'wamid.123');
    assert.equal(out.userId, '15551234567');
    assert.equal(out.chatId, 'PN-1');
    assert.equal(out.text, 'hello');
    assert.equal(out.channel, 'whatsapp');
  });

  it('parses a button-press payload', () => {
    const out = a.parseInbound({
      body: envelope({
        id: 'wamid.btn',
        from: 'U',
        button: { text: 'Click me', payload: 'BTN_PAYLOAD' },
        type: 'button',
      }),
    });
    assert.equal(out.text, 'Click me');
  });

  it('parses an interactive button-reply payload', () => {
    const out = a.parseInbound({
      body: envelope({
        id: 'wamid.int',
        from: 'U',
        interactive: { button_reply: { id: 'BR1', title: 'Yes please' } },
        type: 'interactive',
      }),
    });
    assert.equal(out.text, 'Yes please');
  });

  it('text="" when no text/button/interactive present', () => {
    const out = a.parseInbound({
      body: envelope({ id: 'wamid.empty', from: 'U' }),
    });
    assert.equal(out.text, '');
  });

  it('accepts JSON-string body', () => {
    const json = JSON.stringify(envelope({
      id: 'wamid.str',
      from: 'U',
      text: { body: 'parsed-from-string' },
    }));
    const out = a.parseInbound({ body: json });
    assert.equal(out.id, 'wamid.str');
    assert.equal(out.text, 'parsed-from-string');
  });

  it('invokes accessGroupResolver with { payload, value, msg }', () => {
    let received;
    const a2 = makeAdapter({
      accessGroupResolver: (ctx) => {
        received = ctx;
        return `g-${ctx.msg.from}`;
      },
    });
    const out = a2.parseInbound({
      body: envelope({ id: 'm', from: '1555', text: { body: 'x' } }),
    });
    assert.equal(out.accessGroup, 'g-1555');
    assert.ok(received.payload);
    assert.ok(received.value);
    assert.ok(received.msg);
  });
});

describe('WhatsAppAdapter · sendOutbound', () => {
  it('throws when accessToken missing', async () => {
    const a = makeAdapter({ accessToken: null });
    await assert.rejects(
      () => a.sendOutbound({ userId: '1', text: 'hi' }),
      /requires accessToken/,
    );
  });

  it('throws when no phoneNumberId available (instance or per-message)', async () => {
    const a = makeAdapter({ phoneNumberId: null });
    await assert.rejects(
      () => a.sendOutbound({ userId: '1', text: 'hi' }),
      /requires phoneNumberId/,
    );
  });

  it('throws when userId missing', async () => {
    const a = makeAdapter();
    await assert.rejects(
      () => a.sendOutbound({ text: 'hi' }),
      /requires userId/,
    );
  });

  it('POSTs to graph.facebook.com /<phone-id>/messages with WhatsApp envelope', async () => {
    let captured;
    const a = makeAdapter({
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    await a.sendOutbound({ userId: '15551234567', text: 'hello' });
    assert.equal(captured.url, 'https://graph.facebook.com/v20.0/12345/messages');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.messaging_product, 'whatsapp');
    assert.equal(body.to, '15551234567');
    assert.equal(body.type, 'text');
    assert.equal(body.text.body, 'hello');
    assert.equal(captured.init.headers.authorization, 'Bearer meta-access-token');
    assert.equal(a.metrics.get('whatsapp', KINDS.OUTBOUND), 1);
  });

  it('per-message fromPhoneNumberId overrides the instance default', async () => {
    let captured;
    const a = makeAdapter({
      phoneNumberId: 'default-99',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    await a.sendOutbound({
      userId: '1',
      text: 'x',
      fromPhoneNumberId: 'override-42',
    });
    assert.match(captured.url, /\/override-42\/messages$/);
  });

  it('merges msg.extra into the body', async () => {
    let captured;
    const a = makeAdapter({
      fetchImpl: async (_url, init) => {
        captured = init;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    await a.sendOutbound({
      userId: '1',
      text: 't',
      extra: { context: { message_id: 'wamid.parent' } },
    });
    const body = JSON.parse(captured.body);
    assert.deepEqual(body.context, { message_id: 'wamid.parent' });
  });

  it('throws on non-ok status, increments KINDS.ERROR', async () => {
    const a = makeAdapter({
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid recipient' } }) }),
    });
    await assert.rejects(
      () => a.sendOutbound({ userId: '1', text: 't' }),
      /whatsapp send failed: 400/,
    );
    assert.equal(a.metrics.get('whatsapp', KINDS.ERROR), 1);
  });

  it('honours Retry-After header on transient Graph API failures', async () => {
    let calls = 0;
    const a = makeAdapter({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: { message: 'temporarily unavailable' } }),
            headers: { get: (name) => (name === 'retry-after' ? '0.001' : null) },
          };
        }
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.2' }] }) };
      },
    });

    await a.sendOutbound({ userId: '1', text: 't' });

    assert.equal(calls, 2);
  });
});
