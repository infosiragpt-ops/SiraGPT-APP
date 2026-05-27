'use strict';

const MAX_STRING = 500;
const MAX_STACK = 1800;

const SENSITIVE_KEY_RE = /(?:password|passwd|passphrase|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|session|csrf|credit|card|cvv)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_RE = /\b(?:sk|pk|rk|clerk|ghp|github_pat|xox[baprs])_[A-Za-z0-9._-]{8,}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function clampString(value, max = MAX_STRING) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return redactText(text).slice(0, max);
}

function redactText(value) {
  return String(value)
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(API_KEY_RE, '[REDACTED:key]')
    .replace(JWT_RE, '[REDACTED:jwt]')
    .replace(EMAIL_RE, '[REDACTED:email]');
}

function sanitizeObject(input, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (input == null) return null;
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return typeof input === 'string' ? clampString(input) : input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 12).map((item) => sanitizeObject(item, depth + 1));
  }
  if (typeof input !== 'object') return clampString(input);

  const out = {};
  for (const [key, value] of Object.entries(input).slice(0, 40)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitizeObject(value, depth + 1);
  }
  return out;
}

function normalizeSeverity(raw) {
  const value = String(raw || '').toLowerCase();
  if (value === 'fatal' || value === 'error' || value === 'warn' || value === 'info') return value;
  return 'error';
}

function normalizeSource(raw) {
  const value = String(raw || '').toLowerCase();
  if (value === 'client' || value === 'api' || value === 'render' || value === 'global' || value === 'network') return value;
  return 'client';
}

function normalizeEndpoint(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let path = value;
  try {
    path = new URL(value, 'https://siragpt.local').pathname;
  } catch (_) {
    path = value.split('?')[0] || value;
  }
  if (path.startsWith('/api/')) path = path.slice(4);
  return path.replace(/\/$/, '') || '/';
}

function sanitizeClientEvent(body = {}, req = null) {
  const source = normalizeSource(body.source);
  const severity = normalizeSeverity(body.severity);
  const page = clampString(body.page || body.url || body.path || 'unknown', 300) || 'unknown';
  const action = clampString(body.action || body.event || 'unknown', 180) || 'unknown';
  const message = clampString(body.message || body.error || body.reason || 'client event', 700) || 'client event';
  const requestId = clampString(body.requestId || body.request_id || body.requestID || null, 160);
  const status = Number.isFinite(Number(body.status)) ? Number(body.status) : null;
  const method = clampString(body.method || null, 20);
  const endpoint = clampString(body.endpoint || body.route || null, 300);
  const stack = clampString(body.stack || null, MAX_STACK);
  const component = clampString(body.component || body.label || null, 160);
  const browser = clampString(body.browser || req?.headers?.['user-agent'] || null, 300);
  const extra = sanitizeObject(body.extra || body.metadata || null);

  return {
    source,
    severity,
    page,
    action,
    message,
    requestId,
    status,
    method,
    endpoint,
    stack,
    component,
    browser,
    extra,
  };
}

function buildClientEventAuditEntry(event, req = null) {
  const source = event.source || 'client';
  const failureTag = source === 'api' ? 'api-error' : 'client-error';
  const statusTag = event.status && event.status >= 500 ? 'server-error' : event.status && event.status >= 400 ? 'user-facing-error' : 'client-signal';
  return {
    req,
    action: `${source}_error_reported`,
    resource: 'client_event',
    resourceId: event.requestId || event.page || null,
    tags: ['observability', failureTag, statusTag, event.severity].filter(Boolean),
    metadata: {
      source: event.source,
      severity: event.severity,
      page: event.page,
      action: event.action,
      message: event.message,
      requestId: event.requestId,
      status: event.status,
      method: event.method,
      endpoint: event.endpoint,
      stack: event.stack,
      component: event.component,
      browser: event.browser,
      extra: event.extra,
    },
  };
}

function isExpectedAuthClientEvent(event = {}) {
  if (!event || event.source !== 'api') return false;
  const status = Number(event.status);
  if (status !== 401 && status !== 403) return false;

  const endpoint = normalizeEndpoint(event.endpoint || '');
  const details = `${event.message || ''} ${JSON.stringify(event.extra || {})}`.toLowerCase();
  const expected =
    /invalid credentials/.test(details) ||
    /invalid or expired token/.test(details) ||
    /\binvalid token\b/.test(details) ||
    /access token required/.test(details) ||
    /session revoked/.test(details) ||
    /re-?authentication required/.test(details) ||
    /\bunauthorized\b/.test(details);

  if (!expected) return false;
  if (endpoint === '/auth/login') return true;
  if (endpoint === '/auth/me') return true;
  if (endpoint === '/ai/generate-video') return true;
  return true;
}

module.exports = {
  sanitizeClientEvent,
  buildClientEventAuditEntry,
  isExpectedAuthClientEvent,
  redactText,
};
