'use strict';

/**
 * F4 — Director/planner.
 *
 * ONE planning LLM call (mocked in tests) decomposes a genuinely multi-step
 * goal into a small DAG of subtasks:
 *
 *   { nodes: [{ id, role, goal, dependsOn: [], budget: { maxIterations, maxTokens } }] }
 *
 * The graph is validated hard (unique ids, known roles, existing deps, no
 * cycles, budgets present) before anything runs. An invalid or unparseable
 * plan is an honest `plan_failed` — never a silent fall-through.
 */

const { KNOWN_ROLES, HIGH_STAKES_ROLES } = require('./roles');
const { normalizeNodeBudget, NODE_BUDGET_DEFAULTS } = require('./budget');

const MAX_NODES_DEFAULT = 6;
const PLANNER_MAX_TOKENS = 1_400;

class PlanValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanValidationError';
    this.code = 'PLAN_INVALID';
  }
}

function resolveMaxNodes(env = process.env) {
  const raw = Math.floor(Number(env.SIRAGPT_ORCHESTRATOR_MAX_NODES));
  if (Number.isFinite(raw) && raw >= 1) return Math.min(12, raw);
  return MAX_NODES_DEFAULT;
}

/** Tolerates ```json fences and surrounding prose around the JSON object. */
function parsePlanJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const unfenced = raw.replace(/```(?:json)?/gi, '').trim();
  for (const candidate of [raw, unfenced]) {
    try { return JSON.parse(candidate); } catch (_) { /* try next */ }
  }
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) { /* invalid */ }
  }
  return null;
}

/**
 * Kahn topological sort. Throws PlanValidationError on a cycle.
 * `externalIds` are already-completed nodes a replanned graph may depend on.
 */
function topoOrder(nodes, { externalIds = [] } = {}) {
  const external = new Set(externalIds.map(String));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const dependents = new Map(nodes.map((n) => [n.id, []]));
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (external.has(dep)) continue;
      indegree.set(node.id, indegree.get(node.id) + 1);
      dependents.get(dep).push(node.id);
    }
  }
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(byId.get(id));
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) {
    throw new PlanValidationError('el plan contiene un ciclo de dependencias');
  }
  return order;
}

/**
 * Validate + normalize a raw plan. Throws PlanValidationError when the graph
 * is unusable. `completedIds` lets a replan reference finished nodes without
 * re-declaring them.
 */
function validatePlan(raw, { maxNodes = resolveMaxNodes(), completedIds = [] } = {}) {
  const plan = raw && typeof raw === 'object' ? raw : null;
  const rawNodes = Array.isArray(plan?.nodes) ? plan.nodes : null;
  if (!rawNodes || !rawNodes.length) {
    throw new PlanValidationError('el plan no contiene nodos');
  }
  if (rawNodes.length > maxNodes) {
    throw new PlanValidationError(`el plan excede el máximo de ${maxNodes} nodos (${rawNodes.length})`);
  }
  const completed = new Set(completedIds.map(String));
  const seen = new Set();
  const nodes = [];
  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode !== 'object') {
      throw new PlanValidationError('nodo inválido en el plan');
    }
    const id = String(rawNode.id || '').trim();
    if (!id) throw new PlanValidationError('todo nodo necesita un id');
    if (seen.has(id) || completed.has(id)) {
      throw new PlanValidationError(`id de nodo duplicado: ${id}`);
    }
    seen.add(id);
    const role = String(rawNode.role || '').trim();
    if (!KNOWN_ROLES.includes(role)) {
      throw new PlanValidationError(`rol desconocido "${role}" (roles: ${KNOWN_ROLES.join(', ')})`);
    }
    const goal = String(rawNode.goal || '').trim();
    if (!goal) throw new PlanValidationError(`el nodo ${id} no tiene objetivo (goal)`);
    const budgetRaw = rawNode.budget;
    if (!budgetRaw || typeof budgetRaw !== 'object'
      || (!Number.isFinite(Number(budgetRaw.maxIterations)) && !Number.isFinite(Number(budgetRaw.maxTokens)))) {
      throw new PlanValidationError(`el nodo ${id} no declara presupuesto (budget.maxIterations/maxTokens)`);
    }
    const dependsOn = (Array.isArray(rawNode.dependsOn) ? rawNode.dependsOn : [])
      .map((d) => String(d || '').trim())
      .filter(Boolean);
    if (dependsOn.includes(id)) {
      throw new PlanValidationError(`el nodo ${id} depende de sí mismo`);
    }
    nodes.push({
      id,
      role,
      goal: goal.slice(0, 1_000),
      dependsOn,
      budget: normalizeNodeBudget(budgetRaw),
    });
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!seen.has(dep) && !completed.has(dep)) {
        throw new PlanValidationError(`el nodo ${node.id} depende de un nodo inexistente: ${dep}`);
      }
    }
  }
  topoOrder(nodes, { externalIds: [...completed] }); // throws on cycles
  return { nodes };
}

/**
 * Generator-critic (F4 scope: ONE verifier pass, no best-of-n): when the
 * plan produces a high-stakes deliverable (document/code) and declares no
 * verifier, append one verifier node depending on every high-stakes sink.
 */
function ensureVerifier(plan, { completedIds = [] } = {}) {
  const nodes = plan.nodes;
  if (nodes.some((n) => n.role === 'verifier')) return plan;
  const highStakes = nodes.filter((n) => HIGH_STAKES_ROLES.has(n.role));
  if (!highStakes.length) return plan;
  const dependedOn = new Set();
  for (const node of nodes) for (const dep of node.dependsOn) dependedOn.add(dep);
  const sinks = highStakes.filter((n) => !dependedOn.has(n.id));
  const targets = (sinks.length ? sinks : highStakes).map((n) => n.id);
  let id = 'verificacion';
  const used = new Set([...nodes.map((n) => n.id), ...completedIds.map(String)]);
  while (used.has(id)) id = `${id}_`;
  return {
    nodes: [
      ...nodes,
      {
        id,
        role: 'verifier',
        goal: 'Verifica que los entregables producidos cumplan el objetivo del usuario (contenido, estructura y estilo pedidos). Reporta con honestidad cualquier problema encontrado.',
        dependsOn: targets,
        budget: { maxIterations: 4, maxTokens: Math.min(12_000, NODE_BUDGET_DEFAULTS.maxTokens) },
      },
    ],
  };
}

function buildPlannerSystemPrompt({ maxNodes }) {
  return `You are the DIRECTOR of SiraGPT's agent orchestra. Decompose the user's multi-step goal into the SMALLEST useful DAG of subtasks (prefer 2-3 nodes, hard max ${maxNodes}).

Available specialist roles (each runs a full sandboxed agent with code-execution tools):
- researcher: synthesises findings from the PROVIDED FILES and its own knowledge. It has NO web access.
- data_analyst: computes real numbers from data files with Python.
- coder: writes AND runs code.
- document_editor: produces/edits the final document deliverable (pptx/docx/xlsx/md).
- verifier: inspects deliverables against the goal (critic pass). Add ONE verifier after the final document/code node.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"nodes":[{"id":"n1","role":"researcher","goal":"…","dependsOn":[],"budget":{"maxIterations":6,"maxTokens":16000}}, …]}

