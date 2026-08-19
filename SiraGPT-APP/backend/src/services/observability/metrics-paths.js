'use strict';

const METRICS_PATHS = Object.freeze([
  '/metrics',
  '/internal/metrics',
  '/api/se-agents/metrics',
  '/api/free-ia/metrics.prom',
]);

const METRICS_PATH_SET = new Set(METRICS_PATHS);
const HEALTH_ALIAS_PATH_SET = new Set([
  '/health',
  '/healthz',
  '/livez',
  '/readyz',
  '/api/health',
  '/api/healthz',
  '/api/livez',
  '/api/ready',
  '/api/readyz',
]);
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_SEGMENT = /^[0-9a-f]{16,}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const CUID_LIKE_SEGMENT = /^[a-z][a-z0-9]{23,31}$/;

function isObviousDynamicSegment(segment) {
  if (!segment || segment.startsWith(':')) return false;
  return UUID_SEGMENT.test(segment)
    || LONG_HEX_SEGMENT.test(segment)
    || NUMERIC_SEGMENT.test(segment)
    || (CUID_LIKE_SEGMENT.test(segment) && /\d/.test(segment));
}

function normalizeDynamicBaseSegments(baseUrl) {
  return baseUrl
    .split('/')
    .map((segment) => (isObviousDynamicSegment(segment) ? ':id' : segment))
    .join('/');
}

function normalizedRequestPath(requestOrPath) {
  let value;
  if (typeof requestOrPath === 'string') {
    value = requestOrPath;
  } else {
    value = requestOrPath?.path
      || requestOrPath?.originalUrl
      || requestOrPath?.url
      || '';
  }
  const path = String(value).split('?', 1)[0];
  return path.length > 1 ? path.replace(/\/+$/g, '') : path;
}

function isMetricsRequest(requestOrPath) {
  return METRICS_PATH_SET.has(normalizedRequestPath(requestOrPath));
}

function isHealthRequest(requestOrPath) {
  const path = normalizedRequestPath(requestOrPath);
  return HEALTH_ALIAS_PATH_SET.has(path)
    || path.startsWith('/health/')
    || path.startsWith('/api/health/')
    || path === '/internal/health'
    || path.startsWith('/internal/health/')
    || path.endsWith('/health');
}

function classifyRequestClass(req, res) {
  if (isHealthRequest(req)) return 'health';
  let contentType = '';
  try {
    contentType = res?.getHeader?.('Content-Type')
      ?? res?.getHeader?.('content-type')
      ?? '';
  } catch {
    contentType = '';
  }
  const normalizedContentType = Array.isArray(contentType)
    ? contentType.join(';')
    : String(contentType || '');
  if (/^\s*text\/event-stream(?:\s*;|$)/i.test(normalizedContentType)) {
    return 'streaming';
  }
  return 'standard';
}

function classifyStatusClass(statusCode) {
  const numericStatus = Number(statusCode);
  if (!Number.isInteger(numericStatus) || numericStatus < 100 || numericStatus > 599) {
    return 'other';
  }
  return `${Math.floor(numericStatus / 100)}xx`;
}

function matchedRouteLabel(req) {
  const matched = req?.route?.path;
  if (typeof matched !== 'string' || !matched) return 'unmatched';
  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  return `${normalizeDynamicBaseSegments(base)}${matched}` || 'unmatched';
}

module.exports = {
  METRICS_PATHS,
  classifyRequestClass,
  classifyStatusClass,
  isHealthRequest,
  matchedRouteLabel,
  normalizedRequestPath,
  isMetricsRequest,
};
