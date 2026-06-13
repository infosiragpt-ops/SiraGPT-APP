'use strict';

/**
 * codex/agent-loop — the brain of a run, executed inside the BullMQ job
 * (feature 06). Emits DOMAIN events only (plan_proposed, narrative, reasoning,
 * actions, …); the run-processor owns the run_status transitions around it.
 * Returns a terminal outcome `{ status: 'waiting_approval' | 'done' | 'error', error? }`.
 *
 *  - mode `plan` → delegates to plan-mode (never mutates), ends waiting_approval.
 *  - mode `build` → LLM ↔ tools loop: streaming text → narrative_delta,
 *    reasoning → reasoning_*, tool calls → action_* grouped by consecutive
 *    burst (groupId) + a persisted CodexAction. Budgets: CODEX_MAX_STEPS and a
 *    per-turn tool cap; cancellation polled between steps; a tool error does NOT
 *    abort (it is fed back to the model); only an LLM transport error → error.
 *
 * Every dependency is injectable so the loop is fully testable with a scripted
 * llmTurn + a fake runner — zero network, zero DB.
 */

const planMode = require('./plan-mode');
const buildTools = require('./build-tools');
const actionStoreDefault = require('./action-store');
const checkpointService = require('./checkpoint-service');
const runMetrics = require('./run-metrics');
const { classifyText, toActionRequired, benignAnnotation } = require('./error-patterns');

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_TOOLS_PER_TURN = 4;

function readPosInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Default web_search adapter — lazy require so tests never pull it in. */
async function defaultWebSearch(query) {
  try {
    const { search } = require('../agents/web-search');
    return await search(query, { maxResults: 5 });
  } catch {
    return { results: [] };
  }
}

function buildSystemPrompt({ project, plan, fileTree }) {
  const lines = [
    'Eres un agente de software senior trabajando dentro de un workspace aislado.',
    'Narras en PRIMERA PERSONA y en ESPAÑOL lo que vas haciendo, de forma breve y concreta.',
    'Construyes el proyecto usando las herramientas disponibles (no inventes resultados).',
    'Trabajas paso a paso: piensa, usa una herramienta, lee el resultado, continúa.',
    `Proyecto: ${project?.name || 'Codex'}.`,
  ];
  if (plan) {
    lines.push('Plan aprobado por el usuario (síguelo):');
    lines.push(JSON.stringify(plan));
  }
  if (fileTree) {
    lines.push('Archivos actuales del workspace:');
    lines.push(fileTree);
  }
  lines.push('Cuando el proyecto esté listo, deja de llamar herramientas y resume lo construido.');
  return lines.join('\n');
}

/** Best-effort tracked-file listing for context. Never throws. */
async function safeFileTree(runner, projectId) {
  try {
    const out = await runner.exec(projectId, ['git', 'ls-files']);
    if (out && out.exitCode === 0 && out.stdout) return String(out.stdout).slice(0, 4000);
  } catch { /* ignore */ }
  return '';
}

/** Load the approved plan from the plan run's plan_proposed event. */
async function loadApprovedPlan({ run, eventStore, prisma }) {
  if (!run.planRunId || !eventStore?.listEvents) return null;
  try {
    const events = await eventStore.listEvents(run.planRunId, { afterSeq: 0, prisma });
    const proposed = [...events].reverse().find((e) => e.type === 'plan_proposed');
    return proposed ? proposed.data : null;
  } catch {
    return null;
  }
}

