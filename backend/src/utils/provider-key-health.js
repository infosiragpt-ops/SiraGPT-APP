'use strict';

/**
 * provider-key-health — process-wide memo of API keys a provider has REJECTED
 * (401/403 / "invalid api key"). Every ladder (embeddings, transcription,
 * vision, memory extraction) consults it before spending a network round-trip
 * on a key that is known to be dead, and re-arms automatically:
 *   - after a TTL (default 5 min),
 *   - when the key changes (fingerprint mismatch — an admin pasted a new one),
 *   - explicitly via clear() from admin-connections-bridge after it applies
 *     connections.
 * Presence of a key is not health; this module records validity evidence.
 */

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const rejected = new Map(); // provider → { at, fingerprint, status, message }

function fingerprint(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 16);
}

function ttlMs(env = process.env) {
  const n = Number(env.SIRAGPT_KEY_REJECT_MEMO_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TTL_MS;
}

/** True for auth rejections only — never for quota, network or 5xx. */
function isInvalidKeyError(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status) || 0);
  if (status === 401 || status === 403) return true;
  const code = String(err.code || (err.error && err.error.code) || '').toLowerCase();
  if (code === 'invalid_api_key' || code === 'authentication_error' || code === 'permission_denied') return true;
  const message = String(err.message || (err.error && err.error.message) || '');
  return /incorrect api key|invalid api key|invalid_api_key|api key not valid|unauthorized|authentication failed|permission denied|forbidden/i.test(message)
    && !/rate ?limit|quota/i.test(message);
}

/**
 * @param {string} provider
 * @param {string} key
 * @param {Error|null} err
 * @param {object} env
 * @param {{ reason?: 'auth'|'billing', ttlMs?: number }} [opts] — `billing`
 *   marks a key that is valid but unfunded (402/429 «no credits», 400 «credit
 *   balance is too low», 403 «used all available credits»): the ladders skip
 *   it exactly like an invalid one until the TTL expires or the key changes.
 */
function markRejected(provider, key, err = null, env = process.env, opts = {}) {
  const name = String(provider || '').toLowerCase();
  if (!name) return;
  const reason = opts && opts.reason === 'billing' ? 'billing' : 'auth';
  const customTtl = Number(opts && opts.ttlMs);
  rejected.set(name, {
    at: Date.now(),
    fingerprint: fingerprint(key),
    status: Number((err && (err.status || err.statusCode)) || 0) || null,
    message: err ? String(err.message || '').slice(0, 160) : null,
    ttlMs: Number.isFinite(customTtl) && customTtl >= 1000 ? customTtl : ttlMs(env),
    reason,
  });
}

/** 'auth' | 'billing' | null when the provider is not currently rejected. */
function rejectionReason(provider, key) {
  if (!isRejected(provider, key)) return null;
  const entry = rejected.get(String(provider || '').toLowerCase());
  return entry ? entry.reason || 'auth' : null;
}

/** True when the SAME key was rejected recently. A new key re-arms the provider. */
function isRejected(provider, key) {
  const entry = rejected.get(String(provider || '').toLowerCase());
  if (!entry) return false;
  if (Date.now() - entry.at > entry.ttlMs) { rejected.delete(String(provider).toLowerCase()); return false; }
  if (entry.fingerprint !== fingerprint(key)) { rejected.delete(String(provider).toLowerCase()); return false; }
  return true;
}

function clear(provider = null) {
  if (provider == null) { rejected.clear(); return; }
  rejected.delete(String(provider).toLowerCase());
}

function snapshot() {
  const out = {};
  for (const [name, entry] of rejected) {
    out[name] = { rejectedAt: new Date(entry.at).toISOString(), status: entry.status, reason: entry.reason || 'auth', expiresInMs: Math.max(0, entry.ttlMs - (Date.now() - entry.at)) };
  }
  return out;
}

module.exports = { isInvalidKeyError, markRejected, isRejected, rejectionReason, clear, snapshot, fingerprint, DEFAULT_TTL_MS };
