'use strict';

const crypto = require('node:crypto');

/**
 * business-channels/adapters/telegram — Telegram Bot API channel adapter.
 *
 * Native rewrite of OpenClaw's telegram channel (MIT,
 * github.com/openclaw/openclaw src/channels) on the business-channels
 * adapter contract (../adapter-contract). Decisions shared with the
 * deployed telegram bridge (services/telegram/telegram-control.js) so both
 * surfaces behave identically against the Bot API:
 *   - api base https://api.telegram.org, POST /bot<token>/<method>
 *   - outbound text capped at 4096 chars (Bot API hard limit)
 *   - per-request deadline via AbortSignal.timeout (default 10s)
 *   - message text falls back to caption for media messages
 *
 * Security: the bot token comes ONLY from the injected channel config (the
 * encrypted per-channel store) — never from process.env, and it is scrubbed
 * from every error message/URL this module ever throws or returns. Webhook
 * ingress fails closed unless Telegram's secret-token header matches the
 * independently configured webhookSecret.
 *
 * receive() accepts Telegram webhook updates and normalises `message` and
 * `edited_message` envelopes into the canonical InboxMessage; every other
 * update kind (callback_query, channel_post, my_chat_member, …) returns null
 * so callers can ack-and-drop without special cases.
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_TEXT_LENGTH = 4096; // Bot API sendMessage hard limit.
const DEFAULT_TIMEOUT_MS = 10_000;
const WEBHOOK_SECRET_MIN_LENGTH = 32;
const WEBHOOK_SECRET_MAX_LENGTH = 256;
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]+$/u;

class TelegramApiError extends Error {
  constructor(message, { code = 'telegram_api_error', status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Remove the bot token from any string that might reach logs or callers. */
function redactToken(text, token) {
  const raw = String(text || '');
  if (!token) return raw;
  return raw.split(token).join('[redacted]');
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function singleHeaderValue(headers, name) {
  if (!headers) return null;
  const expectedName = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (typeof value !== 'string' || !value || value.includes(',')) return null;
    return value;
  }
  if (typeof headers !== 'object' || Array.isArray(headers)) return null;
  const matches = Object.entries(headers)
    .filter(([key]) => String(key).toLowerCase() === expectedName);
  if (matches.length !== 1) return null;
  const value = matches[0][1];
  if (Array.isArray(value) || typeof value !== 'string' || !value) return null;
  return value;
}

