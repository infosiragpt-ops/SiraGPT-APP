'use strict';

const { DedupCache } = require('./dedup-cache');
const { sharedMetrics, KINDS } = require('./metrics');

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
   * @param {{ allowlist?: string[], dedup?: DedupCache, metrics?: object, fetchImpl?: typeof fetch }} [opts]
   */
  constructor(name, opts = {}) {
    if (!name) throw new Error('ChannelAdapter requires a name');
    this.name = name;
    this.allowlist = new Set(opts.allowlist || []);
    this.dedup = opts.dedup || new DedupCache();
    this.metrics = opts.metrics || sharedMetrics;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
  }

  /**
   * Returns true when no allowlist is configured or `accessGroup` is in it.
   * `accessGroup` may be undefined; in that case it's allowed only if no
   * allowlist is configured.
   */
  isAllowed(accessGroup) {
    if (this.allowlist.size === 0) return true;
    if (!accessGroup) return false;
    return this.allowlist.has(accessGroup);
  }

  /**
   * @param {{ id: string }} parsed
   * @returns {boolean} true if duplicate, false if newly seen.
   */
  isDuplicate(parsed) {
    if (!parsed || !parsed.id) return false;
    const fresh = this.dedup.add(`${this.name}:${parsed.id}`);
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
}

module.exports = { ChannelAdapter };
