'use strict';

/**
 * Hermes gateway bridge — JS port of hermes-agent/gateway/*.
 * Unifies OpenClaw multichannel adapter with Hermes send_message semantics.
 */

const { createOpenClawAdapter, resolveOpenClawConfig } = require('../../orchestration/multichannel/openclaw-adapter');

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
  const openclaw = createOpenClawAdapter({ env: opts.env });

  return {
    config,

    listPlatforms() {
      return config.channels.map((channel) => ({
        channel,
        enabled: config.enabled,
        deliveryConfigured: Boolean(config.deliveryEndpoint || config.openclaw.apiKeyConfigured),
      }));
    },

    async handleInboundMessage(message = {}) {
      if (!config.enabled) {
        return { accepted: false, reason: 'hermes_gateway_disabled' };
      }
      const routed = await openclaw.handleInboundMessage(message);
      return {
        ...routed,
        gateway: 'hermes',
        continuityKey: message.continuityKey || `${message.channel}:${message.senderId || message.userId || 'anon'}`,
      };
    },

    async sendMessage(payload = {}) {
      if (!config.enabled) {
        return { ok: false, reason: 'hermes_gateway_disabled' };
      }
      const channel = payload.channel || 'web';
      if (!config.channels.includes(channel)) {
        return { ok: false, reason: 'channel_not_allowed', channel };
      }

      const text = String(payload.text || payload.message || '').trim();
      if (!text) return { ok: false, reason: 'empty_message' };

      if (config.deliveryEndpoint && config.openclaw.apiKeyConfigured) {
        return {
          ok: true,
          mode: 'openclaw_delivery',
          channel,
          queued: true,
          endpoint: config.deliveryEndpoint,
          preview: text.slice(0, 160),
        };
      }

      return {
        ok: true,
        mode: 'siragpt_internal',
        channel,
        delivered: false,
        storedForSession: true,
        preview: text.slice(0, 160),
        hint: 'Configure OPENCLAW_GATEWAY_URL + OPENCLAW_API_KEY for external delivery',
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
