'use strict';

const progressLedger = require('./progress-ledger');
const {
  getTelegramConfig,
  sendTelegramMessage,
} = require('../telegram/telegram-control');

const DIGEST_PREFIX = 'codex_proactive_digest:';

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function digestKey(day) {
  return `${DIGEST_PREFIX}${day}`;
}

function plain(value, max = 160) {
  return String(value || '')
    .replace(/[*_`[\]()~>#+=|{}.!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function formatDigest(projects, now = new Date()) {
  const today = dayKey(now);
  const lines = [`SiraGPT Proactivo - resumen ${today}`];
  let entries = 0;
  for (const project of projects) {
    const memory = progressLedger.readProgressContext(project);
    const daily = memory.ledger.filter((item) => String(item.createdAt).startsWith(today));
    if (!daily.length) continue;
    entries += daily.length;
    const passed = daily.filter((item) => item.outcome === 'passed').length;
    const failed = daily.filter((item) => item.outcome === 'failed').length;
    const cost = daily.reduce((sum, item) => sum + (Number(item.costUsd) || 0), 0);
    const additions = daily.reduce((sum, item) => sum + (Number(item.diffstat?.additions) || 0), 0);
    const deletions = daily.reduce((sum, item) => sum + (Number(item.diffstat?.deletions) || 0), 0);
    lines.push('');
    lines.push(`${plain(project.name || project.id)}: ${daily.length} ciclos, ${passed} ok, ${failed} fallidos`);
    lines.push(`Cambios +${additions}/-${deletions} | costo $${cost.toFixed(4)}`);
    for (const item of daily.slice(-3)) {
      lines.push(`- ${plain(item.department, 50)}: ${plain(item.task || item.runId, 120)} [${item.outcome}]`);
    }
  }
  if (!entries) return null;
  return lines.join('\n').slice(0, 3900);
}

async function sendDailyDigest({
  prisma: explicitPrisma,
  env = process.env,
  now = () => new Date(),
  sendMessage = sendTelegramMessage,
} = {}) {
  const prisma = explicitPrisma || require('../../config/database');
  const config = getTelegramConfig(env);
  const chatId = String(env.TELEGRAM_DIGEST_CHAT_ID || config.allowedChatIds[0] || '').trim();
  if (!config.token || !chatId) return { action: 'skipped_not_configured' };
  if (!prisma?.systemSettings?.findUnique || !prisma?.systemSettings?.upsert) {
    return { action: 'skipped_store_unavailable' };
  }

  const today = dayKey(now());
  const key = digestKey(today);
  const sent = await prisma.systemSettings.findUnique({ where: { key } });
  if (sent) return { action: 'already_sent', dayKey: today };

  const projects = await prisma.codexProject.findMany({
    where: { brief: { path: ['proactive', 'enabled'], equals: true }, deletedAt: null },
    take: 50,
    orderBy: { updatedAt: 'asc' },
  });
  const text = formatDigest(projects, now());
  if (!text) return { action: 'skipped_no_activity', dayKey: today };

  const result = await sendMessage(config.token, chatId, text, { parseMode: 'Markdown' });
  if (!result?.ok) {
    return {
      action: 'send_failed',
      dayKey: today,
      error: String(result?.error || result?.body?.description || 'telegram rejected digest').slice(0, 240),
    };
  }
  await prisma.systemSettings.upsert({
    where: { key },
    create: { key, value: JSON.stringify({ sentAt: now().toISOString(), chatId }) },
    update: { value: JSON.stringify({ sentAt: now().toISOString(), chatId }) },
  });
  return { action: 'sent', dayKey: today, projects: projects.length };
}

module.exports = {
  DIGEST_PREFIX,
  dayKey,
  digestKey,
  formatDigest,
  sendDailyDigest,
};
