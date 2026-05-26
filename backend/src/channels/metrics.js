'use strict';

/**
 * Per-channel metric counters: inbound/outbound/duplicates/errors.
 * Lightweight in-process registry; can be exposed via /metrics route.
 */
class ChannelMetrics {
  constructor() {
    this._counters = new Map(); // key: `${channel}:${kind}` -> number
  }

  _key(channel, kind) { return `${channel}:${kind}`; }

  inc(channel, kind, n = 1) {
    const k = this._key(channel, kind);
    this._counters.set(k, (this._counters.get(k) || 0) + n);
  }

  get(channel, kind) {
    return this._counters.get(this._key(channel, kind)) || 0;
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._counters) {
      const [channel, kind] = k.split(':');
      out[channel] = out[channel] || {};
      out[channel][kind] = v;
    }
    return out;
  }

  reset() { this._counters.clear(); }
}

const KINDS = Object.freeze({
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
  DUPLICATE: 'duplicate',
  VERIFY_FAIL: 'verify_fail',
  ERROR: 'error',
  WATCHDOG_RESTART: 'watchdog_restart',
});

const sharedMetrics = new ChannelMetrics();

module.exports = { ChannelMetrics, KINDS, sharedMetrics };
