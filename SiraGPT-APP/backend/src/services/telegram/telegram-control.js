'use strict';

const crypto = require('crypto');

/**
 * telegram-control — control siraGPT code/dev agents from Telegram.
 *
 * Pure, dependency-light command layer (the route injects the heavy deps:
 * the codex orchestrator, prisma user lookup, run store). Completely inert
 * unless TELEGRAM_BOT_TOKEN is set, so it has zero effect on a default
 * deployment / CI.
 *
 * Commands:
 *   /start, /help            → usage
 *   <plain text>             → conversational chat with the siraGPT assistant
 *   /code <goal>             → start a codex run (alias: /build, /agent)
 *   /status <runId>          → report a run's status/phase/percent
 */

const TELEGRAM_API = 'https://api.telegram.org';

const HELP = [
  '🤖 *siraGPT*',
  '',
  'Escríbeme como a un asistente: pregunta lo que quieras y te respondo aquí mismo.',
  '',
  'Comandos de agente de código:',
  '`/code <instrucción>` — inicia una tarea de desarrollo',
  '   ej: `/code crea una landing page con Tailwind y un formulario`',
  '`/status <runId>` — progreso de una tarea',
  '`/help` — esta ayuda',
].join('\n');

/**
 * Tiny per-chat conversation memory so the Telegram bridge holds a real
 * dialogue (follow-ups resolve pronouns, "y eso cómo se hace?" works).
 * Pure + bounded: at most `maxTurns` messages per chat, `maxChats` chats
 * (least-recently-used chat evicted first). No TTL — process-lifetime only.
 */
function createChatMemory({ maxTurns = 12, maxChats = 200 } = {}) {
  const chats = new Map(); // chatId → [{ role, content }]
  function history(chatId) {
    const key = String(chatId);
    const list = chats.get(key) || [];
    if (chats.has(key)) {
      // refresh recency (Map iteration order = insertion order)
      chats.delete(key);
      chats.set(key, list);
    }
    return list.slice();
  }
  function remember(chatId, role, content) {
    const key = String(chatId);
    const text = String(content || '').trim();
    if (!text) return;
    const list = chats.get(key) || [];
    chats.delete(key);
    list.push({ role: role === 'assistant' ? 'assistant' : 'user', content: text });
    while (list.length > maxTurns) list.shift();
    chats.set(key, list);
    while (chats.size > maxChats) {
      const oldest = chats.keys().next().value;
      chats.delete(oldest);
    }
  }
  function reset(chatId) {
    chats.delete(String(chatId));
  }
  return { history, remember, reset, size: () => chats.size };
}

function getTelegramConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const webhookSecret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const allowedChatIds = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const agentUserId = String(env.TELEGRAM_AGENT_USER_ID || '').trim() || null;
  const webhookUrl = String(env.TELEGRAM_WEBHOOK_URL || '').trim() || null;
  return {
    token,
    webhookSecret,
    allowedChatIds,
    agentUserId,
    webhookUrl,
    enabled: Boolean(token),
  };
}

function isTelegramConfigured(env = process.env) {
  return getTelegramConfig(env).enabled;
}

/** When no allow-list is set the bot is open; otherwise restrict by chat id. */
function isChatAllowed(config, chatId) {
  if (!config || !Array.isArray(config.allowedChatIds) || config.allowedChatIds.length === 0) {
    return true;
  }
  return config.allowedChatIds.includes(String(chatId));
}

/**
 * Verify Telegram's secret-token header (set via setWebhook).
 * Fails CLOSED: with no secret configured the webhook is unauthenticated and
 * MUST NOT accept anonymous callers (they could reach enqueueRun → host-side
 * agent/code runs). The route surfaces a clearer 403 in that case. When a
 * secret IS configured, compare in constant time over SHA-256 digests
 * (timingSafeEqual throws on unequal-length buffers, so hash both sides first).
 */
function verifyWebhookSecret(headerValue, config) {
  if (!config || !config.webhookSecret) return false; // no secret configured → reject
  const provided = crypto.createHash('sha256').update(String(headerValue || '')).digest();
  const expected = crypto.createHash('sha256').update(String(config.webhookSecret)).digest();
  return crypto.timingSafeEqual(provided, expected);
}

