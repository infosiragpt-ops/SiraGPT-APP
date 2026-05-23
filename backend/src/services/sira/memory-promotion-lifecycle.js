'use strict';

/**
 * memory-promotion-lifecycle — deterministic policy for promoting facts
 * between memory tiers (short-term → long-term) and decaying stale ones.
 *
 * Why this exists:
 *  `memory-store.js` and `memory-store-adapters.js` provide CRUD over the
 *  short_term / long_term / file / semantic / graph tiers. What was
 *  missing: a deterministic POLICY that decides WHICH short-term turns
 *  should be promoted to long-term, and WHEN long-term facts should be
 *  decayed or merged when they conflict.
 *
 *  Without a promotion policy:
 *    - every fact becomes long-term → context pollution at recall time
 *    - or nothing is promoted → no continuity between sessions
 *
 * This module is pure, deterministic, dependency-free. It does not call
 * the memory store itself — it returns DECISIONS the caller applies.
 *
 * Public API:
 *   scoreTurnForPromotion(turn, opts?)                → PromotionScore
 *   decidePromotions(turns, existingFacts?, opts?)    → PromotionPlan
 *   decayLongTermFacts(facts, opts?)                  → DecayPlan
 *   mergeConflictingFacts(facts, opts?)               → MergePlan
 *
 * PromotionScore shape:
 *   {
 *     score:       number (0..1),
 *     signals:     { repetitions, importance, freshness, explicitTag, factual },
 *     decision:    'promote' | 'monitor' | 'skip',
 *     reason:      string,
 *   }
 */

// ─── Tunables (env-overridable) ──────────────────────────────────────

const PROMOTE_THRESHOLD = Number(process.env.SIRAGPT_MEMORY_PROMOTE_THRESHOLD) || 0.55;
const MONITOR_THRESHOLD = Number(process.env.SIRAGPT_MEMORY_MONITOR_THRESHOLD) || 0.3;
const REPETITION_WEIGHT = 0.20;
const IMPORTANCE_WEIGHT = 0.30;
const FRESHNESS_WEIGHT = 0.10;
const EXPLICIT_TAG_WEIGHT = 0.15;
const FACTUAL_WEIGHT = 0.25;
const DECAY_HALF_LIFE_DAYS = Number(process.env.SIRAGPT_MEMORY_DECAY_HALF_LIFE_DAYS) || 60;
const HARD_FORGET_THRESHOLD = Number(process.env.SIRAGPT_MEMORY_FORGET_THRESHOLD) || 0.12;

// ─── Importance signals ──────────────────────────────────────────────

// User-explicit signals: "remember", "save this", "important note", etc.
const EXPLICIT_PROMOTE_PATTERNS = [
  /\b(?:remember|save|store|don[' ]?t\s+forget|keep\s+in\s+mind|importante|recuerda|guarda(?:r)?|no\s+olvides)\b/i,
  /\b(?:my\s+(?:name|email|phone|address|birthday|preference|allergy|deadline)|mi\s+(?:nombre|email|tel[eé]fono|direcci[oó]n|cumplea[ñn]os|preferencia|alergia|fecha\s+l[ií]mite))\b/i,
  /\b(?:I\s+(?:always|prefer|hate|love|need)|siempre|prefiero|odio|amo|necesito)\b/i,
];

// "Factual" signal: turn contains specific, persistent data (dates, IDs,
// proper nouns, currencies, percentages) — more worth promoting than
// chit-chat or ephemeral commands.
const FACTUAL_TOKEN_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,            // ISO date
  /\b(?:19|20)\d{2}\b/,                // 4-digit year
  /[$€£¥]\s?\d+/,                       // currency
  /\b\d+\s?%/,                          // percent
  /\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\b/, // proper name
  /\b[A-Z]{2,}[A-Z0-9]*\b/,            // acronym / SKU
  /\bhttps?:\/\/\S+/,                   // URL
];

// Anti-promote patterns (chit-chat, commands, ephemerals)
const EPHEMERAL_PATTERNS = [
  /^\s*(?:hi|hello|hola|gracias|thanks?|ok(?:ay)?|bye|adi[oó]s|test|ping|hmm+|yes|no|s[ií]|claro)\s*[!.?]?\s*$/i,
  /^\s*(?:open|cierra|close|abre|run|ejecuta|stop|para|now|ahora)\b/i,
];

// ─── Helpers ─────────────────────────────────────────────────────────

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function clamp(n, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, n));
}

