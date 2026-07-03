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
  debugger: {
    description: 'Diagnostica y corrige errores REALES: lee la salida de tsc y los logs del dev server, encuentra la causa raíz con grep y aplica el fix mínimo.',
    tools: ['list_files', 'read_file', 'grep_search', 'run_command', 'type_check', 'dev_server_check', 'edit_file', 'write_file'],
    maxSteps: 10,
    systemPrompt: [
      'Eres el DEBUGGER: un ingeniero senior de diagnóstico.',
      'Método: (1) reproduce el error con type_check/dev_server_check, (2) localiza la causa raíz con grep_search y read_file — nunca adivines, (3) aplica el fix MÍNIMO que corrige la causa (no refactorices), (4) re-verifica con type_check.',
      'Prohibido silenciar errores con any/@ts-ignore o borrar la feature rota; si el fix real no es posible, reporta exactamente por qué.',
      SHARED_RULES,
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// Custom project agents — the "SDK" surface. A workspace can ship its own
// specialists in `.sira/agents.json`:
//   [{ "name": "invoice_expert", "description": "…", "prompt": "…",
//      "tools": ["read_file","write_file"], "maxSteps": 8 }]
// Strictly validated (bounded prompt, tool allowlist, step cap, count cap) so a
// generated workspace can never escalate what the loop itself can do.
// ---------------------------------------------------------------------------

const CUSTOM_AGENTS_PATH = '.sira/agents.json';
const CUSTOM_NAME_RE = /^[a-z][a-z0-9_-]{1,29}$/;
const CUSTOM_MAX_AGENTS = 10;
const CUSTOM_MAX_PROMPT_CHARS = 4000;
const CUSTOM_MAX_STEPS_CAP = 12;

function allowedCustomTools() {
  // eslint-disable-next-line global-require
  const buildTools = require('../build-tools');
  return Object.keys(buildTools.TOOLS).filter((t) => t !== 'run_subagent');
}

/** Validate one raw custom-agent entry → normalized def, or null + reason. */
function validateCustomAgent(raw) {
  if (!raw || typeof raw !== 'object') return { def: null, reason: 'entrada no es un objeto' };
  const name = String(raw.name || '').trim();
  if (!CUSTOM_NAME_RE.test(name)) return { def: null, reason: `nombre inválido: "${name}"` };
  if (SUBAGENTS[name]) return { def: null, reason: `"${name}" colisiona con un subagente integrado` };
  const prompt = String(raw.prompt || raw.systemPrompt || '').trim();
  if (!prompt) return { def: null, reason: `"${name}" no tiene prompt` };
  const allowed = allowedCustomTools();
  const tools = Array.isArray(raw.tools) && raw.tools.length
    ? raw.tools.filter((t) => allowed.includes(t))
    : ['list_files', 'read_file'];
  if (tools.length === 0) return { def: null, reason: `"${name}" no tiene herramientas válidas` };
  const maxSteps = Math.min(Math.max(Number.parseInt(raw.maxSteps, 10) || 8, 1), CUSTOM_MAX_STEPS_CAP);
  return {
    def: {
      description: String(raw.description || '').slice(0, 300) || `Agente custom del proyecto: ${name}`,
      tools,
      maxSteps,
      custom: true,
      systemPrompt: [
        `Eres ${name.toUpperCase()}: un especialista definido por este proyecto.`,
        prompt.slice(0, CUSTOM_MAX_PROMPT_CHARS),
        SHARED_RULES,
      ].join('\n'),
    },
    reason: null,
  };
}

/**
 * Load and validate the workspace's custom agents. Best-effort: a missing or
 * malformed file returns `{}` (never throws).
 */
async function loadWorkspaceAgents({ runner, project } = {}) {
  if (!runner || typeof runner.readFile !== 'function' || !project) return {};
  let text = '';
  try {
    const out = await runner.readFile(project, CUSTOM_AGENTS_PATH);
    text = String(out?.content || '');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.agents) ? parsed.agents : []);
  const out = {};
  for (const raw of list.slice(0, CUSTOM_MAX_AGENTS)) {
    const { def } = validateCustomAgent(raw);
    if (def) out[String(raw.name).trim()] = def;
  }
  return out;
}

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

/** Fresh workspace listing injected into the specialist's first message so it
 * never wastes a step orienting itself. Best-effort. */
async function freshFileTree(runner, project) {
  if (!runner || typeof runner.exec !== 'function' || !project) return '';
  try {
    const out = await runner.exec(project, ['git', 'ls-files', '--cached', '--others', '--exclude-standard']);
    if (out?.exitCode === 0 && out.stdout) return String(out.stdout).slice(0, 3000);
  } catch { /* orientation is optional */ }
  return '';
}

/**
 * Run one subagent to completion. Returns `{ ok, agent, result, steps,
 * toolCallsCount, actions, durationMs, tokensIn, tokensOut }` and never throws
 * for tool-level failures (they are fed back to the specialist, Claude Code
 * style). `deps.emitAction` (optional) surfaces each specialist tool call on
 * the run timeline as it happens; `deps.customAgents` extends the registry
 * with workspace-defined specialists.
 */
async function runSubagent({ name, task, context = '', deps = {} }) {
  const fail = (result) => ({ ok: false, agent: name, result, steps: 0, toolCallsCount: 0, actions: [], durationMs: 0, tokensIn: 0, tokensOut: 0 });
  const custom = deps.customAgents && typeof deps.customAgents === 'object' ? deps.customAgents : {};
  const def = getSubagent(name) || custom[name] || null;
  if (!def) {
    const names = [...Object.keys(SUBAGENTS), ...Object.keys(custom)];
    return fail(`Subagente desconocido: ${name}. Disponibles: ${names.join(', ')}.`);
  }
  if (!task || !String(task).trim()) return fail('El subagente necesita una tarea (task) concreta.');

  const env = deps.env || process.env;
  const llmTurn = deps.llmTurn || ((a) => require('../llm-turn').defaultLlmTurn(a));
  const now = deps.now || Date.now;
  // The run tier (composer Power selector) rides in from the main loop so the
  // specialist resolves the SAME engine (Claude for paid tiers) instead of
  // silently dropping to the free Cerebras path — the cause of subagents
  // running on the weak model and emitting 0 valid tool calls.
  const tier = deps.tier || null;
  const { runner, project, webSearch, signal } = deps;

  // Lazy require: build-tools' run_subagent requires this module at call time,
  // so a top-level import here would be circular.
  // eslint-disable-next-line global-require
  const buildTools = require('../build-tools');
  const registry = buildTools.toolRegistry(def.tools);

  const maxSteps = Math.min(readPosInt(env.CODEX_SUBAGENT_MAX_STEPS, DEFAULT_SUBAGENT_MAX_STEPS), def.maxSteps + 4);
  const maxToolsPerTurn = readPosInt(env.CODEX_MAX_TOOLS_PER_TURN, DEFAULT_MAX_TOOLS_PER_TURN);

  const tree = await freshFileTree(runner, project);
  const userParts = [String(task)];
  if (context) userParts.push(`Contexto del proyecto:\n${context}`);
  if (tree) userParts.push(`Archivos actuales del workspace:\n${tree}`);
  const messages = [
    { role: 'system', content: def.systemPrompt },
    { role: 'user', content: userParts.join('\n\n') },
  ];

  const t0 = now();
  const actions = [];
  let lastText = '';
  let toolCallsCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const done = (ok, result, steps) => ({
    ok, agent: name, result, steps, toolCallsCount, actions,
    durationMs: Math.max(0, now() - t0), tokensIn, tokensOut,
  });

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) break;
    let turn;
    try {
      turn = await llmTurn({ messages, tools: registry, signal, env, tier });
    } catch (err) {
      return done(false, `El subagente falló: ${String(err?.message || err)}`, step);
    }
    if (turn?.usage) {
      tokensIn += Number(turn.usage.tokensIn) || 0;
      tokensOut += Number(turn.usage.tokensOut) || 0;
      if (typeof deps.onUsage === 'function') deps.onUsage(turn.usage);
    }

    if (turn?.text && turn.text.trim()) {
      lastText = turn.text.trim();
      messages.push({ role: 'assistant', content: lastText });
    }

    const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls.slice(0, maxToolsPerTurn) : [];
    if (calls.length === 0) {
      return done(true, lastText || '(el subagente terminó sin resumen)', step + 1);
    }

    for (const call of calls) {
      // No recursive delegation: a subagent can never call run_subagent.
      const tool = call.name === 'run_subagent' ? null : buildTools.getTool(call.name);
      if (!tool || !def.tools.includes(call.name)) {
        messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] Error: herramienta no disponible para este subagente.` });
        continue;
      }
      toolCallsCount += 1;

      // Live visibility: surface this specialist tool call on the run timeline.
      let live = null;
      if (typeof deps.emitAction === 'function') {
        const cmd = tool.commandFor(call.args);
        live = await Promise.resolve(deps.emitAction({
          kind: tool.kind,
          command: cmd ? `↳ ${name} · ${cmd}` : `↳ ${name} · ${call.name}`,
          path: tool.pathFor(call.args) || undefined,
        })).catch(() => null);
      }

      const result = await tool.execute(call.args, { runner, project, webSearch, env, llmTurn });
      const summary = String(result.summary || '').slice(0, 300);
      actions.push({ tool: call.name, ok: !result.isError, summary });
      if (live && typeof live.end === 'function') {
        await Promise.resolve(live.end({ status: result.isError ? 'error' : 'done', outputSummary: summary })).catch(() => {});
      }
      messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] ${result.observation || result.summary || ''}` });
    }
  }

  return done(true, lastText || 'El subagente agotó su presupuesto de pasos; revisa las acciones ejecutadas.', maxSteps);
}

/** Compact, model-facing rendering of a finished delegation. */
function formatSubagentReport(outcome) {
  const secs = Number.isFinite(outcome.durationMs) ? ` · ${Math.round(outcome.durationMs / 1000)}s` : '';
  const toks = (outcome.tokensIn || outcome.tokensOut) ? ` · ${outcome.tokensIn + outcome.tokensOut} tokens` : '';
  const lines = [
    `[SUBAGENTE ${outcome.agent}] ${outcome.ok ? 'completado' : 'falló'} (${outcome.steps} pasos, ${outcome.toolCallsCount} herramientas${secs}${toks})`,
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
  loadWorkspaceAgents,
  validateCustomAgent,
  allowedCustomTools,
  CUSTOM_AGENTS_PATH,
  DEFAULT_SUBAGENT_MAX_STEPS,
};
