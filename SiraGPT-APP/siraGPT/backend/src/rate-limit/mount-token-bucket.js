'use strict';

const { TokenBucket, TokenBucketRegistry } = require('./token-bucket');

const PRESETS = {
  agent_batch: { capacity: 5, fillRatePerSec: 0.5 },
  ai_generate: { capacity: 10, fillRatePerSec: 2 },
  rag_query: { capacity: 15, fillRatePerSec: 3 },
  document_ai: { capacity: 8, fillRatePerSec: 1 },
  thesis: { capacity: 3, fillRatePerSec: 0.3 },
  design: { capacity: 10, fillRatePerSec: 1 },
  code: { capacity: 10, fillRatePerSec: 1.5 },
  default: { capacity: 30, fillRatePerSec: 5 },
};

function extractPrincipal(req) {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function extractRoutePrefix(path = '') {
  const parts = String(path).split('/').filter(Boolean);
  return parts.slice(0, 3).join('_') || 'root';
}

function createTokenBucketMiddleware(opts = {}) {
  const presets = { ...PRESETS, ...(opts.presets || {}) };
  const registry = new TokenBucketRegistry({
    maxBuckets: opts.maxBuckets || 50000,
    idleTtlMs: opts.idleTtlMs || 10 * 60 * 1000,
  });

  function limiter(routeKey, customPreset) {
    const preset = customPreset || presets[routeKey] || presets.default;

    return (req, res, next) => {
      const principal = extractPrincipal(req);
      const key = `${routeKey}:${principal}`;
      const bucket = registry.getOrCreate(key, preset);

      if (!bucket.consume(1)) {
        res.setHeader('Retry-After', '1');
        res.setHeader('X-RateLimit-Bucket', 'token_bucket');
        return res.status(429).json({
          error: 'rate_limit',
          message: 'Demasiadas solicitudes. Espera un momento.',
          route: routeKey,
        });
      }

      const tokens = bucket.availableTokens();
      res.setHeader('X-RateLimit-Bucket-Tokens', String(Math.floor(tokens)));
      next();
    };
  }

  function forRoute(path, presetName) {
    const routeKey = presetName || extractRoutePrefix(path);
    return limiter(routeKey);
  }

  return { limiter, forRoute, registry };
}

module.exports = { createTokenBucketMiddleware, PRESETS };
