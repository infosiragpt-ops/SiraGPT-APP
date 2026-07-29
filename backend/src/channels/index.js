'use strict';

const { ChannelAdapter } = require('./channel-adapter');
const { TelegramAdapter } = require('./telegram');
const { DiscordAdapter } = require('./discord');
const { SlackAdapter } = require('./slack');
const { WhatsAppAdapter } = require('./whatsapp');
const { EmailAdapter } = require('./email');
const { DedupCache } = require('./dedup-cache');
const { ChannelMetrics, sharedMetrics, KINDS } = require('./metrics');

/**
 * Legacy registry for plugged-in adapter instances. New business-channel
 * ingress uses services/business-channels/registry (factory based).
 */
class ChannelRegistry {
  constructor() { this._adapters = new Map(); }

  register(adapter) {
    if (!(adapter instanceof ChannelAdapter)) {
      throw new Error('ChannelRegistry.register expects a ChannelAdapter');
    }
    this._adapters.set(adapter.name, adapter);
    return adapter;
  }

  get(name) { return this._adapters.get(name); }
  list() { return [...this._adapters.values()]; }
  has(name) { return this._adapters.has(name); }
}

module.exports = {
  ChannelAdapter,
  TelegramAdapter,
  DiscordAdapter,
  SlackAdapter,
  WhatsAppAdapter,
  EmailAdapter,
  DedupCache,
  ChannelMetrics,
  ChannelRegistry,
  sharedMetrics,
  KINDS,
};
