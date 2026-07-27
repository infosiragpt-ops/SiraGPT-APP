'use strict';

/**
 * /api/telegram — siraGPT on Telegram: conversational assistant (plain text →
 * LLM ladder reply, per-chat rolling memory) + remote control for dev agents
 * (/code, /status).
 *
 * Mounted WITHOUT CSRF (external POST from Telegram, gated by a secret token
 * header). Inert unless TELEGRAM_BOT_TOKEN is configured. Heavy deps
 * (orchestrator, prisma, LLM provider) are lazy-required inside handlers so
 * requiring this route never affects boot.
 */

const express = require('express');
const crypto = require('crypto');
const tg = require('../services/telegram/telegram-control');

const router = express.Router();

// Per-chat rolling memory for the conversational relay (process-lifetime).
const chatMemory = tg.createChatMemory({ maxTurns: 12, maxChats: 200 });

const CHAT_SYSTEM_PROMPT = [
  'Eres siraGPT, el asistente personal de IA de siragpt.com, respondiendo por Telegram.',
  'Responde en el idioma del usuario (por defecto español), de forma útil, directa y concisa',
  '(es una app de mensajería: evita muros de texto; usa listas cortas cuando ayuden).',
  'Si el usuario pide construir software, sugiérele el comando /code <instrucción>.',
  'No inventes datos; si no sabes algo, dilo.',
].join(' ');

// Conversational relay: plain Telegram text → LLM ladder → reply. Lazy-requires
// the provider so an unconfigured deployment never pays the import.
async function telegramChatReply({ user, text, chatId }) {
  const { chatComplete } = require('../services/codex/llm-provider');
  const system = user && (user.name || user.email)
    ? `${CHAT_SYSTEM_PROMPT} Hablas con ${user.name || user.email}.`
    : CHAT_SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: system },
    ...chatMemory.history(chatId),
    { role: 'user', content: text },
  ];
  const out = await chatComplete({ messages, temperature: 0.4, maxTokens: 700 });
  const answer = String(out?.content || '').trim();
  if (answer) {
    chatMemory.remember(chatId, 'user', text);
    chatMemory.remember(chatId, 'assistant', answer);
  }
  return answer;
}

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
      chatReply: telegramChatReply,
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
