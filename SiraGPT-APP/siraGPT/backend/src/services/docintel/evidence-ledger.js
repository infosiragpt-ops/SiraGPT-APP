/**
 * evidence-ledger — append-only audit trail for claim ↔ source bindings.
 *
 * Every time the Document Intelligence layer grounds a claim in a
 * source (via citation-grounding.js), the binding is recorded here
 * with a stable fingerprint so that:
 *
 *   1. The QA Board can replay the grounding decision offline.
 *   2. We can detect if the same claim gets bound to contradicting
 *      sources later (see contradiction-detector.js).
 *   3. The HITL review surface can show "why did the system believe X?"
 *
 * Each entry is content-addressed by SHA-256 of the canonicalized
 * { claim_norm, source_id, quote_norm } triple so the ledger is
 * deduplicating and tamper-evident when persisted.
 *
 * State is in-memory + exportable. External persistence is left to
 * the caller (so tests can stay deterministic and the ledger can be
 * bound to a DB, filesystem, or S3 elsewhere).
 */

const crypto = require("crypto");

const VERDICTS = Object.freeze(["verified", "unverified", "contradicted", "withdrawn"]);

function createLedger() {
  const entries = new Map(); // id → entry
  const byClaim = new Map(); // claim_norm → Set<id>
  const bySource = new Map(); // source_id → Set<id>

  function recordBinding({ claim, source_id, quote = "", confidence = 0, verdict = "verified", context = {} } = {}) {
    if (typeof claim !== "string" || claim.trim().length === 0) {
      throw new Error("evidence-ledger: claim (non-empty string) required");
    }
    if (!source_id || typeof source_id !== "string") {
      throw new Error("evidence-ledger: source_id (string) required");
    }
    if (!VERDICTS.includes(verdict)) {
      throw new Error(`evidence-ledger: invalid verdict "${verdict}"`);
    }

    const claim_norm = normalize(claim);
    const quote_norm = normalize(quote);
    const id = fingerprint(claim_norm, source_id, quote_norm);

    const existing = entries.get(id);
    if (existing) {
      existing.seen_count += 1;
      existing.last_seen_at = new Date().toISOString();
      return { id, entry: existing, deduped: true };
    }

    const entry = {
      id,
      claim,
      claim_norm,
      source_id,
      quote,
      quote_norm,
      confidence: clamp01(confidence),
      verdict,
      context,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      seen_count: 1,
    };
    entries.set(id, entry);
    addToIndex(byClaim, claim_norm, id);
    addToIndex(bySource, source_id, id);
    return { id, entry, deduped: false };
  }

  function markContradicted(id, reason) {
    const e = entries.get(id);
    if (!e) return null;
    e.verdict = "contradicted";
    e.contradiction_reason = reason || null;
    e.updated_at = new Date().toISOString();
    return e;
  }

  function markWithdrawn(id, reason) {
    const e = entries.get(id);
    if (!e) return null;
    e.verdict = "withdrawn";
    e.withdrawal_reason = reason || null;
    e.updated_at = new Date().toISOString();
    return e;
  }

  function findByClaim(claim) {
    const key = normalize(claim);
    const ids = byClaim.get(key);
    if (!ids) return [];
    return [...ids].map(id => entries.get(id)).filter(Boolean);
  }

  function findBySource(source_id) {
    const ids = bySource.get(source_id);
    if (!ids) return [];
    return [...ids].map(id => entries.get(id)).filter(Boolean);
  }

  function snapshot() {
    return [...entries.values()].map(e => ({ ...e }));
  }

  function stats() {
    const out = { total: entries.size, by_verdict: { verified: 0, unverified: 0, contradicted: 0, withdrawn: 0 }, unique_claims: byClaim.size, unique_sources: bySource.size };
    for (const e of entries.values()) out.by_verdict[e.verdict] = (out.by_verdict[e.verdict] || 0) + 1;
    return out;
  }

  function importSnapshot(arr) {
    if (!Array.isArray(arr)) throw new Error("evidence-ledger: importSnapshot expects an array");
    let imported = 0;
    for (const e of arr) {
      if (!e || !e.id || !e.claim_norm || !e.source_id) continue;
      if (entries.has(e.id)) continue;
      entries.set(e.id, { ...e });
      addToIndex(byClaim, e.claim_norm, e.id);
      addToIndex(bySource, e.source_id, e.id);
      imported += 1;
    }
    return { imported };
  }

  function verifyIntegrity() {
    for (const e of entries.values()) {
      const rehash = fingerprint(e.claim_norm, e.source_id, e.quote_norm);
      if (rehash !== e.id) return { ok: false, bad_id: e.id, expected: rehash };
    }
    return { ok: true };
  }

  return {
    recordBinding,
    markContradicted,
    markWithdrawn,
    findByClaim,
    findBySource,
    snapshot,
    stats,
    importSnapshot,
    verifyIntegrity,
  };
}

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, " ").trim();
}

function fingerprint(claim_norm, source_id, quote_norm) {
  const h = crypto.createHash("sha256");
  h.update("claim:"); h.update(claim_norm); h.update("|");
  h.update("source:"); h.update(source_id); h.update("|");
  h.update("quote:"); h.update(quote_norm);
  return h.digest("hex").slice(0, 32);
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function addToIndex(index, key, id) {
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(id);
}

module.exports = {
  createLedger,
  VERDICTS,
};
