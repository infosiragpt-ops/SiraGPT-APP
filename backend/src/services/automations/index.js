'use strict';

/**
 * Automations — reminders, recurring jobs, «/loop»-style intervals and a
 * per-user heartbeat that the chat agent can create for the user, delivered
 * back into the chat where they were requested.
 *
 * Native rewrite of the OpenClaw (MIT) cron / heartbeat ideas on top of the
 * existing Cowork `ScheduledAgentTask` table — no migration:
 *   - origin (kind + originating chat) lives in `createdFrom`
 *     (see ./origin.js); the cowork scheduler worker executes the rows;
 *   - one-shot reminders are a cron pinned to the exact minute with
 *     `nextRunAt` = the instant, deleted after a successful run;
 *   - sub-day intervals are snapped to cron divisors (`*\/15 * * * *`);
 *   - the heartbeat is one row per user (`agent:heartbeat`) whose cron
 *     encodes the cadence and the active hours (`*\/30 8-21 * * *`);
 *   - failures are tracked in `lastStatus` (`failed:N`) with backoff
 *     [30 s, 1 min, 5 min, 15 min, 60 min] and auto-disable after 10
 *     (3 for a one-shot reminder);
 *   - an answer of exactly `NO_REPLY` means «nothing to report»: no
 *     message, no notification, `lastStatus: 'quiet'`.
 *
 * Everything here is user-scoped and Prisma-injectable (tests use a fake).
 */

const controlPlane = require('../cowork/control-plane');
const schedule = require('./schedule');
const origin = require('./origin');