function countRepetitions(turn, allTurns) {
  if (!turn || !Array.isArray(allTurns) || allTurns.length === 0) return 0;
  const text = safeText(turn.text || turn.content || '').toLowerCase();
  if (text.length < 4) return 0;
  // Token-set similarity over allTurns (excluding self)
  const turnTokens = new Set(text.match(/[\p{L}\p{N}]{3,}/gu) || []);
  if (turnTokens.size === 0) return 0;
  let mentions = 0;
  for (const other of allTurns) {
    if (other === turn) continue;
    const otherText = safeText(other.text || other.content || '').toLowerCase();
    const otherTokens = new Set(otherText.match(/[\p{L}\p{N}]{3,}/gu) || []);
    if (otherTokens.size === 0) continue;
    let overlap = 0;
    for (const t of turnTokens) if (otherTokens.has(t)) overlap++;
    const ratio = overlap / turnTokens.size;
    if (ratio >= 0.4) mentions++;
  }
  return mentions;
}

function importanceFromLength(text) {
  // Longer, more developed turns score higher importance — but cap so a
  // single 2000-word rant doesn't dominate.
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  if (words < 8) return 0.1;
  if (words < 30) return 0.35;
  if (words < 100) return 0.65;
  if (words < 300) return 0.85;
  return 0.75; // very long turns get slight penalty (likely transcript)
}

function freshnessScore(turn, now = Date.now()) {
  const ts = parseTimestamp(turn);
  if (!ts) return 0.5; // neutral if unknown
  const ageMs = Math.max(0, now - ts);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return 1.0;
  if (ageDays < 7) return 0.85;
  if (ageDays < 30) return 0.6;
  if (ageDays < 90) return 0.35;
  return 0.15;
}

function parseTimestamp(turn) {
  if (!turn) return null;
  const candidate = turn.timestamp || turn.createdAt || turn.created_at || turn.ts || turn.time;
  if (!candidate) return null;
  if (typeof candidate === 'number') return candidate;
  const parsed = Date.parse(String(candidate));
  return Number.isFinite(parsed) ? parsed : null;
}

