'use strict';

/**
 * RLCD — Reinforcement Learning for Calibrated Decisions.
 *
 * SiraGPT takes several typed decisions per turn (intent triage, execution
 * lane, model route, compute mode) and each one comes with a stated
 * confidence. Until now nothing checked whether a 0.9 was right 90% of the
 * time. This ledger records every decision with its confidence, joins the
 * turn's outcome later (thumbs, regenerate, provider failure, faithfulness,
 * constraint miss) by messageId / chat, and keeps reliability bins per
 * decision kind so the software can:
 *   - report calibration (ECE, Brier, per-bin accuracy) at /api/rlcd/stats
 *     and /metrics (sira_rlcd_*);
 *   - return a *calibrated* probability for a raw confidence
 *     (`calibrated(kind, confidence)`), which the execution-lane decision
 *     uses to route coding turns into the agentic loop.
 *
 * In-memory and bounded like routing-feedback; `snapshot()/load()` allow an
 * operator to persist. Recording never throws.
 */

const BIN_COUNT = 10;
const MIN_BIN_SAMPLES = Number(process.env.SIRAGPT_RLCD_MIN_BIN_SAMPLES) || 5;
const PRIOR_WEIGHT = Number(process.env.SIRAGPT_RLCD_PRIOR_WEIGHT) || 5;
const MAX_DECISIONS = Number(process.env.SIRAGPT_RLCD_MAX_DECISIONS) || 20000;
const MAX_CHATS = 5000;
const RECENT_RING = Number(process.env.SIRAGPT_RLCD_RECENT_RING) || 200;

const DECISION_KINDS = Object.freeze(['intent_triage', 'execution_lane', 'model_route', 'compute_mode', 'media_intent']);

const OUTCOME_LABELS = Object.freeze({
  success: 1,
  liked: 1,
  high_faithfulness: 1,
  tool_success: 1,
  failure: 0,
  disliked: 0,
  regenerated: 0,
  provider_failure: 0,
  ttfb_abort: 0,
  low_faithfulness: 0,
  constraint_violation: 0,
});

let seq = 0;
let decisions = new Map(); // id → decision
let byMessage = new Map(); // messageId → [ids]
let lastByChat = new Map(); // chatId → [ids] (most recent turn)
let bins = new Map(); // kind → Array(BIN_COUNT) of { n, sumConf, pos, brier }
let counters = freshCounters();
let recent = []; // newest last, capped at RECENT_RING; entries are the live decision objects
let dirty = false; // true when something changed since the last persisted snapshot

