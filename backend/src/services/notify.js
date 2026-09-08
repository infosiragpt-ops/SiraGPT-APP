'use strict';

/**
 * notify.js — unified notification dispatcher (company-os master plan E5/P4.4).
 *
 * Transport-agnostic fan-out: the caller injects one async function per
 * channel and this module handles preferences, dedupe and best-effort
 * delivery. It deliberately owns NO SMTP/Telegram/webpush code so it can be
 * unit-tested offline and reused by the cowork approval queue, the CEO daily
 * digest (P4.4) and any future channel.
 *
 * Real transports available in this repo (NOT modified here — inject them):
 *
 *  - email    → `backend/src/services/email.js` (nodemailer singleton).
 *               Injection sketch:
 *                 const emailService = require('./email');
 *                 transports.email = async ({ userId, title, body }) => {
 *                   // resolve the user's address via Prisma, then:
 *                   await emailService._send({ to, subject: title, text: body });
 *                 };
 *
 *  - telegram → `backend/src/services/telegram/telegram-control.js`
 *               (`getTelegramConfig()` + `sendTelegramMessage(token, chatId, text)`).
 *               Injection sketch:
 *                 const tg = require('./telegram/telegram-control');
 *                 transports.telegram = async ({ title, body }) => {
 *                   const cfg = tg.getTelegramConfig();
 *                   if (!cfg.enabled) throw new Error('telegram_not_configured');
 *                   await tg.sendTelegramMessage(cfg.token, cfg.allowedChatIds[0],
 *                     `*${title}*\n${body}`);
 *                 };
 *
 *  - webpush  → `backend/src/services/webpush-delivery.js`
 *               (`maybeDeliver(prisma, notification)`, VAPID-gated, fire-and-forget).
 *               Injection sketch:
 *                 const webpush = require('./webpush-delivery');
 *                 transports.webpush = async ({ userId, title, body }) => {
 *                   await webpush.maybeDeliver(prisma,
 *                     { userId, title, message: body, severity: 'critical' });
 *                 };
 *
 *  - See also `backend/src/services/cowork/notify.js`: an earlier, Prisma-coupled
 *    email+telegram+in_app wiring. This dispatcher is the decoupled superset that
 *    wiring can converge on; it is intentionally left untouched.
 *
 * Contract:
 *   createNotifier({ transports, prefsProvider?, now?, dedupeTtlMs? })
 *     → { notify }
 *   notify({ userId, kind, title, body, dedupeKey? })
 *     → { delivered: [channel], failed: [{ channel, error }], deduped: boolean }
 *
 * Rules:
 *   - Best-effort per channel: one throwing transport never blocks the rest.
 *   - Dedupe by `dedupeKey` with a 10-minute TTL (in-memory map, lazy pruning).
 *   - `prefsProvider(userId)` → `{ channels: ['email', ...] }` decides the
 *     fan-out; default (absent/broken provider) is every injected transport.
 *   - Payloads carry ONLY { userId, kind, title, body } — never credentials —
 *     and obvious secret material in the text is redacted defensively.
 */

const NOTIFY_KINDS = Object.freeze(['task_done', 'task_error', 'approval_pending', 'digest']);

const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_DEDUPE_ENTRIES = 5000; // hard cap so the map can never grow unbounded
const MAX_TEXT_CHARS = 4000;
const MAX_DIGEST_ITEM_CHARS = 160;

// Defensive redaction of secret-looking material that a careless caller may
// have interpolated into title/body. Payloads must NEVER include secrets.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI-style API keys
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, // Authorization bearer values
  /\b(api[_-]?key|token|secret|password|contraseña)\s*[:=]\s*[^\s,;]{6,}/gi, // key=value pairs
];

function sanitizeText(value, max = MAX_TEXT_CHARS) {
  let text = value == null ? '' : String(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  return text.slice(0, max);
}

const KIND_LABELS = Object.freeze({
  task_done: 'Completado',
  task_error: 'Error',
  approval_pending: 'Aprobación pendiente',
  digest: 'Resumen',
});

/**
 * Builds the compact Spanish daily-digest body (P4.4 "Digest del CEO").
 * Pure and deterministic: same items → same string.
 *
 * @param {{ items?: Array<{ kind?: string, title?: string, body?: string }> }} input
 * @returns {string}
 */
function buildDigestBody({ items } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) {
    return 'Resumen diario: sin novedades.';
  }
  const lines = [`Resumen diario — ${list.length} ${list.length === 1 ? 'elemento' : 'elementos'}:`];
  list.forEach((item, index) => {
    const label = KIND_LABELS[item.kind] || 'Nota';
    const title = sanitizeText(item.title, MAX_DIGEST_ITEM_CHARS) || '(sin título)';
    const body = sanitizeText(item.body, MAX_DIGEST_ITEM_CHARS);
    lines.push(`${index + 1}. [${label}] ${title}${body ? ` — ${body}` : ''}`);
  });
  return lines.join('\n');
}

