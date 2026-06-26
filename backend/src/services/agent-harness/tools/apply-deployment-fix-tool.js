'use strict';

/**
 * apply_deployment_fix — let the chat agent APPLY a fix to one of the user's
 * deployments after read_deployment_logs diagnosed it: set/override a build
 * secret (env var) or re-publish the deployment. Mutating → permission tier
 * 'confirm', so the harness pauses for the user to approve each action.
 * Owner-scoped throughout.
 *
 * `ctx.deploymentService` / `ctx.prisma` / `ctx.creds` injectable for tests.
 */

const { z } = require('zod');

const inputSchema = z.object({
  deploymentId: z.string().min(1).max(64).describe('The deployment to fix'),
  action: z.enum(['set_secret', 'redeploy'])
    .describe('set_secret = save/override a build env var (e.g. DATABASE_URL, a missing API key); redeploy = re-publish to apply changes'),
  key: z.string().max(128).optional().describe('For set_secret: env var NAME (UPPER_SNAKE)'),
  value: z.string().max(8000).optional().describe('For set_secret: the value to store (sealed at rest)'),
}).strict();

function buildApplyDeploymentFixTool() {
  return {
    name: 'apply_deployment_fix',
    description: [
      "Apply a fix to one of the user's deployments: set/override a build secret (env var), or re-publish the deployment to apply changes.",
      'WHEN TO USE: after read_deployment_logs identified a concrete fix AND the user agreed to apply it. Set a missing/wrong secret with action="set_secret", then action="redeploy" to apply.',
      'Each call asks the user to confirm before running.',
    ].join(' '),
    inputSchema,
    permissionTier: 'confirm',
    humanDescription: (args = {}) =>
      args.action === 'set_secret'
        ? `Guardar secreto ${String(args.key || '').slice(0, 40)} en el deployment`
        : `Re-publicar el deployment ${String(args.deploymentId || '').slice(0, 12)}`,
    execute: async (args, ctx = {}) => {
      const userId = ctx.userId;
      if (!userId) return { ok: false, error: 'no autenticado' };
      const service = ctx.deploymentService || require('../../deployments/deployment-service');
      const prisma = ctx.prisma || safeRequire('../../config/database');
      const db = ctx.prisma || undefined;

      // Ownership check (also surfaces a clear error if it's not theirs).
      let detail;
      try {
        detail = await service.getDeployment({ userId, id: args.deploymentId, db });
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'deployment no encontrado' };
      }
      if (!detail) return { ok: false, error: 'deployment no encontrado o no te pertenece' };

      if (args.action === 'set_secret') {
        if (!args.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.key)) {
          return { ok: false, error: 'nombre de secreto inválido (usa MAYUS_CON_GUION_BAJO)' };
        }
        if (!prisma || !prisma.deployment || !prisma.deployEnv) return { ok: false, error: 'base de datos no disponible' };
        const raw = await prisma.deployment.findFirst({ where: { id: args.deploymentId, userId } });
        const connId = raw && raw.connectedRepositoryId;
        if (!connId) return { ok: false, error: 'este deployment no tiene secrets (sin repo de GitHub conectado)' };
        const creds = ctx.creds || require('../../hosting/credentials');
        const existing = await prisma.deployEnv.findFirst({ where: { connectedRepositoryId: connId, userId } });
        const envObj = existing ? creds.openJson(existing.encryptedEnv) : {};
        envObj[args.key] = String(args.value || '');
        const sealed = creds.sealJson(envObj);
        if (existing) await prisma.deployEnv.update({ where: { id: existing.id }, data: { encryptedEnv: sealed } });
        else await prisma.deployEnv.create({ data: { userId, connectedRepositoryId: connId, encryptedEnv: sealed } });
        return { ok: true, action: 'set_secret', key: args.key, note: `Secreto ${args.key} guardado. Llama apply_deployment_fix con action="redeploy" para aplicarlo.` };
      }

      // redeploy
      try {
        const result = await service.publishDeployment({ userId, id: args.deploymentId, db });
        return {
          ok: true,
          action: 'redeploy',
          status: result.deployment && result.deployment.status,
          url: result.url || null,
          failedPhase: result.failedPhase || null,
          failureMessage: result.failureMessage || null,
          note: result.failedPhase ? 'El re-deploy falló — vuelve a leer los logs para diagnosticar.' : 'Re-deploy lanzado correctamente.',
        };
      } catch (e) {
        return { ok: false, error: (e && e.message) || 're-deploy fallido' };
      }
    },
  };
}

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

module.exports = { buildApplyDeploymentFixTool, inputSchema };
