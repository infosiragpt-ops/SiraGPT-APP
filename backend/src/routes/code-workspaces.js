'use strict';

/**
 * /code workspace ensure — thin HTTP surface over the existing
 * host-runner + session stack. Does not provision a second runtime
 * on Retry.
 *
 *   POST /api/code/workspaces/ensure
 *   GET  /api/code/workspaces/health
 */

const express = require('express');
const { getRequestId } = require('../middleware/request-id');
const { createWorkspaceEnsure } = require('../services/code/workspace-ensure');
const {
  WORKSPACE_ERROR_CODES,
  WORKSPACE_STAGES,
  buildWorkspaceError,
  toPublicEnsureError,
} = require('../services/code/workspace-errors');

function firstHeader(req, name) {
  const raw = req.get(name);
  if (Array.isArray(raw)) return String(raw[0] || '');
  return String(raw || '');
}

function defaultAuthenticateToken() {
  return require('../middleware/auth').authenticateToken;
}

function createCodeWorkspacesRouter({
  authenticateToken = null,
  ensure = null,
  hostRunner = null,
  metrics = null,
  logger = console,
} = {}) {
  const auth = authenticateToken || defaultAuthenticateToken();
  const router = express.Router();
  const ensureService = ensure || createWorkspaceEnsure({
    hostRunner: hostRunner || tryLoadHostRunner(),
    metrics: metrics || tryLoadMetrics(),
    logger,
  });

  router.get('/workspaces/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'code-workspaces',
      stages: Object.keys(WORKSPACE_STAGES),
    });
  });

  router.post('/workspaces/ensure', auth, async (req, res) => {
    const traceId = getRequestId(req) || firstHeader(req, 'x-request-id');
    const userId = req.user?.id || req.user?.userId;
    const idempotencyKey = firstHeader(req, 'idempotency-key') || req.body?.idempotencyKey;
    const clientBuild = firstHeader(req, 'x-client-build') || req.body?.clientBuild;

    try {
      const result = await ensureService.ensureWorkspace({
        userId,
        idempotencyKey,
        clientBuild,
        folderId: req.body?.folderId,
        localId: req.body?.localId,
        workspaceKey: req.body?.workspaceKey,
        runtimeId: req.body?.runtimeId,
        traceId,
      });
      res.setHeader('Cache-Control', 'no-store');
      if (traceId) res.setHeader('X-Request-Id', traceId);
      if (result.body && result.body.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.ceil(result.body.retryAfterMs / 1000)));
      }
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      const payload = buildWorkspaceError({
        code: WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE,
        stage: WORKSPACE_STAGES.REQUESTING_WORKSPACE,
        retryable: true,
        traceId,
        status: 503,
        internalMessage: String(error && error.message || error).slice(0, 500),
      });
      try { logger.warn({ msg: 'code_workspace_ensure_unhandled', ...payload }); } catch { /* noop */ }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json(toPublicEnsureError(payload));
    }
  });

  return router;
}

function tryLoadHostRunner() {
  try {
    return require('../services/code/host-runner');
  } catch {
    return null;
  }
}

function tryLoadMetrics() {
  try {
    const metrics = require('../services/agents/metrics');
    if (typeof metrics.registerCounter === 'function') {
      try {
        metrics.registerCounter('siragpt_code_workspace_ensure_total', {
          help: 'Code workspace ensure calls by outcome',
          labels: ['code', 'reused'],
        });
        metrics.registerCounter('siragpt_code_workspace_bootstrap_failures_total', {
          help: 'Code workspace bootstrap failures by code and stage',
          labels: ['code', 'stage'],
        });
      } catch { /* already registered */ }
    }
    return metrics;
  } catch {
    return null;
  }
}

module.exports = {
  createCodeWorkspacesRouter,
};
