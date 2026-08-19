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
 *
 * Encryption: SLACK_ENCRYPTION_KEY env var supplies a 32-byte key (hex
 * or base64). Falls back to a per-process random key in dev so unit
 * tests stay deterministic via decrypt-after-encrypt round trips.
 */

const crypto = require('crypto');

const ENC_ALGO = 'aes-256-gcm';
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.SLACK_ENCRYPTION_KEY || process.env.SIRAGPT_ENCRYPTION_KEY || '';
  if (raw) {
    let buf = null;
    try { buf = Buffer.from(raw, 'hex'); } catch { buf = null; }
    if (!buf || buf.length !== 32) {
      try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; }
    }
    if (buf && buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
    // Last resort: derive a key from the string
    cachedKey = crypto.createHash('sha256').update(raw).digest();
    return cachedKey;
  }
  cachedKey = crypto.randomBytes(32);
  return cachedKey;
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
};
