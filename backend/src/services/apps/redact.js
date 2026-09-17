'use strict';

const SENSITIVE_KEY = /(token|secret|authorization|bearer|password|cookie|verifier|refresh|client_secret|access_token|api[_-]?key|private[_-]?key)/i;
const SENSITIVE_VALUE = /^(gho_|ghu_|ghs_|github_pat_|ya29\.|AQAAA|AAAA[A-Za-z0-9_-]{20,}|Bearer\s+)/i;

function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key || ''));
}

function looksLikeSecret(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 16) return false;
  return SENSITIVE_VALUE.test(trimmed) || /token|secret/i.test(trimmed) && trimmed.length >= 24;
}

function redactSecrets(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return looksLikeSecret(value) ? '[redacted]' : value;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[cycle]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = child == null ? child : '[redacted]';
      continue;
    }
    out[key] = redactSecrets(child, seen);
  }
  return out;
}

function assertNoSecrets(payload, label = 'payload') {
  const serialized = JSON.stringify(payload || {});
  if (SENSITIVE_VALUE.test(serialized) || /"accessToken"|"refreshToken"|"Authorization"/i.test(serialized)) {
    const error = new Error(`${label} leaked a secret`);
    error.code = 'APP_SECRET_LEAK';
    throw error;
  }
  return payload;
}

module.exports = {
  redactSecrets,
  assertNoSecrets,
  isSensitiveKey,
  looksLikeSecret,
};
