'use strict';

/**
 * codex/agent-sdk — declarative subagent registry + runner for the APPS agent.
 *
 * A subagent is a focused specialist (planner, frontend builder, backend
 * engineer, DB architect, QA reviewer, enterprise analyst) with its own system
 * prompt, a restricted tool set and a hard step budget. The main build loop
 * delegates via the `run_subagent` tool; the whole delegation runs inside one
 * action, and only the specialist's final summary flows back to the caller —
 * exactly the fresh-context/subagent pattern Claude Code uses.
 *
 * Everything is injectable (llmTurn, runner, webSearch) so the SDK is fully
 * testable offline with a scripted llmTurn.
 */

const DEFAULT_SUBAGENT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOLS_PER_TURN = 4;

const SHARED_RULES = [
  'Trabajas dentro de un workspace aislado con un starter React 18 + Vite 7 + TypeScript.',
  'Responde SIEMPRE en español. Cuando termines tu tarea, deja de llamar herramientas y entrega un resumen claro y accionable de lo que hiciste o encontraste.',
  'No inventes resultados de herramientas: usa las herramientas y lee sus salidas.',
].join('\n');

const SUBAGENTS = {
  planner: {
    description: 'Convierte una petición ambigua en un plan de construcción concreto: archivos a crear, componentes, orden de trabajo y criterios de aceptación.',
    tools: ['list_files', 'read_file', 'web_search'],
    maxSteps: 6,
    systemPrompt: [
      'Eres el PLANNER: un arquitecto de software senior.',
      'Tu única salida es un plan de construcción concreto y ordenado: módulos, archivos exactos a crear/editar, componentes con sus props, y criterios de aceptación verificables.',
      'Inspecciona el workspace antes de planear. NO escribes código: planeas.',
      SHARED_RULES,
    ].join('\n'),
  },
  frontend_builder: {
    description: 'Construye interfaces React + TypeScript de calidad producción: componentes, estados, estilos y navegación.',
    tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'type_check'],
    maxSteps: 10,
    systemPrompt: [
      'Eres el FRONTEND BUILDER: un ingeniero de UI senior especializado en React 18 + TypeScript + Vite.',
      'Escribes componentes .tsx completos, con diseño cuidado (jerarquía visual, espaciado, estados hover/focus, responsive) usando estilos inline o CSS en src/.',
      'Después de escribir código, verifica con type_check y corrige los errores que aparezcan.',
      SHARED_RULES,
    ].join('\n'),
  },
  backend_engineer: {
    description: 'Diseña y escribe lógica de servidor, APIs y modelos de datos del proyecto.',
    tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'run_command', 'inspect_database', 'type_check'],
    maxSteps: 10,
    systemPrompt: [
      'Eres el BACKEND ENGINEER: un ingeniero de servidor senior.',
      'Diseñas APIs limpias, validación de entrada, manejo de errores y persistencia. Si el proyecto es Vite puro, implementa la capa de datos como módulos TypeScript en src/lib/ (stores en memoria/localStorage) listos para migrar a una API real.',
      'Después de escribir código, verifica con type_check y corrige los errores.',
      SHARED_RULES,
    ].join('\n'),
  },
  db_architect: {
    description: 'Modela la base de datos: entidades, relaciones, tipos y esquema Prisma o modelos TypeScript.',
    tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'inspect_database'],
    maxSteps: 8,
    systemPrompt: [
      'Eres el DB ARCHITECT: un arquitecto de datos senior.',
      'Modelas entidades con sus campos, tipos, relaciones e índices. Usa inspect_database para ver el esquema actual antes de proponer cambios. Si no hay Prisma, define los modelos como tipos TypeScript en src/lib/types.ts con datos semilla realistas.',
      SHARED_RULES,
    ].join('\n'),
  },
  qa_reviewer: {
    description: 'Revisa el proyecto: errores de compilación, dev server, bugs evidentes y calidad; reporta hallazgos concretos.',
    tools: ['list_files', 'read_file', 'run_command', 'type_check', 'dev_server_check'],
    maxSteps: 8,
    systemPrompt: [
      'Eres el QA REVIEWER: un revisor de código adversarial.',
      'Verifica que el proyecto compila (type_check), que el dev server arranca sin errores (dev_server_check) y lee los archivos clave buscando bugs reales: imports rotos, props mal tipadas, estados que no se actualizan, textos placeholder olvidados.',
      'Reporta cada hallazgo con archivo y detalle. NO corrijas: reporta.',
      SHARED_RULES,
    ].join('\n'),
  },
  enterprise_analyst: {
    description: 'Convierte una necesidad de negocio (CRM, ERP, inventario, facturación, RRHH, punto de venta…) en una especificación de software empresarial: módulos, entidades, roles y flujos.',
    tools: ['list_files', 'read_file', 'web_search'],
    maxSteps: 6,
    systemPrompt: [
      'Eres el ENTERPRISE ANALYST: un consultor senior de software empresarial.',
      'Dado un pedido de negocio, produce una especificación ejecutable: (1) módulos del sistema con su propósito, (2) entidades con campos y relaciones, (3) roles de usuario y permisos, (4) flujos de trabajo clave paso a paso, (5) métricas/KPIs del dashboard.',
      'Piensa como se piensa en un ERP/CRM real: estados de documentos, auditoría, multi-usuario. Datos de ejemplo realistas del dominio (nombres, precios, fechas), nunca "lorem ipsum".',
      SHARED_RULES,
    ].join('\n'),
  },
};

