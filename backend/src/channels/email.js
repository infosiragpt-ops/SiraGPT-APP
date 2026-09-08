'use strict';

const { ChannelAdapter } = require('./channel-adapter');

/**
 * Gmail/IMAP bridge. Provider-specific OAuth and IMAP code stays outside this
 * adapter; injected functions make the normalized channel contract reusable.
 */
class EmailAdapter extends ChannelAdapter {
  constructor(opts = {}) {
    super('email', opts);
    if (typeof opts.receiveImpl !== 'function') {
      throw new Error('EmailAdapter requires receiveImpl');
    }
    if (typeof opts.sendImpl !== 'function') {
      throw new Error('EmailAdapter requires sendImpl');
    }
    this.receiveImpl = opts.receiveImpl;
    this.sendImpl = opts.sendImpl;
    this.listThreadsImpl = typeof opts.listThreadsImpl === 'function'
      ? opts.listThreadsImpl
      : async () => [];
  }

  verify(req) {
    return req?.trustedInternal === true;
  }

  async parseInbound(req) {
    const message = await this.receiveImpl(req);
    if (!message?.id || !message?.from) return null;
    return {
      id: String(message.id),
      channel: this.name,
      userId: String(message.from),
      chatId: String(message.threadId || message.id),
      text: String(message.body || message.snippet || ''),
      accessGroup: String(message.from),
      raw: message,
      ts: message.receivedAt ? Date.parse(message.receivedAt) : Date.now(),
    };
  }

  async sendOutbound(message) {
    return this.sendImpl(message);
  }

  async listThreads(options) {
    return this.listThreadsImpl(options);
  }
}

module.exports = { EmailAdapter };
