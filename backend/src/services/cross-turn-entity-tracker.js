'use strict';

/**
 * cross-turn-entity-tracker.js
 *
 * Per-user, per-chat in-memory entity registry that links surface mentions
 * across turns to a stable entity record. Solves the "el cliente / ese
 * archivo / aquel diagrama" problem: when the user says "ese archivo" in
 * turn 12, the tracker can resolve it to the file that was first introduced
 * in turn 4 (or in an attachment, or in a prior memory fact).
 *
 * Inspired by Anthropic's circuit-tracing finding that LLMs internally
 * carry a stable concept-level representation of entities across tokens
 * and even languages. We mirror that idea at the orchestration layer:
 * named entities, file paths, URLs, and key terms from each turn get
 * registered, deduplicated, and made queryable by future turns.
 *
 * No persistence: lives in-memory keyed by `${userId}:${chatId}`. Auto-
 * evicts least-recently-used entries to stay under MAX_ENTITIES_PER_CHAT.
 * Older chats expire after CHAT_TTL_MS of inactivity.
 *
 * Public API:
 *   register({userId, chatId, turnIndex, role, text})   → array of new/seen entity refs
 *   resolveReference({userId, chatId, surface})          → best-matching entity or null
 *   listEntities({userId, chatId, limit?})               → recent entities, recency-sorted
 *   forgetEntity({userId, chatId, entityId})             → removes entity
 *   resetChat({userId, chatId})                          → wipes chat registry
 *   stats()                                              → in-memory size snapshot
 */

const crypto = require('crypto');
const conceptExtractor = require('./concept-extractor');

const MAX_ENTITIES_PER_CHAT = Number.parseInt(process.env.SIRAGPT_ENTITY_TRACKER_MAX || '120', 10);
const CHAT_TTL_MS = Number.parseInt(process.env.SIRAGPT_ENTITY_TRACKER_TTL_MS || `${24 * 60 * 60 * 1000}`, 10);
const MAX_TEXT_PER_TURN = 6000;

const REGISTRY = new Map(); // key -> { entities: Map<id, entry>, lastTouched: number }

const REFERENCE_SURFACE_RE = /\b(?:el|la|los|las|aquel|aquella|aquellos|aquellas|ese|esa|esos|esas|este|esta|estos|estas|the|that|those|this|these)\s+([a-z][a-z0-9_-]{2,32})\b/gi;

function key(userId, chatId) {
  return `${String(userId || 'anon')}:${String(chatId || 'default')}`;
}

function getChatRegistry(userId, chatId, { createIfMissing = false } = {}) {
  const k = key(userId, chatId);
  let slot = REGISTRY.get(k);
  if (!slot && createIfMissing) {
    slot = { entities: new Map(), lastTouched: Date.now() };
    REGISTRY.set(k, slot);
  }
  if (slot) slot.lastTouched = Date.now();
  return slot;
}

function entityId(type, normalized) {
  return crypto.createHash('sha1').update(`${type}|${normalized}`).digest('hex').slice(0, 12);
}

function safeText(s) { return String(s == null ? '' : s).slice(0, MAX_TEXT_PER_TURN); }

// ── Extraction ─────────────────────────────────────────────────────────────

