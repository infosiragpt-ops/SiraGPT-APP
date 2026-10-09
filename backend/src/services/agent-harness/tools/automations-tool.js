'use strict';

/**
 * automations — the chat agent creates and manages reminders, recurring
 * jobs, «/loop»-style intervals and the per-user heartbeat for the user,
 * delivered back into THIS chat when they fire (native rewrite of the
 * OpenClaw cron / heartbeat tools; see services/automations).
 *
 * The user's local time zone comes from the client (`ctx.timeZone`, sent by
 * the composer with every turn) so «mañana a las 9» means 09:00 where the
 * user is. Answers carry a Spanish `summary` the model relays verbatim —
 * the exact local time and the next run — instead of paraphrasing.
 *
 * `ctx.automations` is injectable for offline tests.
 */

const { z } = require('zod');

const ACTIONS = ['create', 'list', 'remove', 'pause', 'resume', 'run_now', 'heartbeat_on', 'heartbeat_off'];

const inputSchema = z.object({
  action: z.enum(ACTIONS)
    .describe('create (new reminder/recurring job), list, remove, pause, resume, run_now (by id), heartbeat_on / heartbeat_off (periodic check-in for this user).'),
  prompt: z.string().min(1).max(4000).optional()
    .describe('create: what SiraGPT must do or say when the automation fires, written as an instruction to itself with ALL the context needed («Recordarle a Jorge que llame a Juan sobre el contrato de la oficina»). heartbeat_on: optional extra instructions for the check-in.'),
  schedule: z.string().min(1).max(200).optional()
    .describe('create: when, in the user\'s words («en 20 minutos», «mañana a las 9», «el viernes a las 10», «cada lunes a las 9», «todos los días a las 8:30», «cada 15 minutos», or a 5-field cron).'),
  id: z.string().min(1).max(64).optional().describe('remove / pause / resume / run_now: the automation id from list or create.'),
  everyMinutes: z.number().int().min(15).max(60).optional().describe('heartbeat_on: cadence in minutes (15, 20, 30 or 60).'),
  activeHours: z.object({ start: z.number().int().min(0).max(24), end: z.number().int().min(0).max(24) }).optional()
    .describe('heartbeat_on: local hours during which the heartbeat runs (end exclusive), e.g. {start: 8, end: 22}.'),
}).strict();

function describeArgs(args = {}) {
  switch (args && args.action) {
    case 'create': return `Programando una automatización: ${String(args.schedule || '').slice(0, 60)}`;
    case 'list': return 'Consultando tus automatizaciones';
    case 'remove': return 'Eliminando una automatización';
    case 'pause': return 'Pausando una automatización';
    case 'resume': return 'Reanudando una automatización';
    case 'run_now': return 'Ejecutando una automatización ahora';
    case 'heartbeat_on': return 'Activando el latido periódico';
    case 'heartbeat_off': return 'Desactivando el latido periódico';
    default: return 'Gestionando automatizaciones';
  }
}

function kindLabel(kind) {
  return { once: 'recordatorio', recurring: 'automatización recurrente', loop: 'bucle', heartbeat: 'latido' }[kind] || 'automatización';
}

function lineFor(a) {
  const status = !a.enabled
    ? (a.disabledByFailures ? 'pausada por fallos' : 'pausada')
    : (a.nextRunLocal ? `próxima: ${a.nextRunLocal}` : 'activa');
  return `• [${a.id}] ${kindLabel(a.kind)} — «${String(a.prompt).slice(0, 90)}» — ${a.schedule.description} — ${status}`;
}

function errorResult(error) {
  const code = error && error.code ? String(error.code) : 'automation_error';
  const message = error && error.message ? String(error.message) : 'No se pudo completar la acción.';
  return { ok: false, code, error: message, hint: 'Transmite el mensaje de error al usuario tal cual y, si falta la hora o el qué, pregúntaselo.' };
}

