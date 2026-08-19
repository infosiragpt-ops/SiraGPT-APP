'use strict';

/**
 * memory-promotion-applier — bridges memory-promotion-lifecycle
 * (pure decisions) to memory-store (mutating side-effects).
 *
 * Why this exists:
 *  `memory-promotion-lifecycle.js` decides what should happen — which
 *  turns get promoted to long-term, which long-term facts should
 *  decay, which conflicts to merge. But it deliberately doesn't touch
 *  the memory store. This module is the bridge: hand it a memory
 *  store adapter + a window of short-term turns and it APPLIES the
 *  decisions, returning a structured audit log.
 *
 *  Designed to run as a periodic batch job (every N turns or every
 *  hour, whichever fires first) rather than synchronously inside
 *  the chat path — keeps the user's reply latency unchanged.
 *
 *  The adapter is duck-typed; any object exposing the methods
 *  documented below works. The expected memory-layer / memory-store
 *  surface already matches:
 *
 *    adapter.listTurns(userId, opts?)        → Array<Turn>
 *    adapter.listFacts(userId, opts?)        → Array<Fact>
 *    adapter.setFact(userId, key, value)     → Promise<Fact> | Fact
 *    adapter.deleteFact(userId, key)         → Promise<void> | void
 *
 *  When a method is missing the applier degrades gracefully — it
 *  records a skip with a reason and keeps going.
 *
 * Public API:
 *   applyPromotionPlan(adapter, userId, opts?) → Promise<ApplyReport>
 *   runDecayAndMerge(adapter, userId, opts?)   → Promise<DecayMergeReport>
 *   buildBatchCycle(adapter, userId, opts?)    → Promise<FullCycleReport>
 *
 * Side-effects: only those the adapter performs. This module is
 * deterministic per adapter behaviour and exceptions are swallowed
 * with structured error records.
 */

const lifecycle = require('./memory-promotion-lifecycle');

const DEFAULT_WINDOW = Number(process.env.SIRAGPT_MEMORY_APPLIER_WINDOW) || 60;

// ─── Adapter helpers ──────────────────────────────────────────────

async function safeAwait(value) {
  if (value && typeof value.then === 'function') {
    try { return await value; } catch (err) { throw err; }
  }
  return value;
}

function pickList(value) {
  return Array.isArray(value) ? value : [];
}

function factKey(fact) {
  if (!fact) return null;
  return fact.key
    || fact.id
    || fact.subject
    || (typeof fact.text === 'string' ? fact.text.slice(0, 60) : null);
}

// ─── Public: apply a promotion plan ───────────────────────────────

