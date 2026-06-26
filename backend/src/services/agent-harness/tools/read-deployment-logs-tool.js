'use strict';

/**
 * read_deployment_logs — let the chat agent read the latest build/runtime logs
 * of one of the USER's deployments, classify the failure (reusing the codex
 * error-pattern registry), and surface a likely root cause so it can propose a
 * fix. Owner-scoped (deployment-service verifies userId); logs are already
 * secret-redacted at write time. Read-only → permission tier 'auto'.
 *
 * `ctx.deploymentService` / `ctx.classifyText` are injectable for offline tests.
 */

const { z } = require('zod');

const inputSchema = z.object({
  deploymentId: z.string().min(1).max(64)
    .describe('The id of the deployment whose logs to read'),
  maxLines: z.number().int().min(10).max(200).optional()
    .describe('How many of the most recent log lines to return (default 60)'),
  levelFilter: z.enum(['info', 'warn', 'error']).optional()
    .describe('Only return log lines at this level (use "error" to focus on failures)'),
}).strict();

function buildReadDeploymentLogsTool() {
  return {
    name: 'read_deployment_logs',
    description: [
      "Read the latest build/runtime logs of one of the user's deployments, classify the error and surface a likely root cause + suggested fix.",
      'WHEN TO USE: the user reports that a deployment/publish failed, their app/site is down, or asks why a deploy broke. Call this FIRST, before proposing any fix.',
      'WHEN NOT TO USE: for questions unrelated to a deployment, or when you have no deployment id (ask the user for it).',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => `Leyendo logs del deployment ${String(args.deploymentId || '').slice(0, 12)}…`,
    execute: async (args, ctx = {}) => {
      const userId = ctx.userId;
      if (!userId) return { ok: false, error: 'no autenticado' };
      const service = ctx.deploymentService || require('../../deployments/deployment-service');
      const db = ctx.prisma || undefined;

      let detail;
      try {
        detail = await service.getDeployment({ userId, id: args.deploymentId, db });
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'deployment no encontrado' };
      }
      if (!detail) return { ok: false, error: 'deployment no encontrado o no te pertenece' };

      let logsRes;
      try {
        logsRes = await service.getLogs({ userId, id: args.deploymentId, db });
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'no se pudieron leer los logs' };
      }

      const max = args.maxLines || 60;
      let entries = Array.isArray(logsRes.entries) ? logsRes.entries : [];
      if (args.levelFilter) entries = entries.filter((en) => en.level === args.levelFilter);
      const recent = entries.slice(-max).map((en) => ({ level: en.level, message: en.message }));

      let classification = null;
      try {
        const classifyText = ctx.classifyText || require('../../codex/error-patterns').classifyText;
        const c = classifyText(recent.map((en) => en.message).join('\n'));
        if (c && c.pattern) {
          classification = {
            id: c.pattern.id,
            title: c.pattern.title,
            severity: c.severity,
            explanation: c.pattern.explanation,
            remediationUrl: c.pattern.remediationUrl || null,
          };
        }
      } catch { /* classification is best-effort */ }

      return {
        ok: true,
        deploymentStatus: detail.deployment && detail.deployment.status,
        totalLogLines: entries.length,
        recent,
        classification,
        note: 'Analiza estos logs, explica la causa raíz en lenguaje simple y propón un fix concreto. Si el usuario acepta, usa apply_deployment_fix.',
      };
    },
  };
}

module.exports = { buildReadDeploymentLogsTool, inputSchema };
