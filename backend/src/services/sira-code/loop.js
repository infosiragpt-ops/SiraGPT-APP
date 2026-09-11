'use strict';

/**
 * SiraCode prompt loop: LLM → permissioned tools → LLM.
 *
 * Injectable `llmTurn` keeps tests offline and lets the /agentes picker
 * model hit its own API (no OpenRouter mixer, no hardcoded vendor id in
 * the public contract). Cancel is cooperative via AbortSignal.
 */

const crypto = require('crypto');
const { getAgent } = require('./agents');
const { authorizeTool, WRITE_TOOLS } = require('./permissions');
const { executeTool, TOOL_DEFINITIONS } = require('./tools');
const { appendEvent, stageEvent } = require('./events');
const { withProgress } = require('./progress');
const { snapshot } = require('./project-store');
const { attachProof } = require('./isolated-preview');

function emitStage(session, step, extra = {}) {
  const progress = withProgress(session, step, extra);
  return stageEvent(session, step, { ...extra, progress });
}
const { appendMessage } = require('./session-store');
const { ensureSessionTitle } = require('./session-title');
const {
  truncateToolResult,
  compactTranscript,
  applyCompactedTranscript,
  COMPACT_STAGE,
  COMPACT_LABEL,
} = require('./tool-result');
const { shouldStartSiraCodeRun, routeTurn } = require('../trivial-turn');
const {
  ensureCapturedPlan,
  buildSwitchReminder,
  publicPlan,
  isTransientLlmError,
} = require('./plan-handoff');
const {
  resolveMaxToolRounds,
  isToolRoundsExceeded,
  buildToolRoundsStop,
  MAX_TOOL_ROUNDS_DEFAULT,
} = require('./tool-rounds');
const {
  isQuestionTool,
  normalizeQuestionArgs,
  publicQuestions,
} = require('./question-tool');

const MAX_STEPS_DEFAULT = 8;

function defaultLlmTurn() {
  return async function llmTurn({ messages }) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const text = last && last.content ? String(last.content) : '';
    return {
      text: text
        ? `Listo. Recibí la instrucción y no ejecuté herramientas en este turno.`
        : 'Listo.',
      toolCalls: [],
    };
  };
}

function permissionId() {
  return `perm_${crypto.randomBytes(6).toString('hex')}`;
}

async function callLlmTurn(complete, args, session) {
  try {
    return await complete(args);
  } catch (err) {
    if (!isTransientLlmError(err)) throw err;
    if (args.signal && args.signal.aborted) throw err;
    emitStage(session, 'retrying', { label: 'Reintentando' });
    return complete(args);
  }
}

function buildTranscript(session, agent) {
  const transcript = [
    { role: 'system', content: agent.systemPrompt },
  ];
  if (agent.id === 'construir' && session.plan && session.plan.text) {
    transcript.push({
      role: 'system',
      content: buildSwitchReminder(session.plan),
    });
  }
  for (const message of session.messages) {
    transcript.push({ role: message.role, content: message.content });
  }
  return applyCompactedTranscript(transcript, compactTranscript(transcript));
}

