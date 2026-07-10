'use strict';

const MIN_SERIES_PER_FAMILY = 1;
const MAX_SERIES_PER_FAMILY = 10_000;
const FALLBACK_SERIES_PER_FAMILY = 500;
const OVERFLOW_LABEL_VALUE = '__other__';

function boundedSeriesLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_SERIES_PER_FAMILY, Math.min(MAX_SERIES_PER_FAMILY, parsed));
}

const DEFAULT_MAX_SERIES_PER_FAMILY = boundedSeriesLimit(
  process.env.SIRAGPT_METRICS_MAX_SERIES_PER_FAMILY,
  FALLBACK_SERIES_PER_FAMILY,
);

function resolveMaxSeriesPerFamily(value) {
  return boundedSeriesLimit(value, DEFAULT_MAX_SERIES_PER_FAMILY);
}

/**
 * Escape one Prometheus text-format label value.
 *
 * The exposition format requires backslashes, double quotes, and newlines to
 * be escaped. Carriage returns are normalized to the same escaped newline
 * representation so untrusted values can never create a second sample line.
 */
function escapePrometheusLabelValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/"/g, '\\"');
}

/**
 * Collapse an untrusted dynamic label into a bounded, stable token.
 * Intended for error/status codes, not human-readable label values.
 */
function normalizePrometheusLabelToken(value, {
  fallback = 'unknown',
  maxLength = 64,
} = {}) {
  const limit = Math.max(1, Math.min(256, Math.floor(Number(maxLength) || 64)));
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, limit)
    .replace(/_+$/g, '');
  return normalized || fallback;
}

// Metric registries use a readable comma-delimited key internally. Encode
// delimiter and control characters losslessly so rendering can decode the
// original value and apply the canonical Prometheus escaping exactly once.
function encodeLabelKeyValue(value) {
  return String(value ?? '').replace(/[%,"=\\\r\n]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  ));
}

function decodeLabelKeyValue(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

function createLabelKey(labelNames, labels) {
  const values = labels && typeof labels === 'object' ? labels : {};
  return labelNames
    .map((name) => `${name}=${encodeLabelKeyValue(values[name] ?? '')}`)
    .join(',');
}

function overflowLabelKey(labelNames) {
  const labels = Object.fromEntries(
    labelNames.map((name) => [name, OVERFLOW_LABEL_VALUE]),
  );
  return createLabelKey(labelNames, labels);
}

/**
 * Pick a bounded series key in O(1). Counters and histograms reserve one slot
 * for a single global overflow series. Gauges retain the first N keys and drop
 * later new keys because folding unrelated point-in-time values is misleading.
 */
function selectSeriesKey(metric, labels) {
  const key = createLabelKey(metric.labels, labels);
  if (metric.series.has(key) || metric.labels.length === 0) return key;

  const limit = resolveMaxSeriesPerFamily(metric.maxSeries);
  if (metric.type === 'gauge') {
    return metric.series.size < limit ? key : null;
  }

  const overflowKey = overflowLabelKey(metric.labels);
  if (key === overflowKey) return overflowKey;
  const hasOverflow = metric.series.has(overflowKey);
  const concreteCount = metric.series.size - (hasOverflow ? 1 : 0);
  const concreteLimit = Math.max(0, limit - 1);
  return concreteCount < concreteLimit ? key : overflowKey;
}

module.exports = {
  DEFAULT_MAX_SERIES_PER_FAMILY,
  MAX_SERIES_PER_FAMILY,
  MIN_SERIES_PER_FAMILY,
  OVERFLOW_LABEL_VALUE,
  createLabelKey,
  decodeLabelKeyValue,
  encodeLabelKeyValue,
  escapePrometheusLabelValue,
  normalizePrometheusLabelToken,
  overflowLabelKey,
  resolveMaxSeriesPerFamily,
  selectSeriesKey,
};
