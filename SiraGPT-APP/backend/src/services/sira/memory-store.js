/**
 * memory-store — unified contract over the four memory tiers.
 * Closes the memory item from the expanded vision (task 11):
 * "La memoria no debería ser solo guardar conversaciones. Debe
 * dividirse en tipos."
 *
 * Today the memory surface is split across three modules with three
 * different APIs:
 *
 *   - `services/gist-memory.js`     — in-process triples per session.
 *   - `services/long-term-memory.js` — vector-stored facts per user.
 *   - `services/project-memory.js`   — DB-stored facts per project.
 *
 * Each is fine in isolation but a chat-controller that wants
 * "remember this" or "recall what we know about X" has to know the
 * three call shapes. This module is the single shape the controller
 * (and any future consumer) sees.
 *
 *   put({ tier, scope, item, importance })           → { id }
 *   recall({ tier, scope, query, limit })            → [{ item, score }]
 *   forget({ tier, scope, id })                      → { ok }
 *   stats({ tier, scope })                           → { count, ... }
 *
 * Tiers
 * -----
 *   short_term    — per-session, in-process. TTL'd. Triple-shaped.
 *   conversation  — per-conversation, persisted. Survives reconnect.
 *   semantic      — per-user, long-term, vector-recalled. Half-life
 *                   decay built in.
 *   project       — per-project (workspace), DB-stored.
 *   user          — per-user metadata that is not semantic facts
 *                   (preferences, settings, profile).
 *
 * `scope` resolves "whose memory" for a given tier:
 *   short_term    → { sessionId }
 *   conversation  → { conversationId }
 *   semantic      → { userId }
 *   project       → { projectId, userId }
 *   user          → { userId }
 *
 * Adapters
 * --------
 * This module ships with `createInMemoryStore()` for offline tests
 * and as the default fallback. Production wires `createCompositeStore({
 *   gistMemory, longTermMemory, projectMemory, userMemory })` so each
 * tier dispatches to the existing module without rewriting it. The
 * composite is intentionally thin — it routes by `tier`, validates
 * `scope`, and delegates. Anything richer (e.g. cross-tier recall,
 * importance-weighted ranking) lives in a higher layer.
 */

const TIERS = Object.freeze(["short_term", "conversation", "semantic", "project", "user"]);

const REQUIRED_SCOPE = Object.freeze({
  short_term: ["sessionId"],
  conversation: ["conversationId"],
  semantic: ["userId"],
  project: ["projectId"],
  user: ["userId"],
});

class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

function validateTier(tier) {
  if (!TIERS.includes(tier)) {
    throw new MemoryError("memory.invalid_tier", `tier must be one of ${TIERS.join(", ")}, got ${tier}`);
  }
}

function validateScope(tier, scope) {
  validateTier(tier);
  const required = REQUIRED_SCOPE[tier];
  for (const k of required) {
    if (!scope || typeof scope[k] !== "string" || scope[k].length === 0) {
      throw new MemoryError("memory.invalid_scope", `tier "${tier}" requires scope.${k}`);
    }
  }
}

// ── Default in-memory store ────────────────────────────────────────

function _scopeKey(tier, scope) {
  validateScope(tier, scope);
  const parts = REQUIRED_SCOPE[tier].map((k) => `${k}=${scope[k]}`);
  return `${tier}::${parts.join("|")}`;
}

function _itemTextOf(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (typeof item.fact === "string") return item.fact;
  try { return JSON.stringify(item); } catch { return String(item); }
}

function _matchScore(query, item) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;
  const text = _itemTextOf(item).toLowerCase();
  if (!text) return 0;
  // Substring match → 1; word-overlap fallback → 0..1.
  if (text.includes(q)) return 1;
  const qWords = new Set(q.split(/\s+/).filter(Boolean));
  if (qWords.size === 0) return 0;
  const tWords = new Set(text.split(/\s+/).filter(Boolean));
  let overlap = 0;
  for (const w of qWords) if (tWords.has(w)) overlap++;
  return Math.min(1, overlap / qWords.size);
}

