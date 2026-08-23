'use strict';

/**
 * In-memory editor sessions + SSE events. Isolated from /chat state.
 * TTL matches signed download URLs (default 15 min).
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const sessions = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(200);

const STAGES = Object.freeze([
  'open', 'plan', 'edit', 'validate', 'render', 'done', 'error',
]);

function nowIso() {
  return new Date().toISOString();
}

function createSessionId() {
  return `dae_${crypto.randomBytes(12).toString('hex')}`;
}

function createSession({ userId, artifactId, filename, buffer, instructions } = {}) {
  const id = createSessionId();
  const session = {
    id,
    userId: userId || null,
    artifactId: artifactId || null,
    filename: filename || 'documento.docx',
    status: 'open',
    instructions: String(instructions || '').slice(0, 8000),
    events: [],
    buffer: Buffer.isBuffer(buffer) ? buffer : null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  sessions.set(id, session);
  appendEvent(id, 'open', { label: 'Artefacto abierto en el editor' });
  return session;
}

function getSession(id) {
  return sessions.get(String(id || '')) || null;
}

function appendEvent(sessionId, type, payload = {}) {
  const session = getSession(sessionId);
  if (!session) return null;
  const event = {
    type: STAGES.includes(type) ? type : type,
    sessionId,
    ts: nowIso(),
    ...payload,
  };
  session.events.push(event);
  session.updatedAt = event.ts;
  if (type === 'done') session.status = 'done';
  else if (type === 'error') session.status = 'error';
  else if (type !== 'open') session.status = 'running';
  bus.emit(`session:${sessionId}`, event);
  return event;
}

function setSessionBuffer(sessionId, buffer, filename) {
  const session = getSession(sessionId);
  if (!session) return null;
  if (Buffer.isBuffer(buffer)) session.buffer = buffer;
  if (filename) session.filename = filename;
  session.updatedAt = nowIso();
  return session;
}

function setSessionError(sessionId, message) {
  const session = getSession(sessionId);
  if (!session) return null;
  session.error = String(message || 'doc-artifact-editor failed').slice(0, 2000);
  session.status = 'error';
  session.updatedAt = nowIso();
  return session;
}

function subscribe(sessionId, fn) {
  const key = `session:${sessionId}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

function resetStore() {
  sessions.clear();
}

function listPublicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    userId: session.userId,
    artifactId: session.artifactId,
    filename: session.filename,
    status: session.status,
    instructions: session.instructions,
    events: session.events,
    error: session.error,
    hasBuffer: Boolean(session.buffer && session.buffer.length),
    sizeBytes: session.buffer ? session.buffer.length : 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

module.exports = {
  STAGES,
  createSession,
  getSession,
  appendEvent,
  setSessionBuffer,
  setSessionError,
  subscribe,
  resetStore,
  listPublicSession,
};