function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return { command: null, args: '' };
  if (!raw.startsWith('/')) return { command: 'message', args: raw };
  const m = raw.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?([\s\S]*)$/);
  if (!m) return { command: null, args: '' };
  return { command: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

function formatRunUpdate(run) {
  if (!run) return '🔍 No encontré ese run.';
  const pct = typeof run.percent === 'number' ? ` · ${run.percent}%` : '';
  const phase = run.phase ? ` · ${run.phase}` : '';
  const icon = run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : '🛠️';
  return `${icon} Run \`${run.runId}\`\nEstado: ${run.status}${phase}${pct}`;
}

async function sendTelegramMessage(token, chatId, text, opts = {}) {
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || '').slice(0, 4096),
        parse_mode: opts.parseMode || 'Markdown',
        disable_web_page_preview: true,
      }),
      // sendTelegramMessage is awaited inside a 15s polling interval; without a
      // deadline a hung api.telegram.org request stalls run-update delivery.
      signal: AbortSignal.timeout(Number(process.env.TELEGRAM_API_TIMEOUT_MS) || 10000),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-json */ }
    return { ok: Boolean(res.ok && body && body.ok), body };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function setTelegramWebhook(config) {
  if (!config || !config.token || !config.webhookUrl) {
    return { ok: false, error: 'not_configured' };
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${config.token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: config.webhookUrl,
        secret_token: config.webhookSecret || undefined,
        allowed_updates: ['message'],
      }),
      signal: AbortSignal.timeout(Number(process.env.TELEGRAM_API_TIMEOUT_MS) || 10000),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-json */ }
    return { ok: Boolean(res.ok && body && body.ok), body };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Handle a single Telegram update. `deps`:
 *   - config:       getTelegramConfig() result
 *   - send(chatId, text): async sender
 *   - resolveUser(): async → siraGPT user object (or null)
 *   - enqueueRun({ user, goal, chatId }): async → { runId, ... }
 *   - readRun(runId): async → run record (or null)
 */
async function handleTelegramUpdate(update, deps = {}) {
  const { config = {}, send, resolveUser, enqueueRun, readRun, chatReply } = deps;
  const message = update && update.message;
  if (!message || !message.chat) return { handled: false };

  const chatId = message.chat.id;
  const reply = (text) => (send ? send(chatId, text) : Promise.resolve());

  if (!isChatAllowed(config, chatId)) {
    await reply(`⛔️ Chat no autorizado. Pide al admin añadir tu chat_id (${chatId}) a TELEGRAM_ALLOWED_CHAT_IDS.`);
    return { handled: true, action: 'denied' };
  }

  const { command, args } = parseCommand(message.text || '');

  if (command === 'start' || command === 'help') {
    await reply(HELP);
    return { handled: true, action: 'help' };
  }

  if (command === 'status') {
    const run = readRun ? await readRun(args.trim()) : null;
    await reply(formatRunUpdate(run));
    return { handled: true, action: 'status', runId: args.trim() };
  }

  // Plain text = talk to the assistant (OpenClaw-style inbox). Dev runs stay
  // behind explicit /code|/build|/agent so a greeting can never launch one.
  if (command === 'message') {
    const text = String(args || '').trim();
    if (!chatReply) {
      await reply('💬 El chat conversacional no está disponible en este despliegue. Usa `/code <instrucción>` o `/help`.');
      return { handled: true, action: 'chat_unavailable' };
    }
    try {
      const user = resolveUser ? await resolveUser() : null;
      const answer = await chatReply({ user, text, chatId });
      await reply(String(answer || '').trim() || '🤖 (sin respuesta)');
      return { handled: true, action: 'chat' };
    } catch (err) {
      await reply(`❌ No pude responder ahora mismo: ${err && err.message ? err.message : 'error'}. Intenta de nuevo en un momento.`);
      return { handled: true, action: 'chat_error' };
    }
  }

  if (command === 'code' || command === 'build' || command === 'agent') {
    const goal = String(args || '').trim();
    if (goal.length < 8) {
      await reply('✍️ Dame una instrucción más detallada (mín. 8 caracteres).\nEj: `/code crea una landing con Tailwind`');
      return { handled: true, action: 'too_short' };
    }
    const user = resolveUser ? await resolveUser() : null;
    if (!user) {
      await reply('⚙️ El bot no tiene un usuario asignado. Configura `TELEGRAM_AGENT_USER_ID` con tu id de siraGPT.');
      return { handled: true, action: 'no_user' };
    }
    try {
      const record = await enqueueRun({ user, goal, chatId });
      await reply(`🚀 Tarea iniciada.\nRun: \`${record.runId}\`\nProgreso: \`/status ${record.runId}\``);
      return { handled: true, action: 'enqueued', runId: record.runId };
    } catch (err) {
      await reply(`❌ No pude iniciar la tarea: ${err && err.message ? err.message : 'error'}`);
      return { handled: true, action: 'error' };
    }
  }

  await reply('🤔 No reconozco ese comando. Escribe /help.');
  return { handled: true, action: 'unknown' };
}

module.exports = {
  TELEGRAM_API,
  HELP,
  getTelegramConfig,
  isTelegramConfigured,
  isChatAllowed,
  verifyWebhookSecret,
  parseCommand,
  formatRunUpdate,
  sendTelegramMessage,
  setTelegramWebhook,
  handleTelegramUpdate,
  createChatMemory,
};