async function applyPromotionPlan(adapter, userId, opts = {}) {
  if (!adapter || !userId) {
    return { ok: false, error: 'missing adapter or userId', applied: 0 };
  }
  const window = opts.window || DEFAULT_WINDOW;

  let turns = [];
  let facts = [];
  try {
    turns = pickList(await safeAwait(adapter.listTurns?.(userId, { limit: window })));
  } catch (err) {
    return { ok: false, error: `listTurns failed: ${err.message || err}`, applied: 0 };
  }
  try {
    facts = pickList(await safeAwait(adapter.listFacts?.(userId, { limit: 200 })));
  } catch {
    facts = [];
  }

  const plan = lifecycle.decidePromotions(turns, facts, { now: opts.now });

  const audit = {
    promoted: [],
    monitored: [],
    skipped: [],
    errors: [],
  };

  // Apply promotions
  for (const entry of plan.promote) {
    if (!entry || !entry.turn) continue;
    const turn = entry.turn;
    const key = `promoted::${factKey(turn) || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
    const value = {
      text: turn.text || turn.content || '',
      confidence: entry.score?.score ?? 0.7,
      timestamp: new Date().toISOString(),
      reinforcementCount: 0,
      promoted_from: 'short_term',
      promotion_signals: entry.score?.signals || {},
    };
    if (typeof adapter.setFact !== 'function') {
      audit.errors.push({ key, error: 'adapter.setFact not available' });
      continue;
    }
    try {
      await safeAwait(adapter.setFact(userId, key, value));
      audit.promoted.push({ key, score: entry.score?.score, reason: entry.score?.reason });
    } catch (err) {
      audit.errors.push({ key, error: err.message || String(err) });
    }
  }

  // Record monitored (for follow-up cycle decisions) and skipped
  for (const entry of plan.monitor) {
    audit.monitored.push({
      text: (entry.turn?.text || entry.turn?.content || '').slice(0, 60),
      score: entry.score?.score,
    });
  }
  for (const entry of plan.skip) {
    if (entry.score?.decision === 'skip' || entry.reason === 'already in long-term memory') {
      audit.skipped.push({
        text: (entry.turn?.text || entry.turn?.content || '').slice(0, 60),
        reason: entry.reason || entry.score?.reason,
      });
    }
  }

  return {
    ok: true,
    applied: audit.promoted.length,
    audit,
    summary: plan.summary,
  };
}

// ─── Public: decay + merge over long-term facts ──────────────────

async function runDecayAndMerge(adapter, userId, opts = {}) {
  if (!adapter || !userId) {
    return { ok: false, error: 'missing adapter or userId' };
  }
  let facts = [];
  try {
    facts = pickList(await safeAwait(adapter.listFacts?.(userId, { limit: 5000 })));
  } catch (err) {
    return { ok: false, error: `listFacts failed: ${err.message || err}` };
  }
  if (facts.length === 0) {
    return { ok: true, decay: { decisions: [], summary: { total: 0, keep: 0, downgrade: 0, forget: 0 } }, merge: { kept: [], superseded: [], conflicts: [] }, applied: { forgotten: 0, mergedSuperseded: 0 } };
  }

  // Decay first
  const decay = lifecycle.decayLongTermFacts(facts, opts);

  const applied = { forgotten: 0, mergedSuperseded: 0, errors: [] };

  for (const decision of decay.decisions) {
    if (decision.action !== 'forget') continue;
    const key = factKey(decision.fact);
    if (!key) continue;
    if (typeof adapter.deleteFact !== 'function') {
      applied.errors.push({ key, error: 'adapter.deleteFact not available' });
      continue;
    }
    try {
      await safeAwait(adapter.deleteFact(userId, key));
      applied.forgotten++;
    } catch (err) {
      applied.errors.push({ key, error: err.message || String(err) });
    }
  }

  // Merge — only run after decay-removals so we operate on the
  // surviving population
  const survivors = facts.filter(f => {
    const d = decay.decisions.find(x => x.fact === f);
    return !d || d.action !== 'forget';
  });
  const merge = lifecycle.mergeConflictingFacts(survivors);

  for (const sup of merge.superseded) {
    const key = factKey(sup.fact);
    if (!key) continue;
    if (typeof adapter.deleteFact !== 'function') continue;
    try {
      await safeAwait(adapter.deleteFact(userId, key));
      applied.mergedSuperseded++;
    } catch (err) {
      applied.errors.push({ key, error: err.message || String(err) });
    }
  }

  return { ok: true, decay, merge, applied };
}

// ─── Public: full cycle ────────────────────────────────────────

async function buildBatchCycle(adapter, userId, opts = {}) {
  const startedAt = Date.now();
  const promotion = await applyPromotionPlan(adapter, userId, opts);
  const lifecycleReport = await runDecayAndMerge(adapter, userId, opts);
  return {
    userId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    promotion,
    lifecycle: lifecycleReport,
    summary: {
      promoted: promotion?.applied || 0,
      forgotten: lifecycleReport?.applied?.forgotten || 0,
      mergedSuperseded: lifecycleReport?.applied?.mergedSuperseded || 0,
    },
  };
}

module.exports = {
  applyPromotionPlan,
  runDecayAndMerge,
  buildBatchCycle,
  _internal: { factKey, pickList, safeAwait },
};
