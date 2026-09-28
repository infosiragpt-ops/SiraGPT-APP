'use strict';

/**
 * slack-integration — sends Block-kit formatted notifications to a Slack
 * Incoming Webhook URL. The service is NOT auto-wired into the app
 * elsewhere; it's invoked by trigger-registry when the user has an
 * active SlackIntegration row.
 *
 * Public API:
 *   buildBlocks({ event, userId, payload })           → object (Slack JSON body)
 *   sendEventNotification({ webhookUrl, event, … })   → Promise<{ ok, status }>
 *   sendRawMessage(webhookUrl, body)                  → Promise<{ ok, status }>
 *   encryptToken(plain) / decryptToken(cipher)        → string (AES-256-GCM)
 *   webhookDecryptFailure()                           → { status, body } (409/503)
 *
 * Encryption key, first match wins:
 *   1. SLACK_ENCRYPTION_KEY (32 bytes, hex or base64)
 *   2. SIRAGPT_ENCRYPTION_KEY (existing ciphertext stays readable)
 *   3. HKDF-SHA256 subkey of the mandatory ENCRYPTION_KEY (info
 *      'siragpt/slack-webhook/v1'): stable across restarts, no key reuse
 *   4. a per-process random key — only outside production (unit tests
 *      round-trip within one process).
 * A per-process key in production made every saved webhook undecryptable
 * after the next deploy (one restart per merge), so production with no key
 * throws slack_encryption_unconfigured instead.
 */

const crypto = require('crypto');

const ENC_ALGO = 'aes-256-gcm';
const SLACK_KEY_HKDF_INFO = 'siragpt/slack-webhook/v1';
const SLACK_ENCRYPTION_UNCONFIGURED = 'slack_encryption_unconfigured';
const SLACK_RECONNECT_REQUIRED = 'slack_reconnect_required';
let cachedKey = null;

function keyFromSecret(raw) {
  let buf = null;
  try { buf = Buffer.from(raw, 'hex'); } catch { buf = null; }
  if (!buf || buf.length !== 32) {
    try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; }
  }
  if (buf && buf.length === 32) return buf;
  // Last resort: derive a key from the string
  return crypto.createHash('sha256').update(raw).digest();
}

function slackEncryptionUnconfiguredError() {
  const err = new Error('Slack no está disponible: falta la clave de cifrado del servidor. Avisa al administrador.');
  err.code = SLACK_ENCRYPTION_UNCONFIGURED;
  err.status = 503;
  return err;
}

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.SLACK_ENCRYPTION_KEY || process.env.SIRAGPT_ENCRYPTION_KEY || '';
  if (raw) {
    cachedKey = keyFromSecret(raw);
    return cachedKey;
  }
  const master = String(process.env.ENCRYPTION_KEY || '').trim();
  if (master) {
    const ikm = /^[0-9a-f]{64}$/i.test(master) ? Buffer.from(master, 'hex') : Buffer.from(master, 'utf8');
    cachedKey = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), SLACK_KEY_HKDF_INFO, 32));
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production') throw slackEncryptionUnconfiguredError();
  cachedKey = crypto.randomBytes(32);
  return cachedKey;
}

/**
 * HTTP answer for a stored webhook that no longer decrypts: 409 «vuelve a
 * pegar el webhook» (it was saved under a key this process no longer has),
 * or a 503 when the server has no encryption key at all. Never a raw 500.
 */
function webhookDecryptFailure() {
  try {
    getKey();
  } catch (err) {
    if (err && err.code === SLACK_ENCRYPTION_UNCONFIGURED) {
      return { status: 503, body: { error: SLACK_ENCRYPTION_UNCONFIGURED, code: SLACK_ENCRYPTION_UNCONFIGURED, message: err.message } };
    }
  }
  return {
    status: 409,
    body: {
      error: SLACK_RECONNECT_REQUIRED,
      code: SLACK_RECONNECT_REQUIRED,
      message: 'La conexión con Slack caducó; vuelve a pegar el webhook.',
    },
  };
}

function encryptToken(plain) {
  if (plain == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptToken(cipherText) {
  if (!cipherText) return null;
  try {
    const buf = Buffer.from(cipherText, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ENC_ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function summarizePayload(payload, max = 240) {
  try {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  } catch { return ''; }
}

function buildBlocks({ event, userId, payload }) {
  const evt = String(event || 'event');
  const summary = summarizePayload(payload);
  return {
    text: `SiraGPT: ${evt}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `SiraGPT · ${evt}`, emoji: false },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `*user:* ${userId || 'unknown'}` },
          { type: 'mrkdwn', text: `*ts:* ${new Date().toISOString()}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '```' + summary + '```' },
      },
    ],
  };
}

async function sendRawMessage(webhookUrl, body, opts = {}) {
  if (!webhookUrl || typeof webhookUrl !== 'string') throw new Error('webhookUrl required');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const fetchFn = opts.fetch || globalThis.fetch;
  try {
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: ac.signal,
    });
    return { ok: !!res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function sendEventNotification({ webhookUrl, event, userId, payload, fetch: fetchFn }) {
  const body = buildBlocks({ event, userId, payload });
  return sendRawMessage(webhookUrl, body, { fetch: fetchFn });
}

module.exports = {
  buildBlocks,
  sendEventNotification,
  sendRawMessage,
  encryptToken,
  decryptToken,
  webhookDecryptFailure,
  SLACK_ENCRYPTION_UNCONFIGURED,
  SLACK_RECONNECT_REQUIRED,
};
