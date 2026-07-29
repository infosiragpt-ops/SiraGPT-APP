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
   * @param {{ accountId?: string, allowlist?: string[], allowFrom?: string[], dmPolicy?: string, dedup?: DedupCache, metrics?: object, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(name, opts = {}) {
    if (!name) throw new Error('ChannelAdapter requires a name');
    this.name = name;
    this.accountId = typeof opts.accountId === 'string'
      ? opts.accountId.trim()
      : '';
    if (!this.accountId) this.accountId = 'default';
    this.dmPolicy = ['pairing', 'allowlist', 'open', 'closed'].includes(opts.dmPolicy)
      ? opts.dmPolicy
      : 'pairing';
    this.allowlist = new Set(opts.allowFrom || opts.allowlist || []);
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

  /**
   * Legacy ingress only. New business-channel webhooks must use
   * services/business-channels/registry with its persistent authorizer.
   * There is deliberately no verification bypass.
   */
  async receive(req) {
    if (!await this.verify(req)) return null;
    const parsed = await this.parseInbound(req);
    if (!parsed || this.isDuplicate(parsed) || !this.isAllowed(parsed.accessGroup || parsed.userId)) {
      return null;
    }
    this.metrics.inc(this.name, KINDS.INBOUND);
    return parsed;
  }

  async send(msg) {
    return this.sendOutbound(msg);
  }

  async listThreads() {
    return [];
  }
}

module.exports = { ChannelAdapter };
