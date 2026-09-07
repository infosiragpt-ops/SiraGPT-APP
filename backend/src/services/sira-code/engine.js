'use strict';

/**
 * SiraCode native engine — public API used by /api/opencode.
 *
 * Client/server session + prompt loop rewritten in this repo's style.
 * OPENCODE_SERVER_URL is ignored unless SIRAGPT_OPENCODE_SIDECAR=1
 * (fail-closed, off by default, unused in Phase 1).
 */

const { listPublicAgents, getAgent, resolveAgentId } = require('./agents');
const { canWrite } = require('./permissions');
const { executeTool } = require('./tools');
const { formatSse, subscribe, replay, appendEvent, stageEvent } = require('./events');
const {
  createSession,
  requireOwnedSession,
  switchAgent: switchStoredAgent,
  abortSession,
  publicSession,
  _resetForTests,
} = require('./session-store');
const { runPrompt, shouldStartSiraCodeRun } = require('./loop');
const { publicModelLabel, sanitizePublicObject } = require('./display');
const { applyAgentChange, publicPlan } = require('./plan-handoff');
const {
  resolveSessionPermission,
  publicResolvePayload,
} = require('./permission-resume');

function sidecarRequested(env = process.env) {
  return ['1', 'true', 'on', 'yes'].includes(String(env.SIRAGPT_OPENCODE_SIDECAR || '').trim().toLowerCase());
}

function health(env = process.env) {
  return {
    ok: true,
    configured: true,
    native: true,
    engine: 'sira-code',
    sidecar: false,
    sidecarRequested: sidecarRequested(env),
    baseUrl: null,
    agents: listPublicAgents(),
  };
}

async function create(opts = {}) {
  const session = await createSession(opts);
  appendEvent(session, 'session', { agent: session.agentId, label: getAgent(session.agentId).label });
  return publicSession(session);
}

function get(id, userId) {
  return publicSession(requireOwnedSession(id, userId));
}

function emitAgentSwitch(session, nextAgentId) {
  const change = applyAgentChange(session, nextAgentId, switchStoredAgent);
  appendEvent(session, 'agent', {
    agent: session.agentId,
    label: getAgent(session.agentId).label,
  });
  if (change.handoff) {
    stageEvent(session, 'planReady', {
      label: 'Plan listo',
      from: change.from,
      to: change.to,
    });
    appendEvent(session, 'handoff', {
      from: change.from,
      to: change.to,
      plan: publicPlan(session.plan),
    });
  }
  return change;
}

function switchAgent(id, agentId, userId) {
  const session = requireOwnedSession(id, userId);
  emitAgentSwitch(session, agentId);
  return publicSession(session);
}

async function prompt(id, text, opts = {}) {
  const session = requireOwnedSession(id, opts.userId);
  if (opts.agent) emitAgentSwitch(session, opts.agent);
  if (opts.permission != null) session.permission = opts.permission;
  const result = await runPrompt(session, text, {
    llmTurn: opts.llmTurn,
    model: opts.model,
    maxSteps: opts.maxSteps,
    signal: opts.signal,
    chip: opts.chip,
    attachments: opts.attachments,
    permission: opts.permission != null ? opts.permission : session.permission,
  });
  return sanitizePublicObject({
    ...result,
    session: publicSession(session),
    modelLabel: publicModelLabel(session.model),
  });
}

function abort(id, userId) {
  const session = requireOwnedSession(id, userId);
  abortSession(session);
  stageEvent(session, 'cancelled', { label: 'Cancelado' });
  return { ok: true, session: publicSession(session) };
}

async function readFile(id, relPath, userId) {
  const session = requireOwnedSession(id, userId);
  const result = await executeTool(session, 'read', { path: relPath });
  if (!result.ok) {
    const err = new Error(result.error || 'read failed');
    err.code = result.code;
    err.status = 400;
    throw err;
  }
  return { path: relPath, content: result.content };
}

async function listFiles(id, userId) {
  const session = requireOwnedSession(id, userId);
  const files = await session.workspace.listFiles('.');
  return { files };
}

async function resolvePermission(id, permissionId, decision, userId) {
  const session = requireOwnedSession(id, userId);
  const payload = await resolveSessionPermission(session, permissionId, decision);
  return publicResolvePayload(payload, session);
}

function streamEvents(res, { sessionId, userId, lastEventId } = {}) {
  let session = null;
  if (sessionId) {
    session = requireOwnedSession(sessionId, userId);
    for (const event of replay(session, { afterId: lastEventId })) {
      res.write(formatSse(event));
    }
  }
  return subscribe((event) => {
    if (userId && session && session.userId && event.sessionId === session.id && session.userId !== String(userId)) {
      return;
    }
    if (sessionId && event.sessionId !== sessionId) return;
    res.write(formatSse(event));
  }, { sessionId });
}

function agentCanWrite(agentId) {
  return canWrite(resolveAgentId(agentId, { allowInternal: false }));
}

module.exports = {
  health,
  create,
  get,
  switchAgent,
  emitAgentSwitch,
  prompt,
  abort,
  readFile,
  listFiles,
  resolvePermission,
  streamEvents,
  agentCanWrite,
  sidecarRequested,
  shouldStartSiraCodeRun,
  _resetForTests,
};
