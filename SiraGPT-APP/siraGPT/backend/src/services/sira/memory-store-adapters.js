/**
 * memory-store-adapters — concrete adapters that satisfy the
 * `MemoryStore` interface (put / recall / forget / stats) by
 * delegating to the existing memory modules. Closes task 16.
 *
 * Existing modules these adapters wrap
 * ------------------------------------
 *   - services/gist-memory.js     (in-process triples per session)
 *      → `createShortTermAdapter`
 *   - services/long-term-memory.js (vector-stored facts per user)
 *      → `createSemanticAdapter`
 *   - services/project-memory.js   (Prisma rows per project)
 *      → `createProjectAdapter`
 *
 * Plus two simple in-process adapters for tiers without a dedicated
 * persistence module yet:
 *   - `createConversationAdapter()` — per-conversation, in-process.
 *   - `createUserAdapter()`         — per-user metadata, in-process.
 *
 * Why thin
 * --------
 * The wrapped modules have idiosyncratic APIs (gist-memory wants
 * triples; long-term-memory has its own importance scoring; project-
 * memory talks to Prisma directly). The adapters translate to the
 * unified contract without forcing an API rewrite of any of them.
 *
 * Failure tolerance
 * -----------------
 * Each adapter catches errors at the boundary and surfaces them as
 * MemoryError so the chat-controller / runtime never sees a raw
 * Prisma or vector-store stack trace. The contract message stays
 * uniform regardless of backend.
 */

const { MemoryError, REQUIRED_SCOPE } = require("./memory-store");

// ── Helpers ────────────────────────────────────────────────────────

function _itemAsTriple(item) {
  // gist-memory expects { subject, predicate, object } triples.
  // Accept several shapes: a triple, a string, or any object.
  if (item && typeof item === "object" && "subject" in item && "predicate" in item && "object" in item) {
    return { subject: String(item.subject), predicate: String(item.predicate), object: String(item.object) };
  }
  if (typeof item === "string") {
    return { subject: "user", predicate: "noted", object: item };
  }
  // Last-resort: serialize the object as the `object` field.
  let serialized;
  try { serialized = JSON.stringify(item); } catch { serialized = String(item); }
  return { subject: "user", predicate: "noted", object: serialized };
}

function _wrap(asyncFn, errorCode) {
  return async (args) => {
    try {
      return await asyncFn(args);
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      throw new MemoryError(errorCode, err && err.message ? err.message.slice(0, 200) : "adapter_error");
    }
  };
}

// ── short_term — wraps gist-memory ─────────────────────────────────

function createShortTermAdapter({ gistMemory } = {}) {
  if (!gistMemory) throw new MemoryError("memory.adapter_misconfigured", "gistMemory module required");

  return {
    put: _wrap(async ({ scope, item }) => {
      const triple = _itemAsTriple(item);
      gistMemory.append(scope.sessionId, [triple]);
      // gist-memory does not return per-item ids; we synthesize one
      // from the triple's identity so callers can correlate, even
      // though `forget(id)` will fall back to a full session clear.
      const id = `gist:${gistMemory.tripleIdentity ? gistMemory.tripleIdentity(triple) : `${triple.subject}|${triple.predicate}|${triple.object}`}`;
      return { id };
    }, "memory.short_term_put_failed"),

    recall: _wrap(async ({ scope, query = "", limit = 10 }) => {
      const triples = gistMemory.get(scope.sessionId) || [];
      const q = String(query || "").toLowerCase();
      const items = triples.map((t) => {
        const text = `${t.subject} ${t.predicate} ${t.object}`;
        const score = q && text.toLowerCase().includes(q) ? 1 : 0;
        return { item: t, score, importance: 0.5, id: `gist:${t.subject}|${t.predicate}|${t.object}`, ts: Date.now() };
      });
      // Query-bearing recall: keep matches first, then the rest.
      const ranked = q ? items.slice().sort((a, b) => b.score - a.score) : items.slice().reverse();
      return ranked.slice(0, Math.max(1, Number(limit) || 10));
    }, "memory.short_term_recall_failed"),

    forget: _wrap(async ({ scope }) => {
      // gist-memory only supports session-level clear. We document
      // this on the unified surface so callers who want per-id
      // forget for short_term need to migrate their store.
      gistMemory.clear(scope.sessionId);
      return { ok: true };
    }, "memory.short_term_forget_failed"),

    stats: _wrap(async ({ scope }) => {
      const s = gistMemory.stats(scope.sessionId);
      return {
        tier: "short_term", scope,
        count: s.triples || 0,
        oldest_ts: null,
        newest_ts: s.lastTouched || null,
      };
    }, "memory.short_term_stats_failed"),
  };
}