function listSubagents() {
  return Object.entries(SUBAGENTS).map(([name, def]) => ({
    name,
    description: def.description,
    tools: def.tools.slice(),
    maxSteps: def.maxSteps,
  }));
}

function getSubagent(name) {
  return SUBAGENTS[name] || null;
}

function readPosInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Run one subagent to completion. Returns
 * `{ ok, agent, result, steps, toolCallsCount, actions }` and never throws for
 * tool-level failures (they are fed back to the specialist, Claude Code style).
 */
async function runSubagent({ name, task, context = '', deps = {} }) {
  const def = getSubagent(name);
  if (!def) return { ok: false, agent: name, result: `Subagente desconocido: ${name}. Disponibles: ${Object.keys(SUBAGENTS).join(', ')}.`, steps: 0, toolCallsCount: 0, actions: [] };
  if (!task || !String(task).trim()) return { ok: false, agent: name, result: 'El subagente necesita una tarea (task) concreta.', steps: 0, toolCallsCount: 0, actions: [] };

  const env = deps.env || process.env;
  const llmTurn = deps.llmTurn || ((a) => require('../llm-turn').defaultLlmTurn(a));
  const { runner, project, webSearch, signal } = deps;

  // Lazy require: build-tools' run_subagent requires this module at call time,
  // so a top-level import here would be circular.
  // eslint-disable-next-line global-require
  const buildTools = require('../build-tools');
  const registry = buildTools.toolRegistry(def.tools);

  const maxSteps = Math.min(readPosInt(env.CODEX_SUBAGENT_MAX_STEPS, DEFAULT_SUBAGENT_MAX_STEPS), def.maxSteps + 4);
  const maxToolsPerTurn = readPosInt(env.CODEX_MAX_TOOLS_PER_TURN, DEFAULT_MAX_TOOLS_PER_TURN);

  const messages = [
    { role: 'system', content: def.systemPrompt },
    { role: 'user', content: context ? `${task}\n\nContexto del proyecto:\n${context}` : String(task) },
  ];

  const actions = [];
  let lastText = '';
  let toolCallsCount = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) break;
    let turn;
    try {
      turn = await llmTurn({ messages, tools: registry, signal, env });
    } catch (err) {
      return { ok: false, agent: name, result: `El subagente falló: ${String(err?.message || err)}`, steps: step, toolCallsCount, actions };
    }
    if (turn?.usage && typeof deps.onUsage === 'function') deps.onUsage(turn.usage);

    if (turn?.text && turn.text.trim()) {
      lastText = turn.text.trim();
      messages.push({ role: 'assistant', content: lastText });
    }

    const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls.slice(0, maxToolsPerTurn) : [];
    if (calls.length === 0) {
      return { ok: true, agent: name, result: lastText || '(el subagente terminó sin resumen)', steps: step + 1, toolCallsCount, actions };
    }

    for (const call of calls) {
      // No recursive delegation: a subagent can never call run_subagent.
      const tool = call.name === 'run_subagent' ? null : buildTools.getTool(call.name);
      if (!tool || !def.tools.includes(call.name)) {
        messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] Error: herramienta no disponible para este subagente.` });
        continue;
      }
      toolCallsCount += 1;
      const result = await tool.execute(call.args, { runner, project, webSearch, env, llmTurn });
      actions.push({ tool: call.name, ok: !result.isError, summary: String(result.summary || '').slice(0, 300) });
      messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] ${result.observation || result.summary || ''}` });
    }
  }

  return {
    ok: true,
    agent: name,
    result: lastText || 'El subagente agotó su presupuesto de pasos; revisa las acciones ejecutadas.',
    steps: maxSteps,
    toolCallsCount,
    actions,
  };
}

/** Compact, model-facing rendering of a finished delegation. */
function formatSubagentReport(outcome) {
  const lines = [
    `[SUBAGENTE ${outcome.agent}] ${outcome.ok ? 'completado' : 'falló'} (${outcome.steps} pasos, ${outcome.toolCallsCount} herramientas)`,
  ];
  for (const a of outcome.actions.slice(0, 12)) lines.push(`  - ${a.ok ? '✓' : '✗'} ${a.tool}: ${a.summary.split('\n')[0]}`);
  lines.push('Resultado:');
  lines.push(String(outcome.result).slice(0, 4000));
  return lines.join('\n');
}

module.exports = {
  SUBAGENTS,
  listSubagents,
  getSubagent,
  runSubagent,
  formatSubagentReport,
  DEFAULT_SUBAGENT_MAX_STEPS,
};
