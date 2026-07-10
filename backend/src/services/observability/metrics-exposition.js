'use strict';

const utilityMetrics = require('../../utils/metrics');
const agentMetrics = require('../agents/metrics');
const {
  formatProcessMetricsExposition,
} = require('./process-metrics-exposition');
// Sira registers its pipeline families against the legacy agent registry.
// Keep that side effect here so every direct formatter call has the same
// inventory as the HTTP handlers, without depending on index.js boot order.
require('../sira/metrics');
const {
  isLoopbackPeer,
  constantTimeTokenEquals,
  requireSessionOperationalAuth: requireSessionMetricsAuth,
  authorizeOperationalRequest,
  createOperationalAccessPolicy,
} = require('./operational-auth');

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const DATABASE_POOL_GAUGE_BOUNDS = Object.freeze({
  countMax: 1_000_000,
  estimateMax: 100,
  ratioMax: 1_000,
  limitMin: 1,
  limitMax: 100,
});
const DATABASE_POOL_GAUGE_NAMES = Object.freeze({
  capacityObservable: 'siragpt_database_pool_capacity_observable',
  estimatedConnectionsActive: 'siragpt_database_pool_estimated_connections_active',
  estimatedConnectionsIdle: 'siragpt_database_pool_estimated_connections_idle',
  queriesInFlight: 'siragpt_database_pool_queries_in_flight',
  estimatedSaturationRatio: 'siragpt_database_pool_estimated_saturation_ratio',
  currentLimit: 'siragpt_database_pool_limit',
  recommendedLimit: 'siragpt_database_pool_recommended_limit',
  autoscalerRunning: 'siragpt_database_pool_autoscaler_running',
});

for (const [key, name] of Object.entries(DATABASE_POOL_GAUGE_NAMES)) {
  utilityMetrics.registerGauge(name, {
    help: `Prisma database pool ${key.replaceAll(/([A-Z])/g, ' $1').toLowerCase()}`,
    labels: [],
    maxSeries: 1,
    suppressWhenEmpty: [
      'estimatedConnectionsActive',
      'estimatedConnectionsIdle',
      'estimatedSaturationRatio',
      'currentLimit',
      'recommendedLimit',
    ].includes(key),
  });
}

let databasePoolMetricProviders = {
  snapshot: null,
  recommendation: null,
};

function configureDatabasePoolMetrics(providers = {}) {
  databasePoolMetricProviders = {
    snapshot: typeof providers.snapshot === 'function' ? providers.snapshot : null,
    recommendation: typeof providers.recommendation === 'function'
      ? providers.recommendation
      : null,
  };
}

function callPoolProvider(provider) {
  try {
    return typeof provider === 'function' ? provider() : null;
  } catch {
    return null;
  }
}

function boundedValue(value, max, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, parsed));
}

function boundedPoolLimit(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(
    DATABASE_POOL_GAUGE_BOUNDS.limitMax,
    Math.max(DATABASE_POOL_GAUGE_BOUNDS.limitMin, Math.round(parsed)),
  );
}

function collectDatabasePoolGaugeValues(providers = databasePoolMetricProviders) {
  const snapshot = callPoolProvider(providers.snapshot) || {};
  const recommendation = callPoolProvider(providers.recommendation) || {};
  const capacityObservable = snapshot?.capacity?.observable !== false
    && boundedPoolLimit(snapshot?.pool?.max, 0) > 0;
  if (!capacityObservable) {
    return {
      capacityObservable: 0,
      estimatedConnectionsActive: null,
      estimatedConnectionsIdle: null,
      queriesInFlight: boundedValue(
        snapshot.queries_in_flight,
        DATABASE_POOL_GAUGE_BOUNDS.countMax,
      ),
      estimatedSaturationRatio: null,
      currentLimit: null,
      recommendedLimit: null,
      autoscalerRunning: 0,
    };
  }
  // The instrumentation snapshot, not the recommendation engine, owns the
  // actual live pool size.
  const currentLimit = boundedPoolLimit(snapshot?.pool?.max, 0);
  return {
    capacityObservable: 1,
    estimatedConnectionsActive: boundedValue(
      snapshot.estimated_connections_active,
      DATABASE_POOL_GAUGE_BOUNDS.estimateMax,
    ),
    estimatedConnectionsIdle: boundedValue(
      snapshot.estimated_connections_idle,
      DATABASE_POOL_GAUGE_BOUNDS.estimateMax,
    ),
    queriesInFlight: boundedValue(
      snapshot.queries_in_flight,
      DATABASE_POOL_GAUGE_BOUNDS.countMax,
    ),
    estimatedSaturationRatio: boundedValue(
      snapshot.estimated_saturation_ratio,
      DATABASE_POOL_GAUGE_BOUNDS.ratioMax,
    ),
    currentLimit,
    recommendedLimit: boundedPoolLimit(
      recommendation.recommendedLimit,
      currentLimit,
    ),
    autoscalerRunning: recommendation.running ? 1 : 0,
  };
}

