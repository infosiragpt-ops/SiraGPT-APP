'use strict';

const { Router } = require('express');

// Keep legacy/test boot cheap when admission is off. A configured module must be
// compiled; a missing build is never replaced with the old unvalidated editor.
function createDocumentSandboxModule({ prisma, authenticate, logger }) {
  if (!process.env.DOC_SANDBOX_ENGINE) {
    const router = Router();
    router.use(authenticate);
    router.get('/capabilities', (_req, res) => res.set('Cache-Control', 'no-store').json({
      enabled: false, ready: false, supported: false, modelTier: null, modes: [], formats: [], limits: null,
    }));
    router.use((_req, res) => res.set('Cache-Control', 'no-store').status(503).json({
      code: 'E_NOT_READY', message: 'La edición segura de documentos todavía no está habilitada.',
    }));
    return { router, start: async () => {}, close: async () => {} };
  }
  const { createDocumentModule } = require('../../dist/doc-sandbox/index.js');
  const { createRedisConnection, getBullMQRuntimeOptions } = require('./agents/agent-task-queue');
  const { enforcePlanQuota } = require('../middleware/enforce-plan-quota');
  const modelRouter = require('./ai-product-os/model-router');
  const instance = createDocumentModule({ prisma, authenticate, admissionPolicy: enforcePlanQuota({ surface: 'doc-sandbox' }),
    createRedisConnection, runtimeOptions: getBullMQRuntimeOptions(), metrics: require('../utils/metrics'),
    isModelPlanEligible: (name, plan) => {
      const entry = modelRouter.getModel(name);
      return Boolean(entry && modelRouter.isPlanEligible(entry.plans, plan));
    },
    notice: (code) => logger.warn({ code: /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'DOC_MODULE_ERROR' }, 'doc_sandbox'),
  });
  return instance;
}

module.exports = { createDocumentSandboxModule };