async function runPrompt(session, text, {
  llmTurn,
  model = '',
  maxSteps = MAX_STEPS_DEFAULT,
  maxToolRounds = MAX_TOOL_ROUNDS_DEFAULT,
  signal,
  chip,
  attachments,
  permission,
} = {}) {
  const agent = getAgent(session.agentId);
  session.model = model || session.model;
  if (permission != null) session.permission = permission;
  const controller = session.abort || new AbortController();
  session.abort = controller;
  const combined = signal || controller.signal;

  appendMessage(session, {
    role: 'user',
    content: String(text || ''),
    parts: [{ type: 'text', text: String(text || '') }],
  });
  appendEvent(session, 'message', { role: 'user', content: String(text || '') });

  const routerSignals = {
    toggleConstruir: session.agentId === 'construir',
    togglePlanificar: session.agentId === 'planificar',
    chip,
    attachments,
  };
  const turnDecision = routeTurn({ text, ...routerSignals });
  const titled = ensureSessionTitle(session, text, { trivial: turnDecision.trivial });
  if (titled.changed) {
    appendEvent(session, 'title', { title: titled.title, label: 'Sesión' });
  }
  try {
    console.log(`[turn-router] plane=${turnDecision.plane} rule_id=${turnDecision.rule_id}`);
  } catch (_err) { /* internal trace only */ }

  if (!shouldStartSiraCodeRun(text, routerSignals)) {
    session.status = 'idle';
    session.abort = null;
    emitStage(session, 'done', { label: 'Listo' });
    return {
      status: 'idle',
      skipped: true,
      reason: turnDecision.trivial ? 'trivial_turn' : 'plane_gate',
      plane: turnDecision.plane,
      rule_id: turnDecision.rule_id,
      text: '',
      toolResults: [],
      parts: [],
    };
  }

  session.status = 'running';
  emitStage(session, 'thinking', { label: 'Pensando' });

  const transcript = buildTranscript(session, agent);

  const complete = typeof llmTurn === 'function' ? llmTurn : defaultLlmTurn();
  const toolResults = [];
  const toolRoundCap = resolveMaxToolRounds(maxToolRounds);
  let assistantText = '';
  let hitBudget = false;
  let hitToolRounds = false;
  let toolRounds = 0;
  let compactedOnce = false;
  let pausedForQuestion = false;

  function maybeCompactStage(didCompact) {
    if (!didCompact || compactedOnce) return;
    compactedOnce = true;
    emitStage(session, COMPACT_STAGE, { label: COMPACT_LABEL });
  }

  try {
    for (let step = 0; step < maxSteps; step += 1) {
      if (combined.aborted) {
        emitStage(session, 'cancelled', { label: 'Cancelado' });
        session.status = 'cancelled';
        return { status: 'cancelled', text: assistantText, toolResults, parts: [] };
      }

      const packedBefore = compactTranscript(transcript);
      applyCompactedTranscript(transcript, packedBefore);
      maybeCompactStage(packedBefore.compacted);

      const turn = await callLlmTurn(complete, {
        messages: transcript,
        tools: TOOL_DEFINITIONS,
        agent: agent.id,
        model: session.model,
        signal: combined,
        step,
      }, session);

      const calls = Array.isArray(turn && turn.toolCalls) ? turn.toolCalls : [];
      const textPart = turn && typeof turn.text === 'string' ? turn.text : '';
      if (textPart) assistantText = textPart;

      if (calls.length === 0) {
        session.status = 'idle';
        const proof = await attachProof(session).catch(() => session.proof);
        emitStage(session, 'done', { label: 'Listo', proof });
        break;
      }

      for (const call of calls) {
        if (combined.aborted) {
          emitStage(session, 'cancelled', { label: 'Cancelado' });
          session.status = 'cancelled';
          return { status: 'cancelled', text: assistantText, toolResults, parts: [] };
        }
        if (isToolRoundsExceeded(toolRounds, toolRoundCap)) {
          hitToolRounds = true;
          const stop = buildToolRoundsStop({ count: toolRounds, max: toolRoundCap });
          const skipped = call.name || call.tool || '';
          toolResults.push({
            tool: skipped,
            ok: false,
            code: stop.stopReason,
            error: stop.label,
            content: stop.content,
            skipped: true,
          });
          transcript.push({ role: 'tool', content: stop.content });
          break;
        }
        toolRounds += 1;
        const name = call.name || call.tool || '';
        const args = call.arguments || call.args || {};
        const auth = authorizeTool(session.agentId, name, {
          permission: session.permission,
          grants: session.permissionGrants,
        });

        if (auth.needsPermission) {
          const questionAsk = auth.tool === 'question' || isQuestionTool(name);
          let pendingArgs = args;
          let questions;
          if (questionAsk) {
            const normalized = normalizeQuestionArgs(args);
            if (!normalized.ok) {
              const result = {
                ok: false,
                code: normalized.code || 'validation',
                error: normalized.error,
                content: `ERROR: ${normalized.error}`,
              };
              toolResults.push({ tool: 'question', ...result });
              appendEvent(session, 'tool_result', {
                tool: 'question',
                ok: false,
                preview: String(result.content || '').slice(0, 240),
              });
              transcript.push({ role: 'tool', content: result.content });
              continue;
            }
            questions = normalized.questions;
            pendingArgs = { questions };
          }
          const pid = permissionId();
          session.pendingPermissions.set(pid, {
            tool: auth.tool,
            args: pendingArgs,
            name,
            kind: questionAsk ? 'question' : 'permission',
            questions,
          });
          appendEvent(session, 'permission', {
            permissionId: pid,
            tool: auth.tool,
            decision: 'ask',
            label: questionAsk ? 'Esperando respuesta' : 'Esperando permiso',
            kind: questionAsk ? 'question' : 'permission',
            header: questionAsk && questions[0] ? questions[0].header : undefined,
            questions: questionAsk ? publicQuestions(questions) : undefined,
          });
          toolResults.push({
            tool: auth.tool,
            ok: false,
            code: 'permission_required',
            permissionId: pid,
          });
          transcript.push({
            role: 'tool',
            content: questionAsk
              ? `ERROR: pregunta pendiente (${pid})`
              : `ERROR: permiso requerido para ${auth.tool} (${pid})`,
          });
          if (questionAsk) {
            pausedForQuestion = true;
            break;
          }
          continue;
        }

        emitStage(session, 'executing', {
          label: auth.tool === 'read' || auth.tool === 'grep' || auth.tool === 'glob'
            || auth.tool === 'ls' || auth.tool === 'diagnostics'
            ? 'Analizando archivo'
            : 'Ejecutando código',
          tool: auth.tool,
        });
        const result = await executeTool(session, name, args, { signal: combined });
        toolResults.push({ tool: auth.tool, ...result });
        appendEvent(session, 'tool_result', {
          tool: auth.tool,
          ok: result.ok,
          preview: String(result.content || '').slice(0, 240),
        });
        const packedResult = truncateToolResult(result.content || result.error || '');
        transcript.push({
          role: 'tool',
          content: packedResult.content,
        });
        const packedAfter = compactTranscript(transcript);
        applyCompactedTranscript(transcript, packedAfter);
        maybeCompactStage(packedResult.truncated || packedAfter.compacted);
        if (result.ok && WRITE_TOOLS.has(auth.tool)) {
          emitStage(session, 'verifying', { label: 'Verificando resultado', tool: auth.tool });
          if (session.chatId && session.userId) {
            await snapshot(session.workspace, session.userId, session.chatId, session.persistEnv).catch(() => {});
          }
        }
      }
      if (pausedForQuestion) break;
      if (hitToolRounds || isToolRoundsExceeded(toolRounds, toolRoundCap)) {
        hitToolRounds = true;
        break;
      }
      if (step === maxSteps - 1) hitBudget = true;
    }
  } catch (err) {
    const aborted = combined.aborted
      || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
    if (aborted) {
      session.status = 'cancelled';
      if (!session.events.some((ev) => ev.step === 'cancelled' || ev.label === 'Cancelado')) {
        emitStage(session, 'cancelled', { label: 'Cancelado' });
      }
      return { status: 'cancelled', text: assistantText, toolResults, parts: [] };
    }
    emitStage(session, 'error', { label: 'Error', preview: err.message });
    session.status = 'error';
    throw err;
  }

  const parts = [];
  if (assistantText) parts.push({ type: 'text', text: assistantText });
  for (const tr of toolResults) {
    parts.push({
      type: 'tool',
      tool: tr.tool,
      ok: tr.ok,
      content: tr.content || tr.error || '',
    });
  }

  appendMessage(session, {
    role: 'assistant',
    content: assistantText,
    parts,
  });
  appendEvent(session, 'message', { role: 'assistant', content: assistantText });
  if (agent.id === 'planificar' && assistantText) {
    ensureCapturedPlan(session, assistantText, { sourceAgent: 'planificar', status: 'ready' });
  }
  if (pausedForQuestion && (session.status === 'running' || session.status === 'idle')) {
    session.status = 'idle';
  } else if (hitToolRounds && (session.status === 'running' || session.status === 'idle')) {
    session.status = 'stopped';
    session.stopReason = 'tool_rounds';
    const stop = buildToolRoundsStop({ count: toolRounds, max: toolRoundCap });
    emitStage(session, stop.step, {
      label: stop.label,
      count: stop.count,
      max: stop.max,
    });
  } else if (hitBudget && session.status === 'running') {
    session.status = 'stopped';
    session.stopReason = 'step_budget';
    emitStage(session, 'budgetExceeded', { label: 'Presupuesto agotado' });
  } else if (session.status === 'running') {
    session.status = 'idle';
    const proof = await attachProof(session).catch(() => session.proof);
    emitStage(session, 'done', { label: 'Listo', proof });
  }
  session.abort = null;

  return {
    status: session.status,
    text: assistantText,
    toolResults,
    parts,
    message: { parts },
    plan: publicPlan(session.plan),
    toolRounds,
    maxToolRounds: toolRoundCap,
    stopReason: session.status === 'stopped'
      ? (session.stopReason || (hitToolRounds ? 'tool_rounds' : 'step_budget'))
      : undefined,
  };
}

module.exports = {
  runPrompt,
  defaultLlmTurn,
  shouldStartSiraCodeRun,
  MAX_STEPS_DEFAULT,
  MAX_TOOL_ROUNDS_DEFAULT,
};
