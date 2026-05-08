'use strict';

const crypto = require('node:crypto');
const { ChannelAdapter } = require('./channel-adapter');
const { KINDS } = require('./metrics');
const { retryWithBackoff } = require('./retry');

/**
 * Discord interactions adapter.
 *
 * Verifies the `X-Signature-Ed25519` + `X-Signature-Timestamp` headers using
 * the application's public key. The raw request body must be available as
 * either `req.rawBody` (string/Buffer) or `req.body` already serialized.
 */
class DiscordAdapter extends ChannelAdapter {
  /**
   * @param {{
   *   publicKey: string,    // hex-encoded Ed25519 public key
   *   botToken?: string,    // for outbound REST calls
   *   apiBase?: string,
   *   accessGroupResolver?: (interaction: object) => string | undefined,
   * } & ConstructorParameters<typeof ChannelAdapter>[1]} opts
   */
  constructor(opts = {}) {
    super('discord', opts);
    if (!opts.publicKey) throw new Error('DiscordAdapter requires publicKey');
    this.publicKey = opts.publicKey;
    this.botToken = opts.botToken || null;
    this.apiBase = opts.apiBase || 'https://discord.com/api/v10';
    this.accessGroupResolver = opts.accessGroupResolver || null;
    this._publicKeyObject = null;
  }

  _publicKey() {
    if (this._publicKeyObject) return this._publicKeyObject;
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), // Ed25519 SPKI prefix
      Buffer.from(this.publicKey, 'hex'),
    ]);
    this._publicKeyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return this._publicKeyObject;
  }

  verify(req) {
    const sig = req?.headers?.['x-signature-ed25519'];
    const ts = req?.headers?.['x-signature-timestamp'];
    if (!sig || !ts) { this.metrics.inc(this.name, KINDS.VERIFY_FAIL); return false; }
    const raw = req.rawBody != null
      ? (Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody))
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const message = Buffer.concat([Buffer.from(ts), raw]);
    let ok = false;
    try {
      ok = crypto.verify(null, message, this._publicKey(), Buffer.from(sig, 'hex'));
    } catch { ok = false; }
    if (!ok) this.metrics.inc(this.name, KINDS.VERIFY_FAIL);
    return ok;
  }

  parseInbound(req) {
    const interaction = typeof req?.body === 'string' ? JSON.parse(req.body) : (req?.body || req || {});
    if (!interaction?.id) return null;
    const accessGroup = this.accessGroupResolver
      ? this.accessGroupResolver(interaction)
      : undefined;
    const userId = interaction.member?.user?.id || interaction.user?.id || '';
    return {
      id: interaction.id,
      channel: this.name,
      userId: String(userId),
      chatId: String(interaction.channel_id || ''),
      text: interaction.data?.options?.find(o => o.type === 3)?.value
            || interaction.data?.name
            || '',
      accessGroup,
      raw: interaction,
      ts: Date.now(),
    };
  }

  async sendOutbound(msg) {
    if (!msg?.chatId) throw new Error('DiscordAdapter.sendOutbound requires chatId');
    if (!this.botToken) throw new Error('DiscordAdapter.sendOutbound requires botToken');
    const url = `${this.apiBase}/channels/${msg.chatId}/messages`;
    const payload = { content: msg.text ?? '', ...(msg.extra || {}) };
    const res = await retryWithBackoff(async () => {
      const r = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'authorization': `Bot ${this.botToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await safeJson(r);
      const retryAfter = body?.retry_after;
      return {
        ok: r.ok,
        status: r.status,
        body,
        retryAfterMs: retryAfter ? Math.ceil(retryAfter * 1000) : undefined,
      };
    });
    if (!res.ok) {
      this.metrics.inc(this.name, KINDS.ERROR);
      const err = new Error(`discord send failed: ${res.status}`);
      err.body = res.body;
      throw err;
    }
    this.metrics.inc(this.name, KINDS.OUTBOUND);
    return res.body;
  }
}

async function safeJson(r) { try { return await r.json(); } catch { return null; } }

module.exports = { DiscordAdapter };
