'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildAutomationsTool } = require('../src/services/agent-harness/tools/automations-tool');
const { mentionsAutomation } = require('../src/services/automations/cues');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function fakeAutomations(calls) {
  const sample = {
    id: 'task-1', kind: 'once', chatId: 'chat-1', prompt: 'Recordarle a Jorge llamar a Juan', enabled: true,
    schedule: { kind: 'at', cronExpr: '50 14 9 10 *', tz: 'America/Lima', at: '2026-10-09T19:50:00.000Z', description: 'una vez, hoy a las 14:50 (America/Lima)' },
    nextRunAt: '2026-10-09T19:50:00.000Z', nextRunLocal: 'viernes 9 de octubre de 2026, 14:50 (America/Lima)', lastStatus: null, failures: 0, disabledByFailures: false,
  };
  return {
    sample,
    createAutomation: async (prisma, input) => { calls.push(['create', input]); return { ...sample, adjusted: input.schedule === 'cada 7 minutos' ? 'cada 6 min' : null }; },
    listAutomations: async (prisma, input) => { calls.push(['list', input]); return input.userId === 'empty' ? [] : [sample, { ...sample, id: 'task-2', kind: 'recurring', enabled: false, disabledByFailures: true, nextRunLocal: null, schedule: { ...sample.schedule, kind: 'cron', description: 'cada lunes a las 09:00 (America/Lima)' } }]; },
    removeAutomation: async (prisma, input) => { calls.push(['remove', input]); if (input.automationId === 'nope') { const e = new Error('No encontré esa automatización.'); e.code = 'automation_not_found'; e.status = 404; throw e; } return true; },
    setAutomationEnabled: async (prisma, input) => { calls.push(['enabled', input]); return { ...sample, enabled: input.enabled }; },
    runAutomationNow: async (prisma, input) => { calls.push(['run_now', input]); return { ...sample, queued: true }; },
    ensureHeartbeat: async (prisma, input) => { calls.push(['heartbeat_on', input]); return { ...sample, kind: 'heartbeat', everyMinutes: 30, activeHours: input.activeHours, schedule: { ...sample.schedule, tz: input.tz, description: 'cada 30 minutos entre las 08:00 y las 21:59' } }; },
    disableHeartbeat: async (prisma, input) => { calls.push(['heartbeat_off', input]); return true; },
  };
}

test('tool definition: strict schema, auto tier, Spanish human descriptions', () => {
  const def = buildAutomationsTool();
  assert.equal(def.name, 'automations');
  assert.equal(def.permissionTier, 'auto');
  assert.match(def.description, /WHEN TO USE/);
  assert.ok(def.inputSchema.safeParse({ action: 'create', prompt: 'x', schedule: 'en 5 min' }).success);
  assert.ok(!def.inputSchema.safeParse({ action: 'create', bogus: 1 }).success, 'strict');
  assert.ok(!def.inputSchema.safeParse({ action: 'explode' }).success);
  assert.match(def.humanDescription({ action: 'create', schedule: 'mañana a las 9' }), /Programando una automatización: mañana a las 9/);
  assert.match(def.humanDescription({ action: 'heartbeat_on' }), /latido/);
});

test('create passes the chat, user and client time zone through and relays the exact local time', async () => {
  const calls = [];
  const def = buildAutomationsTool();
  const ctx = { prisma: {}, userId: 'u1', chatId: 'chat-1', timeZone: 'America/Lima', automations: fakeAutomations(calls) };
  const out = await def.execute({ action: 'create', prompt: 'Recordarle a Jorge llamar a Juan', schedule: 'en 20 minutos' }, ctx);
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0][1], { userId: 'u1', chatId: 'chat-1', prompt: 'Recordarle a Jorge llamar a Juan', schedule: 'en 20 minutos', tz: 'America/Lima' });
  assert.match(out.summary, /recordatorio programado el viernes 9 de octubre de 2026, 14:50 \(America\/Lima\)/);
  assert.match(out.summary, /Te escribiré en este chat/);
  const adjusted = await def.execute({ action: 'create', prompt: 'Revisa el deploy', schedule: 'cada 7 minutos' }, ctx);
  assert.match(adjusted.summary, /Nota: cada 6 min/);
});