function refreshDatabasePoolMetrics(providers = databasePoolMetricProviders) {
  const values = collectDatabasePoolGaugeValues(providers);
  for (const [key, name] of Object.entries(DATABASE_POOL_GAUGE_NAMES)) {
    if (values[key] === null) {
      utilityMetrics.registry.get(name)?.series.clear();
    } else {
      utilityMetrics.gauge(name, {}, values[key]);
    }
  }
  return values;
}

function metricFamilyNames(text) {
  if (typeof text !== 'string') return [];
  return Array.from(
    text.matchAll(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) [a-z]+$/gm),
    (match) => match[1],
  );
}

function findDuplicateMetricFamilies(text) {
  const seen = new Set();
  const duplicates = new Set();
  for (const family of metricFamilyNames(text)) {
    if (seen.has(family)) duplicates.add(family);
    seen.add(family);
  }
  return Array.from(duplicates).sort();
}

function composeExpositions(expositions) {
  const blocks = (Array.isArray(expositions) ? expositions : [])
    .filter((text) => typeof text === 'string' && text.trim())
    .map((text) => text.trim());
  const text = `${blocks.join('\n\n')}\n`;
  const duplicates = findDuplicateMetricFamilies(text);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Prometheus metric family: ${duplicates.join(', ')}`);
  }
  return text;
}

function formatMetricsExposition() {
  utilityMetrics.refreshProcessMetrics();
  refreshDatabasePoolMetrics();
  return composeExpositions([
    formatProcessMetricsExposition(),
    utilityMetrics.renderText(),
    agentMetrics.renderText(),
  ]);
}

function shouldAllowMetricsLoopback(env = process.env) {
  const isProduction = String(env?.NODE_ENV || '').trim().toLowerCase() === 'production';
  const explicitlyAllowed = String(env?.METRICS_ALLOW_LOOPBACK || '')
    .trim()
    .toLowerCase() === 'true';
  return !isProduction || explicitlyAllowed;
}

function authorizeMetricsRequest(req, res, options = {}) {
  const env = options.env ?? process.env;
  return authorizeOperationalRequest(req, res, {
    ...options,
    env,
    tokenEnvNames: ['METRICS_TOKEN'],
    allowLoopback: shouldAllowMetricsLoopback(env),
    denyForwardedLoopback: true,
  });
}

function createMetricsAccessPolicy(options = {}) {
  const env = options.env ?? process.env;
  return createOperationalAccessPolicy({
    ...options,
    env,
    tokenEnvNames: ['METRICS_TOKEN'],
    allowLoopback: shouldAllowMetricsLoopback(env),
    denyForwardedLoopback: true,
  });
}

function createMetricsHandler({
  render = formatMetricsExposition,
  accessPolicy,
  ...accessOptions
} = {}) {
  const policy = accessPolicy || createMetricsAccessPolicy(accessOptions);
  return async function metricsHandler(req, res, next) {
    let allowed = false;
    let policyError = null;
    await policy(req, res, (error) => {
      policyError = error || null;
      allowed = !error;
    });

    if (policyError) {
      if (typeof next === 'function') return next(policyError);
      if (!res.headersSent) return res.status(500).send('metrics unavailable\n');
      return undefined;
    }
    if (!allowed || res.headersSent) return undefined;

    let exposition;
    try {
      exposition = render();
    } catch (error) {
      if (typeof next === 'function') return next(error);
      if (!res.headersSent) return res.status(500).send('metrics unavailable\n');
      return undefined;
    }
    res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE);
    return res.send(exposition);
  };
}

const metricsAccessPolicy = createMetricsAccessPolicy();
const metricsHandler = createMetricsHandler({ accessPolicy: metricsAccessPolicy });

module.exports = {
  PROMETHEUS_CONTENT_TYPE,
  DATABASE_POOL_GAUGE_BOUNDS,
  DATABASE_POOL_GAUGE_NAMES,
  configureDatabasePoolMetrics,
  collectDatabasePoolGaugeValues,
  refreshDatabasePoolMetrics,
  metricFamilyNames,
  findDuplicateMetricFamilies,
  composeExpositions,
  formatMetricsExposition,
  shouldAllowMetricsLoopback,
  isLoopbackPeer,
  constantTimeTokenEquals,
  requireSessionMetricsAuth,
  authorizeMetricsRequest,
  createMetricsAccessPolicy,
  createMetricsHandler,
  metricsAccessPolicy,
  metricsHandler,
};