function extractEntitiesFromText(text) {
  const safe = safeText(text);
  if (!safe.trim()) return [];
  const out = [];
  const seen = new Set();
  const { concepts } = conceptExtractor.extractConcepts(safe);
  for (const c of concepts) {
    if (c.type !== 'entity') continue;
    const normalized = c.normalized || c.surface;
    const id = entityId(c.kind, normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: c.kind,
      surface: c.surface,
      normalized,
      weight: c.weight,
    });
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

function register({ userId, chatId, turnIndex = 0, role = 'user', text = '' } = {}) {
  const slot = getChatRegistry(userId, chatId, { createIfMissing: true });
  const extracted = extractEntitiesFromText(text);
  const now = Date.now();
  const newOrUpdated = [];
  for (const e of extracted) {
    const prev = slot.entities.get(e.id);
    if (prev) {
      prev.lastMentionedAt = now;
      prev.mentions += 1;
      prev.lastTurnIndex = turnIndex;
      prev.lastSurface = e.surface;
      prev.aliases.add(String(e.surface).toLowerCase());
      newOrUpdated.push({ ...prev, isNew: false });
    } else {
      const entry = {
        id: e.id,
        kind: e.kind,
        normalized: e.normalized,
        canonicalSurface: e.surface,
        lastSurface: e.surface,
        aliases: new Set([String(e.surface).toLowerCase()]),
        firstSeenTurn: turnIndex,
        lastTurnIndex: turnIndex,
        firstSeenAt: now,
        lastMentionedAt: now,
        mentions: 1,
        introducedBy: role,
        weight: e.weight,
      };
      slot.entities.set(e.id, entry);
      newOrUpdated.push({ ...entry, isNew: true });
    }
  }
  evictIfTooMany(slot);
  return newOrUpdated;
}

function evictIfTooMany(slot) {
  if (slot.entities.size <= MAX_ENTITIES_PER_CHAT) return;
  const sorted = [...slot.entities.values()].sort((a, b) => a.lastMentionedAt - b.lastMentionedAt);
  const toEvict = sorted.slice(0, slot.entities.size - MAX_ENTITIES_PER_CHAT);
  for (const e of toEvict) slot.entities.delete(e.id);
}

function resolveReference({ userId, chatId, surface = '' } = {}) {
  const slot = getChatRegistry(userId, chatId);
  if (!slot) return null;
  const safe = String(surface || '').toLowerCase().trim();
  if (!safe) return null;

  // 1. Direct alias match.
  for (const e of slot.entities.values()) {
    if (e.aliases.has(safe)) {
      return scoreCandidate(e, 1.0);
    }
  }

  // 2. Token overlap.
  const tokens = new Set(safe.split(/\s+/).filter((t) => t.length >= 3));
  if (!tokens.size) return null;
  let best = null;
  for (const e of slot.entities.values()) {
    const aliasTokens = new Set([...e.aliases].flatMap((a) => a.split(/\s+/)));
    let overlap = 0;
    for (const t of tokens) if (aliasTokens.has(t)) overlap++;
    if (!overlap) continue;
    const score = overlap / Math.max(1, tokens.size);
    if (!best || score > best.score) best = scoreCandidate(e, score);
  }

  // 3. Fallback: most recent entity of matching kind hint.
  if (!best) {
    const kindHint = guessKindFromSurface(safe);
    if (kindHint) {
      const candidates = [...slot.entities.values()]
        .filter((e) => e.kind === kindHint)
        .sort((a, b) => b.lastMentionedAt - a.lastMentionedAt);
      if (candidates[0]) best = scoreCandidate(candidates[0], 0.4);
    }
  }

  return best;
}

function guessKindFromSurface(s) {
  if (/\b(archivo|file|fichero|documento|document|pdf)\b/.test(s)) return 'entity.file';
  if (/\b(c[oó]digo|code|funci[oó]n|function|m[oó]dulo|module)\b/.test(s)) return 'entity.code';
  if (/\b(repo|repositorio|branch|rama|commit|pr)\b/.test(s)) return 'entity.repo';
  if (/\b(cliente|client|customer|usuario|user)\b/.test(s)) return 'entity.business';
  if (/\b(api|endpoint|ruta|route|servicio|service)\b/.test(s)) return 'entity.backend';
  if (/\b(ui|interfaz|componente|component|frontend)\b/.test(s)) return 'entity.ui';
  return null;
}

function scoreCandidate(entry, score) {
  return {
    id: entry.id,
    kind: entry.kind,
    canonicalSurface: entry.canonicalSurface,
    aliases: [...entry.aliases],
    mentions: entry.mentions,
    firstSeenTurn: entry.firstSeenTurn,
    lastTurnIndex: entry.lastTurnIndex,
    score: Math.max(0, Math.min(1, score)),
  };
}

function listEntities({ userId, chatId, limit = 25 } = {}) {
  const slot = getChatRegistry(userId, chatId);
  if (!slot) return [];
  return [...slot.entities.values()]
    .sort((a, b) => {
      // Recency first (newer entries on top). Tiebreaker on
      // lastTurnIndex so two entries registered in the same millisecond
      // but coming from different turns sort newer-turn first.
      if (b.lastMentionedAt !== a.lastMentionedAt) return b.lastMentionedAt - a.lastMentionedAt;
      return b.lastTurnIndex - a.lastTurnIndex;
    })
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 25)))
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      canonicalSurface: e.canonicalSurface,
      lastSurface: e.lastSurface,
      mentions: e.mentions,
      firstSeenTurn: e.firstSeenTurn,
      lastTurnIndex: e.lastTurnIndex,
      aliases: [...e.aliases].slice(0, 8),
    }));
}

function forgetEntity({ userId, chatId, entityId: eid } = {}) {
  const slot = getChatRegistry(userId, chatId);
  if (!slot) return { removed: 0 };
  return { removed: slot.entities.delete(eid) ? 1 : 0 };
}

function resetChat({ userId, chatId } = {}) {
  const k = key(userId, chatId);
  const slot = REGISTRY.get(k);
  if (!slot) return { cleared: 0 };
  const n = slot.entities.size;
  REGISTRY.delete(k);
  return { cleared: n };
}

function expireStale() {
  const now = Date.now();
  let evicted = 0;
  for (const [k, slot] of REGISTRY) {
    if (now - slot.lastTouched > CHAT_TTL_MS) {
      REGISTRY.delete(k);
      evicted += 1;
    }
  }
  return { evicted };
}

function stats() {
  let chats = 0;
  let entities = 0;
  for (const slot of REGISTRY.values()) {
    chats += 1;
    entities += slot.entities.size;
  }
  return { chats, entities };
}

function buildReferenceResolutionBlock({ userId, chatId, prompt = '', maxRefs = 6 } = {}) {
  const safe = safeText(prompt);
  if (!safe.trim()) return '';
  const resolved = [];
  let m;
  while ((m = REFERENCE_SURFACE_RE.exec(safe)) !== null) {
    const surface = `${m[0]}`;
    const ref = resolveReference({ userId, chatId, surface });
    if (ref && ref.score >= 0.4) {
      resolved.push({ surface, ref });
      if (resolved.length >= maxRefs) break;
    }
  }
  REFERENCE_SURFACE_RE.lastIndex = 0;
  if (!resolved.length) return '';
  const lines = ['## CROSS-TURN ENTITY RESOLUTION'];
  for (const r of resolved) {
    lines.push(`- "${r.surface}" → [${r.ref.kind}] ${r.ref.canonicalSurface} (mentions=${r.ref.mentions}, first turn=${r.ref.firstSeenTurn + 1}, conf=${Math.round(r.ref.score * 100)}%)`);
  }
  return lines.join('\n');
}

function _reset() { REGISTRY.clear(); }

module.exports = {
  register,
  resolveReference,
  listEntities,
  forgetEntity,
  resetChat,
  expireStale,
  stats,
  buildReferenceResolutionBlock,
  extractEntitiesFromText,
  _reset,
  MAX_ENTITIES_PER_CHAT,
  CHAT_TTL_MS,
};
