'use strict';

/**
 * F4 — Hierarchical orchestrator on top of AgentRunner.
 *
 * A director/planner decomposes a genuinely MULTI-STEP goal into a small DAG
 * of subtasks and delegates each node to a specialized sub-agent. Every
 * sub-agent IS a full AgentRunner loop (`runAgentRunner`) with a role
 * system-prompt suffix and the existing tools — no parallel agent stack.
 *
 * Contract (same as a single runner turn):
 *   - verified artifacts, or an honest Spanish failure reason
 *     (plan_failed / budget_exceeded / llm_402 / no_output / exception);
 *   - a claimed turn NEVER falls through to the generic document pipeline;
 *   - the caller's AbortSignal cancels the planner AND every in-flight
 *     sub-agent (no leaked loops, no success claim for a partial run);
 *   - `steer(runId, message)` injects a mid-run user note and replans the
 *     REMAINING nodes only — completed nodes are never restarted.
 *
 * Kill switch: SIRAGPT_AGENT_ORCHESTRATOR (1=on, 0=off; unset = ON in
 * production, OFF under NODE_ENV=test so suites opt in explicitly).
 */

const { composeAbortSignals, throwIfAborted } = require('../../../utils/abort-signals');
const { resolveMaxRuntimeMs } = require('../../doc-agent');
const { isLlmCreditError } = require('../loop');
const { resolveTurnFiles, persistOutputs } = require('../artifacts');
const { createBlackboard } = require('./blackboard');
const { rolePrompt, roleLabel, HIGH_STAKES_ROLES } = require('./roles');
const {
  createBudgetTracker,
  wrapClientWithBudgets,
  resolveRunBudget,
} = require('./budget');
const {
  PlanValidationError,
  validatePlan,
  ensureVerifier,
  topoOrder,
  defaultPlanner,
  resolveMaxNodes,
} = require('./planner');

// Lazy: ../index requires this module inside executeAgentRunnerTurn, so a
// top-level require here would create a cycle with half-built exports.
function runnerModule() {
  return require('../index'); // eslint-disable-line global-require
}

/* ── Kill switch ─────────────────────────────────────────────────────────── */

