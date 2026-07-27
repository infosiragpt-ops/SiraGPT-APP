'use strict';

const { createNotification } = require('../user-notifications');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function deliverEmail(prisma, { userId, title, message, actionUrl = null }) {
  const user = await prisma.user.findUnique({
    where: { id: String(userId) },
    select: { email: true, name: true },
  });
  if (!user?.email) return { ok: false, skipped: true, reason: 'no_email' };
  try {
    const email = require('../email');
    if (!email.isConfigured?.() || typeof email._send !== 'function') {
      return { ok: false, skipped: true, reason: 'smtp_not_configured' };
    }
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message).replaceAll('\n', '<br>');
    const safeUrl = actionUrl && /^https?:\/\//i.test(actionUrl) ? escapeHtml(actionUrl) : null;
    await email._send({
      from: `"SiraGPT" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: String(title || 'SiraGPT Cowork').replace(/[\r\n]+/g, ' ').slice(0, 180),
      html: [
        '<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#171717">',
        `<h2>${safeTitle}</h2>`,
        `<p style="line-height:1.6">${safeMessage}</p>`,
        safeUrl
          ? `<p><a href="${safeUrl}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Abrir SiraGPT</a></p>`
          : '',
        '</div>',
      ].join(''),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function deliverTelegram({ userId, title, message }) {
  try {
    const telegram = require('../telegram/telegram-control');
    const config = telegram.getTelegramConfig();
    if (!config.enabled) return { ok: false, skipped: true, reason: 'telegram_not_configured' };
    if (config.agentUserId && String(config.agentUserId) !== String(userId)) {
      return { ok: false, skipped: true, reason: 'telegram_user_not_linked' };
    }
    const chatId = config.allowedChatIds?.[0];
    if (!chatId) return { ok: false, skipped: true, reason: 'telegram_chat_not_linked' };
    return telegram.sendTelegramMessage(
      config.token,
      chatId,
      `*${String(title || 'SiraGPT Cowork').slice(0, 160)}*\n${String(message || '').slice(0, 3600)}`,
    );
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function notify(prisma, {
  userId,
  type = 'cowork',
  title,
  message,
  severity = 'info',
  metadata = null,
  channels = ['in_app'],
  actionUrl = null,
}) {
  const requested = new Set(Array.isArray(channels) ? channels : [channels]);
  const results = {};
  let row = null;
  if (requested.has('in_app') || requested.has('web_push')) {
    row = await createNotification(prisma, {
      userId: String(userId),
      type,
      title,
      message,
      severity: requested.has('web_push') ? 'critical' : severity,
      metadata: {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        ...(actionUrl ? { actionUrl } : {}),
      },
    });
    results.in_app = { ok: Boolean(row), id: row?.id || null };
    if (requested.has('web_push')) results.web_push = { ok: Boolean(row), delegated: true };
  }
  if (requested.has('email')) {
    results.email = await deliverEmail(prisma, { userId, title, message, actionUrl });
  }
  if (requested.has('telegram')) {
    results.telegram = await deliverTelegram({ userId, title, message });
  }
  return { notification: row, channels: results };
}

async function notifyRunState(prisma, run, status, detail = null, extraMetadata = null) {
  if (!run?.userId) return null;
  const copy = {
    completed: {
      title: 'Tarea Cowork completada',
      message: detail || 'La tarea termino y sus archivos ya estan disponibles.',
      severity: 'info',
    },
    waiting_approval: {
      title: 'Aprobacion necesaria',
      message: detail || 'Una tarea esta esperando tu aprobacion para continuar.',
      severity: 'warning',
    },
    failed: {
      title: 'La tarea Cowork necesita atencion',
      message: detail || 'La tarea se detuvo por un error.',
      severity: 'warning',
    },
  }[status];
  if (!copy) return null;
  return notify(prisma, {
    userId: run.userId,
    type: `cowork_${status}`,
    ...copy,
    metadata: {
      ...(extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {}),
      runId: run.id,
      workspaceId: run.workspaceId,
      chatId: run.chatId,
      status,
    },
    actionUrl: `${String(process.env.FRONTEND_URL || 'https://siragpt.com').replace(/\/$/, '')}/chat${run.chatId ? `?id=${encodeURIComponent(run.chatId)}` : ''}`,
    channels: status === 'waiting_approval'
      ? ['in_app', 'web_push', 'email', 'telegram']
      : ['in_app', 'web_push'],
  });
}

module.exports = {
  notify,
  notifyRunState,
  deliverEmail,
  deliverTelegram,
};
