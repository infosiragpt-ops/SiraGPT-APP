'use strict';

const express = require('express');
const { authenticateToken: defaultAuthenticateToken } = require('../middleware/auth');
const defaultPrisma = require('../config/database');
const workspaceStore = require('../services/cowork/workspace-store');
const controlPlane = require('../services/cowork/control-plane');
const scheduler = require('../services/cowork/scheduler');
const connectorCatalog = require('../services/cowork/connector-catalog');
const permissionManager = require('../services/agent-harness/permission-manager');

function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstString(value[0]);
  return '';
}

function intValue(value, fallback, min, max) {
  const parsed = Number.parseInt(firstString(value) || String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function userId(req) {
  return req.user?.id || req.user?.userId;
}

function sendError(res, error) {
  const status = Number(error?.status) || 500;
  const exposed = status < 500;
  if (!exposed) {
    try { console.error('[cowork-platform]', error); } catch (_) { /* noop */ }
  }
  return res.status(status).json({
    error: exposed ? (error.code || 'cowork_request_failed') : 'cowork_request_failed',
    message: exposed ? error.message : 'Cowork request failed.',
    ...(exposed && error.details ? { details: error.details } : {}),
  });
}

function createCoworkPlatformRouter({
  prisma = defaultPrisma,
  authenticateToken = defaultAuthenticateToken,
} = {}) {
  const router = express.Router();

  router.use(authenticateToken);

  router.get('/workspaces', async (req, res) => {
    try {
      const workspaces = await workspaceStore.listWorkspaces(prisma, {
        userId: userId(req),
        limit: intValue(req.query.limit, 50, 1, 100),
      });
      res.json({ workspaces });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/workspaces', async (req, res) => {
    try {
      const workspace = await workspaceStore.createWorkspace(prisma, {
        userId: userId(req),
        name: req.body?.name,
      });
      res.status(201).json({ workspace });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/chats/:chatId/workspace', async (req, res) => {
    try {
      const workspace = await workspaceStore.ensureWorkspaceForChat(prisma, {
        userId: userId(req),
        chatId: req.params.chatId,
        name: req.body?.name,
      });
      res.json({ workspace });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId', async (req, res) => {
    try {
      const workspace = await workspaceStore.getWorkspace(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
      });
      const [files, recentRuns] = await Promise.all([
        workspaceStore.listFiles(prisma, {
          workspaceId: workspace.id,
          userId: userId(req),
        }),
        controlPlane.listRuns(prisma, {
          userId: userId(req),
          workspaceId: workspace.id,
          limit: 25,
        }),
      ]);
      res.json({ workspace, files, recentRuns });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/workspaces/:workspaceId', async (req, res) => {
    try {
      const workspace = await workspaceStore.getWorkspace(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
      });
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'workspace_name_required' });
      const updated = await prisma.coworkWorkspace.update({
        where: { id: workspace.id },
        data: { name: name.slice(0, 160) },
      });
      return res.json({ workspace: updated });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/files', async (req, res) => {
    try {
      const files = await workspaceStore.listFiles(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
      });
      res.json({ files });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/file', async (req, res) => {
    try {
      const filePath = firstString(req.query.path);
      const versionText = firstString(req.query.version);
      const file = await workspaceStore.readFile(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
        filePath,
        version: versionText ? Number(versionText) : null,
      });
      res.json({ file });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/workspaces/:workspaceId/file', async (req, res) => {
    try {
      const file = await workspaceStore.writeFile(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
        filePath: req.body?.path,
        content: req.body?.content,
        encoding: req.body?.encoding || 'utf8',
        mime: req.body?.mime,
        expectedVersion: req.body?.expectedVersion ?? null,
        artifactId: req.body?.artifactId || null,
        updatedBy: 'user',
      });
      await controlPlane.appendAudit(prisma, {
        userId: userId(req),
        workspaceId: req.params.workspaceId,
        action: 'cowork.file.user_write',
        targetType: 'cowork_file',
        targetId: file.id,
        resultSummary: `${file.path}@${file.currentVersion}`,
      });
      res.json({
        file: {
          id: file.id,
          path: file.path,
          version: file.currentVersion,
          contentHash: file.contentHash,
          mime: file.mime,
          size: file.size,
          unchanged: Boolean(file.unchanged),
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/workspaces/:workspaceId/file', async (req, res) => {
    try {
      const result = await workspaceStore.deleteFile(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
        filePath: req.body?.path,
        expectedVersion: req.body?.expectedVersion,
      });
      await controlPlane.appendAudit(prisma, {
        userId: userId(req),
        workspaceId: req.params.workspaceId,
        action: 'cowork.file.user_delete',
        targetType: 'cowork_file',
        targetId: result.path,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/file/diff', async (req, res) => {
    try {
      const result = await workspaceStore.diffVersions(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
        filePath: firstString(req.query.path),
        fromVersion: intValue(req.query.from, 1, 1, 100000),
        toVersion: firstString(req.query.to) ? intValue(req.query.to, 1, 1, 100000) : null,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/file/download', async (req, res) => {
    try {
      const { file, source, buffer } = await workspaceStore.readFileBuffer(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
        filePath: firstString(req.query.path),
        version: firstString(req.query.version) ? intValue(req.query.version, 1, 1, 100000) : null,
      });
      const filename = file.path.split('/').pop() || 'download';
      res.setHeader('Content-Type', source.mime || 'application/octet-stream');
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(buffer);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/export', async (req, res) => {
    try {
      const exported = await workspaceStore.exportWorkspaceZip(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(exported.buffer.length));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`);
      res.send(exported.buffer);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/runs', async (req, res) => {
    try {
      const runs = await controlPlane.listRuns(prisma, {
        userId: userId(req),
        workspaceId: firstString(req.query.workspaceId) || null,
        chatId: firstString(req.query.chatId) || null,
        status: firstString(req.query.status) || null,
        limit: intValue(req.query.limit, 100, 1, 250),
      });
      res.json({ runs });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/runs/:runId', async (req, res) => {
    try {
      const run = await controlPlane.getOwnedRun(prisma, {
        runId: req.params.runId,
        userId: userId(req),
        include: {
          steeringNotes: { orderBy: { createdAt: 'asc' } },
          approvals: { orderBy: { createdAt: 'desc' } },
          childRuns: { orderBy: { createdAt: 'desc' } },
          fileVersions: {
            orderBy: { createdAt: 'desc' },
            include: { file: { select: { path: true } } },
          },
        },
      });
      res.json({ run });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/runs/:runId/control', async (req, res) => {
    try {
      const run = await controlPlane.transitionRun(prisma, {
        runId: req.params.runId,
        userId: userId(req),
        action: req.body?.action,
      });
      res.json({ run });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/runs/:runId/checklist', async (req, res) => {
    try {
      const run = await controlPlane.updateChecklist(prisma, {
        runId: req.params.runId,
        userId: userId(req),
        checklist: req.body?.items,
      });
      res.json({ run });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/approvals', async (req, res) => {
    try {
      const approvals = await permissionManager.listPendingDurable(prisma, userId(req), {
        limit: intValue(req.query.limit, 100, 1, 250),
      });
      res.json({ approvals });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/approvals/:approvalId/decision', async (req, res) => {
    try {
      const result = await permissionManager.resolvePermission({
        permissionId: req.params.approvalId,
        decision: req.body?.decision,
        userId: userId(req),
        prisma,
      });
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      if (result.requiresResume && result.runId) {
        const approvalUserId = userId(req);
        setImmediate(() => {
          const { resumeCoworkRun } = require('../services/cowork/headless-runner');
          resumeCoworkRun(prisma, {
            runId: result.runId,
            userId: approvalUserId,
          }).catch((error) => {
            try { console.warn('[cowork] durable run resume failed:', error.message); } catch (_) { /* noop */ }
          });
        });
      }
      return res.json({
        ...result,
        resumeScheduled: Boolean(result.requiresResume && result.runId),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/scheduled-tasks', async (req, res) => {
    try {
      const tasks = await scheduler.listScheduledTasks(prisma, {
        userId: userId(req),
        workspaceId: firstString(req.query.workspaceId) || null,
      });
      res.json({ tasks });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/scheduled-tasks', async (req, res) => {
    try {
      const task = await scheduler.createScheduledTask(prisma, {
        userId: userId(req),
        workspaceId: req.body?.workspaceId || null,
        prompt: req.body?.prompt,
        cronExpr: req.body?.cronExpr,
        tz: req.body?.tz,
        deliver: req.body?.deliver,
        maxSteps: req.body?.maxSteps,
        maxCostUsd: req.body?.maxCostUsd,
        createdFrom: 'ui',
      });
      res.status(201).json({ task });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/scheduled-tasks/:taskId', async (req, res) => {
    try {
      const task = await scheduler.updateScheduledTask(prisma, {
        userId: userId(req),
        taskId: req.params.taskId,
        patch: req.body || {},
      });
      res.json({ task });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/scheduled-tasks/:taskId', async (req, res) => {
    try {
      const deleted = await scheduler.deleteScheduledTask(prisma, {
        userId: userId(req),
        taskId: req.params.taskId,
      });
      if (!deleted) return res.status(404).json({ error: 'scheduled_task_not_found' });
      return res.json({ deleted: true });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/connectors', async (req, res) => {
    try {
      const connectors = await connectorCatalog.listConnectors(prisma, userId(req));
      res.json({ connectors });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/connectors/:provider', async (req, res) => {
    try {
      const account = await connectorCatalog.upsertConnector(prisma, {
        userId: userId(req),
        provider: req.params.provider,
        accountLabel: req.body?.accountLabel,
        scopes: req.body?.scopes,
        token: req.body?.token,
        config: req.body?.config,
      });
      res.json({ account });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/connectors/:provider', async (req, res) => {
    try {
      const disconnected = await connectorCatalog.disconnectConnector(prisma, {
        userId: userId(req),
        provider: req.params.provider,
      });
      res.json({ disconnected });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/memory', async (req, res) => {
    try {
      await workspaceStore.getWorkspace(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
      });
      const memories = await prisma.coworkMemory.findMany({
        where: { workspaceId: req.params.workspaceId, userId: String(userId(req)) },
        orderBy: { createdAt: 'desc' },
        take: intValue(req.query.limit, 100, 1, 500),
      });
      res.json({ memories });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/workspaces/:workspaceId/memory', async (req, res) => {
    try {
      await workspaceStore.getWorkspace(prisma, {
        workspaceId: req.params.workspaceId,
        userId: userId(req),
      });
      const fact = String(req.body?.fact || '').trim();
      if (!fact) return res.status(400).json({ error: 'memory_fact_required' });
      const memory = await prisma.coworkMemory.create({
        data: {
          userId: String(userId(req)),
          workspaceId: req.params.workspaceId,
          fact: fact.slice(0, 10_000),
          sourceChatId: req.body?.sourceChatId || null,
        },
      });
      return res.status(201).json({ memory });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/audit', async (req, res) => {
    try {
      const logs = await controlPlane.listAudit(prisma, {
        userId: userId(req),
        workspaceId: firstString(req.query.workspaceId) || null,
        runId: firstString(req.query.runId) || null,
        limit: intValue(req.query.limit, 100, 1, 500),
      });
      res.json({ logs });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/costs', async (req, res) => {
    try {
      const summary = await controlPlane.getCostSummary(prisma, {
        userId: userId(req),
        workspaceId: firstString(req.query.workspaceId) || null,
        days: intValue(req.query.days, 30, 1, 365),
      });
      res.json(summary);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

module.exports = {
  createCoworkPlatformRouter,
  sendError,
};
