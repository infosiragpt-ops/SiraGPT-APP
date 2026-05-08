'use strict';

const crypto = require('node:crypto');
const { ChannelAdapter } = require('./channel-adapter');
const { KINDS } = require('./metrics');
const { retryWithBackoff } = require('./retry');

/**
 * WhatsApp (Meta Cloud API) adapter.
 *
 * Webhook verification:
 *   - GET handshake: `hub.mode=subscribe`, `hub.verify_token=<verifyToken>`,
 *     respond with `hub.challenge`.
 *   - POST events: validate `X-Hub-Signature-256: sha256=<hex>` HMAC over the
 *     raw request body using the app secret.
 */
class WhatsAppAdapter extends ChannelAdapter {
  /**
   * @param {{
   *   appSecret: string,
   *   verifyToken?: string,
   *   accessToken?: string,
   *   phoneNumberId?: string,
   *   apiBase?: string,
   *   accessGroupResolver?: (msg: object) => string | undefined,
   * } & ConstructorParameters<typeof ChannelAdapter>[1]} opts
   */
  constructor(opts = {}) {
    super('whatsapp', opts);
    if (!opts.appSecret) throw new Error('WhatsAppAdapter requires appSecret');
    this.appSecret = opts.appSecret;
    this.verifyToken = opts.verifyToken || null;
    this.accessToken = opts.accessToken || null;
    this.phoneNumberId = opts.phoneNumberId || null;
    this.apiBase = opts.apiBase || 'https://graph.facebook.com/v20.0';
    this.accessGroupResolver = opts.accessGroupResolver || null;
  }

  /**
   * Returns either:
   *   - true/false for POST signature checks,
   *   - the challenge string for GET handshakes (caller must respond with it).
   */
  verify(req) {
    const method = (req?.method || '').toUpperCase();
    if (method === 'GET') {
      const q = req.query || {};
      if (q['hub.mode'] === 'subscribe'
        && this.verifyToken
        && q['hub.verify_token'] === this.verifyToken) {
        return q['hub.challenge'] || true;
      }
      this.metrics.inc(this.name, KINDS.VERIFY_FAIL);
      return false;
    }
    const sig = req?.headers?.['x-hub-signature-256'];
    if (!sig || !sig.startsWith('sha256=')) {
      this.metrics.inc(this.name, KINDS.VERIFY_FAIL);
      return false;
    }
    const raw = req.rawBody != null
      ? (Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody))
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const expected = 'sha256=' + crypto.createHmac('sha256', this.appSecret).update(raw).digest('hex');
    let ok = false;
    try {
      ok = expected.length === sig.length
        && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    } catch { ok = false; }
    if (!ok) this.metrics.inc(this.name, KINDS.VERIFY_FAIL);
    return ok;
  }

  parseInbound(req) {
    const payload = typeof req?.body === 'string' ? JSON.parse(req.body) : (req?.body || req || {});
    const change = payload?.entry?.[0]?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return null;
    const accessGroup = this.accessGroupResolver
      ? this.accessGroupResolver({ payload, value, msg })
      : undefined;
    return {
      id: msg.id,
      channel: this.name,
      userId: String(msg.from || ''),
      chatId: String(value.metadata?.phone_number_id || ''),
      text: msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '',
      accessGroup,
      raw: payload,
      ts: Date.now(),
    };
  }

  async sendOutbound(msg) {
    if (!this.accessToken) throw new Error('WhatsAppAdapter.sendOutbound requires accessToken');
    const phoneId = msg.fromPhoneNumberId || this.phoneNumberId;
    if (!phoneId) throw new Error('WhatsAppAdapter.sendOutbound requires phoneNumberId');
    if (!msg?.userId) throw new Error('WhatsAppAdapter.sendOutbound requires userId');
    const url = `${this.apiBase}/${phoneId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: msg.userId,
      type: 'text',
      text: { body: msg.text ?? '' },
      ...(msg.extra || {}),
    };
    const res = await retryWithBackoff(async () => {
      const r = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await safeJson(r);
      return { ok: r.ok, status: r.status, body };
    });
    if (!res.ok) {
      this.metrics.inc(this.name, KINDS.ERROR);
      const err = new Error(`whatsapp send failed: ${res.status}`);
      err.body = res.body;
      throw err;
    }
    this.metrics.inc(this.name, KINDS.OUTBOUND);
    return res.body;
  }
}

async function safeJson(r) { try { return await r.json(); } catch { return null; } }

module.exports = { WhatsAppAdapter };
