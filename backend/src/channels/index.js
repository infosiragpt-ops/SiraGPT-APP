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
 * Lightweight registry for plugged-in channel adapters. Every entry is
 * scoped by channel kind plus its business-channel/account id.
 */
class ChannelRegistry {
  constructor() { this._adapters = new Map(); }

  static key(name, accountId = 'default') {
    return `${name}:${accountId}`;
  }

  register(adapter) {
    if (!(adapter instanceof ChannelAdapter)) {
      throw new Error('ChannelRegistry.register expects a ChannelAdapter');
    }
    this._adapters.set(ChannelRegistry.key(adapter.name, adapter.accountId), adapter);
    return adapter;
  }

  get(name, accountId = 'default') {
    return this._adapters.get(ChannelRegistry.key(name, accountId));
  }
  list() { return [...this._adapters.values()]; }
  has(name, accountId = 'default') {
    return this._adapters.has(ChannelRegistry.key(name, accountId));
  }
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
