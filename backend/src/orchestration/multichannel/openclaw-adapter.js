'use strict';

const {
  DELIVERY_STATUSES,
  DELIVERY_ERRORS_ES,
  createDeliveryReceipt,
  rejectedReceipt,
  acceptedNotDeliveredReceipt,
  deliveredReceipt,
  normalizeTransportResult,
  classifyTransportThrown,
  payloadLooksSecret,
  previewText,
} = require('./delivery-receipt');

const DEFAULT_CHANNELS = Object.freeze([
  'whatsapp', 'telegram', 'slack', 'discord', 'signal', 'imessage',
]);

function resolveOpenClawConfig(env = process.env) {
  return {
    enabled: ['1', 'true', 'yes', 'on'].includes(String(env.OPENCLAW_ENABLED || '').toLowerCase()),
    endpoint: env.OPENCLAW_GATEWAY_URL || '',
    apiKeyConfigured: Boolean(env.OPENCLAW_API_KEY),
    allowedChannels: String(env.OPENCLAW_CHANNELS || DEFAULT_CHANNELS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    siragptInternalEndpoint: env.SIRAGPT_INTERNAL_API_URL || env.BASE_URL || '',
  };
}

function channelAllowed(config, channel) {
  const name = String(channel || '').trim().toLowerCase();
  return Boolean(name) && config.allowedChannels.includes(name);
}

function validateOutboundPayload(config, payload = {}) {
  if (!config.enabled) {
    return rejectedReceipt('openclaw_disabled', { channel: payload.channel || null });
  }
  if (!config.apiKeyConfigured) {
    return rejectedReceipt('missing_api_key', { channel: payload.channel || null });
  }
  const channel = String(payload.channel || '').trim().toLowerCase();
  if (!channelAllowed(config, channel)) {
    return rejectedReceipt('channel_not_allowed', { channel: channel || null });
  }
  const text = String(payload.text || payload.message || payload.content || '').trim();
  if (!text) {
    return rejectedReceipt('empty_message', { channel });
  }
  if (payloadLooksSecret(text) || payloadLooksSecret(payload.apiKey) || payloadLooksSecret(payload.token)) {
    return rejectedReceipt('secret_rejected', { channel });
  }
  const destination = payload.chatId || payload.userId || payload.senderId || payload.to;
  if (!destination) {
    return rejectedReceipt('missing_destination', { channel, preview: text });
  }
  return {
    ok: true,
    channel,
    text,
    destination: String(destination),
    userId: payload.userId || payload.senderId || null,
  };
}

/**
 * Default HTTP transport. Confirmación honesta: 200 sin prueba de envío
 * no cuenta como delivered. fetchImpl es inyectable (tests) o global
 * solo cuando hay endpoint + clave.
 */
async function httpTransport(payload, { endpoint, apiKey, fetchImpl, timeoutMs = 8_000 } = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, delivered: false, code: 'transport_missing' };
  }
  if (!endpoint) {
    return { ok: false, delivered: false, code: 'transport_missing' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        channel: payload.channel,
        text: payload.text,
        chatId: payload.chatId || payload.to || null,
        userId: payload.userId || payload.senderId || null,
      }),
      signal: controller ? controller.signal : undefined,
    });
    let body = null;
    try {
      body = typeof res.json === 'function' ? await res.json() : null;
    } catch {
      body = null;
    }
    if (!res || res.ok !== true) {
      return { ok: false, delivered: false, code: 'transport_failed', status: res && res.status };
    }
    const normalized = normalizeTransportResult(body);
    if (!normalized.confirmed) {
      return {
        ok: false,
        delivered: false,
        code: normalized.code || 'not_confirmed',
        platformMessageId: normalized.platformMessageId,
      };
    }
    return {
      ok: true,
      delivered: true,
      platformMessageId: normalized.platformMessageId,
    };
  } catch (err) {
    return { ok: false, delivered: false, code: classifyTransportThrown(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveTransport(opts = {}, config) {
  if (typeof opts.transport === 'function') return opts.transport;
  // Never infer a live fetch from env alone — that is how "Conectada"
  // false-success happens. Callers that want HTTP pass fetchImpl.
  if (typeof opts.fetchImpl === 'function' && config.endpoint) {
    return (payload) => httpTransport(payload, {
      endpoint: config.endpoint,
      apiKey: opts.env && opts.env.OPENCLAW_API_KEY,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
  }
  return null;
}

async function deliverOutbound(payload = {}, opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || resolveOpenClawConfig(env);
  const validated = validateOutboundPayload(config, payload);
  if (validated.accepted === false) return validated;

  const extra = {
    channel: validated.channel,
    preview: validated.text,
    userId: validated.userId,
    route: 'siragpt-orchestration',
  };

  const transport = resolveTransport({ ...opts, env }, config);
  if (!transport) {
    return acceptedNotDeliveredReceipt('transport_missing', extra);
  }

  try {
    const raw = await transport({
      channel: validated.channel,
      text: validated.text,
      chatId: payload.chatId || payload.to || null,
      userId: validated.userId,
      senderId: payload.senderId || null,
    });
    const normalized = normalizeTransportResult(raw);
    if (normalized.confirmed) {
      return deliveredReceipt({
        ...extra,
        platformMessageId: normalized.platformMessageId,
        mode: 'transport',
      });
    }
    return acceptedNotDeliveredReceipt(normalized.code || 'not_confirmed', {
      ...extra,
      failed: true,
      platformMessageId: normalized.platformMessageId,
      mode: 'transport',
    });
  } catch (err) {
    return acceptedNotDeliveredReceipt(classifyTransportThrown(err), {
      ...extra,
      failed: true,
      mode: 'transport',
    });
  }
}

/**
 * Cron dispatch can confirm acceptance of a turn. That is not channel delivery.
 * Only a transport confirmation upgrades the receipt to delivered.
 */
async function attachCronDeliveryReceipt(dispatchResult, job = {}, opts = {}) {
  const channel = job.channel || job.deliverTo || null;
  const cronJobId = job.id || null;
  if (!channel) {
    return {
      ...dispatchResult,
      delivery: createDeliveryReceipt({
        accepted: dispatchResult && dispatchResult.ok === true,
        delivered: false,
        status: dispatchResult && dispatchResult.ok === true
          ? DELIVERY_STATUSES.ACCEPTED
          : DELIVERY_STATUSES.FAILED,
        errorCode: dispatchResult && dispatchResult.ok === true ? 'cron_not_delivered' : 'cron_dispatch_failed',
        cronJobId,
        preview: job.prompt || job.text,
      }),
    };
  }

  if (!dispatchResult || dispatchResult.ok !== true) {
    return {
      ...dispatchResult,
      delivery: rejectedReceipt('cron_dispatch_failed', {
        channel,
        cronJobId,
        preview: job.prompt || job.text,
      }),
    };
  }

  const text = job.deliveryText || job.reply || job.resultText || dispatchResult.text || dispatchResult.answer;
  const delivery = await deliverOutbound({
    channel,
    text: text || job.prompt,
    chatId: job.chatId || job.to,
    userId: job.userId,
    senderId: job.senderId,
  }, opts);

  if (delivery.accepted && !delivery.delivered && delivery.status === DELIVERY_STATUSES.ACCEPTED) {
    return {
      ...dispatchResult,
      delivery: acceptedNotDeliveredReceipt('cron_not_delivered', {
        channel,
        cronJobId,
        preview: text || job.prompt,
        userId: job.userId,
        route: 'cron-as-turn',
      }),
    };
  }

  return {
    ...dispatchResult,
    delivery: {
      ...delivery,
      cronJobId: cronJobId ? String(cronJobId) : delivery.cronJobId,
      route: delivery.route || 'cron-as-turn',
    },
  };
}

function createOpenClawAdapter({ env = process.env, transport, fetchImpl, timeoutMs } = {}) {
  const config = resolveOpenClawConfig(env);
  const sharedOpts = { env, transport, fetchImpl, timeoutMs, config };

  return {
    config,
    async handleInboundMessage(message = {}) {
      if (!config.enabled) {
        return { accepted: false, delivered: false, reason: 'openclaw_disabled' };
      }
      if (!config.apiKeyConfigured) {
        return { accepted: false, delivered: false, reason: 'missing_OPENCLAW_API_KEY' };
      }
      return {
        accepted: true,
        delivered: false,
        route: 'siragpt-orchestration',
        userId: message.userId || message.senderId || 'external',
        channel: message.channel,
        receipt: createDeliveryReceipt({
          accepted: true,
          delivered: false,
          status: DELIVERY_STATUSES.ACCEPTED,
          errorCode: 'inbound_only',
          channel: message.channel,
          userId: message.userId || message.senderId || 'external',
          preview: message.content || message.text,
          route: 'siragpt-orchestration',
        }),
      };
    },
    async deliverOutbound(payload, opts = {}) {
      return deliverOutbound(payload, { ...sharedOpts, ...opts, env: opts.env || env, config });
    },
    async deliverCronTurn(dispatchResult, job, opts = {}) {
      return attachCronDeliveryReceipt(dispatchResult, job, { ...sharedOpts, ...opts, env: opts.env || env, config });
    },
  };
}

module.exports = {
  createOpenClawAdapter,
  resolveOpenClawConfig,
  deliverOutbound,
  attachCronDeliveryReceipt,
  httpTransport,
  validateOutboundPayload,
  DELIVERY_STATUSES,
  DELIVERY_ERRORS_ES,
  createDeliveryReceipt,
  rejectedReceipt,
  acceptedNotDeliveredReceipt,
  deliveredReceipt,
  previewText,
};
