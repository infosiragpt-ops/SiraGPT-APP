'use strict';

const crypto = require('node:crypto');
const { ChannelAdapter } = require('./channel-adapter');
const { KINDS } = require('./metrics');
const { retryWithBackoff, parseRetryAfterHeader } = require('./retry');

/**
 * Slack Events API adapter.
 *
 * Verifies the `X-Slack-Signature` header (`v0=hex(HMAC-SHA256(signingSecret, "v0:"+ts+":"+body))`).
 * Rejects requests with timestamps older than `toleranceSec` (default 300).
 */
class SlackAdapter extends ChannelAdapter {
  /**
   * @param {{
   *   signingSecret: string,
   *   botToken?: string,
   *   apiBase?: string,
   *   toleranceSec?: number,
   *   accessGroupResolver?: (event: object) => string | undefined,
   * } & ConstructorParameters<typeof ChannelAdapter>[1]} opts
   */
  constructor(opts = {}) {
    super('slack', opts);
    if (!opts.signingSecret) throw new Error('SlackAdapter requires signingSecret');
    this.signingSecret = opts.signingSecret;
    this.botToken = opts.botToken || null;
    this.apiBase = opts.apiBase || 'https://slack.com/api';
    this.toleranceSec = opts.toleranceSec ?? 300;
    this.accessGroupResolver = opts.accessGroupResolver || null;
  }

  verify(req) {
    const sig = req?.headers?.['x-slack-signature'];
    const ts = req?.headers?.['x-slack-request-timestamp'];
    if (!sig || !ts) { this.metrics.inc(this.name, KINDS.VERIFY_FAIL); return false; }
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) { this.metrics.inc(this.name, KINDS.VERIFY_FAIL); return false; }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - tsNum) > this.toleranceSec) {
      this.metrics.inc(this.name, KINDS.VERIFY_FAIL);
      return false;
    }
    const raw = req.rawBody != null
      ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
      : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const base = `v0:${ts}:${raw}`;
    const mac = `v0=${crypto.createHmac('sha256', this.signingSecret).update(base).digest('hex')}`;
    let ok = false;
    try {
      ok = mac.length === sig.length
        && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig));
    } catch { ok = false; }
    if (!ok) this.metrics.inc(this.name, KINDS.VERIFY_FAIL);
    return ok;
  }

  parseInbound(req) {
    const payload = typeof req?.body === 'string' ? JSON.parse(req.body) : (req?.body || req || {});
    // URL verification handshake — surface as a non-message envelope.
    if (payload?.type === 'url_verification') {
      return {
        id: `challenge:${payload.challenge}`,
        channel: this.name,
        userId: '',
        text: '',
        raw: payload,
        ts: Date.now(),
      };
    }
    const event = payload.event || payload;
    if (!event?.ts && !event?.event_id && !payload?.event_id) return null;
    const id = payload.event_id || `${event.channel || ''}:${event.ts || ''}`;
    const accessGroup = this.accessGroupResolver
      ? this.accessGroupResolver(event)
      : undefined;
    return {
      id,
      channel: this.name,
      userId: String(event.user || ''),
      chatId: String(event.channel || ''),
      text: event.text || '',
      accessGroup,
      raw: payload,
      ts: Date.now(),
    };
  }

  async sendOutbound(msg) {
    if (!msg?.chatId) throw new Error('SlackAdapter.sendOutbound requires chatId');
    if (!this.botToken) throw new Error('SlackAdapter.sendOutbound requires botToken');
    const url = `${this.apiBase}/chat.postMessage`;
    const payload = { channel: msg.chatId, text: msg.text ?? '', ...(msg.extra || {}) };
    const res = await retryWithBackoff(async () => {
      const r = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
      });
      const body = await safeJson(r);
      const retryAfter = parseRetryAfterHeader(r.headers?.get?.('retry-after'));
      return {
        ok: r.ok && body?.ok !== false,
        status: r.status,
        body,
        retryAfterMs: retryAfter,
      };
    });
    if (!res.ok) {
      this.metrics.inc(this.name, KINDS.ERROR);
      const err = new Error(`slack postMessage failed: ${res.status} ${res.body?.error || ''}`);
      err.body = res.body;
      throw err;
    }
    this.metrics.inc(this.name, KINDS.OUTBOUND);
    return res.body;
  }
}

async function safeJson(r) { try { return await r.json(); } catch { return null; } }

module.exports = { SlackAdapter };
