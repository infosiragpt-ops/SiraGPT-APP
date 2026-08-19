'use strict';

const { ChannelAdapter } = require('./channel-adapter');
const { KINDS } = require('./metrics');
const { retryWithBackoff, parseRetryAfterHeader } = require('./retry');

/**
 * Telegram Bot API adapter.
 *
 * Webhook verification: matches the secret token submitted in the
 * `X-Telegram-Bot-Api-Secret-Token` header (set when registering the webhook).
 *
 * Polling watchdog: when polling is started via `startPolling`, the adapter
 * tracks the timestamp of the last successful `getUpdates`. If the gap exceeds
 * `staleThresholdMs` (default 60s) the polling loop is auto-restarted.
 */
class TelegramAdapter extends ChannelAdapter {
  /**
   * @param {{
   *   botToken: string,
   *   webhookSecret?: string,
   *   apiBase?: string,
   *   pollIntervalMs?: number,
   *   staleThresholdMs?: number,
   *   accessGroupResolver?: (msg: object) => string | undefined,
   * } & ConstructorParameters<typeof ChannelAdapter>[1]} opts
   */
  constructor(opts = {}) {
    super('telegram', opts);
    if (!opts.botToken) throw new Error('TelegramAdapter requires botToken');
    this.botToken = opts.botToken;
    this.webhookSecret = opts.webhookSecret || null;
    this.apiBase = opts.apiBase || 'https://api.telegram.org';
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.staleThresholdMs = opts.staleThresholdMs ?? 60_000;
    this.accessGroupResolver = opts.accessGroupResolver || null;

    this._offset = 0;
    this._polling = false;
    this._pollTimer = null;
    this._watchdogTimer = null;
    this._lastPollAt = 0;
    this._restartCount = 0;
  }

  async verify(req) {
    if (!this.webhookSecret) return true; // no secret configured ⇒ accept.
    const got = req?.headers?.['x-telegram-bot-api-secret-token']
      ?? req?.headers?.['X-Telegram-Bot-Api-Secret-Token'];
    const ok = !!got && constantTimeEqual(got, this.webhookSecret);
    if (!ok) this.metrics.inc(this.name, KINDS.VERIFY_FAIL);
    return ok;
  }

  parseInbound(req) {
    const update = req?.body || req || {};
    const msg = update.message || update.edited_message || update.channel_post;
    if (!msg) return null;
    const id = `${msg.chat?.id ?? ''}:${msg.message_id}`;
    const accessGroup = this.accessGroupResolver
      ? this.accessGroupResolver(msg)
      : undefined;
    return {
      id,
      channel: this.name,
      userId: String(msg.from?.id ?? msg.chat?.id ?? ''),
      chatId: String(msg.chat?.id ?? ''),
      text: msg.text || msg.caption || '',
      accessGroup,
      raw: update,
      ts: Date.now(),
    };
  }

  async sendOutbound(msg) {
    if (!msg?.chatId) throw new Error('TelegramAdapter.sendOutbound requires chatId');
    const url = `${this.apiBase}/bot${this.botToken}/sendMessage`;
    const payload = {
      chat_id: msg.chatId,
      text: msg.text ?? '',
      ...(msg.extra || {}),
    };
    const res = await retryWithBackoff(async () => {
      const r = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await safeJson(r);
      const retryAfter = body?.parameters?.retry_after;
      const headerRetryAfter = parseRetryAfterHeader(r.headers?.get?.('retry-after'));
      return {
        ok: r.ok,
        status: r.status,
        body,
        retryAfterMs: retryAfter ? retryAfter * 1000 : headerRetryAfter,
      };
    });
    if (!res.ok) {
      this.metrics.inc(this.name, KINDS.ERROR);
      const err = new Error(`telegram sendMessage failed: ${res.status}`);
      err.body = res.body;
      throw err;
    }
    this.metrics.inc(this.name, KINDS.OUTBOUND);
    return res.body;
  }

  // ── Long polling ──────────────────────────────────────────────────────────

  startPolling(onUpdate) {
    if (this._polling) return;
    this._polling = true;
    this._lastPollAt = Date.now();
    this._loop(onUpdate).catch(() => {});
    this._watchdogTimer = setInterval(() => this._watchdog(onUpdate), Math.max(this.staleThresholdMs / 2, 5_000));
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  stopPolling() {
    this._polling = false;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
  }

  isStale(now = Date.now()) {
    return this._polling && (now - this._lastPollAt) > this.staleThresholdMs;
  }

  get restartCount() { return this._restartCount; }

  async _loop(onUpdate) {
    while (this._polling) {
      try {
        const url = `${this.apiBase}/bot${this.botToken}/getUpdates?timeout=25&offset=${this._offset}`;
        const r = await this.fetchImpl(url);
        const body = await safeJson(r);
        this._lastPollAt = Date.now();
        if (body?.result?.length) {
          for (const update of body.result) {
            this._offset = Math.max(this._offset, (update.update_id || 0) + 1);
            const parsed = this.parseInbound({ body: update });
            if (!parsed) continue;
            if (this.isDuplicate(parsed)) continue;
            this.metrics.inc(this.name, KINDS.INBOUND);
            try { await onUpdate(parsed); }
            catch { this.metrics.inc(this.name, KINDS.ERROR); }
          }
        }
      } catch {
        this.metrics.inc(this.name, KINDS.ERROR);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  _watchdog(onUpdate) {
    if (!this._polling) return;
    if (this.isStale()) {
      this._restartCount++;
      this.metrics.inc(this.name, KINDS.WATCHDOG_RESTART);
      // Kick a fresh loop; the previous one will exit on next iteration check.
      this._polling = false;
      setImmediate(() => {
        this._polling = true;
        this._lastPollAt = Date.now();
        this._loop(onUpdate).catch(() => {});
      });
    }
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function safeJson(r) { try { return await r.json(); } catch { return null; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { TelegramAdapter };
