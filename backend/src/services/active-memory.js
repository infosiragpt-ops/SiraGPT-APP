'use strict';

const crypto = require('crypto');
const diskPersistence = require('./cowork-disk-persistence');

const hydratedUsers = new Set();
const persistTimers = new Map();

const MAX_MEMORY_ENTRIES = Number.parseInt(process.env.SIRAGPT_MAX_MEMORY_ENTRIES || '1000', 10);
const PROMOTION_THRESHOLD = Number.parseInt(process.env.SIRAGPT_MEMORY_PROMOTION_THRESHOLD || '3', 10);
const DEMOTION_THRESHOLD = Number.parseInt(process.env.SIRAGPT_MEMORY_DEMOTION_THRESHOLD || '0', 10);
const MEMORY_TTL_MS = Number.parseInt(process.env.SIRAGPT_MEMORY_TTL_MS || `${30 * 24 * 60 * 60 * 1000}`, 10);

const store = new Map();
const promotionLog = [];


function normalizeFactForDedup(fact) {
  return String(fact || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function hydrateUserMemory(userId) {
  if (!userId || hydratedUsers.has(userId)) return;
  hydratedUsers.add(userId);
  const saved = diskPersistence.loadMemoryEntries(userId);
  for (const entry of saved) {
    if (entry?.id && !store.has(entry.id)) {
      store.set(entry.id, entry);
    }
  }
}

function schedulePersistUserMemory(userId) {
  if (!userId) return;
  const existing = persistTimers.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    persistTimers.delete(userId);
    const entries = [...store.values()].filter((e) => e.userId === userId);
    diskPersistence.saveMemoryEntries(userId, entries);
  }, 400);
  if (timer.unref) timer.unref();
  persistTimers.set(userId, timer);
}

function createMemoryEntry(userId, fact, opts = {}) {
  hydrateUserMemory(userId);
  const normalized = normalizeFactForDedup(fact);
  const nearHash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  for (const entry of store.values()) {
    if (entry.userId !== userId) continue;
    const other = normalizeFactForDedup(entry.fact);
    if (other === normalized || entry.hash === nearHash) {
      entry.accessCount += 1;
      entry.lastAccessed = Date.now();
      entry.strength = Math.min(1, entry.strength + 0.1);
      schedulePersistUserMemory(userId);
      return entry;
    }
  }

  const id = `mem_${crypto.randomBytes(6).toString('hex')}`;
  // Store the NORMALIZED-fact hash so the dedup fast-path (entry.hash === nearHash
  // above) actually fires — it previously stored a hash of the RAW fact while the
  // comparison used the normalized hash, so that branch never matched (dead code).
  const hash = nearHash;

  const entry = {
    id,
    userId,
    fact,
    hash,
    source: opts.source || 'user_message',
    category: opts.category || 'general',
    tags: opts.tags || [],
    confidence: opts.confidence ?? 0.7,
    strength: opts.strength ?? 0.3,
    accessCount: 1,
    promotionCount: 0,
    createdFrom: opts.createdFrom || null,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    expiresAt: opts.ttl ? Date.now() + opts.ttl : Date.now() + MEMORY_TTL_MS,
    metadata: opts.metadata || {},
    tier: 'short_term',
  };

  if (store.size >= MAX_MEMORY_ENTRIES) {
    evictWeakest();
  }

  store.set(id, entry);
  schedulePersistUserMemory(userId);
  return entry;
}

function findExisting(userId, hash) {
  for (const entry of store.values()) {
    if (entry.userId === userId && entry.hash === hash) return entry;
  }
  return null;
}

function evictWeakest() {
  let weakest = null;
  let weakestScore = Infinity;

  for (const entry of store.values()) {
    const score = entry.strength * 0.5 + (entry.accessCount / 10) * 0.3 + (entry.tier === 'long_term' ? 0.2 : 0);
    if (score < weakestScore) {
      weakestScore = score;
      weakest = entry;
    }
  }

  if (weakest) store.delete(weakest.id);
}

