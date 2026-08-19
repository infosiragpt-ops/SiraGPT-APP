'use strict';

function resolveOpenClawConfig(env = process.env) {
  return {
    enabled: ['1', 'true', 'yes', 'on'].includes(String(env.OPENCLAW_ENABLED || '').toLowerCase()),
    endpoint: env.OPENCLAW_GATEWAY_URL || '',
    apiKeyConfigured: Boolean(env.OPENCLAW_API_KEY),
    allowedChannels: String(env.OPENCLAW_CHANNELS || 'whatsapp,telegram,slack,discord,signal,imessage')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    siragptInternalEndpoint: env.SIRAGPT_INTERNAL_API_URL || env.BASE_URL || '',
  };
}

function createOpenClawAdapter({ env = process.env } = {}) {
  const config = resolveOpenClawConfig(env);
  return {
    config,
    async handleInboundMessage(message) {
      if (!config.enabled) {
        return { accepted: false, reason: 'openclaw_disabled' };
      }
      if (!config.apiKeyConfigured) {
        return { accepted: false, reason: 'missing_OPENCLAW_API_KEY' };
      }
      return {
        accepted: true,
        route: 'siragpt-orchestration',
        userId: message.userId || message.senderId || 'external',
        channel: message.channel,
      };
    },
  };
}

module.exports = { createOpenClawAdapter, resolveOpenClawConfig };
