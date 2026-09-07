'use strict';

/**
 * Permission reply → execute for SiraCode sessions.
 *
 * Independent rewrite inspired by OpenCode's ask → once / always / reject
 * reply (anomalyco/opencode, MIT). Not a vendor copy. Approving an `ask`
 * tool actually runs it in the session workspace; `always` remembers the
 * grant for this session so later turns do not ask again.
 *
 * Deny stays deny: a reviewer cannot unlock a tool the agent forbids
 * (e.g. write in Planificar). Composer Solo lectura still blocks writes
 * and commands even after an allow.
 */

const { appendEvent, stageEvent } = require('./events');
const { appendMessage } = require('./session-store');
const { executeTool } = require('./tools');
const { authorizeTool, canonicalTool, WRITE_TOOLS } = require('./permissions');
const { publicModelLabel, sanitizePublicObject } = require('./display');

const DECISION_ALIASES = Object.freeze({
  allow: 'allow',
  once: 'allow',
  always: 'always',
  always_allow: 'always',
  always_allow_in_chat: 'always',
  deny: 'deny',
  reject: 'deny',
});

function normalizeDecision(decision) {
  const raw = String(decision || '').trim().toLowerCase();
  return DECISION_ALIASES[raw] || null;
}

function grantTool(session, toolName) {
  if (!session) return;
  if (!session.permissionGrants) session.permissionGrants = new Set();
  session.permissionGrants.add(canonicalTool(toolName));
}

function hasGrant(session, toolName) {
  if (!session || !session.permissionGrants) return false;
  return session.permissionGrants.has(canonicalTool(toolName));
}

function listPending(session) {
  if (!session || !session.pendingPermissions) return [];
  return [...session.pendingPermissions.entries()].map(([permissionId, pending]) => ({
    permissionId,
    tool: pending.tool,
    label: 'Esperando permiso',
  }));
}

function publicPending(session) {
  return listPending(session);
}

async function executeApproved(session, pending, { signal } = {}) {
  const name = pending.name || pending.tool;
  const args = pending.args || {};
  stageEvent(session, 'executing', {
    label: 'Ejecutando código',
    tool: pending.tool,
  });
  const result = await executeTool(session, name, args, {
    approved: true,
    permission: session.permission,
    signal: signal || (session.abort && session.abort.signal) || undefined,
  });
  appendEvent(session, 'tool_result', {
    tool: pending.tool,
    ok: result.ok,
    preview: String(result.content || result.error || '').slice(0, 240),
  });
  if (result.ok && WRITE_TOOLS.has(pending.tool)) {
    stageEvent(session, 'verifying', { label: 'Verificando resultado', tool: pending.tool });
  }
  appendMessage(session, {
    role: 'tool',
    content: result.content || result.error || '',
    parts: [{
      type: 'tool',
      tool: pending.tool,
      ok: result.ok,
      content: result.content || result.error || '',
    }],
  });
  return result;
}

async function resolveSessionPermission(session, permissionId, decision) {
  const pending = session.pendingPermissions.get(String(permissionId || ''));
  if (!pending) {
    const err = new Error('permiso no encontrado');
    err.code = 'permission_not_found';
    err.status = 404;
    throw err;
  }

  const normalized = normalizeDecision(decision);
  if (!normalized) {
    const err = new Error('decisión inválida');
    err.code = 'validation_failed';
    err.status = 400;
    throw err;
  }

  session.pendingPermissions.delete(String(permissionId));
  session.updatedAt = Date.now();

  if (normalized === 'deny') {
    appendEvent(session, 'permission_resolved', {
      permissionId,
      tool: pending.tool,
      decision: 'deny',
      label: 'Permiso denegado',
    });
    stageEvent(session, 'cancelled', { label: 'Permiso denegado', tool: pending.tool });
    return {
      ok: true,
      allowed: false,
      executed: false,
      remembered: false,
      tool: pending.tool,
      decision: 'deny',
    };
  }

  // A reviewer can only unlock `ask`. Agent `deny` and composer Solo lectura
  // stay closed even if the client sends allow/always.
  const auth = authorizeTool(session.agentId, pending.name || pending.tool, {
    permission: session.permission,
    approved: true,
    grants: session.permissionGrants,
  });
  if (auth.denied) {
    appendEvent(session, 'permission_resolved', {
      permissionId,
      tool: pending.tool,
      decision: 'deny',
      label: 'Permiso denegado',
    });
    stageEvent(session, 'cancelled', { label: 'Permiso denegado', tool: pending.tool });
    return {
      ok: true,
      allowed: false,
      executed: false,
      remembered: false,
      tool: pending.tool,
      decision: 'deny',
      code: auth.reason || 'permission_denied',
    };
  }

  if (normalized === 'always') {
    grantTool(session, pending.tool);
  }

  appendEvent(session, 'permission_resolved', {
    permissionId,
    tool: pending.tool,
    decision: normalized,
    label: 'Permiso concedido',
  });

  const result = await executeApproved(session, pending);
  return {
    ok: true,
    allowed: true,
    executed: true,
    remembered: normalized === 'always',
    tool: pending.tool,
    decision: normalized,
    result: {
      ok: result.ok,
      code: result.code || undefined,
      preview: String(result.content || result.error || '').slice(0, 240),
    },
  };
}

function publicResolvePayload(payload, session) {
  return sanitizePublicObject({
    ...payload,
    modelLabel: publicModelLabel(session && session.model),
    pendingPermissions: publicPending(session),
  });
}

module.exports = {
  DECISION_ALIASES,
  normalizeDecision,
  grantTool,
  hasGrant,
  listPending,
  publicPending,
  executeApproved,
  resolveSessionPermission,
  publicResolvePayload,
};