function orchestratorEnabled(env = process.env) {
  const raw = String(env.SIRAGPT_AGENT_ORCHESTRATOR || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  // Default ON in production paths; OFF under test so suites opt in.
  return env.NODE_ENV !== 'test';
}

/* ── shouldOrchestrate: only genuinely multi-step goals ──────────────────── */

// A role "signal" needs an ACTION for that specialty, not a topic mention —
// "crea una ppt sobre python" is one document task, not document+code.
const RESEARCH_SIGNAL = /\b(investiga(?:r|me|lo)?|research|averigua|indaga|recopila\s+informaci[oó]n|revisa\s+la\s+literatura|estado\s+del\s+arte)\b/i;
const CODER_SIGNAL = /\b(script|c[oó]digo\s+(?:python|en\s+\w+|que)|programa\s+(?:en|un|una)\s|implementa\b|automatiza\b)/i;
const DATA_SIGNAL = /\b(analiza(?:r)?|procesa(?:r)?|calcula(?:r)?|cruza(?:r)?|limpia(?:r)?)\b[\s\S]{0,80}?\b(datos|data|cifras|csv|excel|xlsx|hoja\s+de\s+c[aá]lculo|estad[ií]sticas|m[eé]tricas|ventas|n[uú]meros)\b/i;
const DOC_ALT_SIGNAL = /\b(redacta(?:r)?|documenta(?:r)?|resume|escribe)\b[\s\S]{0,60}?\b(informe|reporte|documento|resumen|word|docx|conclusiones|entregable|presentaci[oó]n|ppt)\b/i;

// Multi-step connectives: an explicit sequence, or a second imperative after
// "y" ("analiza los datos Y GENERA un informe").
const SEQUENCE_SIGNAL = /\b(y\s+(?:luego|despu[eé]s|entonces)\b|luego\b|despu[eé]s\b|a\s+continuaci[oó]n\b|primero\b|then\b|con\s+(?:los|esos|sus)\s+(?:resultados|hallazgos|datos)\b|en\s+base\s+a\s+(?:eso|los\s+resultados)\b|a\s+partir\s+de\s+(?:eso|los\s+resultados|ah[ií])\b)/i;
const SECOND_IMPERATIVE_SIGNAL = /\by\b\s+(?:me\s+)?(?:crea|cr[eé]ame|genera|redacta|documenta|escribe|arma|haz(?:me)?|prepara|produce|elabora|construye|dise[nñ]a|verifica|valida|resume)\b/i;

/**
 * True ONLY for goals that need several distinct specialists in sequence
 * (research then write, code then verify, analyze data then document).
 * Simple "crea una ppt rosada" / style follow-ups stay on the single
 * AgentRunner path.
 */
function shouldOrchestrate(text, _ctx = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  const { CREATE_DOC_RE, DOC_NOUN_RE } = runnerModule();
  const roles = new Set();
  if (RESEARCH_SIGNAL.test(t)) roles.add('researcher');
  if (CODER_SIGNAL.test(t)) roles.add('coder');
  if (DATA_SIGNAL.test(t)) roles.add('data_analyst');
  if ((CREATE_DOC_RE.test(t) && DOC_NOUN_RE.test(t)) || DOC_ALT_SIGNAL.test(t)) {
    roles.add('document_editor');
  }
  if (roles.size < 2) return false;
  return SEQUENCE_SIGNAL.test(t) || SECOND_IMPERATIVE_SIGNAL.test(t);
}

/* ── Steering: live-run registry ─────────────────────────────────────────── */

const ACTIVE_RUNS = new Map(); // runId -> { steeringQueue: string[] }

/**
 * Inject a user/director note into a LIVE orchestration. Picked up between
 * nodes: remaining unfinished nodes are replanned around the note; completed
 * nodes are never restarted. Returns false when the run is not live.
 */
function steer(runId, message) {
  const handle = ACTIVE_RUNS.get(String(runId || ''));
  if (!handle) return false;
  const note = String(message || '').trim();
  if (!note) return false;
  handle.steeringQueue.push(note);
  return true;
}

function isOrchestratorRunActive(runId) {
  return ACTIVE_RUNS.has(String(runId || ''));
}

/* ── Node instruction (blackboard → sub-agent) ───────────────────────────── */

function buildNodeInstruction({ node, blackboard, originalGoal }) {
  const parts = [
    `OBJETIVO GLOBAL DEL USUARIO:\n${originalGoal}`,
    `TU SUBTAREA (rol: ${node.role}):\n${node.goal}`,
  ];
  const upstream = blackboard.upstreamContext(node.dependsOn);
  if (upstream) {
    parts.push(`RESULTADOS DE NODOS PREVIOS (tu materia prima):\n${upstream}`);
  }
  const steering = blackboard.steering;
  if (steering.length) {
    parts.push(`INSTRUCCIONES ADICIONALES DEL USUARIO DURANTE LA EJECUCIÓN (obedécelas):\n${steering.map((s) => `- ${s}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

function sanitizeUploadFileName(name, fallback) {
  const base = String(name || fallback).split(/[\\/]/).pop();
  return base || fallback;
}

/* ── Core run ────────────────────────────────────────────────────────────── */

function makeRunId() {
  return `orc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nodeSummary(node, result) {
  return {
    id: node.id,
    role: node.role,
    goal: node.goal,
    status: result?.status || 'pending',
    stoppedReason: result?.reason || null,
    finalText: result?.finalText || '',
    outputNames: (result?.outputs || []).map((o) => o.name),
    iterations: result?.iterations || 0,
  };
}

/**
 * Run the full orchestration. Throws ONLY on abort; every other failure is
 * returned as `{ stoppedReason, errorMessage, outputs: [] }` so callers can
 * surface the honest Spanish error without a try/catch dance.
 */
async function runOrchestrator({
  files = [],
  instruction,
  model,
  client,
  onEvent = () => {},
  driver,
  signal,
  chatId = null,
  userId = null,
  runId = null,
  plannerFn = null,
  maxNodes = null,
  runBudget: runBudgetOverrides = null,
  env = process.env,
} = {}) {
  const task = String(instruction || '').trim();
  if (!task) throw new Error('runOrchestrator: instruction is required');
  const runner = runnerModule();
  const resolvedModel = model || runner.defaultModel();
  const id = String(runId || makeRunId());

  const abortScope = composeAbortSignals([signal], {
    timeoutMs: resolveMaxRuntimeMs(
      env.SIRAGPT_ORCHESTRATOR_MAX_RUNTIME_MS || env.SIRAGPT_AGENT_RUNNER_MAX_RUNTIME_MS,
    ),
    timeoutReason: 'agent_orchestrator_timeout',
  });

  // Exactly ONE 'cancelled' trace per aborted orchestration, no matter which
  // layer (planner, sub-agent loop, sandbox) sees the abort first.
  let cancelledSeen = false;
  const emit = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'cancelled') {
      if (cancelledSeen) return;
      cancelledSeen = true;
    }
    try { onEvent(ev); } catch (_) { /* trace only */ }
  };

  const handle = { steeringQueue: [] };
  ACTIVE_RUNS.set(id, handle);

  const results = new Map(); // nodeId -> node result
  const completedOrder = []; // [{ id, role }]
  const blackboard = createBlackboard();
  const allSteps = [];
  const runTracker = createBudgetTracker({ scope: 'run', ...resolveRunBudget({ env, overrides: runBudgetOverrides || {} }) });
  const emitBudgetExceeded = (err) => emit({
    type: 'budget_exceeded',
    runId: id,
    scope: err.scope,
    kind: err.kind,
    node: err.nodeId || undefined,
    preview: `${err.scope === 'run' ? 'presupuesto global' : `presupuesto del nodo ${err.nodeId || ''}`} agotado (${err.kind}: ${err.used}/${err.max})`,
  });

  const failure = (reason, errorMessage) => ({
    ok: false,
    orchestrated: true,
    runId: id,
    finalText: '',
    outputs: [],
    steps: allSteps,
    iterations: runTracker.state.iterationsUsed,
    tokensUsed: runTracker.state.tokensUsed,
    stoppedReason: reason,
    errorMessage: errorMessage || null,
    driver: driver || null,
    model: resolvedModel,
    nodes: [...results.entries()].map(([nodeId, r]) => ({ id: nodeId, ...r.public })),
  });

  try {
    throwIfAborted(abortScope.signal);
    let llm = client || null;
    if (!llm) {
      const { createOpenRouterClient } = require('../../doc-agent'); // eslint-disable-line global-require
      llm = createOpenRouterClient();
    }
    const plannerClient = wrapClientWithBudgets(llm, [runTracker], { onExceeded: emitBudgetExceeded });
    const planner = plannerFn || defaultPlanner;
    const nodeCap = maxNodes || resolveMaxNodes(env);
    const fileNames = files.map((f, i) => sanitizeUploadFileName(f?.name, `file-${i + 1}`));

    emit({ type: 'orchestrator_start', runId: id, tool: 'orchestrator' });
    emit({ type: 'plan_start', runId: id, tool: 'orchestrator', preview: task.slice(0, 160) });

    const callPlanner = async (phase, extras = {}) => {
      throwIfAborted(abortScope.signal);
      const raw = await planner({
        phase,
        instruction: task,
        fileNames,
        client: plannerClient,
        model: resolvedModel,
        signal: abortScope.signal,
        maxNodes: nodeCap,
        ...extras,
      });
      throwIfAborted(abortScope.signal);
      const completedIds = blackboard.completedIds();
      let plan = validatePlan(raw, { maxNodes: nodeCap, completedIds });
      plan = ensureVerifier(plan, { completedIds });
      return topoOrder(plan.nodes, { externalIds: completedIds });
    };

    let remaining;
    try {
      remaining = await callPlanner('initial', { completed: [], remaining: [], steering: [] });
    } catch (err) {
      throwIfAborted(abortScope.signal);
      if (err?.code === 'BUDGET_EXCEEDED') return failure('budget_exceeded', err.message);
      if (isLlmCreditError(err)) return failure('llm_402', err?.message || String(err));
      return failure('plan_failed', err?.message || String(err));
    }
    emit({
      type: 'plan_ready',
      runId: id,
      tool: 'orchestrator',
      nodes: remaining.map((n) => ({ id: n.id, role: n.role, dependsOn: n.dependsOn })),
      preview: remaining.map((n) => `${n.id}:${n.role}`).join(' → '),
    });

    while (remaining.length) {
      throwIfAborted(abortScope.signal);

      // Steering: replan the REMAINING nodes only; completed nodes stand.
      if (handle.steeringQueue.length) {
        const notes = handle.steeringQueue.splice(0, handle.steeringQueue.length);
        for (const note of notes) blackboard.addSteering(note);
        emit({ type: 'steered', runId: id, tool: 'orchestrator', preview: notes.join(' | ').slice(0, 200) });
        emit({ type: 'replanning', runId: id, tool: 'orchestrator' });
        const completed = completedOrder.map(({ id: nodeId, role }) => {
          const entry = blackboard.read(nodeId);
          return { id: nodeId, role, goal: entry?.goal || '', summary: entry?.finalText || '' };
        });
        try {
          remaining = await callPlanner('replan', {
            completed,
            remaining: remaining.map((n) => ({ id: n.id, role: n.role, goal: n.goal, dependsOn: n.dependsOn })),
            steering: blackboard.steering,
          });
        } catch (err) {
          throwIfAborted(abortScope.signal);
          if (err?.code === 'BUDGET_EXCEEDED') return failure('budget_exceeded', err.message);
          if (isLlmCreditError(err)) return failure('llm_402', err?.message || String(err));
          return failure('plan_failed', `replan inválido: ${err?.message || String(err)}`);
        }
        emit({
          type: 'plan_ready',
          runId: id,
          tool: 'orchestrator',
          replanned: true,
          nodes: remaining.map((n) => ({ id: n.id, role: n.role, dependsOn: n.dependsOn })),
          preview: remaining.map((n) => `${n.id}:${n.role}`).join(' → '),
        });
        if (!remaining.length) break;
      }

      const node = remaining.shift();
      emit({
        type: 'node_start',
        runId: id,
        tool: node.role,
        node: node.id,
        role: node.role,
        preview: `${roleLabel(node.role)}: ${node.goal.slice(0, 140)}`,
      });

      const nodeTracker = createBudgetTracker({ scope: 'node', nodeId: node.id, ...node.budget });
      const nodeClient = wrapClientWithBudgets(llm, [runTracker, nodeTracker], { onExceeded: emitBudgetExceeded });
      const nodeFiles = [...files];
      const seenNames = new Set(nodeFiles.map((f, i) => sanitizeUploadFileName(f?.name, `file-${i + 1}`)));
      for (const depId of node.dependsOn) {
        const dep = blackboard.read(depId);
        for (const out of (dep?.outputs || [])) {
          if (!out || out.valid === false || !out.buffer || !out.buffer.length) continue;
          const name = seenNames.has(out.name) ? `${depId}-${out.name}` : out.name;
          seenNames.add(name);
          nodeFiles.push({ name, buffer: out.buffer });
        }
      }

      let nodeResult;
      try {
        const run = await runner.runAgentRunner({
          files: nodeFiles,
          instruction: buildNodeInstruction({ node, blackboard, originalGoal: task }),
          model: resolvedModel,
          client: nodeClient,
          onEvent: (ev) => emit(ev && typeof ev === 'object' ? { ...ev, node: node.id, role: node.role } : ev),
          driver,
          maxIterations: node.budget.maxIterations,
          signal: abortScope.signal,
          // Distinct sandbox per node: never reuse the chat-persistent
          // workspace, or one node would re-collect another node's outputs.
          chatId: chatId ? `${chatId}:f4:${node.id}` : null,
          userId,
          systemAppend: rolePrompt(node.role),
          // Text-producing specialists may finish without a file; only the
          // deliverable roles keep the runner's no-output retry pressure.
          requireFileOutput: HIGH_STAKES_ROLES.has(node.role),
        });
        const validOutputs = (run.outputs || []).filter((o) => o && o.valid !== false && o.buffer && o.buffer.length);
        for (const step of (run.steps || [])) allSteps.push({ node: node.id, role: node.role, ...step });
        if (run.stoppedReason === 'llm_402') {
          nodeResult = { status: 'failed', reason: 'llm_402', error: run.errorMessage || null };
        } else if (validOutputs.length || (['final', 'fast_path', 'verification_failed'].includes(run.stoppedReason) && String(run.finalText || '').trim())) {
          // Same contract as a single runner turn: a delivered verified file
          // counts, and a text-only final counts for text-producing nodes.
          nodeResult = {
            status: 'completed',
            finalText: String(run.finalText || '').trim(),
            outputs: validOutputs,
            iterations: run.iterations || 0,
            reason: null,
          };
        } else {
          nodeResult = {
            status: 'failed',
            // 3H32 stop reasons (max_iterations / loop_cut / budget_exceeded)
            // are all honest budget stops; anything else is a plain no-output.
            reason: ['max_iterations', 'loop_cut', 'budget_exceeded'].includes(run.stoppedReason) ? 'budget_exceeded' : 'no_output',
            error: run.errorMessage || null,
          };
        }
      } catch (err) {
        if (abortScope.signal.aborted) throw err;
        const reason = err?.code === 'BUDGET_EXCEEDED'
          ? 'budget_exceeded'
          : (isLlmCreditError(err) ? 'llm_402' : 'exception');
        nodeResult = { status: 'failed', reason, error: err?.message || String(err) };
      }

      results.set(node.id, { ...nodeResult, public: nodeSummary(node, nodeResult) });
      emit({
        type: 'node_done',
        runId: id,
        tool: node.role,
        node: node.id,
        role: node.role,
        ok: nodeResult.status === 'completed',
        preview: nodeResult.status === 'completed'
          ? (nodeResult.outputs.map((o) => o.name).join(', ') || nodeResult.finalText.slice(0, 120))
          : `falló: ${nodeResult.reason}`,
      });

      if (nodeResult.status === 'completed') {
        completedOrder.push({ id: node.id, role: node.role });
        blackboard.write(node.id, {
          role: node.role,
          goal: node.goal,
          finalText: nodeResult.finalText,
          outputs: nodeResult.outputs,
        });
        continue;
      }

      // The verifier is a critic pass: an unhappy/failed critic never
      // destroys a delivered result — its outcome is reported in the summary.
      // Exception: running out of run-level budget mid-verification is NOT a
      // critique opinion — it is an honest global stop, never persisted as ok.
      if (node.role === 'verifier' && nodeResult.reason !== 'budget_exceeded') {
        blackboard.write(node.id, {
          role: node.role,
          goal: node.goal,
          finalText: `La verificación no pudo completarse (${nodeResult.reason}).`,
          outputs: [],
        });
        completedOrder.push({ id: node.id, role: node.role });
        continue;
      }

      // A failed working node makes every dependent node impossible: stop the
      // whole orchestration honestly. Never declare success on a partial run.
      return failure(nodeResult.reason, nodeResult.error);
    }

    // Deliverables: outputs of completed non-verifier nodes, last version of
    // a filename wins (verifier reports are internal critique, not delivery).
    const byName = new Map();
    for (const { id: nodeId, role } of completedOrder) {
      if (role === 'verifier') continue;
      const entry = blackboard.read(nodeId);
      for (const out of (entry?.outputs || [])) byName.set(out.name, out);
    }
    const outputs = [...byName.values()];

    const deliverNodes = completedOrder.filter(({ role }) => role !== 'verifier');
    const lastDeliver = deliverNodes.length ? blackboard.read(deliverNodes[deliverNodes.length - 1].id) : null;
    const verifierNode = completedOrder.find(({ role }) => role === 'verifier');
    const verifierEntry = verifierNode ? blackboard.read(verifierNode.id) : null;
    let finalText = String(lastDeliver?.finalText || '').trim();
    if (!finalText && outputs.length) finalText = `Listo. Generé ${outputs.map((o) => o.name).join(', ')}.`;
    if (verifierEntry && String(verifierEntry.finalText || '').trim()) {
      finalText = `${finalText}\n\nVerificación: ${String(verifierEntry.finalText).trim().slice(0, 400)}`.trim();
    }

    emit({
      type: 'outputs',
      runId: id,
      count: outputs.length,
      names: outputs.map((o) => o.name),
      label: 'Listo',
    });

    return {
      ok: true,
      orchestrated: true,
      runId: id,
      finalText,
      outputs,
      steps: allSteps,
      iterations: runTracker.state.iterationsUsed,
      tokensUsed: runTracker.state.tokensUsed,
      stoppedReason: 'final',
      errorMessage: null,
      driver: driver || null,
      model: resolvedModel,
      nodes: [...results.values()].map((r) => r.public),
    };
  } catch (err) {
    if (abortScope.signal.aborted) {
      emit({ type: 'cancelled', runId: id, label: 'Cancelado' });
    }
    throw err;
  } finally {
    ACTIVE_RUNS.delete(id);
    abortScope.cleanup();
  }
}

/* ── Chat-contract wrapper (same shape as runAgentRunnerForChat) ─────────── */

async function runOrchestratorForChat({
  prisma,
  userId,
  chatId,
  fileIds = [],
  attachedFiles = [],
  instruction,
  model,
  client,
  signal,
  onEvent = () => {},
  driver,
  runId = null,
  plannerFn = null,
  maxNodes = null,
  runBudget = null,
  persist = persistOutputs,
} = {}) {
  const runner = runnerModule();
  let loaded = attachedFiles;
  if ((!loaded || !loaded.length) && prisma && userId && Array.isArray(fileIds) && fileIds.length) {
    loaded = await runner.loadFilesByIds({ prisma, userId, fileIds });
  }
  const resolved = await resolveTurnFiles({
    prisma,
    userId,
    chatId,
    attachedFiles: loaded,
  });
  const run = await runOrchestrator({
    files: resolved.files,
    instruction,
    model,
    client,
    onEvent,
    driver,
    signal,
    chatId,
    userId,
    runId,
    plannerFn,
    maxNodes,
    runBudget,
  });
  if (!run.ok) {
    // Honest failure — no partial-run persistence, no success claim, and the
    // caller's F1/F2 hard stop keeps the generic pipeline unreachable.
    return {
      ok: false,
      skipped: false,
      orchestrated: true,
      runId: run.runId,
      summary: '',
      artifacts: [],
      steps: run.steps || [],
      iterations: run.iterations,
      driver: run.driver,
      stoppedReason: run.stoppedReason || 'no_output',
      errorMessage: run.errorMessage || null,
      nodes: run.nodes || [],
    };
  }
  const valid = (run.outputs || []).filter((o) => o && o.valid !== false && o.buffer && o.buffer.length);
  const artifacts = await persist({
    outputs: valid,
    userId,
    chatId,
    prisma,
    onEvent,
  });
  const summary = String(run.finalText || '').trim()
    || (artifacts.length
      ? `Listo. Generé ${artifacts.map((a) => a.filename).join(', ')}.`
      : 'No pude generar el archivo. Intenta de nuevo con más detalle.');
  return {
    ok: artifacts.length > 0,
    orchestrated: true,
    runId: run.runId,
    summary,
    artifacts,
    steps: run.steps || [],
    iterations: run.iterations,
    driver: run.driver,
    stoppedReason: artifacts.length ? 'agent_runner' : 'no_output',
    errorMessage: artifacts.length ? null : (run.errorMessage || null),
    priorArtifactId: resolved.latest?.id || null,
    nodes: run.nodes || [],
  };
}

module.exports = {
  orchestratorEnabled,
  shouldOrchestrate,
  runOrchestrator,
  runOrchestratorForChat,
  steer,
  isOrchestratorRunActive,
  buildNodeInstruction,
  PlanValidationError,
};