const MAX_PER_USER = Math.min(
  200,
  Math.max(1, Number.parseInt(process.env.SIRAGPT_AUTOMATIONS_MAX_PER_USER || '25', 10) || 25),
);
const DEFAULT_MAX_STEPS = 12;
const MAX_PROMPT_CHARS = 4000;
const NO_REPLY = 'NO_REPLY';
const MAX_FAILURES = 10;
const ONCE_MAX_FAILURES = 3;
const BACKOFF_MS = Object.freeze([30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
const HEARTBEAT_MINUTES = Object.freeze([15, 20, 30, 60]);
const DEFAULT_HEARTBEAT_PROMPT = [
  'Latido periódico de SiraGPT. Revisa si hay algo pendiente, vencido o que el usuario deba saber ahora:',
  'recordatorios acordados en esta conversación, tareas que quedaron a medias, fechas próximas.',
  'Si no hay nada nuevo que valga la pena interrumpir al usuario, responde exactamente NO_REPLY.',
  'Si hay algo, dilo en una o dos frases, sin repetir lo que ya informaste antes.',
].join(' ');

class AutomationError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

const SCHEDULE_ERROR_MESSAGES = Object.freeze({
  schedule_in_past: 'Ese momento ya pasó. Indica una hora futura.',
  schedule_too_far: 'Solo puedo programar hasta un año hacia adelante.',
  schedule_too_frequent: 'La frecuencia mínima es cada minuto.',
});

function parseFailureStreak(lastStatus) {
  const m = /^failed:(\d+)$/.exec(String(lastStatus || ''));
  return m ? Number(m[1]) : 0;
}

function backoffDelayMs(streak) {
  const idx = Math.min(Math.max(Number(streak) || 1, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[idx];
}

function maxFailuresFor(kind) {
  return kind === 'once' ? ONCE_MAX_FAILURES : MAX_FAILURES;
}

function isNoReply(answer) {
  const text = String(answer || '').trim();
  if (!text) return false;
  // Tolerate light decoration («NO_REPLY.», «**NO_REPLY**») but nothing else.
  return /^[`*_\s]*NO_REPLY[`*_.\s]*$/.test(text);
}

function kindForSchedule(parsed) {
  if (parsed.kind === 'at') return 'once';
  if (parsed.kind === 'every') return 'loop';
  return 'recurring';
}

function normalizePrompt(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new AutomationError('automation_prompt_required', 'Describe qué debe hacer la automatización.', 400);
  return text.slice(0, MAX_PROMPT_CHARS);
}

function normalizeTitle(title, prompt) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  const base = text || String(prompt || '').replace(/\s+/g, ' ').trim();
  return base.slice(0, 80);
}

/**
 * Parses `scheduleInput` (natural text or an already-parsed schedule) or
 * throws an AutomationError the caller can relay verbatim.
 */
function resolveSchedule(scheduleInput, { now, tz }) {
  const zone = schedule.normalizeTimeZone(tz, 'UTC');
  if (scheduleInput && typeof scheduleInput === 'object' && scheduleInput.cronExpr) {
    if (!schedule.isValidCron(scheduleInput.cronExpr)) {
      throw new AutomationError('schedule_invalid', 'La expresión cron no es válida.', 400);
    }
    const kind = ['at', 'every', 'cron'].includes(scheduleInput.kind) ? scheduleInput.kind : 'cron';
    const at = kind === 'at' && scheduleInput.at ? new Date(scheduleInput.at).toISOString() : null;
    const built = { kind, cronExpr: String(scheduleInput.cronExpr), tz: zone, at, everyMs: scheduleInput.everyMs || null, adjusted: null, source: 'cron' };
    return { ...built, description: schedule.describeSchedule(built, { now }) };
  }
  const parsed = schedule.parseNaturalSchedule(String(scheduleInput || ''), { now, tz: zone });
  if (!parsed) {
    throw new AutomationError(
      'schedule_unparseable',
      'No entendí cuándo debe ejecutarse. Ejemplos: «en 20 minutos», «mañana a las 9», «cada lunes a las 9», «todos los días a las 8:30», «cada 15 minutos».',
      400,
    );
  }
  if (parsed.error) {
    throw new AutomationError(parsed.error, SCHEDULE_ERROR_MESSAGES[parsed.error] || 'Horario inválido.', 400);
  }
  return parsed;
}

function automationWhere(userId, { chatId = null, kind = null } = {}) {
  const where = { userId: String(userId), createdFrom: { startsWith: origin.ORIGIN_PREFIX } };
  if (chatId) where.createdFrom = { contains: `;chat=${String(chatId)}` };
  if (kind) where.createdFrom = { startsWith: `${origin.ORIGIN_PREFIX}${kind}` };
  return where;
}

function toPublic(row, { now = new Date() } = {}) {
  if (!row) return null;
  const decoded = origin.decodeOrigin(row.createdFrom);
  const isOnce = decoded.kind === 'once';
  const sched = {
    kind: isOnce ? 'at' : (decoded.kind === 'loop' ? 'every' : 'cron'),
    cronExpr: row.cronExpr,
    tz: row.tz || 'UTC',
    at: isOnce && row.nextRunAt ? new Date(row.nextRunAt).toISOString() : null,
  };
  const failures = parseFailureStreak(row.lastStatus);
  const disabledByFailures = String(row.lastStatus || '') === 'disabled:failures';
  return {
    id: row.id,
    kind: decoded.kind,
    chatId: decoded.chatId,
    prompt: row.prompt,
    schedule: { ...sched, description: schedule.describeSchedule(sched, { now }) },
    enabled: Boolean(row.enabled),
    nextRunAt: row.nextRunAt ? new Date(row.nextRunAt).toISOString() : null,
    nextRunLocal: row.enabled && row.nextRunAt ? schedule.formatLocal(row.nextRunAt, row.tz || 'UTC') : null,
    lastRunAt: row.lastRunAt ? new Date(row.lastRunAt).toISOString() : null,
    lastStatus: row.lastStatus || null,
    failures,
    disabledByFailures,
    maxSteps: row.maxSteps,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}

async function countAutomations(prisma, userId) {
  return prisma.scheduledAgentTask.count({ where: automationWhere(userId) });
}

async function assertChatOwned(prisma, { userId, chatId }) {
  if (!chatId) throw new AutomationError('automation_chat_required', 'La automatización necesita un chat de origen.', 400);
  const chat = await prisma.chat.findFirst({
    where: { id: String(chatId), userId: String(userId), deletedAt: null },
    select: { id: true, title: true },
  });
  if (!chat) throw new AutomationError('automation_chat_not_found', 'No encontré ese chat.', 404);
  return chat;
}

/**
 * Creates an automation delivered into `chatId`.
 *
 * @param {object} prisma
 * @param {{ userId:string, chatId:string, prompt:string, schedule:string|object, tz?:string, title?:string, maxSteps?:number, now?:Date }} input
 */
async function createAutomation(prisma, {
  userId,
  chatId,
  prompt,
  schedule: scheduleInput,
  tz = 'UTC',
  maxSteps = null,
  now = new Date(),
}) {
  const text = normalizePrompt(prompt);
  const parsed = resolveSchedule(scheduleInput, { now, tz });
  const kind = kindForSchedule(parsed);
  await assertChatOwned(prisma, { userId, chatId });
  const existing = await countAutomations(prisma, userId);
  if (existing >= MAX_PER_USER) {
    throw new AutomationError(
      'automation_limit_reached',
      `Ya tienes ${existing} automatizaciones activas (máximo ${MAX_PER_USER}). Elimina alguna antes de crear otra.`,
      409,
      { limit: MAX_PER_USER, count: existing },
    );
  }
  const limits = await controlPlane.loadUserLimits(prisma, userId);
  const steps = Math.round(Math.min(
    Math.max(Number(maxSteps) || Math.min(DEFAULT_MAX_STEPS, limits.maxSteps), 1),
    limits.maxSteps,
  ));
  const nextRunAt = schedule.nextRunFor(parsed, { now });
  if (!nextRunAt) throw new AutomationError('schedule_in_past', SCHEDULE_ERROR_MESSAGES.schedule_in_past, 400);
  const row = await prisma.scheduledAgentTask.create({
    data: {
      userId: String(userId),
      workspaceId: null,
      prompt: text,
      cronExpr: parsed.cronExpr,
      tz: parsed.tz,
      deliver: 'chat',
      createdFrom: origin.encodeOrigin({ kind, chatId }),
      maxSteps: steps,
      maxCostUsd: limits.maxCostUsd,
      nextRunAt,
      enabled: true,
    },
  });
  return { ...toPublic(row, { now }), adjusted: parsed.adjusted || null };
}

async function listAutomations(prisma, { userId, chatId = null, now = new Date() }) {
  const rows = await prisma.scheduledAgentTask.findMany({
    where: automationWhere(userId, { chatId }),
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => toPublic(row, { now }));
}

async function getAutomationRow(prisma, { userId, automationId }) {
  const row = await prisma.scheduledAgentTask.findFirst({
    where: { id: String(automationId || ''), userId: String(userId) },
  });
  if (!row || !origin.isAutomationOrigin(row.createdFrom)) {
    throw new AutomationError('automation_not_found', 'No encontré esa automatización.', 404);
  }
  return row;
}

async function getAutomation(prisma, { userId, automationId, now = new Date() }) {
  return toPublic(await getAutomationRow(prisma, { userId, automationId }), { now });
}

async function removeAutomation(prisma, { userId, automationId }) {
  const row = await getAutomationRow(prisma, { userId, automationId });
  const deleted = await prisma.scheduledAgentTask.deleteMany({ where: { id: row.id, userId: String(userId) } });
  return deleted.count === 1;
}

async function setAutomationEnabled(prisma, { userId, automationId, enabled, now = new Date() }) {
  const row = await getAutomationRow(prisma, { userId, automationId });
  const on = Boolean(enabled);
  const data = { enabled: on, lockedBy: null, lockedUntil: null };
  if (on) {
    const decoded = origin.decodeOrigin(row.createdFrom);
    if (decoded.kind === 'once') {
      // A paused reminder whose instant already passed cannot be resumed.
      if (new Date(row.nextRunAt).getTime() <= now.getTime()) {
        throw new AutomationError('schedule_in_past', 'Ese recordatorio ya venció; crea uno nuevo con otra hora.', 409);
      }
    } else {
      const next = schedule.nextRunFor({ kind: 'cron', cronExpr: row.cronExpr, tz: row.tz }, { now });
      if (!next) throw new AutomationError('schedule_invalid', 'El horario guardado ya no es válido.', 409);
      data.nextRunAt = next;
    }
    // Resuming clears a failure streak / auto-disable so the backoff restarts.
    data.lastStatus = null;
  }
  const updated = await prisma.scheduledAgentTask.update({ where: { id: row.id }, data });
  return toPublic(updated, { now });
}

/**
 * Queues the automation for the next worker tick (≤ the scheduler interval)
 * instead of running it inline: the worker owns locking and lifecycle.
 */
async function runAutomationNow(prisma, { userId, automationId, now = new Date() }) {
  const row = await getAutomationRow(prisma, { userId, automationId });
  const updated = await prisma.scheduledAgentTask.update({
    where: { id: row.id },
    data: { enabled: true, nextRunAt: now, lockedBy: null, lockedUntil: null },
  });
  return { ...toPublic(updated, { now }), queued: true };
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

function hourRange(start, end) {
  const s = ((Math.round(Number(start)) % 24) + 24) % 24;
  const e = ((Math.round(Number(end)) % 24) + 24) % 24;
  if (s === e) return '*';
  const last = (e - 1 + 24) % 24;
  if (s <= last) return s === 0 && last === 23 ? '*' : `${s}-${last}`;
  // Wraps midnight: 22-6 → 22-23,0-5
  return `${s}-23,0-${last}`;
}

function heartbeatCron({ everyMinutes = 30, activeHours = null } = {}) {
  // Snap to a cron-friendly cadence; a tie rounds UP (fewer runs).
  const minutes = HEARTBEAT_MINUTES.reduce((best, m) => (
    Math.abs(m - Number(everyMinutes)) <= Math.abs(best - Number(everyMinutes)) ? m : best
  ), HEARTBEAT_MINUTES[0]);
  const hours = activeHours && Number.isFinite(Number(activeHours.start)) && Number.isFinite(Number(activeHours.end))
    ? hourRange(activeHours.start, activeHours.end)
    : '*';
  const minuteField = minutes === 60 ? '0' : `*/${minutes}`;
  return { cronExpr: `${minuteField} ${hours} * * *`, everyMinutes: minutes };
}

function buildHeartbeatPrompt(custom = null) {
  const extra = String(custom || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return extra ? `${DEFAULT_HEARTBEAT_PROMPT}\n\nInstrucciones del usuario para este latido: ${extra}` : DEFAULT_HEARTBEAT_PROMPT;
}

async function getHeartbeat(prisma, { userId, now = new Date() }) {
  const row = await prisma.scheduledAgentTask.findFirst({
    where: automationWhere(userId, { kind: 'heartbeat' }),
    orderBy: { createdAt: 'desc' },
  });
  return row ? toPublic(row, { now }) : null;
}

/**
 * Creates or updates the single heartbeat automation of a user.
 * `everyMinutes` snaps to 15/20/30/60; `activeHours {start,end}` are local
 * hours (end exclusive) in `tz`; outside them the heartbeat does not run.
 */
async function ensureHeartbeat(prisma, {
  userId,
  chatId,
  tz = 'UTC',
  everyMinutes = 30,
  activeHours = { start: 8, end: 22 },
  prompt = null,
  now = new Date(),
}) {
  const zone = schedule.normalizeTimeZone(tz, 'UTC');
  await assertChatOwned(prisma, { userId, chatId });
  const { cronExpr, everyMinutes: snapped } = heartbeatCron({ everyMinutes, activeHours });
  const nextRunAt = schedule.nextRunFor({ kind: 'cron', cronExpr, tz: zone }, { now });
  if (!nextRunAt) throw new AutomationError('schedule_invalid', 'No pude calcular el horario del latido.', 400);
  const existing = await prisma.scheduledAgentTask.findFirst({
    where: automationWhere(userId, { kind: 'heartbeat' }),
    orderBy: { createdAt: 'desc' },
  });
  const data = {
    prompt: buildHeartbeatPrompt(prompt),
    cronExpr,
    tz: zone,
    deliver: 'chat',
    createdFrom: origin.encodeOrigin({ kind: 'heartbeat', chatId }),
    nextRunAt,
    enabled: true,
    lastStatus: null,
    lockedBy: null,
    lockedUntil: null,
  };
  let row;
  if (existing) {
    row = await prisma.scheduledAgentTask.update({ where: { id: existing.id }, data });
  } else {
    const count = await countAutomations(prisma, userId);
    if (count >= MAX_PER_USER) {
      throw new AutomationError('automation_limit_reached', `Ya tienes ${count} automatizaciones (máximo ${MAX_PER_USER}).`, 409);
    }
    const limits = await controlPlane.loadUserLimits(prisma, userId);
    row = await prisma.scheduledAgentTask.create({
      data: {
        userId: String(userId),
        workspaceId: null,
        maxSteps: Math.min(DEFAULT_MAX_STEPS, limits.maxSteps),
        maxCostUsd: limits.maxCostUsd,
        ...data,
      },
    });
  }
  return { ...toPublic(row, { now }), everyMinutes: snapped, activeHours: activeHours || null };
}

async function disableHeartbeat(prisma, { userId }) {
  const deleted = await prisma.scheduledAgentTask.deleteMany({ where: automationWhere(userId, { kind: 'heartbeat' }) });
  return deleted.count > 0;
}

// ─── Run-time helpers used by the scheduler worker ──────────────────────────

/**
 * System text for a headless automation run. Replaces the Cowork «deliver
 * files in the workspace» framing: an automation answers in the chat.
 */
function buildAutomationSystemPrompt({ kind, tz = 'UTC', now = new Date(), chatTitle = null } = {}) {
  const local = schedule.formatLocal(now, tz);
  const lines = [
    'Eres SiraGPT ejecutando una automatización que el usuario programó en este chat; el usuario no está escribiendo ahora.',
    `Hora local del usuario: ${local}.`,
    chatTitle ? `Chat: «${String(chatTitle).slice(0, 120)}».` : null,
    'Responde directamente con el resultado, en el idioma de la conversación, breve y útil; el texto se publicará como un mensaje nuevo en el chat.',
    'No pidas confirmación ni hagas preguntas: no habrá respuesta hasta que el usuario vuelva.',
  ];
  if (kind === 'once') {
    lines.push('Es un recordatorio puntual: entrega el aviso con el contexto necesario para actuar (qué, cuándo, con quién).');
  } else if (kind === 'heartbeat') {
    lines.push(`Es un latido periódico: si no hay nada nuevo o relevante que informar, responde exactamente ${NO_REPLY} y nada más.`);
  } else {
    lines.push(`Si en esta ejecución no hay nada nuevo que informar (por ejemplo, nada cambió desde la última vez), responde exactamente ${NO_REPLY} y nada más.`);
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Next persisted state of an automation row after a run.
 * @returns {{ action:'delete'|'update', data?:object, disabled?:boolean, failures?:number }}
 */
function nextStateAfterRun(task, outcome, { now = new Date() } = {}) {
  const decoded = origin.decodeOrigin(task.createdFrom);
  if (!decoded.isAutomation) return null;
  const ok = Boolean(outcome && outcome.ok);
  const quiet = Boolean(outcome && outcome.status === 'quiet');
  if (ok) {
    if (decoded.kind === 'once') return { action: 'delete' };
    const next = schedule.nextRunFor({ kind: 'cron', cronExpr: task.cronExpr, tz: task.tz }, { now: new Date(now.getTime() + 1000) });
    return {
      action: 'update',
      data: {
        lastRunAt: now,
        lastStatus: quiet ? 'quiet' : 'completed',
        nextRunAt: next || new Date(now.getTime() + 60_000),
        lockedBy: null,
        lockedUntil: null,
      },
    };
  }
  const failures = parseFailureStreak(task.lastStatus) + 1;
  if (failures >= maxFailuresFor(decoded.kind)) {
    return {
      action: 'update',
      disabled: true,
      failures,
      data: {
        lastRunAt: now,
        lastStatus: 'disabled:failures',
        enabled: false,
        lockedBy: null,
        lockedUntil: null,
      },
    };
  }
  return {
    action: 'update',
    failures,
    data: {
      lastRunAt: now,
      lastStatus: `failed:${failures}`,
      nextRunAt: new Date(now.getTime() + backoffDelayMs(failures)),
      lockedBy: null,
      lockedUntil: null,
    },
  };
}

function notificationTitleFor(kind) {
  if (kind === 'once') return 'Recordatorio de SiraGPT';
  if (kind === 'heartbeat') return 'SiraGPT tiene algo para ti';
  return 'Automatización ejecutada';
}

module.exports = {
  AutomationError,
  MAX_PER_USER,
  NO_REPLY,
  MAX_FAILURES,
  ONCE_MAX_FAILURES,
  BACKOFF_MS,
  DEFAULT_HEARTBEAT_PROMPT,
  isNoReply,
  parseFailureStreak,
  backoffDelayMs,
  resolveSchedule,
  kindForSchedule,
  toPublic,
  createAutomation,
  listAutomations,
  getAutomation,
  removeAutomation,
  setAutomationEnabled,
  runAutomationNow,
  heartbeatCron,
  buildHeartbeatPrompt,
  getHeartbeat,
  ensureHeartbeat,
  disableHeartbeat,
  buildAutomationSystemPrompt,
  nextStateAfterRun,
  notificationTitleFor,
  ...origin,
  schedule,
};
