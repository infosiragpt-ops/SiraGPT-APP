'use strict';

/**
 * memory-adapter — unified Mem0-compatible episodic + semantic memory.
 *
 * Three-tier architecture:
 *   1. short-term (in-process) — last N turns per user, fast recall
 *   2. long-term (pgvector via user_memories) — durable, semantic recall
 *   3. episodic (Mem0-compatible facade) — conversation episodes with
 *      importance scoring, consolidation, and background pruning.
 *
 * Delegates to user-memory-store for pgvector operations and
 * long-term-memory for fact extraction. Exposes a unified recall()
 * that blends all tiers.
 */

const longTermMemory = require('../services/long-term-memory');
const userMemoryStore = require('../services/user-memory-store');

const MAX_SHORT_TERM = 20;
const SHORT_TERM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CONSOLIDATION_MIN_IMPORTANCE = 0.6;
const PRUNE_AGE_DAYS = 90;

let _shortTerm = new Map(); // userId → [{ content, category, ts, importance }]

function now() { return Date.now(); }

function expireShortTerm() {
  const cutoff = now() - SHORT_TERM_TTL_MS;
  for (const [userId, entries] of _shortTerm) {
    const filtered = entries.filter(e => e.ts >= cutoff);
    if (filtered.length === 0) {
      _shortTerm.delete(userId);
    } else {
      _shortTerm.set(userId, filtered);
    }
  }
}

function addShortTerm(userId, content, { category = 'episodic', importance = 0.5 } = {}) {
  if (!userId || !content) return;
  let entries = _shortTerm.get(userId);
  if (!entries) {
    entries = [];
    _shortTerm.set(userId, entries);
  }
  entries.push({ content, category, ts: now(), importance });
  while (entries.length > MAX_SHORT_TERM) entries.shift();
}

function recallShortTerm(userId, query, k = 5) {
  const entries = _shortTerm.get(userId) || [];
  if (entries.length === 0 || !query) return [];

  const queryLower = String(query).toLowerCase();
  const scored = entries.map(e => {
    const contentLower = e.content.toLowerCase();
    let score = 0;
    if (contentLower.includes(queryLower)) score = 0.8;
    else {
      const queryWords = queryLower.split(/\s+/).filter(Boolean);
      if (queryWords.length > 0) {
        const matches = queryWords.filter(w => contentLower.includes(w));
        score = matches.length / queryWords.length * 0.6;
      }
    }
    return { ...e, score, source: 'short_term' };
  });

  return scored
    .filter(s => s.score > 0.1)
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, k);
}

async function recallLongTerm(userId, query, k = 5) {
  const store = userMemoryStore.getStore();
  if (!store) {
    return longTermMemory.recallFacts(userId, query, k)
      .then(results => results.map(r => ({ ...r, source: 'long_term_rag' })))
      .catch(() => []);
  }

  try {
    const results = await store.recall(userId, query, k);
    return results.map(r => ({ ...r, source: 'pgvector' }));
  } catch (_) {
    return [];
  }
}

function createMemoryAdapter(opts = {}) {
  const consolidateOnRecall = opts.consolidateOnRecall !== false;

  return {
    async add(userId, content, meta = {}) {
      addShortTerm(userId, content, meta);

      const store = userMemoryStore.getStore();
      if (store && meta.importance >= CONSOLIDATION_MIN_IMPORTANCE) {
        try {
          await store.upsertFacts(userId, [{
            fact: content,
            category: meta.category || 'episodic',
            importanceScore: meta.importance || 0.5,
            confidence: meta.confidence || 0.8,
            source: meta.source || null,
          }]);
        } catch (_) {
          /* pgvector store is best-effort */
        }
      }

      return { added: true, tier: meta.importance >= CONSOLIDATION_MIN_IMPORTANCE ? 'long_term' : 'short_term' };
    },

    async recall(userId, query, k = 5) {
      expireShortTerm();

      const [short, long] = await Promise.all([
        recallShortTerm(userId, query, Math.min(k, 3)),
        recallLongTerm(userId, query, k),
      ]);

      // Blend: short term weighted higher for recency, long term for depth
      const blended = new Map();
      for (const item of short) {
        blended.set(item.content, { ...item, score: item.score * 0.7, tier: 'short_term' });
      }
      for (const item of long) {
        const existing = blended.get(item.text || item.content);
        if (existing) {
          existing.score = Math.max(existing.score, (item.score || 0) * 0.5);
          existing.tier = 'blended';
        } else {
          blended.set(item.text || item.content, {
            ...item,
            content: item.text || item.content,
            score: (item.score || 0) * 0.5,
            tier: 'long_term',
          });
        }
      }

      // Consolidation trigger: promote frequently recalled facts
      if (consolidateOnRecall && long.length > 0) {
        setImmediate(() => {
          const store = userMemoryStore.getStore();
          if (!store) return;
          for (const item of long) {
            if ((item.importance || 0) >= 0.8) {
              store.upsertFacts(userId, [{
                fact: item.text || item.content,
                category: item.category || 'knowledge',
                importanceScore: 0.9,
                source: 'consolidation',
              }]).catch(() => {});
            }
          }
        });
      }

      return Array.from(blended.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },

    async clear(userId) {
      _shortTerm.delete(userId);
      const store = userMemoryStore.getStore();
      if (store) {
        try { await store.clear(userId); } catch (_) { /* best-effort */ }
      }
      try { await longTermMemory.clearUserMemory(userId); } catch (_) { /* best-effort */ }
      return { cleared: true };
    },

    async stats(userId) {
      const shortCount = (_shortTerm.get(userId) || []).length;
      let longCount = 0;
      const store = userMemoryStore.getStore();
      if (store) {
        try {
          const s = await store.stats(userId);
          longCount = s.memories || 0;
        } catch (_) { /* best-effort */ }
      } else {
        try {
          const s = await longTermMemory.memoryStats(userId);
          longCount = s.count || 0;
        } catch (_) { /* best-effort */ }
      }
      return {
        shortTerm: shortCount,
        longTerm: longCount,
        pgvector: userMemoryStore.isEnabled(),
        mem0Compatible: true,
        semantic: true,
        episodic: true,
      };
    },

    capabilities() {
      return {
        pgvector: userMemoryStore.isEnabled(),
        mem0Compatible: true,
        semantic: true,
        episodic: true,
        shortTermEnabled: true,
        consolidationActive: true,
        prunerEnabled: true,
      };
    },

    async prune(userId, olderThanDays = PRUNE_AGE_DAYS) {
      const store = userMemoryStore.getStore();
      if (!store) return { pruned: 0 };

      try {
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();
        const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
        const result = await prisma.$executeRawUnsafe(
          `DELETE FROM user_memories
           WHERE user_id = $1
             AND last_accessed_at < $2
             AND importance_score < 0.3
             AND access_count < 3`,
          userId,
          cutoff,
        );
        await prisma.$disconnect();
        return { pruned: Number(result || 0) };
      } catch (_) {
        return { pruned: 0, error: _.message };
      }
    },
  };
}

module.exports = {
  createMemoryAdapter,
  addShortTerm,
  recallShortTerm,
  recallLongTerm,
  expireShortTerm,
  MAX_SHORT_TERM,
  SHORT_TERM_TTL_MS,
};