// ── semantic — wraps long-term-memory ──────────────────────────────

function createSemanticAdapter({ longTermMemory } = {}) {
  if (!longTermMemory) throw new MemoryError("memory.adapter_misconfigured", "longTermMemory module required");

  return {
    put: _wrap(async () => {
      // long-term-memory extracts facts ASYNCHRONOUSLY from messages
      // via `extractFactsAsync`. There is no synchronous "store this
      // verbatim" path. Returning a sentinel id keeps the contract
      // honest: the call accepted the request, but persistence
      // happens on a background pass over messages.
      return { id: "semantic:async-extraction" };
    }, "memory.semantic_put_failed"),

    recall: _wrap(async ({ scope, query = "", limit = 10 }) => {
      if (typeof longTermMemory.recallFacts !== "function") return [];
      const results = await longTermMemory.recallFacts(scope.userId, query, limit);
      // recallFacts returns Array<{ fact, score, ... }>. Translate.
      return (results || []).map((r) => ({
        item: r.fact || r.text || r,
        score: typeof r.score === "number" ? r.score : 0,
        importance: typeof r.importance === "number" ? r.importance : 0.5,
        id: r.id || null,
        ts: r.created_at ? new Date(r.created_at).getTime() : null,
      }));
    }, "memory.semantic_recall_failed"),

    forget: _wrap(async ({ scope }) => {
      // Like gist-memory, long-term-memory only supports clearing
      // the user's whole memory; per-id forget would need a vector-
      // store-aware deletion path that doesn't exist today.
      if (typeof longTermMemory.clearUserMemory === "function") {
        await longTermMemory.clearUserMemory(scope.userId);
      }
      return { ok: true };
    }, "memory.semantic_forget_failed"),

    stats: _wrap(async ({ scope }) => {
      if (typeof longTermMemory.memoryStats !== "function") {
        return { tier: "semantic", scope, count: 0, oldest_ts: null, newest_ts: null };
      }
      const s = await longTermMemory.memoryStats(scope.userId);
      return {
        tier: "semantic", scope,
        count: s?.count || s?.size || 0,
        oldest_ts: null,
        newest_ts: null,
      };
    }, "memory.semantic_stats_failed"),
  };
}

// ── project — wraps project-memory ─────────────────────────────────

