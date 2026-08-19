'use strict';

/**
 * cross-chat-intent-similarity.js
 *
 * Finds the top-K most similar prior chats by intent + concept profile
 * for a given target chat. Complements the existing cross-chat retrieval
 * (which uses embeddings) with an attribution-derived ranking that
 * surfaces chats with the same *kind* of intent, not just textual
 * similarity.
 *
 * Each chat is summarised once into a compact "profile":
 *   {
 *     chatId,
 *     intents:   Set<canonicalAction>           — e.g. {'fix','deploy'}
 *     supernodes: Set<canonicalConcept>          — e.g. {'ui','backend'}
 *     entityKinds: Set<string>                  — e.g. {'entity.file','entity.named'}
 *     turnCount, lastTouched
 *   }
 *
 * In-memory index keyed by chatId. Profiles auto-refresh on observe();
 * eviction by recency when MAX_PROFILES is exceeded.
 *
 * Similarity = weighted jaccard of intents (0.5), supernodes (0.35),
 * entityKinds (0.15).
 *
 * Pure heuristic, no LLM, no I/O.
 */

const conceptExtractor = require('./concept-extractor');
const conceptSim = require('./concept-similarity');

const MAX_PROFILES = Number.parseInt(process.env.SIRAGPT_CROSS_CHAT_SIM_MAX || '500', 10);
const PROFILE_TTL_MS = Number.parseInt(process.env.SIRAGPT_CROSS_CHAT_SIM_TTL_MS || `${7 * 24 * 60 * 60 * 1000}`, 10);

const PROFILES = new Map(); // chatId -> profile

function safeText(v) { return String(v == null ? '' : v).slice(0, 6000); }

function buildProfileFromHistory(chatId, history = []) {
  const intents = new Set();
  const supernodes = new Set();
  const entityKinds = new Set();
  let turnCount = 0;
  for (const t of Array.isArray(history) ? history : []) {
    if ((t?.role || 'user') === 'assistant') continue;
    turnCount += 1;
    const { concepts } = conceptExtractor.extractConcepts(safeText(t?.content || t?.text || ''));
    for (const c of concepts) {
      if (c.type === 'action') intents.add(c.normalized);
      if (c.type === 'entity') {
        entityKinds.add(c.kind);
        const canon = conceptSim.canonical(c);
        if (canon) supernodes.add(canon);
      }
    }
  }
  return { chatId, intents, supernodes, entityKinds, turnCount, lastTouched: Date.now() };
}

function observe({ chatId, history = [] } = {}) {
  if (!chatId) return null;
  const profile = buildProfileFromHistory(chatId, history);
  PROFILES.set(chatId, profile);
  if (PROFILES.size > MAX_PROFILES) evictOldest();
  return profile;
}

function evictOldest() {
  const sorted = [...PROFILES.values()].sort((a, b) => a.lastTouched - b.lastTouched);
  const toRemove = sorted.slice(0, PROFILES.size - MAX_PROFILES);
  for (const p of toRemove) PROFILES.delete(p.chatId);
}

function expireStale() {
  const cutoff = Date.now() - PROFILE_TTL_MS;
  let evicted = 0;
  for (const [k, p] of PROFILES) {
    if (p.lastTouched < cutoff) { PROFILES.delete(k); evicted += 1; }
  }
  return { evicted };
}

function jaccardSet(a, b) {
  if (!a.size && !b.size) return 0;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  if (!inter) return 0;
  return inter / (a.size + b.size - inter);
}

function profileSimilarity(p1, p2) {
  if (!p1 || !p2) return 0;
  const intentSim = jaccardSet(p1.intents, p2.intents);
  const supernodeSim = jaccardSet(p1.supernodes, p2.supernodes);
  const entitySim = jaccardSet(p1.entityKinds, p2.entityKinds);
  return Number((0.5 * intentSim + 0.35 * supernodeSim + 0.15 * entitySim).toFixed(3));
}

function similar({ chatId, history = [], k = 5, excludeSelf = true } = {}) {
  const target = history && history.length ? buildProfileFromHistory(chatId || '__target__', history) : PROFILES.get(chatId);
  if (!target) return [];
  const scored = [];
  for (const candidate of PROFILES.values()) {
    if (excludeSelf && candidate.chatId === chatId) continue;
    const score = profileSimilarity(target, candidate);
    if (score <= 0) continue;
    scored.push({
      chatId: candidate.chatId,
      score,
      sharedIntents: [...candidate.intents].filter((i) => target.intents.has(i)).slice(0, 6),
      sharedSupernodes: [...candidate.supernodes].filter((s) => target.supernodes.has(s)).slice(0, 6),
      turnCount: candidate.turnCount,
      lastTouched: candidate.lastTouched,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(50, Number(k) || 5)));
}

function listProfiles({ limit = 20 } = {}) {
  return [...PROFILES.values()]
    .sort((a, b) => b.lastTouched - a.lastTouched)
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 20)))
    .map((p) => ({
      chatId: p.chatId,
      intents: [...p.intents],
      supernodes: [...p.supernodes],
      entityKinds: [...p.entityKinds],
      turnCount: p.turnCount,
      lastTouched: p.lastTouched,
    }));
}

function reset({ chatId } = {}) {
  if (!chatId) { const n = PROFILES.size; PROFILES.clear(); return { cleared: n }; }
  return { cleared: PROFILES.delete(chatId) ? 1 : 0 };
}

function _reset() { PROFILES.clear(); }

function buildSimilarChatsBlock(similar) {
  if (!similar || !similar.length) return '';
  const lines = ['## SIMILAR PRIOR CHATS'];
  for (const s of similar) {
    const sharedI = s.sharedIntents.length ? ` intents:[${s.sharedIntents.join(',')}]` : '';
    const sharedS = s.sharedSupernodes.length ? ` topics:[${s.sharedSupernodes.join(',')}]` : '';
    lines.push(`- ${s.chatId} (sim=${s.score}, ${s.turnCount} turns)${sharedI}${sharedS}`);
  }
  return lines.join('\n');
}

module.exports = {
  observe,
  similar,
  listProfiles,
  reset,
  _reset,
  expireStale,
  profileSimilarity,
  buildProfileFromHistory,
  buildSimilarChatsBlock,
  MAX_PROFILES,
  PROFILE_TTL_MS,
};
