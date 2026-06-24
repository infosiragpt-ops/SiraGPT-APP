'use strict';

/**
 * codex/plan-mode — "plan first, always" (spec §7.1, feature 06). A plan run
 * NEVER mutates: it asks the LLM for a structured, approvable plan
 * `{ architecture, pages[], components[], tasks[] }`, parses it tolerantly
 * (fences/prose like builder/llm.js extractJson), validates the shape, retries
 * once on parse failure, emits `plan_proposed`, and returns
 * `{ status: 'waiting_approval' }`. On a second parse failure → `{ status: 'error' }`.
 *
 * The llmTurn function is injected (default wired in agent-loop) so plan-mode is
 * fully testable with a scripted model.
 */

const { extractJson } = require('../builder/llm');

function buildPlanMessages({ project, prompt, fileTree, priorPlan, feedback } = {}) {
  const system = [
    'Eres un agente de software senior que planifica proyectos web en español.',
    'Tu tarea es producir un PLAN APROBABLE, no escribir código todavía.',
    'Responde ÚNICAMENTE con un objeto JSON válido (sin prosa, sin fences) con esta forma exacta:',
    '{',
    '  "architecture": "string — descripción breve de la arquitectura y stack",',
    '  "pages": ["string — rutas/páginas principales"],',
    '  "components": ["string — componentes reutilizables clave"],',
    '  "tasks": [{ "id": "string", "title": "string", "status": "pending" }]',
    '}',
    'Sé concreto y conciso. 3–8 tareas accionables ordenadas.',
  ].join('\n');

  const parts = [`Proyecto: ${project?.name || 'Sin nombre'}`];
  if (fileTree) parts.push(`Árbol de archivos actual:\n${fileTree}`);
  parts.push(`Lo que el usuario quiere construir:\n${prompt || '(sin descripción)'}`);
  if (priorPlan) parts.push(`Plan anterior (a ajustar):\n${JSON.stringify(priorPlan)}`);
  if (feedback) parts.push(`Ajuste solicitado por el usuario:\n${feedback}`);

  return { system, user: parts.join('\n\n') };
}

function asStringArray(v) {
  if (!Array.isArray(v)) return null;
  return v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.name || x.title || x.label || JSON.stringify(x) : String(x)))
    .filter((s) => typeof s === 'string' && s.length > 0);
}

function normaliseTasks(v) {
  if (!Array.isArray(v)) return null;
  return v.map((t, i) => {
    if (typeof t === 'string') return { id: `t${i + 1}`, title: t, status: 'pending' };
    if (t && typeof t === 'object') {
      return { id: String(t.id || `t${i + 1}`), title: String(t.title || t.name || `Tarea ${i + 1}`), status: String(t.status || 'pending') };
    }
    return { id: `t${i + 1}`, title: `Tarea ${i + 1}`, status: 'pending' };
  });
}

/**
 * Parse + normalise a model response into a valid plan, or null if the shape
 * cannot be recovered.
 */
function parsePlan(text) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const architecture = typeof raw.architecture === 'string' ? raw.architecture.trim() : '';
  const pages = asStringArray(raw.pages);
  const components = asStringArray(raw.components);
  const tasks = normaliseTasks(raw.tasks);
  if (!architecture || pages == null || components == null || tasks == null) return null;
  return { architecture, pages, components, tasks };
}

/**
 * Run plan mode. Emits plan_proposed on success. NEVER calls a mutating tool.
 * Returns { status: 'waiting_approval' } or { status: 'error', error }.
 */
async function runPlanMode({ run, project, deps }) {
  const { llmTurn, eventStore, env = process.env, prisma } = deps || {};
  if (!llmTurn || !eventStore) throw new Error('plan-mode: llmTurn + eventStore deps required');

  const messages = (() => {
    const { system, user } = buildPlanMessages({
      project,
      prompt: run.prompt,
      fileTree: deps.fileTree,
      priorPlan: deps.priorPlan,
      feedback: deps.feedback,
    });
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  })();

  let plan = null;
  for (let attempt = 0; attempt < 2 && !plan; attempt += 1) {
    let turn;
    try {
      // Plan mode passes NO tools — the model can only return text.
      turn = await llmTurn({ messages, tools: [], signal: deps.signal, env });
    } catch (err) {
      return { status: 'error', error: `LLM falló durante la planificación: ${String(err?.message || err)}` };
    }
    if (turn?.usage && deps.metrics?.recordLlmUsage) deps.metrics.recordLlmUsage(turn.usage);
    plan = parsePlan(turn?.text || '');
    if (!plan && attempt === 0) {
      messages.push({ role: 'assistant', content: String(turn?.text || '') });
      messages.push({ role: 'user', content: 'Tu respuesta no fue un JSON válido con la forma pedida. Devuelve SOLO el objeto JSON.' });
    }
  }

  if (!plan) return { status: 'error', error: 'No se pudo obtener un plan estructurado válido del modelo.' };

  await eventStore.appendEvent(run.id, 'plan_proposed', plan, { prisma });
  return { status: 'waiting_approval', plan };
}

module.exports = { buildPlanMessages, parsePlan, runPlanMode, normaliseTasks, asStringArray };