function promoteToLongTerm(entryId, { userId = null } = {}) {
  const entry = store.get(entryId);
  if (!entry) return null;
  // When a userId is supplied (any user-facing path), enforce ownership BEFORE
  // mutating — otherwise any authenticated user could promote (and read back)
  // another user's memory entry by id. Internal callers omit userId.
  if (userId != null && entry.userId !== userId) return null;

  if (entry.tier === 'long_term') return entry;

  entry.tier = 'long_term';
  entry.strength = Math.min(1, entry.strength + 0.3);
  entry.promotionCount += 1;
  entry.expiresAt = Date.now() + MEMORY_TTL_MS * 3;

  promotionLog.push({
    entryId,
    from: 'short_term',
    to: 'long_term',
    at: Date.now(),
  });

  return entry;
}

function demoteToShortTerm(entryId) {
  const entry = store.get(entryId);
  if (!entry) return null;

  if (entry.tier === 'short_term') return entry;

  entry.tier = 'short_term';
  entry.strength = Math.max(0, entry.strength - 0.3);
  entry.expiresAt = Date.now() + MEMORY_TTL_MS;

  return entry;
}

function autoPromote(userId) {
  let promoted = 0;

  for (const entry of store.values()) {
    if (entry.userId !== userId) continue;
    if (entry.tier === 'long_term') continue;

    if (entry.accessCount >= PROMOTION_THRESHOLD || entry.strength >= 0.8) {
      promoteToLongTerm(entry.id);
      promoted++;
    }
  }

  return { promoted };
}

function autoDemote(userId) {
  let demoted = 0;

  for (const entry of store.values()) {
    if (entry.userId !== userId) continue;
    if (entry.tier === 'short_term') continue;

    if (entry.accessCount <= DEMOTION_THRESHOLD && entry.strength < 0.3) {
      demoteToShortTerm(entry.id);
      demoted++;
    }
  }

  return { demoted };
}

function recall(userId, query, opts = {}) {
  hydrateUserMemory(userId);
  const limit = Math.min(opts.limit || 10, 50);
  const tier = opts.tier || null;
  const category = opts.category || null;
  // Whether this read counts as a genuine access. Prompt-building / display
  // paths (getMemoryContext, read-only routes) pass bump:false so merely
  // assembling the system prompt every turn doesn't inflate accessCount and
  // force short_term facts into long_term via auto-promotion. Defaults to true
  // so explicit recall() keeps its access-counting behavior.
  const bump = opts.bump !== false;

  const now = Date.now();
  let entries = [...store.values()].filter(e => {
    if (e.userId !== userId) return false;
    if (e.expiresAt && e.expiresAt < now) {
      store.delete(e.id);
      return false;
    }
    if (tier && e.tier !== tier) return false;
    if (category && e.category !== category) return false;
    return true;
  });

  if (query) {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    entries = entries.map(entry => {
      const factLower = entry.fact.toLowerCase();
      let relevance = 0;

      for (const term of queryTerms) {
        if (factLower.includes(term)) relevance += 1;
      }

      for (const tag of entry.tags) {
        if (queryLower.includes(tag.toLowerCase())) relevance += 0.5;
      }

      if (entry.category !== 'general' && queryLower.includes(entry.category.toLowerCase())) {
        relevance += 0.5;
      }

      const recencyBoost = Math.max(0, 1 - (now - entry.lastAccessed) / MEMORY_TTL_MS);
      const strengthBoost = entry.strength;
      const accessBoost = Math.min(entry.accessCount / 10, 1);
      const tierBoost = entry.tier === 'long_term' ? 1 : 0.5;

      const score = relevance * 0.4 + recencyBoost * 0.2 + strengthBoost * 0.2 + accessBoost * 0.1 + tierBoost * 0.1;

      return { ...entry, score };
    });

    entries = entries
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score);
  } else {
    entries = entries.sort((a, b) => b.lastAccessed - a.lastAccessed);
  }

  const results = entries.slice(0, limit);

  if (bump) {
    for (const entry of results) {
      const live = store.get(entry.id);
      if (live) {
        live.accessCount += 1;
        live.lastAccessed = now;
      }
    }
  }

  return results;
}

