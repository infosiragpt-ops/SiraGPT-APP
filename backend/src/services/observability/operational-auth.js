'use strict';

const crypto = require('node:crypto');
const {
  authenticateToken,
  requireAdmin,
  requireSuperAdmin,
} = require('../../middleware/auth');

function requireSessionOperationalAuth(req, res, next) {
  if (req.authMethod === 'api_key' || !req.userSession) {
    return res.status(403).json({ error: 'Super admin session required' });
  }
  return next();
}

const DEFAULT_AUTH_MIDDLEWARES = Object.freeze([
  authenticateToken,
  requireSessionOperationalAuth,
  requireAdmin,
  requireSuperAdmin,
]);

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

function hasForwardingHeaders(req) {
  const headerNames = Object.keys(req?.headers || {});
  const rawHeaders = Array.isArray(req?.rawHeaders) ? req.rawHeaders : [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headerNames.push(String(rawHeaders[index] || ''));
  }
  return headerNames.some((name) => {
    const normalized = String(name).toLowerCase();
    return normalized === 'forwarded' || normalized.startsWith('x-forwarded-');
  });
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

function resolveOperationalToken(env, tokenEnvNames) {
  for (const name of tokenEnvNames) {
    const value = env?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
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

async function authorizeOperationalRequest(req, res, {
  env = process.env,
  tokenEnvNames = ['METRICS_TOKEN'],
  authMiddlewares = DEFAULT_AUTH_MIDDLEWARES,
  allowLoopback = true,
  denyForwardedLoopback = false,
} = {}) {
  if (
    allowLoopback
    && isLoopbackPeer(req)
    && !(denyForwardedLoopback && hasForwardingHeaders(req))
  ) {
    return true;
  }

  const configuredToken = resolveOperationalToken(env, tokenEnvNames);
  if (constantTimeTokenEquals(bearerToken(req), configuredToken)) return true;

  const chain = Array.isArray(authMiddlewares) && authMiddlewares.length > 0
    ? authMiddlewares
    : DEFAULT_AUTH_MIDDLEWARES;
  return runMiddlewareChain(req, res, chain);
}

function createOperationalAccessPolicy(options = {}) {
  return async function operationalAccessPolicy(req, res, next) {
    try {
      const allowed = await authorizeOperationalRequest(req, res, options);
      if (allowed && !res.headersSent) return next();
      return undefined;
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  DEFAULT_AUTH_MIDDLEWARES,
  requireSessionOperationalAuth,
  isLoopbackPeer,
  hasForwardingHeaders,
  constantTimeTokenEquals,
  bearerToken,
  resolveOperationalToken,
  runMiddlewareChain,
  authorizeOperationalRequest,
  createOperationalAccessPolicy,
};
