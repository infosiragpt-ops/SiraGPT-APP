'use strict';

const METRICS_PATHS = Object.freeze([
  '/metrics',
  '/internal/metrics',
  '/api/se-agents/metrics',
]);

const METRICS_PATH_SET = new Set(METRICS_PATHS);
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

function matchedRouteLabel(req) {
  const matched = req?.route?.path;
  if (typeof matched !== 'string' || !matched) return 'unmatched';
  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  return `${normalizeDynamicBaseSegments(base)}${matched}` || 'unmatched';
}

module.exports = {
  METRICS_PATHS,
  matchedRouteLabel,
  normalizedRequestPath,
  isMetricsRequest,
};
