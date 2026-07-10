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
