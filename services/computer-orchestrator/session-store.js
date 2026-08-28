'use strict';

/**
 * In-memory session index keyed by orchestrator userId.
 * Backend already suffixes member+conversation (see member-key.js);
 * we reuse one desktop per that key and never spawn extras per click.
 */

function slugUserId(userId, fallback = 'member') {
  const slug = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return slug || fallback;
}

function sessionIdFor(userId) {
  return 'ac_' + slugUserId(userId);
}

function containerNameFor(userId) {
  return 'sira-ac-user-' + slugUserId(userId);
}

function createSessionStore() {
  const byUser = new Map();
  const byId = new Map();

  function put(session) {
    byUser.set(String(session.userId), session);
    byId.set(String(session.sessionId), session);
    return session;
  }

  function getByUser(userId) {
    return byUser.get(slugUserId(userId)) || byUser.get(String(userId || '')) || null;
  }

  function getById(sessionId) {
    return byId.get(String(sessionId || '')) || null;
  }

  function list() {
    return [...byId.values()];
  }

  function size() {
    return byId.size;
  }

  function clear() {
    byUser.clear();
    byId.clear();
  }

  return { put, getByUser, getById, list, size, clear };
}

module.exports = {
  slugUserId,
  sessionIdFor,
  containerNameFor,
  createSessionStore,
};
