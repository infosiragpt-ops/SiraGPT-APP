'use strict';

/**
 * Hermes memory bridge — JS port of hermes-agent/plugins/memory/*.
 * Unifies active-memory + session-manager with Hermes session_search semantics.
 */

const activeMemory = require('../active-memory');
const sessionManager = require('../session-manager');

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenize(text) {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function scoreHaystack(haystack, terms) {
  if (terms.length === 0) return 0;
  const normalized = normalizeText(haystack);
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += 1;
  }
  return score / terms.length;
}

function serializeMessage(msg, idx, anchorId = null) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content || '');
  return {
    id: msg.id || `msg_${idx}`,
    role: msg.role || 'unknown',
    content,
    timestamp: msg.timestamp || msg.createdAt || null,
    metadata: msg.metadata || {},
    anchor: anchorId ? (msg.id || `msg_${idx}`) === anchorId : false,
  };
}

function sliceBookend(history, fromEnd = false, count = 3) {
  const conversational = history
    .map((msg, idx) => serializeMessage(msg, idx))
    .filter((msg) => msg.role === 'user' || msg.role === 'assistant');
  return fromEnd ? conversational.slice(-count) : conversational.slice(0, count);
}

function remember(userId, fact, opts = {}) {
  return activeMemory.createMemoryEntry(userId, fact, {
    source: opts.source || 'hermes-memory-bridge',
    category: opts.category || 'general',
    tags: opts.tags || ['hermes'],
    confidence: opts.confidence ?? 0.75,
  });
}

function recall(userId, query, opts = {}) {
  return activeMemory.recall(userId, query, {
    limit: opts.limit || 8,
  });
}

function promote(userId, entryId) {
  // Pass userId so ownership is enforced BEFORE the entry is mutated (the
  // post-hoc check below alone still promoted a foreign entry first).
  const entry = activeMemory.promoteToLongTerm(entryId, { userId });
  if (!entry || entry.userId !== userId) return null;
  return entry;
}

function buildMemoryPrompt(userId, opts = {}) {
  return activeMemory.buildMemoryPrompt(userId, opts);
}

function searchSessions(userId, query, opts = {}) {
  const terms = tokenize(query);
  const limit = Math.min(opts.limit || 10, 25);
  const windowSize = Math.max(0, Math.min(opts.window ?? 5, 20));
  const bookendSize = Math.max(0, Math.min(opts.bookendSize ?? 3, 10));
  const historyLimit = Math.min(opts.historyLimit || 200, 500);
  const roleFilter = opts.roleFilter
    ? new Set(String(opts.roleFilter).split(',').map((r) => r.trim()).filter(Boolean))
    : null;
  const sessions = sessionManager.listSessions(userId, { includeArchived: opts.includeArchived !== false, limit: 50 });

  const hits = [];
  for (const session of sessions) {
    const history = sessionManager.getHistory(session.id, { limit: historyLimit }) || [];
    // The session bookends and title are identical for every match in this
    // session — compute them once instead of re-deriving per matching message
    // (was O(matches × historyLen) of redundant history.map/filter work).
    const bookendStart = sliceBookend(history, false, bookendSize);
    const bookendEnd = sliceBookend(history, true, bookendSize);
    const sessionTitle = session.label || session.summary || session.id;
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (roleFilter && !roleFilter.has(msg.role || 'unknown')) continue;
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      const score = scoreHaystack(content, terms);
      if (score <= 0) continue;

      const anchorId = msg.id || `msg_${i}`;
      const start = Math.max(0, i - windowSize);
      const end = Math.min(history.length, i + windowSize + 1);
      const excerpt = content.slice(0, 240);
      hits.push({
        sessionId: session.id,
        title: sessionTitle,
        label: session.label || null,
        role: msg.role || 'unknown',
        score,
        excerpt,
        snippet: excerpt,
        timestamp: msg.timestamp || msg.createdAt || session.lastActivity || null,
        matchMessageId: anchorId,
        messagesBefore: i,
        messagesAfter: Math.max(0, history.length - i - 1),
        bookendStart,
        messages: history.slice(start, end).map((candidate, idx) => serializeMessage(candidate, start + idx, anchorId)),
        bookendEnd,
        matchedTerms: terms.filter((term) => normalizeText(content).includes(term)),
      });
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
}

function nudgePromotion(userId) {
  return activeMemory.autoPromote(userId);
}

function listEntries(userId) {
  return activeMemory.recall(userId, null, { limit: 50 });
}

function status(userId = null) {
  const base = {
    providers: ['active-memory', 'session-manager'],
    promotionThreshold: Number.parseInt(process.env.SIRAGPT_MEMORY_PROMOTION_THRESHOLD || '3', 10),
  };
  if (!userId) return base;
  return {
    ...base,
    memoryEntries: listEntries(userId).length,
    sessions: sessionManager.listSessions(userId).length,
  };
}

module.exports = {
  remember,
  recall,
  promote,
  buildMemoryPrompt,
  searchSessions,
  nudgePromotion,
  listEntries,
  status,
};