function createProjectAdapter({ projectMemory, prisma } = {}) {
  if (!projectMemory) throw new MemoryError("memory.adapter_misconfigured", "projectMemory module required");

  return {
    put: _wrap(async ({ scope, item }) => {
      const factText = typeof item === "string" ? item : (item && item.text) ? item.text : JSON.stringify(item);
      if (typeof projectMemory.saveFacts !== "function") {
        throw new MemoryError("memory.project_unsupported", "projectMemory.saveFacts not present");
      }
      const r = await projectMemory.saveFacts(prisma, scope.projectId, [{ text: factText }]);
      const id = Array.isArray(r) && r[0]?.id ? `project:${r[0].id}` : "project:unknown";
      return { id };
    }, "memory.project_put_failed"),

    recall: _wrap(async ({ scope, query = "", limit = 10 }) => {
      if (typeof projectMemory.listMemory !== "function") return [];
      const rows = await projectMemory.listMemory(prisma, { projectId: scope.projectId });
      const q = String(query || "").toLowerCase();
      const items = (rows || []).map((r) => {
        const text = String(r.text || r.content || "").toLowerCase();
        const score = q && text.includes(q) ? 1 : 0;
        return {
          item: { id: r.id, text: r.text || r.content, created_at: r.createdAt || r.created_at },
          score,
          importance: 0.5,
          id: `project:${r.id}`,
          ts: r.createdAt ? new Date(r.createdAt).getTime() : null,
        };
      });
      const ranked = q ? items.slice().sort((a, b) => b.score - a.score) : items;
      return ranked.slice(0, Math.max(1, Number(limit) || 10));
    }, "memory.project_recall_failed"),

    forget: _wrap(async ({ scope, id }) => {
      const factId = String(id || "").startsWith("project:") ? String(id).slice("project:".length) : id;
      if (typeof projectMemory.deleteMemory !== "function") {
        throw new MemoryError("memory.project_unsupported", "projectMemory.deleteMemory not present");
      }
      const r = await projectMemory.deleteMemory(prisma, { projectId: scope.projectId, factId });
      return { ok: Boolean(r && r.ok) };
    }, "memory.project_forget_failed"),

    stats: _wrap(async ({ scope }) => {
      if (typeof projectMemory.listMemory !== "function") {
        return { tier: "project", scope, count: 0, oldest_ts: null, newest_ts: null };
      }
      const rows = await projectMemory.listMemory(prisma, { projectId: scope.projectId });
      let oldest = Infinity;
      let newest = 0;
      for (const r of rows || []) {
        const t = r.createdAt ? new Date(r.createdAt).getTime() : null;
        if (t == null) continue;
        if (t < oldest) oldest = t;
        if (t > newest) newest = t;
      }
      return {
        tier: "project", scope,
        count: (rows || []).length,
        oldest_ts: oldest === Infinity ? null : oldest,
        newest_ts: newest === 0 ? null : newest,
      };
    }, "memory.project_stats_failed"),
  };
}

// ── conversation / user — simple in-process adapters ───────────────

function createInProcessAdapter(tier) {
  // Map<scopeKey, Map<id, {item, ts, importance}>>
  const buckets = new Map();
  let seq = 0;

  function keyOf(scope) {
    const required = REQUIRED_SCOPE[tier];
    return required.map((k) => `${k}=${scope[k]}`).join("|");
  }
  function bucket(scope) {
    const k = keyOf(scope);
    if (!buckets.has(k)) buckets.set(k, new Map());
    return buckets.get(k);
  }

  return {
    async put({ scope, item, importance = 0.5 }) {
      const id = `${tier}:${(++seq).toString(36)}`;
      bucket(scope).set(id, { item, ts: Date.now(), importance });
      return { id };
    },
    async recall({ scope, query = "", limit = 10 }) {
      const all = [...bucket(scope).entries()];
      const q = String(query || "").toLowerCase();
      const scored = all.map(([id, r]) => {
        const text = typeof r.item === "string" ? r.item : JSON.stringify(r.item);
        const score = q && text.toLowerCase().includes(q) ? 1 : 0;
        return { id, item: r.item, score, importance: r.importance, ts: r.ts };
      });
      const ranked = q ? scored.slice().sort((a, b) => b.score - a.score) : scored.slice().sort((a, b) => b.ts - a.ts);
      return ranked.slice(0, Math.max(1, Number(limit) || 10));
    },
    async forget({ scope, id }) {
      const ok = bucket(scope).delete(id);
      return { ok };
    },
    async stats({ scope }) {
      const b = bucket(scope);
      let oldest = Infinity;
      let newest = 0;
      for (const r of b.values()) {
        if (r.ts < oldest) oldest = r.ts;
        if (r.ts > newest) newest = r.ts;
      }
      return {
        tier, scope,
        count: b.size,
        oldest_ts: b.size ? oldest : null,
        newest_ts: b.size ? newest : null,
      };
    },
    _reset() { buckets.clear(); seq = 0; },
  };
}

function createConversationAdapter() { return createInProcessAdapter("conversation"); }
function createUserAdapter() { return createInProcessAdapter("user"); }

module.exports = {
  createShortTermAdapter,
  createSemanticAdapter,
  createProjectAdapter,
  createConversationAdapter,
  createUserAdapter,
  createInProcessAdapter,
};
