'use strict';

/**
 * Plan → Construir handoff for SiraCode sessions.
 *
 * Independent rewrite inspired by OpenCode's session reminders
 * (plan mode → build switch). Not a vendor copy. Spanish product
 * copy only; never mention providers or raw model ids.
 */

const PLAN_MAX_CHARS = 4_000;
const PLAN_PREVIEW_CHARS = 240;
const STEP_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s+\S/gm;

function extractStepCount(text) {
  const raw = String(text || '');
  const hits = raw.match(STEP_LINE_RE);
  return hits ? hits.length : 0;
}

function looksLikePlan(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const steps = extractStepCount(raw);
  if (steps >= 2) return true;
  return raw.length >= 40;
}

function capturePlanFromText(text, extra = {}) {
  const raw = String(text || '').trim();
  if (!looksLikePlan(raw)) return null;
  return {
    text: raw.slice(0, PLAN_MAX_CHARS),
    stepCount: extractStepCount(raw),
    status: extra.status || 'ready',
    capturedAt: Number(extra.capturedAt) || Date.now(),
    sourceAgent: extra.sourceAgent || 'planificar',
  };
}

function latestPlanificarAssistant(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row || row.role !== 'assistant') continue;
    if (row.agentId && row.agentId !== 'planificar') continue;
    if (String(row.content || '').trim()) return row;
  }
  return null;
}

function ensureCapturedPlan(session, text, extra = {}) {
  const captured = capturePlanFromText(text, {
    sourceAgent: extra.sourceAgent || (session && session.agentId) || 'planificar',
    capturedAt: extra.capturedAt,
    status: extra.status,
  });
  if (!captured || !session) return null;
  session.plan = captured;
  session.updatedAt = captured.capturedAt;
  return captured;
}

function handoffPlanificarToConstruir(session) {
  if (!session) return { handoff: false };
  if (session.plan && session.plan.text) {
    session.plan = { ...session.plan, status: 'active' };
    return { handoff: true, from: 'planificar', to: 'construir', reused: true };
  }
  const last = latestPlanificarAssistant(session);
  const captured = last
    ? ensureCapturedPlan(session, last.content, { sourceAgent: 'planificar', status: 'active' })
    : null;
  if (!captured) return { handoff: false, from: 'planificar', to: 'construir' };
  return { handoff: true, from: 'planificar', to: 'construir', reused: false };
}

function applyAgentChange(session, nextAgentId, switchFn) {
  const prev = session.agentId;
  switchFn(session, nextAgentId);
  if (prev === 'planificar' && session.agentId === 'construir') {
    return handoffPlanificarToConstruir(session);
  }
  return { handoff: false, from: prev, to: session.agentId };
}

function buildSwitchReminder(plan) {
  const header = [
    'El usuario cambió de Planificar a Construir.',
    'Ejecuta el plan aprobado. No lo reescribas ni empieces de cero.',
    'Trabaja solo en el workspace de la sesión. No menciones proveedores ni ids de modelo.',
  ].join(' ');
  if (plan && plan.text) {
    return `${header}\n\nPlan aprobado:\n${plan.text}`;
  }
  return `${header} No hay un plan escrito; actúa sobre el último mensaje del usuario.`;
}

function publicPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const text = String(plan.text || '');
  return {
    status: plan.status || 'ready',
    stepCount: Number(plan.stepCount) || 0,
    capturedAt: plan.capturedAt || null,
    preview: text.slice(0, PLAN_PREVIEW_CHARS),
  };
}

function isTransientLlmError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 'aborted') {
    return false;
  }
  const status = Number(err.status || err.statusCode);
  if (status === 429 || status >= 500) return true;
  const blob = `${err.code || ''} ${err.message || ''}`;
  return /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket|fetch failed|429|502|503|504/i.test(blob);
}

module.exports = {
  PLAN_MAX_CHARS,
  PLAN_PREVIEW_CHARS,
  extractStepCount,
  looksLikePlan,
  capturePlanFromText,
  latestPlanificarAssistant,
  ensureCapturedPlan,
  handoffPlanificarToConstruir,
  applyAgentChange,
  buildSwitchReminder,
  publicPlan,
  isTransientLlmError,
};
