/**
 * gist-memory — multi-step proximal-triple accumulator for GEAR.
 *
 * Section 5.1 of the GEAR paper (Shen et al., ACL 2025) introduces a
 * per-session "gist memory" G^(n) that grows with each iteration of
 * the agent loop. It stores the proximal triples extracted at each step
 * (Eq. 4–5). Subsequent `read` calls pass the accumulated memory into
 * the prompt so the LLM can produce proximal triples that complement
 * what's already known, instead of re-stating facts from earlier hops.
 *
 * This module is intentionally session-scoped rather than user-scoped:
 * the memory must reset when a conversation ends, because G^(n) is
 * tied to the *query decomposition* q^(1)…q^(n), not to the user's
 * long-term profile (that's what long-term-memory.js handles).
 *
 * Minimal API:
 *   append(sessionId, triples[])   — add iteration n's proximal triples
 *   get(sessionId)                 — all accumulated triples, in order
 *   clear(sessionId)
 *   stats(sessionId)
 *
 * The TTL sweep keeps abandoned sessions from leaking memory — every
 * append bumps `lastTouched` and anything stale beyond SESSION_TTL_MS
 * is dropped on the next append.
 */

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRIPLES_PER_SESSION = 200;

const sessions = new Map(); // sessionId → { triples: Triple[], lastTouched: number }

function now() { return Date.now(); }

function sweepExpired() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastTouched < cutoff) sessions.delete(id);
  }
}

function tripleIdentity(t) {
  return `${(t.subject || '').toLowerCase()}|${(t.predicate || '').toLowerCase()}|${(t.object || '').toLowerCase()}`;
}

/**
 * Append this iteration's proximal triples. Dedupes against already-
 * stored triples so a fact that appears in two consecutive hops doesn't
 * clog the memory. Oldest-wins eviction caps total size.
 *
 * Returns `{ appended, total }`.
 */
function append(sessionId, triples) {
  if (!sessionId || !Array.isArray(triples) || triples.length === 0) {
    return { appended: 0, total: 0 };
  }

  // Sweep cheaply — only runs when a session is touched.
  sweepExpired();

  let session = sessions.get(sessionId);
  if (!session) {
    session = { triples: [], lastTouched: now(), known: new Set() };
    sessions.set(sessionId, session);
  }

  let appended = 0;
  for (const t of triples) {
    if (!t || !t.subject || !t.predicate || !t.object) continue;
    const id = tripleIdentity(t);
    if (session.known.has(id)) continue;
    session.known.add(id);
    session.triples.push(t);
    appended++;
  }

  if (session.triples.length > MAX_TRIPLES_PER_SESSION) {
    const drop = session.triples.length - MAX_TRIPLES_PER_SESSION;
    const removed = session.triples.splice(0, drop);
    for (const r of removed) session.known.delete(tripleIdentity(r));
  }

  session.lastTouched = now();
  return { appended, total: session.triples.length };
}

function get(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  if (session.lastTouched < now() - SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return [];
  }
  return session.triples.slice();
}

function clear(sessionId) {
  sessions.delete(sessionId);
}

function clearAll() {
  sessions.clear();
}

function stats(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { triples: 0, lastTouched: null };
  return {
    triples: session.triples.length,
    lastTouched: session.lastTouched,
    ageMs: now() - session.lastTouched,
  };
}

module.exports = {
  append,
  get,
  clear,
  clearAll,
  stats,
  SESSION_TTL_MS,
  MAX_TRIPLES_PER_SESSION,
  // exported for tests
  tripleIdentity,
};
