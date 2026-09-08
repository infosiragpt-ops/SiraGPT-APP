'use strict';

/**
 * Hermes gateway bridge — JS port of hermes-agent/gateway/*.
 * Unifies OpenClaw multichannel adapter with Hermes send_message semantics.
 */

const { createOpenClawAdapter, resolveOpenClawConfig } = require('../../orchestration/multichannel/openclaw-adapter');
const { rejectedReceipt } = require('../../orchestration/multichannel/delivery-receipt');

const DEFAULT_CHANNELS = Object.freeze([
  'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'imessage', 'email', 'web',
]);

function resolveHermesGatewayConfig(env = process.env) {
  const openclaw = resolveOpenClawConfig(env);
  const hermesEnabled = ['1', 'true', 'yes', 'on'].includes(String(env.HERMES_GATEWAY_ENABLED || '1').toLowerCase());
  const channels = String(env.HERMES_GATEWAY_CHANNELS || env.OPENCLAW_CHANNELS || DEFAULT_CHANNELS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    enabled: hermesEnabled && openclaw.enabled,
    openclaw,
    channels,
    deliveryEndpoint: env.HERMES_GATEWAY_DELIVERY_URL || openclaw.endpoint || '',
    siragptInternalEndpoint: openclaw.siragptInternalEndpoint,
  };
}

function createHermesGateway(opts = {}) {
  const config = resolveHermesGatewayConfig(opts.env);
  const openclaw = createOpenClawAdapter({
    env: opts.env,
    transport: opts.transport,
    fetchImpl: opts.fetchImpl,
  });
  const deliveryConfig = {
    ...openclaw.config,
    enabled: config.enabled,
    allowedChannels: config.channels,
    endpoint: config.deliveryEndpoint || openclaw.config.endpoint,
  };

  return {
    config,

    listPlatforms() {
      return config.channels.map((channel) => ({
        channel,
        enabled: config.enabled,
        // Endpoint/key presence is configuration, not a Conectada/delivered proof.
        deliveryConfigured: Boolean(config.deliveryEndpoint && config.openclaw.apiKeyConfigured),
        connected: false,
      }));
    },

    async handleInboundMessage(message = {}) {
      if (!config.enabled) {
        return { accepted: false, delivered: false, reason: 'hermes_gateway_disabled' };
      }
      const routed = await openclaw.handleInboundMessage(message);
      return {
        ...routed,
        delivered: routed.delivered === true,
        gateway: 'hermes',
        continuityKey: message.continuityKey || `${message.channel}:${message.senderId || message.userId || 'anon'}`,
      };
    },

    async sendMessage(payload = {}) {
      if (!config.enabled) {
        const receipt = rejectedReceipt('hermes_gateway_disabled', { channel: payload.channel || null });
        return { ok: false, accepted: false, delivered: false, reason: 'hermes_gateway_disabled', receipt };
      }
      const channel = payload.channel || 'web';
      if (!config.channels.includes(channel)) {
        const receipt = rejectedReceipt('channel_not_allowed', { channel });
        return { ok: false, accepted: false, delivered: false, reason: 'channel_not_allowed', channel, receipt };
      }

      const receipt = await openclaw.deliverOutbound(
        { ...payload, channel },
        {
          env: opts.env,
          config: deliveryConfig,
          transport: opts.transport,
          fetchImpl: opts.transport
            ? undefined
            : (opts.fetchImpl !== undefined
              ? opts.fetchImpl
              : (deliveryConfig.endpoint ? globalThis.fetch : undefined)),
        },
      );

      return {
        ok: receipt.delivered === true,
        accepted: receipt.accepted === true,
        delivered: receipt.delivered === true,
        reason: receipt.error ? receipt.error.code : undefined,
        channel: receipt.channel,
        preview: receipt.preview,
        receipt,
        mode: receipt.delivered ? 'openclaw_delivery' : (receipt.accepted ? 'accepted_only' : 'rejected'),
      };
    },

    status() {
      return {
        enabled: config.enabled,
        channels: config.channels,
        openclaw: {
          enabled: config.openclaw.enabled,
          apiKeyConfigured: config.openclaw.apiKeyConfigured,
          endpointConfigured: Boolean(config.openclaw.endpoint),
        },
      };
    },
  };
}

let _singleton = null;

function getHermesGateway(opts = {}) {
  if (!_singleton || opts.refresh) _singleton = createHermesGateway(opts);
  return _singleton;
}

module.exports = {
  DEFAULT_CHANNELS,
  resolveHermesGatewayConfig,
  createHermesGateway,
  getHermesGateway,
};