/**
 * Read-only listing of a user's live (non-expired) memory entries, newest
 * first. Unlike recall(), it does NOT bump accessCount/lastAccessed — so the
 * "consider memory every turn" path can scan facts without skewing the data.
 */
function listEntries(userId, opts = {}) {
  hydrateUserMemory(userId);
  const limit = Math.min(opts.limit || 50, 500);
  const now = Date.now();
  return [...store.values()]
    .filter((e) => e.userId === userId && !(e.expiresAt && e.expiresAt < now))
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .slice(0, limit)
    .map((e) => ({ ...e }));
}

function getMemoryContext(userId, opts = {}) {
  // Count both tiers in a single pass over the store instead of two full
  // spread+filter materializations (this runs every chat turn). Same semantics
  // as the original .filter()s: by userId, by tier, no expiry filter, no limit.
  let longTermCount = 0;
  let shortTermCount = 0;
  for (const e of store.values()) {
    if (e.userId !== userId) continue;
    if (e.tier === 'long_term') longTermCount += 1;
    else if (e.tier === 'short_term') shortTermCount += 1;
  }

  // Read-only prompt assembly: do NOT bump accessCount (this runs every turn).
  const recentMemories = recall(userId, null, { limit: opts.limit || 20, bump: false });

  const longTermFacts = recentMemories
    .filter(m => m.tier === 'long_term')
    .map(m => m.fact);

  const shortTermFacts = recentMemories
    .filter(m => m.tier === 'short_term')
    .map(m => m.fact);

  return {
    longTermCount,
    shortTermCount,
    totalActive: longTermCount + shortTermCount,
    longTermFacts,
    shortTermFacts,
    categories: [...new Set(recentMemories.map(m => m.category))],
  };
}

function buildMemoryPrompt(userId, opts = {}) {
  const context = getMemoryContext(userId, { limit: opts.limit || 15 });

  if (context.longTermFacts.length === 0 && context.shortTermFacts.length === 0) {
    return '';
  }

  const parts = ['## Active Memory'];

  if (context.longTermFacts.length > 0) {
    parts.push('### Persistent Facts');
    for (const fact of context.longTermFacts) {
      parts.push(`- ${fact}`);
    }
  }

  if (context.shortTermFacts.length > 0) {
    parts.push('### Recent Context');
    for (const fact of context.shortTermFacts.slice(0, 8)) {
      parts.push(`- ${fact}`);
    }
  }

  return parts.join('\n');
}

function forget(userId, query) {
  if (!query) return { removed: 0 };

  const queryLower = query.toLowerCase();
  let removed = 0;

  for (const [id, entry] of store) {
    if (entry.userId !== userId) continue;
    if (entry.fact.toLowerCase().includes(queryLower)) {
      store.delete(id);
      removed++;
    }
  }

  return { removed };
}

function clearUserMemory(userId) {
  let cleared = 0;
  for (const [id, entry] of store) {
    if (entry.userId === userId) {
      store.delete(id);
      cleared++;
    }
  }
  return { cleared };
}

/**
 * Delete a single entry by id, scoped to the owning user (so one user can
 * never delete another's memory). Returns the removed fact for confirmation.
 */
function deleteById(userId, id) {
  const entry = store.get(id);
  if (!entry || entry.userId !== userId) return { removed: 0, fact: null };
  store.delete(id);
  schedulePersistUserMemory(userId);
  return { removed: 1, fact: entry.fact };
}

