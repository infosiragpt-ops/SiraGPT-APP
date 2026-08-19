'use strict';

/**
 * secret-redactor — shared last-mile redaction for logs, tracing attrs,
 * guard labels and structured error payloads.
 *
 * This module is intentionally conservative: request bodies are not handled
 * here and should still never be logged. Callers should redact at the point
 * where data crosses into logs/traces, not mutate the request that is sent.
 */

const DEFAULT_MAX_STRING_LENGTH = 500;

const BASE_SENSITIVE_QUERY_KEYS = Object.freeze([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'code',
  'id_token',
  'password',
  'refresh_token',
  'sas',
  'secret',
  'sig',
  'signature',
  'sv',
  'token',
  'x-amz-security-token',
  'x-amz-signature',
  'x-goog-access-token',
  'x-goog-signature',
]);

const BASE_DENY_HEADERS = Object.freeze([
  'authorization',
  'cookie',
  'openai-organization',
  'proxy-authorization',
  'set-cookie',
  'x-amz-security-token',
  'x-anthropic-api-key',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-goog-api-key',
  'x-openai-api-key',
  'x-vercel-protection-bypass',
]);

const TRACE_HEADERS = Object.freeze([
  'baggage',
  'traceparent',
  'tracestate',
]);

const TOKEN_PATTERNS = Object.freeze([
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/g },
  { name: 'basic-token', pattern: /\bBasic\s+[A-Za-z0-9+/=]{16,}/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'stripe-key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
]);

function csvSet(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function sensitiveQueryKeys() {
  return new Set([
    ...BASE_SENSITIVE_QUERY_KEYS,
    ...csvSet(process.env.SIRAGPT_REDACT_EXTRA_QUERY_KEYS),
  ]);
}

function denyHeaders() {
  const traceHeaders = new Set(TRACE_HEADERS);
  return new Set([
    ...BASE_DENY_HEADERS,
    ...csvSet(process.env.SIRAGPT_REDACT_EXTRA_HEADERS),
  ].filter((name) => !traceHeaders.has(name)));
}

function truncate(value, maxLen = DEFAULT_MAX_STRING_LENGTH) {
  const limit = Number.parseInt(maxLen, 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_STRING_LENGTH;
  const text = String(value);
  if (text.length <= safeLimit) return text;
  const marker = '...';
  if (safeLimit <= marker.length) return marker.slice(0, safeLimit);
  return `${text.slice(0, safeLimit - marker.length)}${marker}`;
}

function hasUnsafeControlChar(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function looksRelativeUrl(value) {
  return value.startsWith('/') || /^[A-Za-z0-9._~-]+(?:\/|\?)/u.test(value);
}

function redactParsedUrl(parsed, { relative = false } = {}) {
  parsed.username = '';
  parsed.password = '';

  const keys = sensitiveQueryKeys();
  for (const [key] of parsed.searchParams) {
    if (keys.has(String(key).toLowerCase())) {
      parsed.searchParams.set(key, '***');
    }
  }

  if (!relative) return parsed.href;
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
}

function redactQueryFragments(value) {
  const keys = Array.from(sensitiveQueryKeys())
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!keys) return value;
  const queryPattern = new RegExp(`([?&](?:${keys})=)([^&#\\s]+)`, 'giu');
  return value.replace(queryPattern, '$1***');
}

function redactUrl(input, opts = {}) {
  if (input == null) return '';
  let raw;
  try {
    raw = typeof input === 'string' ? input : String(input);
  } catch {
    return '<redacted>';
  }

  if (!raw) return '';
  if (hasUnsafeControlChar(raw)) return '<redacted>';

  let redacted;
  try {
    redacted = redactParsedUrl(new URL(raw));
  } catch (_absoluteErr) {
    if (!looksRelativeUrl(raw)) return '<redacted>';
    try {
      redacted = redactParsedUrl(new URL(raw, 'https://siragpt.local'), { relative: true });
    } catch (_relativeErr) {
      return '<redacted>';
    }
  }

  return truncate(redacted, opts.maxLen);
}

function redactString(input, opts = {}) {
  if (input == null) return input;
  let value;
  try {
    value = String(input);
  } catch {
    return '<redacted>';
  }

  value = redactQueryFragments(value);
  value = value.replace(/\b(https?:\/\/)[^\s/?#@]+:[^\s/?#@]+@/giu, '$1');

  for (const { name, pattern } of TOKEN_PATTERNS) {
    value = value.replace(pattern, `***${name}-redacted***`);
  }

  if (opts.maxLen) return truncate(value, opts.maxLen);
  return value;
}

function redactHeaderValue(value) {
  const text = value == null ? '' : String(value);
  return `***redacted (len=${text.length})***`;
}

function putRedactedHeader(target, key, value, denied) {
  if (key == null || typeof key === 'symbol') return;
  if (value == null || typeof value === 'symbol') return;
  const name = String(key).trim();
  if (!name) return;
  target[name] = denied.has(name.toLowerCase())
    ? redactHeaderValue(value)
    : redactString(value);
}

function redactHeaderEntries(entries, denied) {
  const redacted = {};
  for (const entry of entries) {
    if (!entry || typeof entry[Symbol.iterator] !== 'function') continue;
    const pair = Array.from(entry);
    if (pair.length < 2) continue;
    putRedactedHeader(redacted, pair[0], pair[1], denied);
  }
  return redacted;
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;

  const denied = denyHeaders();

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const redacted = {};
    headers.forEach((value, key) => putRedactedHeader(redacted, key, value, denied));
    return redacted;
  }

  if (Array.isArray(headers)) {
    return redactHeaderEntries(headers, denied);
  }

  if (typeof headers.forEach === 'function') {
    const redacted = {};
    headers.forEach((value, key) => putRedactedHeader(redacted, key, value, denied));
    return redacted;
  }

  if (typeof headers[Symbol.iterator] === 'function') {
    return redactHeaderEntries(headers, denied);
  }

  const redacted = {};
  for (const key of Object.getOwnPropertyNames(headers)) {
    putRedactedHeader(redacted, key, headers[key], denied);
  }
  return redacted;
}

function redactErrorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return redactString(err);
  return redactString(err.message || String(err));
}

function redactErrorLike(err) {
  if (!err) return null;
  if (typeof err !== 'object') return { message: redactString(err) };

  const redacted = {
    name: redactString(err.name || 'Error'),
    message: redactErrorMessage(err),
  };

  if (err.stack) redacted.stack = redactString(err.stack);
  if (err.code != null && typeof err.code !== 'symbol') redacted.code = redactString(err.code);
  return redacted;
}

module.exports = {
  redactUrl,
  redactHeaders,
  redactString,
  redactErrorMessage,
  redactErrorLike,
  SENSITIVE_QUERY_KEYS: BASE_SENSITIVE_QUERY_KEYS,
  DENY_HEADERS: BASE_DENY_HEADERS,
  TRACE_HEADERS,
  TOKEN_PATTERNS,
};