function createInMemoryStore({ now = () => Date.now() } = {}) {
  // Map<scopeKey, Map<id, record>>
  const buckets = new Map();
  let _idSeq = 0;
  const nextId = () => `mem_${(++_idSeq).toString(36)}_${now().toString(36)}`;

  function bucketOf(tier, scope) {
    const key = _scopeKey(tier, scope);
    if (!buckets.has(key)) buckets.set(key, new Map());
    return buckets.get(key);
  }

  return {
    async put({ tier, scope, item, importance = 0.5 } = {}) {
      validateScope(tier, scope);
      if (item == null) throw new MemoryError("memory.missing_item", "item is required");
      const id = nextId();
      const record = {
        id, tier, scope: { ...scope },
        item, importance: Number.isFinite(importance) ? importance : 0.5,
        ts: now(),
      };
      bucketOf(tier, scope).set(id, record);
      return { id };
    },

    async recall({ tier, scope, query = "", limit = 10 } = {}) {
      validateScope(tier, scope);
      const bucket = bucketOf(tier, scope);
      const cap = Number.isFinite(limit) && limit > 0 ? limit : 10;
      const scored = [];
      for (const r of bucket.values()) {
        const score = query ? _matchScore(query, r.item) : 0;
        // No query → return most recent items (recency-ranked).
        const rank = query ? score : r.ts / 1e13;
        scored.push({ item: r.item, score, importance: r.importance, id: r.id, ts: r.ts, _rank: rank });
      }
      scored.sort((a, b) => b._rank - a._rank);
      return scored.slice(0, cap).map(({ _rank, ...rest }) => rest);
    },

    async forget({ tier, scope, id } = {}) {
      validateScope(tier, scope);
      if (typeof id !== "string" || !id) {
        throw new MemoryError("memory.missing_id", "id is required");
      }
      const ok = bucketOf(tier, scope).delete(id);
      return { ok };
    },

    async stats({ tier, scope } = {}) {
      validateScope(tier, scope);
      const bucket = bucketOf(tier, scope);
      let oldest = Infinity;
      let newest = 0;
      for (const r of bucket.values()) {
        if (r.ts < oldest) oldest = r.ts;
        if (r.ts > newest) newest = r.ts;
      }
      return {
        tier, scope: { ...scope },
        count: bucket.size,
        oldest_ts: bucket.size === 0 ? null : oldest,
        newest_ts: bucket.size === 0 ? null : newest,
      };
    },

    // Test helpers
    _reset() { buckets.clear(); _idSeq = 0; },
  };
}

// ── Composite (production) ─────────────────────────────────────────

/**
 * Routes calls to per-tier adapters. Every adapter must implement the
 * same four methods (put/recall/forget/stats). Missing adapters raise
 * `MemoryError("memory.tier_unwired")` so the operator notices early.
 *
 * @param {object} adapters
 * @param {object} [adapters.short_term]
 * @param {object} [adapters.conversation]
 * @param {object} [adapters.semantic]
 * @param {object} [adapters.project]
 * @param {object} [adapters.user]
 */
function createCompositeStore(adapters = {}) {
  function pick(tier) {
    validateTier(tier);
    const a = adapters[tier];
    if (!a) throw new MemoryError("memory.tier_unwired", `no adapter wired for tier "${tier}"`);
    return a;
  }
  return {
    async put(args) { validateScope(args?.tier, args?.scope); return pick(args.tier).put(args); },
    async recall(args) { validateScope(args?.tier, args?.scope); return pick(args.tier).recall(args); },
    async forget(args) { validateScope(args?.tier, args?.scope); return pick(args.tier).forget(args); },
    async stats(args) { validateScope(args?.tier, args?.scope); return pick(args.tier).stats(args); },
  };
}

module.exports = {
  TIERS,
  REQUIRED_SCOPE,
  MemoryError,
  validateTier,
  validateScope,
  createInMemoryStore,
  createCompositeStore,
};