/**
 * Remove prior facts describing the same single-valued attribute so an updated
 * fact (e.g. a new name) supersedes the stale one instead of accumulating
 * contradictions. Matches on category + metadata.attribute. `exceptId` keeps
 * the freshly-created entry.
 */
function supersede(userId, { category, attribute, exceptId } = {}) {
  if (!attribute) return { removed: 0 };
  let removed = 0;
  for (const [id, entry] of store) {
    if (entry.userId !== userId) continue;
    if (id === exceptId) continue;
    if (entry.category === category && entry.metadata && entry.metadata.attribute === attribute) {
      store.delete(id);
      removed++;
    }
  }
  if (removed) schedulePersistUserMemory(userId);
  return { removed };
}

function getStats(userId) {
  const userEntries = [...store.values()].filter(e => e.userId === userId);
  return {
    total: userEntries.length,
    longTerm: userEntries.filter(e => e.tier === 'long_term').length,
    shortTerm: userEntries.filter(e => e.tier === 'short_term').length,
    categories: [...new Set(userEntries.map(e => e.category))],
    avgStrength: userEntries.length > 0
      ? userEntries.reduce((acc, e) => acc + e.strength, 0) / userEntries.length
      : 0,
    avgAccessCount: userEntries.length > 0
      ? userEntries.reduce((acc, e) => acc + e.accessCount, 0) / userEntries.length
      : 0,
  };
}

function expireStale() {
  const now = Date.now();
  let expired = 0;
  for (const [id, entry] of store) {
    if (entry.expiresAt && entry.expiresAt < now) {
      store.delete(id);
      expired++;
    }
  }
  return { expired };
}

// ---------------------------------------------------------------------------
// Consolidation ("dreaming") pass — OpenClaw port #9 (docs/code/openclaw-port-charter.md).
// A single nightly-style sweep that merges near-duplicate facts, decays stale
// ones, applies the existing promotion/demotion rules and purges expired
// entries. Additive: no existing function's signature or behavior changes.
// ---------------------------------------------------------------------------

// Two normalized facts are considered near-duplicates when the Jaccard
// similarity of their token sets reaches this threshold.
const CONSOLIDATION_SIMILARITY_THRESHOLD = 0.85;
// Decay reuses the module's existing knobs rather than inventing new ones:
// the window derives from MEMORY_TTL_MS (an entry untouched for half its TTL
// counts as "not recently accessed") and the step mirrors the +0.1 strength
// reinforcement createMemoryEntry applies on a dedupe hit.
const CONSOLIDATION_DECAY_WINDOW_MS = Math.floor(MEMORY_TTL_MS / 2);
const CONSOLIDATION_DECAY_STEP = 0.1;

function tokenizeForSimilarity(fact) {
  return new Set(
    normalizeFactForDedup(fact)
      .split(/[^a-z0-9áéíóúüñ]+/)
      .filter(Boolean)
  );
}

