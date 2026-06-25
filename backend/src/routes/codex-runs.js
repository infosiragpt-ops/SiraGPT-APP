'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { enforcePlanQuota } = require('../middleware/enforce-plan-quota');
const prisma = require('../config/database');
const chatTaskScope = require('../services/agents/chat-task-scope');
const crypto = require('crypto');
const codexOrchestrator = require('../services/codex/codex-run-orchestrator');
const codexRunStore = require('../services/codex/codex-run-store');
const { createGitHubCodexConnector } = require('../services/github-codex-connector');
const { runAgentTaskJob } = require('../services/agents/agent-task-runner');
const { runTests } = require('../services/agents/code-sandbox');

const router = express.Router();

router.post(
  '/runs',
  [
    body('goal').isString().trim().isLength({ min: 8, max: 8000 }),
    body('chatId').optional().isString(),
    body('scopeMode').optional().isIn(['chat', 'global']),
    body('repository').optional().isString().trim().isLength({ max: 240 }),
    body('branch').optional().isString().trim().isLength({ max: 120 }),
    body('taskId').optional().isString(),
    body('model').optional().isString(),
  ],
  authenticateToken,
  enforcePlanQuota({ surface: 'agent.task.create' }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const scope = await chatTaskScope.assertChatScopeForAgentTask({
        prisma,
        userId: req.user.id,
        body: req.body,
      });
      if (!scope.ok) return res.status(scope.status).json(scope.body);

      const taskId = req.body.taskId || crypto.randomUUID();
      const record = codexOrchestrator.enqueueCodexRun(
        {
          userId: req.user.id,
          chatId: scope.chatId,
          goal: req.body.goal,
          repository: req.body.repository || null,
          branch: req.body.branch || 'main',
          taskId,
          model: req.body.model,
        },
        {
          githubConnector: req.body.repository ? createGitHubCodexConnector() : null,
          runAgentTaskJob: async (payload) => runAgentTaskJob({
            ...payload,
            taskId: payload.taskId || taskId,
            user: req.user,
          }),
          runVerification: async () => {
            try {
              return await runTests({
                cwd: process.cwd(),
                timeoutMs: 120_000,
              });
            } catch (err) {
              return { ok: false, error: err && err.message ? err.message : String(err) };
            }
          },
        },
      );

      return res.status(202).json({
        ok: true,
        runId: record.runId,
        status: record.status,
        phase: record.phase,
        chatId: record.chatId,
      });
    } catch (err) {
      // A Prisma rejection in the scope assertion or a synchronous store/FS
      // throw in enqueueCodexRun would otherwise escape to Express's default
      // HTML 500 page; return the JSON error contract the codex.js surface uses.
      return res.status(500).json({ error: 'codex_enqueue_failed', message: err && err.message ? err.message : String(err) });
    }
  },
);

router.get(
  '/runs/:runId',
  [param('runId').isString()],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const row = codexRunStore.readRun(req.params.runId);
    if (!row || String(row.userId) !== String(req.user.id)) {
      return res.status(404).json({ error: 'run_not_found' });
    }
    return res.json({ ok: true, run: row });
  },
);

router.get(
  '/runs/:runId/events',
  [param('runId').isString()],
  authenticateToken,
  async (req, res) => {
    const row = codexRunStore.readRun(req.params.runId);
    if (!row || String(row.userId) !== String(req.user.id)) {
      return res.status(404).json({ error: 'run_not_found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    for (const event of row.events || []) send(event);
    send({ type: 'snapshot', run: row });
    res.end();
  },
);

module.exports = router;