function constantTimeSecretEqual(provided, expected) {
  const providedDigest = crypto.createHash('sha256').update(String(provided || '')).digest();
  const expectedDigest = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * @param {object} [deps]
 * @param {{ botToken?: string, webhookSecret?: string }} [deps.config]
 *   Channel config, decrypted by the caller. Never logged.
 * @param {typeof fetch} [deps.fetchImpl] Injectable fetch for offline tests.
 * @param {string} [deps.apiBase] Injectable only by trusted code/tests.
 * @param {number} [deps.timeoutMs] Injectable only by trusted code/tests.
 */
function createTelegramAdapter(deps = {}) {
  const config = deps.config || {};
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const apiBase = deps.apiBase || TELEGRAM_API_BASE;
  const requestedTimeoutMs = Number(deps.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.min(requestedTimeoutMs, 30_000)
    : DEFAULT_TIMEOUT_MS;

  function tokenFrom(cfg) {
    return String((cfg && cfg.botToken) || '').trim();
  }

  function webhookSecretFrom(cfg) {
    return typeof cfg?.webhookSecret === 'string' ? cfg.webhookSecret : '';
  }

  function validWebhookSecret(cfg) {
    const secret = webhookSecretFrom(cfg);
    return (
      secret.length >= WEBHOOK_SECRET_MIN_LENGTH
      && secret.length <= WEBHOOK_SECRET_MAX_LENGTH
      && WEBHOOK_SECRET_PATTERN.test(secret)
    );
  }

  async function callApi(method, payload, cfg) {
    const token = tokenFrom(cfg);
    if (!token) {
      throw new TelegramApiError('telegram config has no botToken', { code: 'missing_bot_token' });
    }
    let res;
    try {
      res = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network/timeout errors can echo the request URL (token included).
      throw new TelegramApiError(
        `telegram ${method} request failed: ${redactToken(err && err.message, token)}`,
        { code: 'network_error' },
      );
    }
    const body = await safeJson(res);
    if (!res.ok || !body || body.ok !== true) {
      const description = redactToken(body && body.description, token) || `HTTP ${res.status}`;
      const retryAfterSec = body && body.parameters && body.parameters.retry_after;
      throw new TelegramApiError(`telegram ${method} failed: ${description}`, {
        status: res.status,
        retryAfterMs: Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : null,
      });
    }
    return body.result;
  }

  /**
   * Verify Telegram's X-Telegram-Bot-Api-Secret-Token header. This method is
   * deliberately independent from receive() so the registry can authenticate
   * the request before parsing or exposing any provider payload.
   */
  function verifyInbound({ headers } = {}) {
    const expected = webhookSecretFrom(config);
    const provided = singleHeaderValue(headers, 'x-telegram-bot-api-secret-token');
    if (!validWebhookSecret(config) || !provided) return false;
    return constantTimeSecretEqual(provided, expected);
  }

  /** Webhook update → canonical InboxMessage, or null for ignorable updates. */
  function receive(update) {
    if (!update || typeof update !== 'object') return null;
    const message = update.message || update.edited_message;
    if (
      !message
      || !message.chat
      || message.chat.id === undefined
      || message.message_id === undefined
    ) return null;
    const senderId = message.from && message.from.id !== undefined ? message.from.id : message.chat.id;
    return {
      channelKind: 'telegram',
      // message_id is only unique within one chat. The database idempotency
      // key is {businessChannelId, externalId}, so include the chat id.
      externalId: `${message.chat.id}:${message.message_id}`,
      from: String(senderId),
      text: String(message.text || message.caption || ''),
      ts: Number.isFinite(message.date) ? message.date * 1000 : Date.now(),
      threadId: String(message.chat.id),
      raw: update,
    };
  }

  /** Send a plain-text message. `to` is the Telegram chat id (threadId). */
  async function send({ to, text } = {}) {
    if (to === undefined || to === null || String(to).trim() === '') {
      throw new TelegramApiError('send requires a destination chat id', { code: 'missing_destination' });
    }
    const result = await callApi('sendMessage', {
      chat_id: to,
      text: String(text || '').slice(0, MAX_TEXT_LENGTH),
      disable_web_page_preview: true,
    }, config);
    return { ok: true, externalId: String(result && result.message_id) };
  }

  /** Validate the channel config against the live Bot API (getMe). */
  async function verifyConfig(cfg = config) {
    const errors = [];
    if (!tokenFrom(cfg)) errors.push('missing_bot_token');
    if (!webhookSecretFrom(cfg)) {
      errors.push('missing_webhook_secret');
    } else if (!validWebhookSecret(cfg)) {
      errors.push('invalid_webhook_secret');
    }
    if (errors.length > 0) return { ok: false, errors };
    try {
      const me = await callApi('getMe', {}, cfg);
      return { ok: true, errors: [], bot: { id: me && me.id, username: me && me.username } };
    } catch (err) {
      return { ok: false, errors: [`getMe_failed: ${err && err.message ? err.message : 'unknown error'}`] };
    }
  }

  return { kind: 'telegram', verifyInbound, receive, send, verifyConfig };
}

module.exports = {
  createTelegramAdapter,
  TelegramApiError,
  TELEGRAM_API_BASE,
  MAX_TEXT_LENGTH,
  WEBHOOK_SECRET_MIN_LENGTH,
  WEBHOOK_SECRET_MAX_LENGTH,
  singleHeaderValue,
};
