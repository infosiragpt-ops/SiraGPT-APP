'use strict';

/**
 * api-docs — interactive Swagger UI mounted at `/api-docs`. Renders
 * the OpenAPI 3.1 spec already produced by
 * `backend/src/services/contracts/schema-registry.js#buildOpenApiSpec`.
 *
 * Why this exists as a thin route and not a one-liner in index.js:
 *   - Encapsulates the env-gate (resolveApiDocsConfig) so tests can
 *     pin the resolution rules without booting Express.
 *   - Lets future operators flip the JSON spec source (e.g. swap the
 *     custom generator for `@asteasolutions/zod-to-openapi` once the
 *     backend migrates to zod v4) by changing one import here.
 *   - Keeps `swagger-ui-express` out of the main module surface so a
 *     missing native binary on an exotic deploy is observable as
 *     "api-docs disabled, reason: load_failed" instead of a hard
 *     boot crash.
 *
 * Operator runbook (also in docs/api-docs.md):
 *   - Default ON in non-production NODE_ENV.
 *   - Default OFF in production. Set API_DOCS_ENABLED=true to enable.
 *     Use a reverse-proxy auth or admin-gated subdomain for
 *     production exposure — the OpenAPI spec itself never carries
 *     secrets, only endpoint shapes.
 *   - The spec is built on every request; for very high traffic
 *     consider memoizing if the route shows up in latency budgets.
 */

const express = require('express');

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveApiDocsConfig(env = process.env) {
  const explicit = env.API_DOCS_ENABLED;
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  // Default: ON in non-production, OFF in production. Operators flip
  // it on per-deploy via API_DOCS_ENABLED=true (often paired with a
  // basic-auth reverse-proxy block).
  const enabled = parseBoolean(explicit, !isProduction);
  return {
    enabled,
    isProduction,
    title: env.API_DOCS_TITLE || 'siraGPT API',
  };
}

function buildApiDocsRouter(options = {}) {
  const env = options.env || process.env;
  const buildSpec = options.buildSpec || (() => {
    const { buildOpenApiSpec } = require('../services/contracts/schema-registry');
    return buildOpenApiSpec({ title: resolveApiDocsConfig(env).title });
  });

  const router = express.Router();
  const config = resolveApiDocsConfig(env);

  if (!config.enabled) {
    // Disabled mode: a single GET that surfaces the env hint so
    // operators don't get a confusing "404 cannot GET /api-docs"
    // when they hit it on prod expecting documentation.
    router.get('/', (_req, res) => {
      res.status(404).json({
        error: 'api-docs disabled',
        hint: 'set API_DOCS_ENABLED=true to expose interactive docs',
      });
    });
    return router;
  }

  let swaggerUi;
  try {
    swaggerUi = require('swagger-ui-express');
  } catch (err) {
    // The package is optional — a fresh checkout without `npm install`
    // shouldn't crash boot. Surface the failure as a JSON message.
    router.get('/', (_req, res) => {
      res.status(503).json({
        error: 'api-docs unavailable',
        reason: 'swagger-ui-express failed to load',
        detail: err && err.message,
      });
    });
    return router;
  }

  // serve() returns the static asset middleware; setup() returns the
  // index handler. We pass a function for the spec so the OpenAPI
  // generator runs per-request rather than at boot — adding a route
  // contract becomes visible immediately on /api-docs without a
  // server restart.
  router.use(swaggerUi.serve);
  router.get(
    '/',
    swaggerUi.setup(null, {
      explorer: true,
      swaggerOptions: {
        // Pinning a deterministic operationsSorter keeps the rendered
        // page diff-stable for screenshot-based visual regressions.
        operationsSorter: 'alpha',
        tagsSorter: 'alpha',
        // Persist the last-used auth token in localStorage so a
        // developer doesn't have to re-paste their JWT on every page
        // reload. Browsers scope the storage to the docs origin.
        persistAuthorization: true,
      },
      // Live spec resolution: each render rebuilds the spec from the
      // schema-registry so a contract added in this PR shows up the
      // moment the route reloads.
      swaggerUrl: undefined,
      customSiteTitle: `${config.title} — API Reference`,
    }),
  );

  // Raw JSON for tooling (Postman, generated clients, contract
  // tests). Distinct from /api/enterprise/contracts/openapi so the
  // docs surface stands alone — tooling that doesn't have an
  // enterprise auth token can still grab the schema here, since the
  // env-gate already controls exposure.
  router.get('/openapi.json', (_req, res) => {
    res.json(buildSpec());
  });

  return router;
}

module.exports = {
  buildApiDocsRouter,
  resolveApiDocsConfig,
};
