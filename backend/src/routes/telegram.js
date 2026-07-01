'use strict';

/**
 * /api/telegram — Telegram remote control for siraGPT dev agents.
 *
 * Mounted WITHOUT CSRF (external POST from Telegram, gated by a secret token
 * header). Inert unless TELEGRAM_BOT_TOKEN is configured. Heavy deps
 * (orchestrator, prisma) are lazy-required inside handlers so requiring this
 * route never affects boot.
 */

const express = require('express');
const crypto = require('crypto');
const tg = require('../services/telegram/telegram-control');

const router = express.Router();

// Best-effort: poll a run and push milestone updates back to Telegram.
function startRunPoller(config, chatId, runId) {
  let lastPhase = null;
  let polls = 0;
  const maxPolls = 40; // ~10 min at 15s
  const timer = setInterval(async () => {
    polls += 1;
    let run = null;
    try {
      run = require('../services/codex/codex-run-store').readRun(runId);
    } catch {
      /* store unavailable */
    }
    const terminal = run && (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
    // Stop the poller BEFORE any await that could throw, so a Telegram send
    // failure can never skip clearInterval and strand the 15s interval.
    if (terminal || polls >= maxPolls) {
      clearInterval(timer);
    }
    // Notifications are best-effort — a send failure must not crash the tick.
    try {
      if (run && run.phase && run.phase !== lastPhase) {
        lastPhase = run.phase;
        await tg.sendTelegramMessage(config.token, chatId, tg.formatRunUpdate(run));
      }
      if (terminal) {
        await tg.sendTelegramMessage(config.token, chatId, tg.formatRunUpdate(run));
      }
    } catch (err) {
      console.warn('[telegram] run-poller notify failed:', err?.message || err);
    }
  }, 15_000);
  if (timer.unref) timer.unref();
}

router.get('/health', (req, res) => {
  const cfg = tg.getTelegramConfig();
  res.json({
    ok: true,
    configured: cfg.enabled,
    hasWebhookSecret: Boolean(cfg.webhookSecret),
    restricted: cfg.allowedChatIds.length > 0,
    agentUserConfigured: Boolean(cfg.agentUserId),
    webhookConfigured: Boolean(cfg.webhookUrl),
  });
});

router.post('/webhook', async (req, res) => {
  const cfg = tg.getTelegramConfig();
  if (!cfg.enabled) return res.status(503).json({ ok: false, error: 'telegram_not_configured' });

  // Fail closed: an enabled bot with no webhook secret is an unauthenticated
  // path to host-side agent/code runs. Refuse with a clear operator signal.
  if (!cfg.webhookSecret) {
    return res.status(403).json({ ok: false, error: 'webhook_secret_required' });
  }

  const secretHeader = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!tg.verifyWebhookSecret(secretHeader, cfg)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  // Acknowledge immediately so Telegram doesn't retry; process asynchronously.
  res.status(200).json({ ok: true });

  try {
    await tg.handleTelegramUpdate(req.body, {
      config: cfg,
      send: (chatId, text) => tg.sendTelegramMessage(cfg.token, chatId, text),
      resolveUser: async () => {
        if (!cfg.agentUserId) return null;
        try {
          const prisma = require('../config/database');
          return await prisma.user.findUnique({
            where: { id: cfg.agentUserId },
            select: { id: true, email: true, name: true },
          });
        } catch {
          return null;
        }
      },
      readRun: async (runId) => {
        try {
          return require('../services/codex/codex-run-store').readRun(runId);
        } catch {
          return null;
        }
      },
      enqueueRun: async ({ user, goal, chatId }) => {
        const codexOrchestrator = require('../services/codex/codex-run-orchestrator');
        const { runAgentTaskJob } = require('../services/agents/agent-task-runner');
        const { runTests } = require('../services/agents/code-sandbox');
        const taskId = crypto.randomUUID();
        const record = codexOrchestrator.enqueueCodexRun(
          {
            userId: user.id,
            chatId: `telegram-${chatId}`,
            goal,
            repository: null,
            branch: 'main',
            taskId,
          },
          {
            githubConnector: null,
            runAgentTaskJob: async (payload) => runAgentTaskJob({
              ...payload,
              taskId: payload.taskId || taskId,
              user,
            }),
            runVerification: async () => {
              try {
                return await runTests({ cwd: process.cwd(), timeoutMs: 120_000 });
              } catch (err) {
                return { ok: false, error: err && err.message ? err.message : String(err) };
              }
            },
          },
        );
        startRunPoller(cfg, chatId, record.runId);
        return record;
      },
    });
  } catch {
    /* response already sent; swallow to avoid unhandled rejection */
  }
});

module.exports = router;
