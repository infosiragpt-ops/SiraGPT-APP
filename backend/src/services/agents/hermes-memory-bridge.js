'use strict';

/**
 * Hermes memory bridge — JS port of hermes-agent/plugins/memory/*.
 * Unifies active-memory + session-manager with Hermes session_search semantics.
 */

const activeMemory = require('../active-memory');
const sessionManager = require('../session-manager');

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function scoreHaystack(haystack, terms) {
  if (terms.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score / terms.length;
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
  const entry = activeMemory.promoteToLongTerm(entryId);
  if (!entry || entry.userId !== userId) return null;
  return entry;
}

function buildMemoryPrompt(userId, opts = {}) {
  return activeMemory.buildMemoryPrompt(userId, opts);
}

function searchSessions(userId, query, opts = {}) {
  const terms = tokenize(query);
  const limit = opts.limit || 10;
  const sessions = sessionManager.listSessions(userId, { includeArchived: opts.includeArchived !== false });

  const hits = [];
  for (const session of sessions) {
    const history = sessionManager.getHistory(session.id, { limit: opts.historyLimit || 40 }) || [];
    for (const msg of history) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      const score = scoreHaystack(content.toLowerCase(), terms);
      if (score <= 0) continue;
      hits.push({
        sessionId: session.id,
        role: msg.role || 'unknown',
        score,
        excerpt: content.slice(0, 240),
        timestamp: msg.timestamp || msg.createdAt || null,
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
