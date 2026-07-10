'use strict';

const crypto = require('node:crypto');

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
  authenticateToken,
  requireAdmin,
  requireSuperAdmin,
} = require('../../middleware/auth');

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function requireSessionMetricsAuth(req, res, next) {
  if (req.authMethod === 'api_key' || !req.userSession) {
    return res.status(403).json({ error: 'Super admin session required' });
  }
  return next();
}

const DEFAULT_AUTH_MIDDLEWARES = Object.freeze([
  authenticateToken,
  requireSessionMetricsAuth,
  requireAdmin,
  requireSuperAdmin,
]);

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

function isIpv4Loopback(address) {
  const octets = String(address).split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) {
    return false;
  }
  return Number(octets[0]) === 127;
}

function isLoopbackPeer(req) {
  const rawAddress = req?.socket?.remoteAddress;
  if (typeof rawAddress !== 'string' || !rawAddress) return false;
  const address = rawAddress.toLowerCase().split('%', 1)[0];
  if (address === '::1') return true;
  if (isIpv4Loopback(address)) return true;
  if (address.startsWith('::ffff:')) {
    return isIpv4Loopback(address.slice('::ffff:'.length));
  }
  return false;
}

function constantTimeTokenEquals(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  const candidateDigest = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

function bearerToken(req) {
  let header;
  if (typeof req?.get === 'function') header = req.get('authorization');
  if (header === undefined) header = req?.headers?.authorization;
  if (Array.isArray(header)) return null;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(String(header || ''));
  return match ? match[1] : null;
}

function runMiddlewareChain(req, res, middlewares) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const step = (error) => {
      if (error) {
        reject(error);
        return;
      }
      if (res.headersSent) {
        resolve(false);
        return;
      }
      if (index >= middlewares.length) {
        resolve(true);
        return;
      }
      const middleware = middlewares[index++];
      try {
        const pending = middleware(req, res, step);
        if (pending && typeof pending.then === 'function') {
          pending
            .then(() => {
              if (res.headersSent) resolve(false);
            })
            .catch(reject);
        } else if (res.headersSent) {
          resolve(false);
        }
      } catch (middlewareError) {
        reject(middlewareError);
      }
    };
    step();
  });
}

async function authorizeMetricsRequest(req, res, {
  env = process.env,
  authMiddlewares = DEFAULT_AUTH_MIDDLEWARES,
} = {}) {
  if (isLoopbackPeer(req)) return true;

  const configuredToken = env?.METRICS_TOKEN;
  const suppliedToken = bearerToken(req);
  if (constantTimeTokenEquals(suppliedToken, configuredToken)) return true;

  const chain = Array.isArray(authMiddlewares) && authMiddlewares.length > 0
    ? authMiddlewares
    : DEFAULT_AUTH_MIDDLEWARES;
  return runMiddlewareChain(req, res, chain);
}

function createMetricsAccessPolicy(options = {}) {
  return async function metricsAccessPolicy(req, res, next) {
    try {
      const allowed = await authorizeMetricsRequest(req, res, options);
      if (allowed && !res.headersSent) return next();
      return undefined;
    } catch (error) {
      return next(error);
    }
  };
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
  isLoopbackPeer,
  constantTimeTokenEquals,
  requireSessionMetricsAuth,
  authorizeMetricsRequest,
  createMetricsAccessPolicy,
  createMetricsHandler,
  metricsAccessPolicy,
  metricsHandler,
};
