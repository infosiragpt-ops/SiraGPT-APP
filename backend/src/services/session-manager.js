'use strict';

const crypto = require('crypto');

const MAX_ACTIVE_SESSIONS = Number.parseInt(process.env.SIRAGPT_MAX_ACTIVE_SESSIONS || '50', 10);
const MAX_HISTORY_MESSAGES = Number.parseInt(process.env.SIRAGPT_SESSION_MAX_HISTORY || '200', 10);
const SESSION_TTL_MS = Number.parseInt(process.env.SIRAGPT_SESSION_TTL_MS || `${24 * 60 * 60 * 1000}`, 10);
const SESSION_CLEANUP_INTERVAL_MS = Number.parseInt(process.env.SIRAGPT_SESSION_CLEANUP_INTERVAL || `${5 * 60 * 1000}`, 10);

const sessions = new Map();

let cleanupTimer = null;

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(id);
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function createSession(userId, opts = {}) {
  const id = opts.id || `sess_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();

  const userSessions = [...sessions.values()].filter(s => s.userId === userId);
  if (userSessions.length >= MAX_ACTIVE_SESSIONS) {
    const oldest = userSessions.sort((a, b) => a.lastActivity - b.lastActivity)[0];
    sessions.delete(oldest.id);
  }

  const session = {
    id,
    userId,
    label: opts.label || `Session ${userSessions.length + 1}`,
    model: opts.model || null,
    provider: opts.provider || null,
    createdAt: now,
    lastActivity: now,
    messages: [],
    summary: null,
    metadata: opts.metadata || {},
    parentId: opts.parentId || null,
    tags: opts.tags || [],
    tokenCount: 0,
  };

  sessions.set(id, session);
  return session;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function listSessions(userId, opts = {}) {
  const limit = Math.min(opts.limit || 20, MAX_ACTIVE_SESSIONS);
  let userSessions = [...sessions.values()]
    .filter(s => s.userId === userId);

  if (opts.tag) {
    userSessions = userSessions.filter(s => s.tags.includes(opts.tag));
  }

  return userSessions
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, limit)
    .map(s => ({
      id: s.id,
      label: s.label,
      model: s.model,
      messageCount: s.messages.length,
      tokenCount: s.tokenCount,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      tags: s.tags,
      summary: s.summary,
    }));
}

function addMessage(sessionId, message) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const msg = {
    id: `msg_${crypto.randomBytes(4).toString('hex')}`,
    role: message.role || 'user',
    content: message.content || '',
    timestamp: Date.now(),
    metadata: message.metadata || {},
    tokens: message.tokens || 0,
  };

  session.messages.push(msg);
  session.lastActivity = Date.now();
  session.tokenCount += msg.tokens;

  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    const dropped = session.messages.length - MAX_HISTORY_MESSAGES;
    session.messages = session.messages.slice(dropped);
  }

  return msg;
}

function getHistory(sessionId, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session) return [];

  let messages = session.messages;

  if (opts.after) {
    const idx = messages.findIndex(m => m.id === opts.after);
    if (idx >= 0) messages = messages.slice(idx + 1);
  }

  if (opts.limit) {
    messages = messages.slice(-opts.limit);
  }

  if (opts.role) {
    messages = messages.filter(m => m.role === opts.role);
  }

  return messages;
}

function sendToSession(sourceSessionId, targetSessionId, message) {
  const source = sessions.get(sourceSessionId);
  const target = sessions.get(targetSessionId);
  if (!source || !target) return null;

  const msg = addMessage(targetSessionId, {
    role: message.role || 'user',
    content: message.content,
    metadata: {
      ...message.metadata,
      forwardedFrom: sourceSessionId,
      forwardedAt: new Date().toISOString(),
    },
    tokens: message.tokens || 0,
  });

  return msg;
}

function spawnSession(parentSessionId, userId, opts = {}) {
  const parent = sessions.get(parentSessionId);
  if (!parent) return null;

  const child = createSession(userId, {
    ...opts,
    parentId: parentSessionId,
    model: opts.model || parent.model,
    provider: opts.provider || parent.provider,
    metadata: {
      ...opts.metadata,
      spawnedFrom: parentSessionId,
    },
  });

  const recentMessages = parent.messages.slice(-4);
  for (const msg of recentMessages) {
    addMessage(child.id, {
      role: msg.role,
      content: msg.content,
      metadata: { inherited: true },
      tokens: msg.tokens,
    });
  }

  return child;
}

async function compactSession(sessionId, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const total = session.messages.length;

  if (opts.model && total > 2) {
    try {
      const { compactContext } = require('./sira/context-compactor');
      const messages = session.messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
      }));
      const result = await compactContext({
        messages,
        model: opts.model,
        ragChunks: [],
        memoryGists: [],
      });
      if (result && Array.isArray(result.messages)) {
        const kept = result.messages;
        const dropped = total - kept.length;
        session.messages = session.messages.filter((m, i) => {
          if (i < 2 || i >= total - 6) return true;
          return kept.some(km => (km.content || '').slice(0, 80) === (m.content || '').slice(0, 80));
        });
        if (opts.summary) session.summary = opts.summary;
        return {
          compacted: true,
          keptMessages: session.messages.length,
          droppedMessages: dropped,
          newTokenEstimate: result.stats?.total_tokens || 0,
          pipeline: 'context-compactor',
        };
      }
    } catch (_e) { /* fallback to naive trim */ }
  }

  const keepFirst = opts.keepFirst || 2;
  const keepLast = opts.keepLast || 6;

  if (total <= keepFirst + keepLast) {
    return { compacted: false, reason: 'session_too_short' };
  }

  const kept = [
    ...session.messages.slice(0, keepFirst),
    ...session.messages.slice(-keepLast),
  ];

  const dropped = total - kept.length;

  session.messages = kept;
  if (opts.summary) {
    session.summary = opts.summary;
  }

  return {
    compacted: true,
    keptMessages: kept.length,
    droppedMessages: dropped,
    newTokenEstimate: kept.reduce((acc, m) => acc + (m.tokens || 0), 0),
    pipeline: 'naive-trim',
  };
}

function archiveSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const archived = {
    ...session,
    archivedAt: Date.now(),
  };

  sessions.delete(sessionId);
  return archived;
}

function getSessionStats(userId) {
  const userSessions = [...sessions.values()].filter(s => s.userId === userId);
  return {
    activeSessions: userSessions.length,
    totalMessages: userSessions.reduce((acc, s) => acc + s.messages.length, 0),
    totalTokens: userSessions.reduce((acc, s) => acc + s.tokenCount, 0),
    oldestSession: userSessions.length > 0
      ? Math.min(...userSessions.map(s => s.createdAt))
      : null,
    newestSession: userSessions.length > 0
      ? Math.max(...userSessions.map(s => s.createdAt))
      : null,
  };
}

function resetSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  session.messages = [];
  session.summary = null;
  session.tokenCount = 0;
  session.lastActivity = Date.now();

  return { id: session.id, reset: true };
}

startCleanup();

module.exports = {
  createSession,
  getSession,
  listSessions,
  addMessage,
  getHistory,
  sendToSession,
  spawnSession,
  compactSession,
  archiveSession,
  resetSession,
  getSessionStats,
  startCleanup,
  stopCleanup,
  MAX_ACTIVE_SESSIONS,
  MAX_HISTORY_MESSAGES,
};
