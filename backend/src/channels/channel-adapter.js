'use strict';

const { DedupCache } = require('./dedup-cache');
const { sharedMetrics, KINDS } = require('./metrics');
const { isSenderAllowed } = require('../services/business-channels/pairing');

/**
 * Normalized inbound message envelope produced by `parseInbound`.
 * @typedef {Object} InboundMessage
 * @property {string} id        Stable channel-native message id (used for dedup).
 * @property {string} channel   Channel name (telegram|discord|slack|whatsapp).
 * @property {string} userId    Channel-native user id.
 * @property {string=} chatId   Channel-native chat/conversation id.
 * @property {string=} text     Plain-text body, when present.
 * @property {string=} accessGroup  Resolved access group used for allowlisting.
 * @property {object} raw       Raw payload for downstream handlers.
 * @property {number} ts        Receipt timestamp (ms since epoch).
 */

/**
 * Outbound message envelope passed to `sendOutbound`.
 * @typedef {Object} OutboundMessage
 * @property {string=} chatId
 * @property {string=} userId
 * @property {string} text
 * @property {object=} extra   Channel-specific extras (parse_mode, blocks, etc.).
 */

class ChannelAdapter {
  /**
   * @param {string} name
   * @param {{ accountId?: string, allowlist?: string[], allowFrom?: string[], authorizeInbound?: Function, dmPolicy?: string, dedup?: DedupCache, metrics?: object, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(name, opts = {}) {
    if (!name) throw new Error('ChannelAdapter requires a name');
    this.name = name;
    const explicitAccountId = typeof opts.accountId === 'string'
      ? opts.accountId.trim()
      : '';
    this.accountId = explicitAccountId || 'default';
    this.dmPolicy = ['pairing', 'allowlist', 'open', 'closed'].includes(opts.dmPolicy)
      ? opts.dmPolicy
      : 'pairing';
    this.allowlist = new Set(opts.allowFrom || opts.allowlist || []);
    this.authorizeInbound = typeof opts.authorizeInbound === 'function'
      ? opts.authorizeInbound
      : null;
    if (this.authorizeInbound && !explicitAccountId) {
      throw new Error('ChannelAdapter requires accountId with authorizeInbound');
    }
    this.dedup = opts.dedup || new DedupCache();
    this.metrics = opts.metrics || sharedMetrics;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
  }

  /**
   * Channels fail closed. `open` requires both the policy and the explicit
   * wildcard, matching the Prisma-backed business-channel gate.
   */
  isAllowed(accessGroup) {
    return isSenderAllowed({
      senderId: accessGroup,
      dmPolicy: this.dmPolicy,
      allowFrom: [...this.allowlist],
    });
  }

  /**
   * @param {{ id: string }} parsed
   * @returns {boolean} true if duplicate, false if newly seen.
   */
  isDuplicate(parsed) {
    if (!parsed || !parsed.id) return false;
    const fresh = this.dedup.add(`${this.name}:${this.accountId}:${parsed.id}`);
    if (!fresh) {
      this.metrics.inc(this.name, KINDS.DUPLICATE);
      return true;
    }
    return false;
  }

  // ── Hooks (override in subclasses) ────────────────────────────────────────

  /** @returns {Promise<boolean>|boolean} */
  async verify(_req) { throw new Error(`verify() not implemented for ${this.name}`); }

  /** @returns {Promise<InboundMessage|null>|InboundMessage|null} */
  async parseInbound(_req) { throw new Error(`parseInbound() not implemented for ${this.name}`); }

  /** @returns {Promise<object>} */
  async sendOutbound(_msg) { throw new Error(`sendOutbound() not implemented for ${this.name}`); }

  async _gateParsedInbound(parsed) {
    if (!parsed) return { message: null, authorization: { allowed: false, reason: 'invalid_payload' } };
    if (this.isDuplicate(parsed)) {
      return { message: null, authorization: { allowed: false, reason: 'duplicate' } };
    }

    const authorization = this.authorizeInbound
      ? await this.authorizeInbound({
        channel: this.name,
        accountId: this.accountId,
        senderId: parsed.userId,
        accessGroup: parsed.accessGroup,
        message: parsed,
      })
      : {
        allowed: this.isAllowed(parsed.accessGroup || parsed.userId),
        reason: 'adapter_policy',
      };
    if (!authorization?.allowed) {
      return { message: null, authorization: authorization || { allowed: false } };
    }
    this.metrics.inc(this.name, KINDS.INBOUND);
    return { message: parsed, authorization };
  }

  /**
   * Structured webhook ingress for routers that must surface
   * `pairing_required`. There is deliberately no public verification bypass.
   */
  async receiveWithAuthorization(req) {
    if (!await this.verify(req)) return null;
    return this._gateParsedInbound(await this.parseInbound(req));
  }

  /**
   * Backward-compatible interface: allowed message or null.
   */
  async receive(req) {
    const result = await this.receiveWithAuthorization(req);
    return result?.message || null;
  }

  async send(msg) {
    return this.sendOutbound(msg);
  }

  async listThreads() {
    return [];
  }
}

module.exports = { ChannelAdapter };