function buildAutomationsTool() {
  return {
    name: 'automations',
    description: [
      'Create and manage automations for the user, delivered in THIS chat when they fire: one-shot reminders («recuérdame en 20 minutos…», «avísame mañana a las 9»), recurring jobs («cada lunes a las 9 envíame el resumen…», «todos los días a las 8 revisa…»), short loops («cada 10 minutos revisa si el deploy terminó») and a periodic heartbeat check-in.',
      'WHEN TO USE: the user asks to be reminded, to receive something at a time or on a schedule, to monitor something periodically, or to see / pause / delete their scheduled items. Call it ONCE with the user\'s own words in `schedule`; the tool parses them in the user\'s time zone and returns the exact local time — relay that `summary` verbatim so the user can correct it.',
      'WHEN NOT TO USE: the user wants the work done right now (just do it), or the request is hypothetical. Never pretend an automation exists without calling this tool; never invent ids.',
      'Write `prompt` as a complete self-instruction with the context the future run needs (names, links, what to check, how to answer); the future run does not see this conversation\'s working memory beyond the chat history.',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: describeArgs,
    execute: async (args = {}, ctx = {}) => {
      const automations = ctx.automations || require('../../automations');
      const prisma = ctx.prisma;
      const userId = ctx.userId || null;
      const chatId = ctx.chatId || null;
      const tz = ctx.timeZone || 'UTC';
      if (!prisma || !userId) return { ok: false, code: 'automations_unavailable', error: 'Las automatizaciones no están disponibles en este contexto.' };
      const action = args && args.action;
      try {
        if (action === 'list') {
          const items = await automations.listAutomations(prisma, { userId });
          if (!items.length) return { ok: true, count: 0, automations: [], summary: 'No tienes automatizaciones ni recordatorios programados.' };
          return {
            ok: true,
            count: items.length,
            automations: items,
            summary: `Tienes ${items.length} automatización(es):\n${items.map(lineFor).join('\n')}`,
          };
        }
        if (action === 'create') {
          if (!chatId) return { ok: false, code: 'automation_chat_required', error: 'Este chat aún no está guardado; pide al usuario que vuelva a enviar el pedido en el siguiente mensaje.' };
          if (!args.prompt || !args.schedule) {
            return { ok: false, code: 'automation_args_required', error: 'Faltan `prompt` (qué hacer) o `schedule` (cuándo). Si el usuario no dijo cuándo, pregúntale la hora o la frecuencia antes de crear nada.' };
          }
          const created = await automations.createAutomation(prisma, { userId, chatId, prompt: args.prompt, schedule: args.schedule, tz });
          const when = created.kind === 'once' && created.nextRunLocal
            ? `el ${created.nextRunLocal}`
            : `${created.schedule.description}${created.nextRunLocal ? ` (próxima: ${created.nextRunLocal})` : ''}`;
          return {
            ok: true,
            automation: created,
            summary: `Listo: ${kindLabel(created.kind)} programado ${when}. Te escribiré en este chat cuando se ejecute.${created.adjusted ? ` Nota: ${created.adjusted}.` : ''}`,
            hint: 'Confirma al usuario la hora/frecuencia exacta del summary. Si el usuario quiere cambiarla, elimina esta automatización y crea otra.',
          };
        }
        if (action === 'remove' || action === 'pause' || action === 'resume' || action === 'run_now') {
          if (!args.id) return { ok: false, code: 'automation_id_required', error: 'Falta `id`; usa action "list" para verlos.' };
          if (action === 'remove') {
            await automations.removeAutomation(prisma, { userId, automationId: args.id });
            return { ok: true, removed: true, id: args.id, summary: 'Automatización eliminada.' };
          }
          if (action === 'run_now') {
            const queued = await automations.runAutomationNow(prisma, { userId, automationId: args.id });
            return { ok: true, automation: queued, summary: 'La automatización se ejecutará en el próximo minuto y responderá en su chat.' };
          }
          const updated = await automations.setAutomationEnabled(prisma, { userId, automationId: args.id, enabled: action === 'resume' });
          return {
            ok: true,
            automation: updated,
            summary: action === 'resume'
              ? `Reanudada: ${updated.schedule.description}${updated.nextRunLocal ? ` (próxima: ${updated.nextRunLocal})` : ''}.`
              : 'Automatización pausada; no se ejecutará hasta que la reanudes.',
          };
        }
        if (action === 'heartbeat_on') {
          if (!chatId) return { ok: false, code: 'automation_chat_required', error: 'Este chat aún no está guardado; vuelve a intentarlo en el siguiente mensaje.' };
          const hb = await automations.ensureHeartbeat(prisma, {
            userId,
            chatId,
            tz,
            everyMinutes: args.everyMinutes || 30,
            activeHours: args.activeHours || { start: 8, end: 22 },
            prompt: args.prompt || null,
          });
          const hours = hb.activeHours ? ` entre las ${hb.activeHours.start}:00 y las ${hb.activeHours.end}:00` : '';
          return {
            ok: true,
            heartbeat: hb,
            summary: `Latido activado: cada ${hb.everyMinutes} minutos${hours} (${hb.schedule.tz}) revisaré si hay algo pendiente y solo te escribiré aquí cuando haya algo que decir.${hb.nextRunLocal ? ` Próxima revisión: ${hb.nextRunLocal}.` : ''}`,
          };
        }
        if (action === 'heartbeat_off') {
          const removed = await automations.disableHeartbeat(prisma, { userId });
          return { ok: true, removed, summary: removed ? 'Latido desactivado.' : 'No había un latido activo.' };
        }
        return { ok: false, code: 'automation_action_invalid', error: `Acción desconocida: ${String(action)}` };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

module.exports = { buildAutomationsTool, ACTIONS };