function detectExplicitTag(text) {
  for (const pattern of EXPLICIT_PROMOTE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function detectFactualContent(text) {
  let hits = 0;
  for (const pattern of FACTUAL_TOKEN_PATTERNS) {
    if (pattern.test(text)) hits++;
  }
  if (hits === 0) return 0;
  if (hits === 1) return 0.5;
  if (hits === 2) return 0.75;
  return 1.0;
}

function isEphemeral(text) {
  for (const pattern of EPHEMERAL_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return text.trim().length < 12;
}

// ─── Public: score a single turn ───────────────────────────────────

function scoreTurnForPromotion(turn, opts = {}) {
  const text = safeText(turn?.text || turn?.content || '');
  const allTurns = Array.isArray(opts.allTurns) ? opts.allTurns : [];
  if (isEphemeral(text)) {
    return {
      score: 0,
      signals: { repetitions: 0, importance: 0, freshness: 0, explicitTag: false, factual: 0 },
      decision: 'skip',
      reason: 'ephemeral content (greeting / command / too short)',
    };
  }
  const repetitions = countRepetitions(turn, allTurns);
  const repetitionScore = clamp(repetitions / 3); // 3+ mentions = max
  const importance = importanceFromLength(text);
  const freshness = freshnessScore(turn, opts.now);
  const explicitTag = detectExplicitTag(text);
  const factual = detectFactualContent(text);

  const score = clamp(
    (repetitionScore * REPETITION_WEIGHT) +
    (importance * IMPORTANCE_WEIGHT) +
    (freshness * FRESHNESS_WEIGHT) +
    ((explicitTag ? 1 : 0) * EXPLICIT_TAG_WEIGHT) +
    (factual * FACTUAL_WEIGHT),
  );

  let decision = 'skip';
  let reason = 'below monitor threshold';
  if (explicitTag) {
    decision = 'promote';
    reason = 'user explicitly tagged as memorable';
  } else if (score >= PROMOTE_THRESHOLD) {
    decision = 'promote';
    reason = `score ${score.toFixed(2)} ≥ promote threshold ${PROMOTE_THRESHOLD}`;
  } else if (score >= MONITOR_THRESHOLD) {
    decision = 'monitor';
    reason = `score ${score.toFixed(2)} between monitor and promote thresholds`;
  }

  return {
    score: Number(score.toFixed(3)),
    signals: {
      repetitions,
      importance: Number(importance.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      explicitTag,
      factual: Number(factual.toFixed(3)),
    },
    decision,
    reason,
  };
}

// ─── Public: full promotion plan over a turn list ────────────────────

function decidePromotions(turns, existingFacts = [], opts = {}) {
  const list = Array.isArray(turns) ? turns : [];
  if (list.length === 0) return { promote: [], monitor: [], skip: [], summary: emptySummary() };
  const existing = new Set(
    (existingFacts || [])
      .map(f => safeText(f?.text || f?.value || '').toLowerCase().slice(0, 120))
      .filter(Boolean),
  );
  const promote = [];
  const monitor = [];
  const skip = [];
  for (const turn of list) {
    const score = scoreTurnForPromotion(turn, { ...opts, allTurns: list });
    const key = safeText(turn?.text || turn?.content || '').toLowerCase().slice(0, 120);
    if (existing.has(key)) {
      skip.push({ turn, score, reason: 'already in long-term memory' });
      continue;
    }
    if (score.decision === 'promote') promote.push({ turn, score });
    else if (score.decision === 'monitor') monitor.push({ turn, score });
    else skip.push({ turn, score });
  }
  return { promote, monitor, skip, summary: summarisePlan({ promote, monitor, skip }) };
}

function emptySummary() {
  return { total: 0, promote_count: 0, monitor_count: 0, skip_count: 0, avg_score: 0 };
}

function summarisePlan({ promote, monitor, skip }) {
  const total = promote.length + monitor.length + skip.length;
  const all = [...promote, ...monitor, ...skip];
  const avg = all.length === 0 ? 0 : all.reduce((acc, p) => acc + (p.score?.score || 0), 0) / all.length;
  return {
    total,
    promote_count: promote.length,
    monitor_count: monitor.length,
    skip_count: skip.length,
    avg_score: Number(avg.toFixed(3)),
  };
}

// ─── Decay long-term facts ──────────────────────────────────────────

/**
 * Apply exponential decay to long-term facts based on age + last
 * reinforcement timestamp. Returns a list of decisions:
 *   - keep: fact is still strong
 *   - downgrade: dropped below the warning threshold, route back to short-term
 *   - forget: confidence ≤ HARD_FORGET_THRESHOLD, remove from store
 *
 * Each fact's "current" confidence is derived as:
 *   confidence = initial * 0.5 ^ (age_days / half_life)
 *   bumped to ≥ recent_reinforcement_boost when refreshed lately
 */
function decayLongTermFacts(facts, opts = {}) {
  const now = opts.now || Date.now();
  const halfLifeDays = opts.halfLifeDays || DECAY_HALF_LIFE_DAYS;
  const list = Array.isArray(facts) ? facts : [];
  const out = [];
  for (const fact of list) {
    const initial = Number(fact?.confidence) || 0.8;
    const ts = parseTimestamp(fact) || parseTimestamp({ timestamp: fact?.lastReinforced }) || now;
    const ageMs = Math.max(0, now - ts);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const decay = Math.pow(0.5, ageDays / halfLifeDays);
    let current = initial * decay;
    // Reinforcement bump
    const reinforcements = Number(fact?.reinforcementCount) || 0;
    if (reinforcements > 0) {
      current = clamp(current + 0.05 * Math.min(reinforcements, 6));
    }
    let action = 'keep';
    if (current <= HARD_FORGET_THRESHOLD) action = 'forget';
    else if (current < 0.35) action = 'downgrade';
    out.push({
      fact,
      decayedConfidence: Number(current.toFixed(3)),
      ageDays: Number(ageDays.toFixed(2)),
      action,
    });
  }
  return {
    decisions: out,
    summary: {
      total: out.length,
      keep: out.filter(d => d.action === 'keep').length,
      downgrade: out.filter(d => d.action === 'downgrade').length,
      forget: out.filter(d => d.action === 'forget').length,
    },
  };
}

// ─── Merge conflicting facts ────────────────────────────────────────

/**
 * When the long-term store has multiple facts about the same subject
 * with different values, merge them deterministically by:
 *   - prefer the most recent
 *   - if same date, prefer the highest confidence
 *   - if same confidence, prefer the longest (more specific)
 *   - mark older versions as superseded
 */
function mergeConflictingFacts(facts, opts = {}) {
  const list = Array.isArray(facts) ? facts : [];
  if (list.length === 0) return { kept: [], superseded: [], conflicts: [] };
  const keyOf = (f) => safeText(f?.subject || f?.key || f?.topic || '').toLowerCase().trim();

  const grouped = new Map();
  for (const fact of list) {
    const k = keyOf(fact);
    if (!k) continue;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(fact);
  }
  const kept = [];
  const superseded = [];
  const conflicts = [];
  for (const [subject, group] of grouped.entries()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    // Sort: newest first, then highest confidence, then longest text
    const sorted = [...group].sort((a, b) => {
      const ta = parseTimestamp(a) || 0;
      const tb = parseTimestamp(b) || 0;
      if (tb !== ta) return tb - ta;
      const ca = Number(a?.confidence) || 0;
      const cb = Number(b?.confidence) || 0;
      if (cb !== ca) return cb - ca;
      const la = safeText(a?.text || a?.value || '').length;
      const lb = safeText(b?.text || b?.value || '').length;
      return lb - la;
    });
    const winner = sorted[0];
    const losers = sorted.slice(1);
    kept.push(winner);
    for (const l of losers) superseded.push({ fact: l, supersededBy: winner });
    // Surface as a conflict only when values differ semantically
    const winnerValue = safeText(winner?.value || winner?.text || '').toLowerCase();
    const conflicting = losers.filter(l => {
      const lv = safeText(l?.value || l?.text || '').toLowerCase();
      return lv && lv !== winnerValue;
    });
    if (conflicting.length > 0) {
      conflicts.push({ subject, winner, conflicting });
    }
  }
  void opts;
  return { kept, superseded, conflicts };
}

module.exports = {
  scoreTurnForPromotion,
  decidePromotions,
  decayLongTermFacts,
  mergeConflictingFacts,
  // Thresholds exported for caller tuning + tests
  PROMOTE_THRESHOLD,
  MONITOR_THRESHOLD,
  HARD_FORGET_THRESHOLD,
  DECAY_HALF_LIFE_DAYS,
  _internal: {
    countRepetitions,
    importanceFromLength,
    freshnessScore,
    detectExplicitTag,
    detectFactualContent,
    isEphemeral,
    parseTimestamp,
  },
};