test('create without a persisted chat, or without when/what, asks instead of guessing', async () => {
  const calls = [];
  const def = buildAutomationsTool();
  const noChat = await def.execute({ action: 'create', prompt: 'x', schedule: 'en 5 min' }, { prisma: {}, userId: 'u1', chatId: null, automations: fakeAutomations(calls) });
  assert.equal(noChat.ok, false);
  assert.equal(noChat.code, 'automation_chat_required');
  const noWhen = await def.execute({ action: 'create', prompt: 'x' }, { prisma: {}, userId: 'u1', chatId: 'c', automations: fakeAutomations(calls) });
  assert.equal(noWhen.code, 'automation_args_required');
  assert.match(noWhen.error, /pregúntale la hora/);
  assert.equal(calls.length, 0, 'nothing created');
  const noCtx = await def.execute({ action: 'list' }, {});
  assert.equal(noCtx.code, 'automations_unavailable');
});

test('list / pause / resume / remove / run_now relay structured results and service errors verbatim', async () => {
  const calls = [];
  const def = buildAutomationsTool();
  const ctx = { prisma: {}, userId: 'u1', chatId: 'chat-1', timeZone: 'America/Lima', automations: fakeAutomations(calls) };
  const list = await def.execute({ action: 'list' }, ctx);
  assert.equal(list.count, 2);
  assert.match(list.summary, /\[task-1\] recordatorio — «Recordarle a Jorge llamar a Juan» — una vez, hoy a las 14:50 \(America\/Lima\) — próxima: viernes 9/);
  assert.match(list.summary, /\[task-2\] automatización recurrente .* pausada por fallos/);
  const empty = await def.execute({ action: 'list' }, { ...ctx, userId: 'empty' });
  assert.equal(empty.count, 0);
  assert.match(empty.summary, /No tienes automatizaciones/);
  const paused = await def.execute({ action: 'pause', id: 'task-1' }, ctx);
  assert.deepEqual(calls.at(-1), ['enabled', { userId: 'u1', automationId: 'task-1', enabled: false }]);
  assert.match(paused.summary, /pausada/);
  const resumed = await def.execute({ action: 'resume', id: 'task-1' }, ctx);
  assert.match(resumed.summary, /Reanudada: una vez, hoy a las 14:50/);
  const ran = await def.execute({ action: 'run_now', id: 'task-1' }, ctx);
  assert.match(ran.summary, /próximo minuto/);
  const removed = await def.execute({ action: 'remove', id: 'task-1' }, ctx);
  assert.equal(removed.removed, true);
  const missing = await def.execute({ action: 'remove', id: 'nope' }, ctx);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'automation_not_found');
  assert.equal(missing.error, 'No encontré esa automatización.');
  const noId = await def.execute({ action: 'pause' }, ctx);
  assert.equal(noId.code, 'automation_id_required');
});

test('heartbeat on/off: defaults 30 min 08-22 in the client zone; off reports whether one existed', async () => {
  const calls = [];
  const def = buildAutomationsTool();
  const ctx = { prisma: {}, userId: 'u1', chatId: 'chat-1', timeZone: 'Europe/Madrid', automations: fakeAutomations(calls) };
  const on = await def.execute({ action: 'heartbeat_on' }, ctx);
  assert.equal(on.ok, true);
  assert.deepEqual(calls[0][1], { userId: 'u1', chatId: 'chat-1', tz: 'Europe/Madrid', everyMinutes: 30, activeHours: { start: 8, end: 22 }, prompt: null });
  assert.match(on.summary, /cada 30 minutos entre las 8:00 y las 22:00 \(Europe\/Madrid\)/);
  assert.match(on.summary, /solo te escribiré aquí cuando haya algo que decir/);
  const custom = await def.execute({ action: 'heartbeat_on', everyMinutes: 60, activeHours: { start: 9, end: 18 }, prompt: 'Revisa el buzón' }, ctx);
  assert.equal(calls[1][1].prompt, 'Revisa el buzón');
  assert.equal(custom.ok, true);
  const off = await def.execute({ action: 'heartbeat_off' }, ctx);
  assert.match(off.summary, /Latido desactivado/);
});