async function runBuildLoop({ run, project, signal, isCancelled, deps }) {
  const { eventStore, prisma, env = process.env, clock = () => new Date() } = deps;
  // The metrics accumulator (feature 08) is fed during the loop and finalized at
  // close. Created here when the caller didn't inject one.
  const metrics = deps.metrics || runMetrics.createAccumulator({ run, clock });
  const llmTurn = deps.llmTurn || ((a) => require('./llm-turn').defaultLlmTurn(a));
  const runner = deps.runner || require('./runner-client').createRunnerClient();
  const actionStore = deps.actionStore || actionStoreDefault;
  const webSearch = deps.webSearch || defaultWebSearch;
  const projectId = project?.id || run.projectId;

  const maxSteps = readPosInt(env.CODEX_MAX_STEPS, DEFAULT_MAX_STEPS);
  const maxToolsPerTurn = readPosInt(env.CODEX_MAX_TOOLS_PER_TURN, DEFAULT_MAX_TOOLS_PER_TURN);
  const registry = buildTools.toolRegistry();

  const plan = deps.plan || (await loadApprovedPlan({ run, eventStore, prisma }));
  const fileTree = deps.fileTree != null ? deps.fileTree : await safeFileTree(runner, projectId);
  const messages = [
    { role: 'system', content: buildSystemPrompt({ project, plan, fileTree }) },
    { role: 'user', content: run.prompt || 'Construye el proyecto según el plan aprobado.' },
  ];

  let actionCounter = 0;
  let groupCounter = 0;
  let aborted = false;

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) { aborted = true; break; }
    if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };

    let turn;
    try {
      turn = await llmTurn({ messages, tools: registry, signal, env });
    } catch (err) {
      // Transport error → run error. Feature 09: a blocking pattern (402, missing
      // key, quota) surfaces an action_required card before the run ends.
      const msg = String(err?.message || err);
      const cls = classifyText(msg);
      if (cls && cls.severity === 'blocking') {
        await eventStore.appendEvent(run.id, 'action_required', toActionRequired(cls.pattern, msg), { prisma }).catch(() => {});
      }
      return { status: 'error', error: msg };
    }
    if (turn?.usage && metrics?.recordLlmUsage) metrics.recordLlmUsage(turn.usage);

    // Reasoning block (native or prompted).
    if (turn?.reasoning && (turn.reasoning.text || turn.reasoning.label)) {
      const blockId = `r${step}`;
      const r = turn.reasoning;
      await eventStore.appendEvent(run.id, 'reasoning_start', { blockId, label: r.label || 'Razonando' }, { prisma });
      if (r.text) await eventStore.appendEvent(run.id, 'reasoning_delta', { blockId, text: String(r.text) }, { prisma });
      await eventStore.appendEvent(run.id, 'reasoning_end', { blockId, durationMs: Number(r.durationMs) || 0 }, { prisma });
    }

    // Narrative.
    if (turn?.text && turn.text.trim()) {
      await eventStore.appendEvent(run.id, 'narrative_delta', { text: turn.text.trim() }, { prisma });
      messages.push({ role: 'assistant', content: turn.text.trim() });
    }

    const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls.slice(0, maxToolsPerTurn) : [];
    if (calls.length === 0) {
      // Model produced no tool call → it's done.
      await closeBuild({ run, project, runner, eventStore, prisma, llmTurn, clock, env, metrics });
      return { status: 'done' };
    }

    const groupId = `g${++groupCounter}`;
    for (const call of calls) {
      const tool = buildTools.getTool(call.name);
      const actionId = `a${++actionCounter}`;
      if (!tool) {
        await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: 'terminal', command: String(call.name), groupId }, { prisma });
        await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `herramienta desconocida: ${call.name}`, durationMs: 0 }, { prisma });
        // Honest counting (feature 08, spec req. 4): actionsCount = actions with
        // an action_end of ANY status. This unknown-tool path emits an action_end,
        // so it must be counted too — otherwise the "Work done" number undercounts.
        if (metrics?.recordAction) metrics.recordAction('terminal', 0);
        messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] Error: herramienta desconocida.` });
        continue;
      }

      const command = tool.commandFor(call.args);
      const path = tool.pathFor(call.args);
      await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: tool.kind, command: command || undefined, path: path || undefined, groupId }, { prisma });

      const t0 = clock().getTime();
      const result = await tool.execute(call.args, { runner, project: projectId, webSearch });
      const durationMs = Math.max(0, clock().getTime() - t0);
      const status = result.isError ? 'error' : 'done';

      // Feature 09: classify a failed action. A benign diagnostic (peer-deps
      // warning, vite port retry…) is annotated on the outputSummary and the
      // loop continues; a blocking pattern (402, missing key, runner down) emits
      // an action_required card and ends the run.
      let outputSummary = result.summary || '';
      let blockingPattern = null;
      if (result.isError) {
        const cls = classifyText(result.observation || outputSummary);
        if (cls && cls.severity === 'benign') {
          outputSummary = `${outputSummary}\n${benignAnnotation(cls.pattern)}`.trim();
        } else if (cls && cls.severity === 'blocking') {
          blockingPattern = cls.pattern;
        }
      }

      const endData = { actionId, status, outputSummary, durationMs };
      if (Number.isFinite(result.linesRead)) endData.linesRead = result.linesRead;
      await eventStore.appendEvent(run.id, 'action_end', endData, { prisma });

      try {
        await actionStore.recordAction({ runId: run.id, kind: tool.kind, command, path, status, outputSummary, durationMs, linesRead: result.linesRead, groupId, prisma });
      } catch { /* persistence best-effort; the event timeline is the source of truth */ }

      if (metrics?.recordAction) metrics.recordAction(tool.kind, durationMs);
      if (Number.isFinite(result.linesRead) && metrics?.recordLinesRead) metrics.recordLinesRead(result.linesRead);

      messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] ${result.observation || outputSummary || ''}` });

      if (blockingPattern) {
        await eventStore.appendEvent(run.id, 'action_required', toActionRequired(blockingPattern, result.observation || outputSummary), { prisma }).catch(() => {});
        return { status: 'error', error: blockingPattern.title };
      }
    }
  }

  // Budget exhausted (or aborted by the hard timeout signal): close honestly,
  // not as an error — the work done so far is real.
  await eventStore.appendEvent(
    run.id,
    'narrative_delta',
    { text: aborted ? 'Me detuve por el límite de tiempo de la corrida.' : 'Alcancé el límite de pasos de esta corrida; cierro con lo construido hasta aquí.' },
    { prisma },
  ).catch(() => {});
  await closeBuild({ run, project, runner, eventStore, prisma, llmTurn, clock, env, metrics });
  return { status: 'done' };
}

