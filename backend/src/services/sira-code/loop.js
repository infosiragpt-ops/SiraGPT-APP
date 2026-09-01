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
const { authorizeTool } = require('./permissions');
const { executeTool, TOOL_DEFINITIONS } = require('./tools');
const { appendEvent, stageEvent } = require('./events');
const { appendMessage } = require('./session-store');
const { shouldStartSiraCodeRun, routeTurn } = require('../trivial-turn');

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

async function runPrompt(session, text, {
  llmTurn,
  model = '',
  maxSteps = MAX_STEPS_DEFAULT,
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
  try {
    console.log(`[turn-router] plane=${turnDecision.plane} rule_id=${turnDecision.rule_id}`);
  } catch (_err) { /* internal trace only */ }

  if (!shouldStartSiraCodeRun(text, routerSignals)) {
    session.status = 'idle';
    session.abort = null;
    stageEvent(session, 'done', { label: 'Listo' });
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
  stageEvent(session, 'thinking', { label: 'Pensando' });

  const transcript = [
    { role: 'system', content: agent.systemPrompt },
    ...session.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const complete = typeof llmTurn === 'function' ? llmTurn : defaultLlmTurn();
  const toolResults = [];
  let assistantText = '';

  try {
    for (let step = 0; step < maxSteps; step += 1) {
      if (combined.aborted) {
        stageEvent(session, 'cancelled', { label: 'Cancelado' });
        session.status = 'cancelled';
        return { status: 'cancelled', text: assistantText, toolResults, parts: [] };
      }

      const turn = await complete({
        messages: transcript,
        tools: TOOL_DEFINITIONS,
        agent: agent.id,
        model: session.model,
        signal: combined,
        step,
      });

      const calls = Array.isArray(turn && turn.toolCalls) ? turn.toolCalls : [];
      const textPart = turn && typeof turn.text === 'string' ? turn.text : '';
      if (textPart) assistantText = textPart;

      if (calls.length === 0) {
        session.status = 'idle';
        stageEvent(session, 'done', { label: 'Listo' });
        break;
      }

      for (const call of calls) {
        if (combined.aborted) {
          stageEvent(session, 'cancelled', { label: 'Cancelado' });
          session.status = 'cancelled';
          return { status: 'cancelled', text: assistantText, toolResults, parts: [] };
        }
        const name = call.name || call.tool || '';
        const args = call.arguments || call.args || {};
        const auth = authorizeTool(session.agentId, name, {
          permission: session.permission,
        });

        if (auth.needsPermission) {
          const pid = permissionId();
          session.pendingPermissions.set(pid, { tool: auth.tool, args, name });
          appendEvent(session, 'permission', {
            permissionId: pid,
            tool: auth.tool,
            decision: 'ask',
            label: 'Esperando permiso',
          });
          toolResults.push({
            tool: auth.tool,
            ok: false,
            code: 'permission_required',
            permissionId: pid,
          });
          transcript.push({
            role: 'tool',
            content: `ERROR: permiso requerido para ${auth.tool} (${pid})`,
          });
          continue;
        }

        stageEvent(session, 'executing', {
          label: auth.tool === 'read' || auth.tool === 'grep' || auth.tool === 'glob'
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
        transcript.push({
          role: 'tool',
          content: result.content || result.error || '',
        });
        if (result.ok && (auth.tool === 'write' || auth.tool === 'edit')) {
          stageEvent(session, 'verifying', { label: 'Verificando resultado', tool: auth.tool });
        }
      }
    }
  } catch (err) {
    const aborted = combined.aborted
      || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
    if (aborted) {
      session.status = 'cancelled';
      if (!session.events.some((ev) => ev.step === 'cancelled' || ev.label === 'Cancelado')) {
        stageEvent(session, 'cancelled', { label: 'Cancelado' });
      }
      return { status: 'cancelled', text: assistantText, toolResults, parts: [] };
    }
    stageEvent(session, 'error', { label: 'Error', preview: err.message });
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
  if (session.status === 'running') {
    session.status = 'idle';
    stageEvent(session, 'done', { label: 'Listo' });
  }
  session.abort = null;

  return {
    status: session.status,
    text: assistantText,
    toolResults,
    parts,
    message: { parts },
  };
}

module.exports = {
  runPrompt,
  defaultLlmTurn,
  shouldStartSiraCodeRun,
  MAX_STEPS_DEFAULT,
};