test('the harness registers automations, the loop labels it, the prompt teaches it and the selector keeps it on scheduling turns', () => {
  const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');
  assert.ok(buildHarnessTools(new Set()).some((d) => d.name === 'automations'));
  assert.ok(!buildHarnessTools(new Set(['automations'])).some((d) => d.name === 'automations'));
  const loop = read('src/services/agentic-chat-stream.js');
  assert.match(loop, /automations: \['programar una automatización'/);
  assert.match(loop, /usa `automations` \(action create\/list\/pause\/resume\/remove/);
  assert.match(loop, /Nunca afirmes que algo quedó programado sin haber llamado a la herramienta/);
  const { selectTools } = require('../src/services/agents/tool-selector');
  const tools = ['web_search', 'read_url', 'read_file', 'search_docs', 'automations', ...Array.from({ length: 30 }, (_, i) => `misc_tool_${i}`)].map((name) => ({ name, description: name }));
  for (const q of ['recuérdame en 20 minutos llamar a Juan', 'cada lunes a las 9 mándame el resumen', 'todos los días a las 8 revisa el correo', 'borra mis automatizaciones', 'remind me tomorrow at 9am']) {
    const picked = selectTools({ tools, userQuery: q, intent: 'code_generation', maxTools: 8, signals: {} }, { skillAdapter: null });
    assert.ok(picked.selectedNames.includes('automations'), q);
  }
  const bySignal = selectTools({ tools, userQuery: 'hazlo', intent: 'code_generation', maxTools: 8, signals: { automations: true } }, { skillAdapter: null });
  assert.ok(bySignal.selectedNames.includes('automations'));
  const route = read('src/routes/ai.js');
  assert.match(route, /body\('timeZone'\)\.optional\(\{ nullable: true \}\)\.isString\(\)\.isLength\(\{ max: 64 \}\)/);
  // Inline (no require) on purpose: the generate handler is also evaluated in a
  // sandbox by tests/generate-chat-coding-workspace.test.js.
  assert.match(route, /timeZone: \(\(\) => \{\s*const raw = typeof req\.body\?\.timeZone === 'string' \? req\.body\.timeZone\.trim\(\) : '';\s*if \(!raw \|\| raw\.length > 64\) return 'UTC';\s*try \{ Intl\.DateTimeFormat\(undefined, \{ timeZone: raw \}\); return raw; \} catch \(_\) \{ return 'UTC'; \}\s*\}\)\(\),/);
  assert.doesNotMatch(route.slice(route.indexOf('toolContext: {'), route.indexOf('toolContext: {') + 6000), /require\('\.\.\/services\/automations/, 'no module requires inside the sandboxed handler region');
});

test('scheduling cues: ES/EN positives, and plain coding/chat negatives', () => {
  for (const q of [
    'recuérdame mañana a las 9 enviar el informe', 'avísame cuando sea viernes a las 10', 'cada 15 minutos revisa si el deploy terminó',
    'todos los días a las 8:30 dame el clima', 'programa un recordatorio para el lunes', 'activa el heartbeat', 'lista mis tareas programadas',
    'every monday at 9 send me the summary', 'remind me in 20 minutes', 'cada fin de semana a las 10 un resumen', 'monitorea el sitio cada hora',
  ]) assert.equal(mentionsAutomation(q), true, q);
  for (const q of [
    'programa en Python una función que ordene una lista', 'haz una presentación de 10 láminas', 'qué hora es en Lima', 'resume este documento',
    'explícame cómo funciona cron en Linux a nivel de kernel'.replace('cron', 'systemd'), 'arregla el bug del login', '',
  ]) assert.equal(mentionsAutomation(q), false, q);
});