/**
 * @param {object} [options]
 * @param {Record<string, Function>} [options.transports] — map channel → async fn({userId, kind, title, body}).
 * @param {Function} [options.prefsProvider] — async (userId) → { channels: string[] }.
 * @param {Function} [options.now] — clock override (ms), for tests.
 * @param {number} [options.dedupeTtlMs] — dedupe window, default 10 min.
 */
function createNotifier({
  transports = {},
  prefsProvider = null,
  now = Date.now,
  dedupeTtlMs = DEFAULT_DEDUPE_TTL_MS,
} = {}) {
  const channelNames = Object.keys(transports).filter(
    (name) => typeof transports[name] === 'function',
  );
  const dedupeMap = new Map(); // dedupeKey → sentAtMs

  function pruneDedupe(nowMs) {
    for (const [key, sentAt] of dedupeMap) {
      if (nowMs - sentAt >= dedupeTtlMs) dedupeMap.delete(key);
    }
    // Safety valve: evict oldest entries beyond the hard cap.
    while (dedupeMap.size > MAX_DEDUPE_ENTRIES) {
      const oldest = dedupeMap.keys().next().value;
      dedupeMap.delete(oldest);
    }
  }

  async function resolveChannels(userId) {
    if (typeof prefsProvider !== 'function') return channelNames;
    try {
      const prefs = await prefsProvider(userId);
      const requested = prefs && Array.isArray(prefs.channels) ? prefs.channels : null;
      if (!requested) return channelNames;
      // Preferences pick the fan-out, but only among injected transports.
      return requested.filter((name) => channelNames.includes(name));
    } catch (_error) {
      // Broken prefs must never block delivery — fall back to every transport.
      return channelNames;
    }
  }

  /**
   * @param {object} input
   * @param {string} input.userId
   * @param {'task_done'|'task_error'|'approval_pending'|'digest'} input.kind
   * @param {string} input.title
   * @param {string} input.body
   * @param {string} [input.dedupeKey]
   * @returns {Promise<{ delivered: string[], failed: Array<{channel: string, error: string}>, deduped: boolean }>}
   */
  async function notify({ userId, kind, title, body, dedupeKey } = {}) {
    if (!NOTIFY_KINDS.includes(kind)) {
      throw new Error(`notify: unknown kind "${kind}" (expected one of ${NOTIFY_KINDS.join(', ')})`);
    }

    const nowMs = now();
    pruneDedupe(nowMs);

    if (dedupeKey != null && dedupeKey !== '') {
      const key = String(dedupeKey);
      if (dedupeMap.has(key)) {
        return { delivered: [], failed: [], deduped: true };
      }
      dedupeMap.set(key, nowMs);
    }

    // Explicit whitelist — no caller-supplied extras (tokens, headers, prisma
    // handles…) can ever leak into a transport payload.
    const payload = Object.freeze({
      userId: userId == null ? null : String(userId),
      kind,
      title: sanitizeText(title, 300),
      body: sanitizeText(body),
    });

    const targets = await resolveChannels(payload.userId);
    const delivered = [];
    const failed = [];

    // Best-effort per channel: run all transports, isolate every failure.
    await Promise.all(
      targets.map(async (channel) => {
        try {
          await transports[channel](payload);
          delivered.push(channel);
        } catch (error) {
          failed.push({ channel, error: error?.message ? String(error.message) : String(error) });
        }
      }),
    );

    // Promise.all resolution order is scheduling-dependent — normalise to the
    // declared channel order so results are deterministic for callers/tests.
    const order = (name) => targets.indexOf(name);
    delivered.sort((a, b) => order(a) - order(b));
    failed.sort((a, b) => order(a.channel) - order(b.channel));

    return { delivered, failed, deduped: false };
  }

  return { notify };
}

module.exports = {
  createNotifier,
  buildDigestBody,
  sanitizeText,
  NOTIFY_KINDS,
  DEFAULT_DEDUPE_TTL_MS,
};