/**
 * Build close (feature 07 + 08): create the git checkpoint for the changes this
 * run produced (no checkpoint when the tree is clean), then finalize metrics +
 * run_summary (feature 08 extends this). Best-effort — a checkpoint/metrics
 * failure must not turn a successful build into an error.
 */
async function closeBuild({ run, project, runner, eventStore, prisma, llmTurn, clock, env, metrics }) {
  let checkpoint = null;
  try {
    checkpoint = await checkpointService.createCheckpoint({ run, project, deps: { runner, eventStore, prisma, llmTurn, clock, env } });
  } catch (err) {
    if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] checkpoint failed:', err?.message || err);
  }

  // Metrics + run_summary (feature 08). Order: checkpoint → diffstat → metric →
  // run_summary, then the processor emits the terminal run_status. Best-effort —
  // a metrics failure must not turn a successful build into an error.
  if (metrics && typeof metrics.finalize === 'function') {
    try {
      let diffstat = { additions: 0, deletions: 0 };
      if (checkpoint) {
        const d = await checkpointService.getCheckpointDiff({ checkpointId: checkpoint.id, userId: run.userId, deps: { runner, prisma } });
        if (d && !d.error) diffstat = { additions: d.additions, deletions: d.deletions };
      }
      const userPlan = await resolveUserPlan(run.userId, prisma);
      await metrics.finalize({ diffstat, userPlan, prisma, eventStore, env, clock });
    } catch (err) {
      if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] metrics finalize failed:', err?.message || err);
    }
  }
  return { checkpoint };
}

/** Best-effort lookup of the user's plan for pricing (defaults to FREE). */
async function resolveUserPlan(userId, prisma) {
  if (!userId || !prisma || !prisma.user) return 'FREE';
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
    return u?.plan || 'FREE';
  } catch {
    return 'FREE';
  }
}

async function runAgentLoop({ run, project, signal, isCancelled, deps = {} } = {}) {
  const { eventStore } = deps;
  if (!eventStore) throw new Error('agent-loop: eventStore dep required');
  const llmTurn = deps.llmTurn || ((a) => require('./llm-turn').defaultLlmTurn(a));

  if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };

  if (run.mode === 'plan') {
    return planMode.runPlanMode({ run, project, deps: { ...deps, llmTurn } });
  }
  return runBuildLoop({ run, project, signal, isCancelled, deps: { ...deps, llmTurn } });
}

module.exports = { runAgentLoop, runBuildLoop, buildSystemPrompt, safeFileTree, loadApprovedPlan };