function jaccardSimilarity(aTokens, bTokens) {
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const [small, large] = aTokens.size <= bTokens.size ? [aTokens, bTokens] : [bTokens, aTokens];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Deterministic "who survives a merge" order: strongest first ("conserva la de
// mayor strength"), then most accessed, then oldest, then id as a stable tiebreak.
function rankForConsolidation(a, b) {
  if (b.strength !== a.strength) return b.strength - a.strength;
  if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Nightly consolidation sweep for one user's memory ("dreaming job").
 *
 * In order: (1) merges near-duplicate entries (token Jaccard >=
 * CONSOLIDATION_SIMILARITY_THRESHOLD over normalized content) keeping the
 * strongest entry and summing the absorbed accessCount into it, (2) decays the
 * strength of entries without recent access (window/step derived from the
 * module's existing knobs), (3) applies the existing autoPromote/autoDemote
 * rules, (4) purges expired entries.
 *
 * Deterministic given the store state and the injected `now` (timestamps
 * written by the reused promotion/demotion helpers still come from the real
 * clock, as before). Idempotent: a second pass with the same `now` reports
 * all-zero counters.
 *
 * @param {{ userId: string, now?: number }} opts
 * @returns {{ merged: number, decayed: number, promoted: number, demoted: number, purged: number }}
 */
function consolidateMemories({ userId, now = Date.now() } = {}) {
  const result = { merged: 0, decayed: 0, promoted: 0, demoted: 0, purged: 0 };
  if (!userId) return result;
  hydrateUserMemory(userId);

  const isExpired = (entry) => Boolean(entry.expiresAt && entry.expiresAt < now);

  // (1) Merge near-duplicates among the user's live entries. Expired entries
  // are left alone here — the purge step below owns them.
  const live = [...store.values()]
    .filter((entry) => entry.userId === userId && !isExpired(entry))
    .sort(rankForConsolidation);
  const tokensById = new Map(live.map((entry) => [entry.id, tokenizeForSimilarity(entry.fact)]));
  const absorbed = new Set();
  for (let i = 0; i < live.length; i++) {
    const keeper = live[i];
    if (absorbed.has(keeper.id)) continue;
    for (let j = i + 1; j < live.length; j++) {
      const candidate = live[j];
      if (absorbed.has(candidate.id)) continue;
      const similarity = jaccardSimilarity(tokensById.get(keeper.id), tokensById.get(candidate.id));
      if (similarity < CONSOLIDATION_SIMILARITY_THRESHOLD) continue;
      keeper.accessCount += candidate.accessCount;
      keeper.lastAccessed = Math.max(keeper.lastAccessed || 0, candidate.lastAccessed || 0);
      if (keeper.expiresAt && candidate.expiresAt) {
        keeper.expiresAt = Math.max(keeper.expiresAt, candidate.expiresAt);
      }
      absorbed.add(candidate.id);
      store.delete(candidate.id);
      result.merged += 1;
    }
  }

  // (2) Decay entries without recent access. `lastDecayedAt` records the pass
  // so re-running with the same `now` is a no-op (idempotency), mirroring how
  // access refreshes `lastAccessed`.
  for (const entry of store.values()) {
    if (entry.userId !== userId || isExpired(entry)) continue;
    const lastTouch = Math.max(entry.lastAccessed || 0, entry.lastDecayedAt || 0);
    if (entry.strength > 0 && now - lastTouch >= CONSOLIDATION_DECAY_WINDOW_MS) {
      entry.strength = Math.max(0, Math.round((entry.strength - CONSOLIDATION_DECAY_STEP) * 1e4) / 1e4);
      entry.lastDecayedAt = now;
      result.decayed += 1;
    }
  }

  // (3) Existing promotion/demotion rules, unchanged.
  result.promoted = autoPromote(userId).promoted;
  result.demoted = autoDemote(userId).demoted;

  // (4) Purge expired entries for this user.
  for (const [id, entry] of store) {
    if (entry.userId !== userId) continue;
    if (isExpired(entry)) {
      store.delete(id);
      result.purged += 1;
    }
  }

  if (result.merged || result.decayed || result.promoted || result.demoted || result.purged) {
    schedulePersistUserMemory(userId);
  }

  return result;
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer = null;

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => { expireStale(); }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

startCleanup();

module.exports = {
  createMemoryEntry,
  recall,
  listEntries,
  getMemoryContext,
  buildMemoryPrompt,
  promoteToLongTerm,
  demoteToShortTerm,
  autoPromote,
  autoDemote,
  forget,
  deleteById,
  supersede,
  clearUserMemory,
  getStats,
  expireStale,
  consolidateMemories,
  CONSOLIDATION_SIMILARITY_THRESHOLD,
  CONSOLIDATION_DECAY_WINDOW_MS,
  CONSOLIDATION_DECAY_STEP,
  startCleanup,
  stopCleanup,
  PROMOTION_THRESHOLD,
  DEMOTION_THRESHOLD,
};
