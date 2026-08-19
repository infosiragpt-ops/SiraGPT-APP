'use strict';

/**
 * cross-chat-hybrid-ranker.js
 *
 * Combines the existing embedding-based cross-chat-retrieval with the
 * intent-profile-based cross-chat-intent-similarity into a single hybrid
 * ranker. The hybrid score is:
 *
 *   final = (1 - w) * cosineSimilarity + w * intentProfileScore
 *
 * Default w = 0.35 — embeddings still dominate (they have richer
 * semantics), but intent-profile alignment adds a meaningful boost for
 * "this chat is about the same kind of work as that one".
 *
 * The module does NOT replace cross-chat-retrieval. Callers can opt in:
 *
 *   const candidates = await retrieval.recallSimilarTurns({...});
 *   const ranked = hybridRanker.rerank({ currentChatId, candidates });
 *
 * No I/O, no LLM. Reuses already-collected intent profiles from the
 * cross-chat-intent-similarity module (which observe()s every chat in
 * the AI route hot-path).
 */

const crossChatSim = require('./cross-chat-intent-similarity');

const DEFAULT_WEIGHT = 0.35;

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function rerank({
  currentChatId = null,
  candidates = [],
  weight = DEFAULT_WEIGHT,
} = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const w = clamp01(Number(weight) || DEFAULT_WEIGHT);

  // Collect intent profile of the current chat (if observed).
  const currentProfile = currentChatId ? (crossChatSim.listProfiles({ limit: 200 }).find((p) => p.chatId === currentChatId) || null) : null;

  const scored = candidates.map((c, idx) => {
    const cosine = clamp01(Number(c.similarity) || 0);
    let intentScore = 0;
    if (currentProfile && c.chatId) {
      const otherProfile = crossChatSim.listProfiles({ limit: 200 }).find((p) => p.chatId === c.chatId);
      if (otherProfile) {
        intentScore = clamp01(crossChatSim.profileSimilarity(
          { intents: new Set(currentProfile.intents), supernodes: new Set(currentProfile.supernodes), entityKinds: new Set(currentProfile.entityKinds) },
          { intents: new Set(otherProfile.intents), supernodes: new Set(otherProfile.supernodes), entityKinds: new Set(otherProfile.entityKinds) },
        ));
      }
    }
    const combined = (1 - w) * cosine + w * intentScore;
    return {
      ...c,
      originalIndex: idx,
      cosineScore: Number(cosine.toFixed(3)),
      intentScore: Number(intentScore.toFixed(3)),
      combinedScore: Number(combined.toFixed(3)),
    };
  });

  scored.sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) return b.combinedScore - a.combinedScore;
    // Tiebreak by cosine then original order.
    if (b.cosineScore !== a.cosineScore) return b.cosineScore - a.cosineScore;
    return a.originalIndex - b.originalIndex;
  });

  return scored;
}

function buildHybridBlock(ranked, opts = {}) {
  if (!ranked || !ranked.length) return '';
  const cap = Math.max(1, Number(opts.max) || 4);
  const lines = ['## HYBRID CROSS-CHAT RANK'];
  for (const r of ranked.slice(0, cap)) {
    const q = String(r.question || '').slice(0, 100);
    lines.push(`- [combined=${r.combinedScore} cosine=${r.cosineScore} intent=${r.intentScore}] ${q}`);
  }
  return lines.join('\n');
}

module.exports = {
  rerank,
  buildHybridBlock,
  DEFAULT_WEIGHT,
};
