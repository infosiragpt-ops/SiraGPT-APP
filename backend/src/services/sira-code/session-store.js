'use strict';

/**
 * In-memory, user-scoped SiraCode sessions.
 *
 * Messages are event-sourced: every user prompt, tool call, permission
 * and assistant part is appended. Sessions never leak across users.
 */

const crypto = require('crypto');
const { DEFAULT_AGENT_ID, resolveAgentId, getAgent } = require('./agents');
const { createWorkspace } = require('./workspace');

const sessions = new Map();
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function publicSession(session) {
  const agent = getAgent(session.agentId);
  return {
    id: session.id,
    agent: agent.id,
    agentLabel: agent.label,
    userId: session.userId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

async function createSession({
  userId,
  agent = DEFAULT_AGENT_ID,
  model = '',
  title = '',
} = {}) {
  const id = newId('sc');
  const agentId = resolveAgentId(agent, { allowInternal: false });
  const workspace = await createWorkspace(id);
  const now = Date.now();
  const session = {
    id,
    userId: String(userId || ''),
    agentId,
    model: String(model || ''),
    title: String(title || '').slice(0, 200),
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    messages: [],
    events: [],
    seq: 0,
    workspace,
    abort: null,
    pendingPermissions: new Map(),
    permission: 'default',
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  return sessions.get(String(id || '')) || null;
}

function requireOwnedSession(id, userId) {
  const session = getSession(id);
  if (!session) {
    const err = new Error('sesión no encontrada');
    err.code = 'session_not_found';
    err.status = 404;
    throw err;
  }
  if (userId && session.userId && session.userId !== String(userId)) {
    const err = new Error('sesión no encontrada');
    err.code = 'session_not_found';
    err.status = 404;
    throw err;
  }
  return session;
}

function switchAgent(session, agentId) {
  session.agentId = resolveAgentId(agentId, { allowInternal: false });
  session.updatedAt = Date.now();
  return session;
}

function appendMessage(session, message) {
  const row = {
    id: message.id || newId('msg'),
    role: message.role,
    content: message.content || '',
    parts: Array.isArray(message.parts) ? message.parts : [],
    agentId: session.agentId,
    ts: Date.now(),
  };
  session.messages.push(row);
  session.updatedAt = row.ts;
  return row;
}

function abortSession(session) {
  session.status = 'cancelled';
  session.updatedAt = Date.now();
  if (session.abort) {
    try { session.abort.abort(); } catch { /* already aborted */ }
  }
  return session;
}

function listUserSessions(userId) {
  const uid = String(userId || '');
  return [...sessions.values()]
    .filter((s) => !uid || s.userId === uid)
    .map(publicSession);
}

async function destroySession(session) {
  abortSession(session);
  sessions.delete(session.id);
  if (session.workspace && typeof session.workspace.destroy === 'function') {
    await session.workspace.destroy().catch(() => {});
  }
}

function sweepExpired(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const dead = [];
  for (const session of sessions.values()) {
    if (now - session.updatedAt > ttlMs) dead.push(session);
  }
  return Promise.all(dead.map((session) => destroySession(session)));
}

function _resetForTests() {
  sessions.clear();
}

module.exports = {
  sessions,
  createSession,
  getSession,
  requireOwnedSession,
  switchAgent,
  appendMessage,
  abortSession,
  listUserSessions,
  publicSession,
  destroySession,
  sweepExpired,
  _resetForTests,
};