function freshCounters() {
  return {
    decisions: 0,
    outcomes: 0,
    outcomesUnmatched: 0,
    byKind: Object.create(null),
    byOutcome: Object.create(null),
    laneForced: 0,
    laneConsulted: 0,
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function binIndex(conf) {
  return Math.min(BIN_COUNT - 1, Math.floor(conf * BIN_COUNT));
}

function binsFor(kind) {
  if (!bins.has(kind)) {
    bins.set(kind, Array.from({ length: BIN_COUNT }, () => ({ n: 0, sumConf: 0, pos: 0, brier: 0 })));
  }
  return bins.get(kind);
}

function bump(obj, key, by = 1) {
  if (key == null || key === '') return;
  obj[key] = (obj[key] || 0) + by;
}

function evictIfNeeded() {
  while (decisions.size > MAX_DECISIONS) {
    const oldest = decisions.keys().next().value;
    const d = decisions.get(oldest);
    decisions.delete(oldest);
    if (d && d.messageId && byMessage.has(d.messageId)) {
      const rest = byMessage.get(d.messageId).filter((id) => id !== oldest);
      if (rest.length) byMessage.set(d.messageId, rest); else byMessage.delete(d.messageId);
    }
  }
  while (lastByChat.size > MAX_CHATS) {
    lastByChat.delete(lastByChat.keys().next().value);
  }
}

/**
 * Record one typed decision. Returns the decision id (or null when the
 * input is unusable). `signature` groups decisions for reporting (e.g.
 * "chat|moderate|grok-4.6").
 */
function recordDecision({ kind, choice, confidence, signature = null, chatId = null, meta = null } = {}) {
  try {
    const k = String(kind || '').trim();
    const conf = clamp01(confidence);
    if (!k || conf == null) return null;
    seq += 1;
    const id = `d${Date.now().toString(36)}${seq.toString(36)}`;
    const decision = {
      id,
      kind: k,
      choice: choice == null ? null : String(choice).slice(0, 80),
      confidence: Math.round(conf * 1000) / 1000,
      signature: signature ? String(signature).slice(0, 160) : null,
      chatId: chatId ? String(chatId) : null,
      meta: meta && typeof meta === 'object' ? meta : null,
      createdAt: Date.now(),
      messageId: null,
      outcome: null,
    };
    decisions.set(id, decision);
    recent.push(decision);
    if (recent.length > RECENT_RING) recent.splice(0, recent.length - RECENT_RING);
    counters.decisions += 1;
    dirty = true;
    bump(counters.byKind, k);
    evictIfNeeded();
    return id;
  } catch {
    return null;
  }
}

/** Mark these decisions as the current turn of `chatId` (for regenerate). */
function markTurn(chatId, ids) {
  try {
    if (!chatId || !Array.isArray(ids) || !ids.length) return;
    lastByChat.set(String(chatId), ids.filter((id) => decisions.has(id)));
    evictIfNeeded();
  } catch { /* never throws */ }
}

/** Add decisions to the current turn of `chatId` without dropping earlier ones. */
function appendTurn(chatId, ids) {
  try {
    if (!chatId || !Array.isArray(ids) || !ids.length) return;
    const key = String(chatId);
    const current = lastByChat.get(key) || [];
    const merged = Array.from(new Set([...current, ...ids])).filter((id) => decisions.has(id));
    lastByChat.set(key, merged);
    evictIfNeeded();
  } catch { /* never throws */ }
}

/** Join decisions to the persisted assistant message. */
function bindMessage(ids, messageId) {
  try {
    if (!messageId || !Array.isArray(ids)) return 0;
    const mid = String(messageId);
    let bound = 0;
    for (const id of ids) {
      const d = decisions.get(id);
      if (!d) continue;
      d.messageId = mid;
      bound += 1;
    }
    if (bound) byMessage.set(mid, ids.filter((id) => decisions.has(id)));
    return bound;
  } catch {
    return 0;
  }
}

function applyOutcome(decision, label, value, source) {
  const previous = decision.outcome;
  decision.outcome = { label, value, source: source || null, at: Date.now() };
  const arr = binsFor(decision.kind);
  const b = arr[binIndex(decision.confidence)];
  if (previous) {
    // A later signal (thumb after an implicit failure) replaces the earlier
    // one for this decision instead of double counting.
    b.n -= 1;
    b.sumConf -= decision.confidence;
    b.pos -= previous.value;
    b.brier -= (decision.confidence - previous.value) ** 2;
  }
  b.n += 1;
  b.sumConf += decision.confidence;
  b.pos += value;
  b.brier += (decision.confidence - value) ** 2;
  dirty = true;
}

/**
 * Record an outcome for the decisions of a message (`messageId`), the most
 * recent turn of a chat (`chatId`) or explicit `decisionIds`.
 * `outcome` is one of OUTCOME_LABELS. Returns the number of decisions updated.
 */
function recordOutcome({ messageId = null, chatId = null, decisionIds = null, outcome, source = null } = {}) {
  try {
    const label = String(outcome || '').toLowerCase().trim();
    if (!(label in OUTCOME_LABELS)) return 0;
    const value = OUTCOME_LABELS[label];
    let ids = Array.isArray(decisionIds) ? decisionIds : null;
    if (!ids && messageId && byMessage.has(String(messageId))) ids = byMessage.get(String(messageId));
    if (!ids && chatId && lastByChat.has(String(chatId))) ids = lastByChat.get(String(chatId));
    if (!ids || !ids.length) {
      counters.outcomesUnmatched += 1;
      return 0;
    }
    let updated = 0;
    for (const id of ids) {
      const d = decisions.get(id);
      if (!d) continue;
      applyOutcome(d, label, value, source);
      updated += 1;
    }
    if (updated) {
      counters.outcomes += 1;
      bump(counters.byOutcome, label);
    } else {
      counters.outcomesUnmatched += 1;
    }
    return updated;
  } catch {
    return 0;
  }
}

/**
 * Calibrated probability that a decision of `kind` taken with `confidence`
 * ends well. Shrinks the observed accuracy of the confidence bin toward the
 * raw confidence with PRIOR_WEIGHT pseudo-samples, so it equals the raw
 * value with no data and converges to the observed rate as evidence grows.
 */
function calibrated(kind, confidence) {
  const conf = clamp01(confidence);
  if (conf == null) return { calibrated: null, raw: null, samples: 0, observed: null };
  const arr = bins.get(String(kind));
  const b = arr ? arr[binIndex(conf)] : null;
  const n = b ? b.n : 0;
  const observed = n > 0 ? b.pos / n : null;
  const value = (conf * PRIOR_WEIGHT + (b ? b.pos : 0)) / (PRIOR_WEIGHT + n);
  return {
    calibrated: Math.round(value * 1000) / 1000,
    raw: conf,
    samples: n,
    observed: observed == null ? null : Math.round(observed * 1000) / 1000,
    reliable: n >= MIN_BIN_SAMPLES,
  };
}

function reliabilityFor(kind) {
  const arr = bins.get(String(kind));
  if (!arr) return { kind, samples: 0, ece: null, brier: null, accuracy: null, bins: [] };
  let total = 0;
  let ece = 0;
  let brier = 0;
  let pos = 0;
  const out = arr.map((b, i) => {
    total += b.n;
    pos += b.pos;
    brier += b.brier;
    const acc = b.n ? b.pos / b.n : null;
    const avgConf = b.n ? b.sumConf / b.n : null;
    return {
      range: [Math.round((i / BIN_COUNT) * 100) / 100, Math.round(((i + 1) / BIN_COUNT) * 100) / 100],
      samples: b.n,
      accuracy: acc == null ? null : Math.round(acc * 1000) / 1000,
      avgConfidence: avgConf == null ? null : Math.round(avgConf * 1000) / 1000,
      gap: acc == null ? null : Math.round((acc - avgConf) * 1000) / 1000,
    };
  });
  if (total) {
    for (const b of arr) {
      if (!b.n) continue;
      ece += (b.n / total) * Math.abs(b.pos / b.n - b.sumConf / b.n);
    }
  }
  return {
    kind,
    samples: total,
    ece: total ? Math.round(ece * 1000) / 1000 : null,
    brier: total ? Math.round((brier / total) * 1000) / 1000 : null,
    accuracy: total ? Math.round((pos / total) * 1000) / 1000 : null,
    bins: out,
  };
}

function snapshot() {
  return {
    version: 2,
    decisions: counters.decisions,
    outcomes: counters.outcomes,
    outcomesUnmatched: counters.outcomesUnmatched,
    pending: decisions.size,
    byKind: { ...counters.byKind },
    byOutcome: { ...counters.byOutcome },
    lane: { consulted: counters.laneConsulted, forced: counters.laneForced },
    reliability: Array.from(new Set([...DECISION_KINDS, ...bins.keys()])).map(reliabilityFor),
    bins: Object.fromEntries(Array.from(bins.entries()).map(([k, arr]) => [k, arr.map((b) => ({ ...b }))])),
  };
}

/**
 * Durable subset of the state: reliability bins + counters. Pending
 * decisions are short-lived (they need an outcome within the session) and
 * are deliberately not persisted.
 */
function persistable() {
  return {
    version: 2,
    savedAt: Date.now(),
    counters: {
      decisions: counters.decisions,
      outcomes: counters.outcomes,
      outcomesUnmatched: counters.outcomesUnmatched,
      byKind: { ...counters.byKind },
      byOutcome: { ...counters.byOutcome },
      laneForced: counters.laneForced,
      laneConsulted: counters.laneConsulted,
    },
    bins: Object.fromEntries(Array.from(bins.entries()).map(([k, arr]) => [k, arr.map((b) => ({ n: b.n, sumConf: b.sumConf, pos: b.pos, brier: b.brier }))])),
  };
}

/** Last decisions (newest first) with their outcome, for the admin panel. */
function recentDecisions({ limit = 50, kind = null } = {}) {
  const n = Math.max(1, Math.min(RECENT_RING, Number(limit) || 50));
  const out = [];
  for (let i = recent.length - 1; i >= 0 && out.length < n; i -= 1) {
    const d = recent[i];
    if (kind && d.kind !== kind) continue;
    out.push({
      id: d.id,
      kind: d.kind,
      choice: d.choice,
      confidence: d.confidence,
      signature: d.signature,
      chatId: d.chatId ? `${String(d.chatId).slice(0, 6)}…` : null,
      source: d.meta && d.meta.source ? d.meta.source : 'heuristic',
      createdAt: d.createdAt,
      outcome: d.outcome ? { label: d.outcome.label, value: d.outcome.value, source: d.outcome.source, at: d.outcome.at } : null,
    });
  }
  return out;
}

function isDirty() { return dirty; }
function markClean() { dirty = false; }

function load(obj) {
  try {
    if (!obj || typeof obj !== 'object' || !obj.bins) return false;
    if (obj.counters && typeof obj.counters === 'object') {
      const c = obj.counters;
      counters.decisions = Number(c.decisions) || 0;
      counters.outcomes = Number(c.outcomes) || 0;
      counters.outcomesUnmatched = Number(c.outcomesUnmatched) || 0;
      counters.byKind = { ...(c.byKind && typeof c.byKind === 'object' ? c.byKind : {}) };
      counters.byOutcome = { ...(c.byOutcome && typeof c.byOutcome === 'object' ? c.byOutcome : {}) };
      counters.laneForced = Number(c.laneForced) || 0;
      counters.laneConsulted = Number(c.laneConsulted) || 0;
    }
    for (const [k, arr] of Object.entries(obj.bins)) {
      if (!Array.isArray(arr) || arr.length !== BIN_COUNT) continue;
      bins.set(k, arr.map((b) => ({
        n: Number(b.n) || 0,
        sumConf: Number(b.sumConf) || 0,
        pos: Number(b.pos) || 0,
        brier: Number(b.brier) || 0,
      })));
    }
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function noteLane({ consulted = false, forced = false } = {}) {
  if (consulted) counters.laneConsulted += 1;
  if (forced) counters.laneForced += 1;
  if (consulted || forced) dirty = true;
}

function toPrometheusText() {
  const s = snapshot();
  const lines = [];
  const push = (name, help, type, samples) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    if (!samples.length) { lines.push(`${name} 0`); return; }
    for (const [labels, val] of samples) lines.push(labels ? `${name}{${labels}} ${val}` : `${name} ${val}`);
  };
  push('sira_rlcd_decisions_total', 'Typed decisions recorded with a stated confidence', 'counter', [['', s.decisions]]);
  push('sira_rlcd_decisions_kind', 'Decisions by kind', 'counter', Object.entries(s.byKind).map(([k, v]) => [`kind="${k}"`, v]));
  push('sira_rlcd_outcomes_total', 'Outcomes joined to a decision', 'counter', [['', s.outcomes]]);
  push('sira_rlcd_outcomes_unmatched_total', 'Outcomes that found no decision to join', 'counter', [['', s.outcomesUnmatched]]);
  push('sira_rlcd_outcome_label', 'Outcomes by label', 'counter', Object.entries(s.byOutcome).map(([k, v]) => [`label="${k}"`, v]));
  push('sira_rlcd_lane_consulted_total', 'Execution-lane decisions that consulted the calibrated probability', 'counter', [['', s.lane.consulted]]);
  push('sira_rlcd_lane_forced_total', 'Execution-lane decisions forced into the agentic loop by calibration', 'counter', [['', s.lane.forced]]);
  const withData = s.reliability.filter((r) => r.samples > 0);
  push('sira_rlcd_ece', 'Expected calibration error per decision kind', 'gauge', withData.map((r) => [`kind="${r.kind}"`, r.ece]));
  push('sira_rlcd_brier', 'Brier score per decision kind', 'gauge', withData.map((r) => [`kind="${r.kind}"`, r.brier]));
  push('sira_rlcd_accuracy', 'Observed success rate per decision kind', 'gauge', withData.map((r) => [`kind="${r.kind}"`, r.accuracy]));
  return `${lines.join('\n')}\n`;
}

function reset() {
  seq = 0;
  decisions = new Map();
  byMessage = new Map();
  lastByChat = new Map();
  bins = new Map();
  counters = freshCounters();
  recent = [];
  dirty = false;
}

function getDecision(id) {
  const d = decisions.get(id);
  return d ? { ...d } : null;
}

module.exports = {
  DECISION_KINDS,
  OUTCOME_LABELS,
  BIN_COUNT,
  MIN_BIN_SAMPLES,
  PRIOR_WEIGHT,
  recordDecision,
  markTurn,
  appendTurn,
  bindMessage,
  recordOutcome,
  calibrated,
  reliabilityFor,
  noteLane,
  snapshot,
  persistable,
  recentDecisions,
  isDirty,
  markClean,
  RECENT_RING,
  load,
  toPrometheusText,
  reset,
  getDecision,
  size: () => decisions.size,
};