Rules:
- ids short and unique; dependsOn only references declared ids; NO cycles.
- every node MUST declare budget.maxIterations (1-15) and budget.maxTokens.
- goals in Spanish, concrete and self-contained (the sub-agent sees only its goal + upstream results).
- fewer nodes is better: only split when the subtasks genuinely need different specialists.`;
}

function buildReplanUserPrompt({ instruction, completed, remaining, steering }) {
  const done = completed.map((c) => `- ${c.id} (${c.role}): ${c.goal}\n  Resultado: ${String(c.summary || '').slice(0, 400)}`);
  const left = remaining.map((n) => `- ${n.id} (${n.role}): ${n.goal}`);
  return [
    `OBJETIVO ORIGINAL DEL USUARIO:\n${instruction}`,
    `NODOS YA COMPLETADOS (NO los repitas — sus resultados ya existen y puedes usarlos como dependsOn):\n${done.join('\n') || '(ninguno)'}`,
    `NODOS PENDIENTES DEL PLAN ANTERIOR (puedes reemplazarlos):\n${left.join('\n') || '(ninguno)'}`,
    `INSTRUCCIONES NUEVAS DEL USUARIO (steering — ajusta el plan restante a esto):\n${steering.map((s) => `- ${s}`).join('\n')}`,
    'Devuelve SOLO el JSON con los nodos RESTANTES del plan actualizado (sin los completados).',
  ].join('\n\n');
}

/**
 * Default production planner: one LLM call, JSON out. Tests inject their own
 * `plannerFn` — this function is never reached with a mocked orchestration.
 *
 * context: { phase: 'initial'|'replan', instruction, fileNames, client,
 *            model, signal, maxNodes, completed, remaining, steering }
 */
async function defaultPlanner(context) {
  const {
    phase = 'initial',
    instruction,
    fileNames = [],
    client,
    model,
    signal,
    maxNodes = resolveMaxNodes(),
    completed = [],
    remaining = [],
    steering = [],
  } = context;
  const files = fileNames.length ? `\n\nARCHIVOS DISPONIBLES:\n${fileNames.map((n) => `- ${n}`).join('\n')}` : '';
  const user = phase === 'replan'
    ? buildReplanUserPrompt({ instruction, completed, remaining, steering })
    : `PEDIDO DEL USUARIO:\n${instruction}${files}`;
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: buildPlannerSystemPrompt({ maxNodes }) },
      { role: 'user', content: user },
    ],
    max_tokens: PLANNER_MAX_TOKENS,
  }, signal ? { signal } : undefined);
  const content = response?.choices?.[0]?.message?.content || '';
  const parsed = parsePlanJson(content);
  if (!parsed) {
    throw new PlanValidationError('el director no devolvió un plan JSON parseable');
  }
  return parsed;
}

module.exports = {
  PlanValidationError,
  MAX_NODES_DEFAULT,
  resolveMaxNodes,
  parsePlanJson,
  topoOrder,
  validatePlan,
  ensureVerifier,
  defaultPlanner,
  buildPlannerSystemPrompt,
};
