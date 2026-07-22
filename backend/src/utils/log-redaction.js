'use strict';

/**
 * Shared log redaction helpers.
 *
 * Pino's fast-redact path list is fast but necessarily finite. These helpers
 * add a depth-bounded key-name redaction pass for structured payloads that may
 * contain provider credentials several levels down, and for non-pino agent
 * loggers that serialize JSON directly.
 */

const REDACTION_CENSOR = '[REDACTED]';
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ARRAY_ITEMS = 50;

const SENSITIVE_KEYS = new Set([
  'password',
  'passcode',
  'passwd',
  'pwd',
  'token',
  'idtoken',
  'id_token',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'apikey',
  'api_key',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'clientsecret',
  'client_secret',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'privatekey',
  'private_key',
  'secretaccesskey',
  'secret_access_key',
  'webhooksecret',
  'webhook_secret',
  // Database DSNs are credentials even when the password is absent (remote
  // host/database names and signed Prisma URLs are still sensitive).
  'databaseurl',
  'database_url',
  'directdatabaseurl',
  'direct_database_url',
  'prismadatabaseurl',
  'prisma_database_url',
  'codexdatabasevaultkeys',
  'codex_database_vault_keys',
]);

function normalizeKey(key) {
  return String(key || '').replace(/[\s._-]+/g, '').toLowerCase();
}

function isSensitiveKey(key) {
  const raw = String(key || '').toLowerCase();
  return SENSITIVE_KEYS.has(raw) || SENSITIVE_KEYS.has(normalizeKey(raw));
}

function redactPayloadDeep(value, opts = {}, seen = new WeakSet(), depth = 0) {
  const censor = opts.censor || REDACTION_CENSOR;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayItems = opts.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS;

  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (value instanceof Error) return value;
  if (Buffer.isBuffer(value)) return value;
  if (depth >= maxDepth) return '[truncated]';
  if (seen.has(value)) return '[circular]';

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, maxArrayItems).map(item => redactPayloadDeep(item, opts, seen, depth + 1));
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? censor : redactPayloadDeep(child, opts, seen, depth + 1);
  }
  return out;
}

module.exports = {
  REDACTION_CENSOR,
  SENSITIVE_KEYS,
  isSensitiveKey,
  redactPayloadDeep,
};
