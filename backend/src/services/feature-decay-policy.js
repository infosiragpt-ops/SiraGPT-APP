'use strict';

/**
 * feature-decay-policy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-feature-kind decay policy. The saliency-decay-tracker applies a
 * single exponential half-life to every feature; in practice different
 * feature kinds have very different *meaningful lifetimes*:
 *
 *   • A constraint ("never use Python") should stay live for the whole
 *     conversation — half-life on the order of days.
 *   • A topic mention persists for a few turns — minutes to ~1 hour.
 *   • An urgency marker burns out fast — a few minutes at most.
 *   • A code language / file type mention sticks around as long as the
 *     conversation stays technical.
 *
 * This module exposes the canonical per-kind half-life table plus a
 * `decay(strength, ageMs, kind)` helper that the saliency tracker (and
 * any future decay-driven module) can use to compute the right curve
 * per feature kind. Env overrides let ops tune lifetimes without code
 * changes.
 *
 * Public API:
 *   halfLifeMsFor(kind)                → number
 *   decay(strength, ageMs, kind?)      → number     (clamped to [0, 1])
 *   classifyKind(kind)                 → 'sticky' | 'persistent' | 'normal' | 'transient'
 *   listPolicies()                     → [{ kind, halfLifeMs, classification }, ...]
 *   POLICIES                           → frozen table
 */

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

const DEFAULT_HALF_LIFE_MS = Number(process.env.SIRAGPT_DECAY_DEFAULT_HALF_LIFE_MS) || 30 * ONE_MINUTE;

// Half-lives per kind (ms). Read env overrides at module load.
const POLICIES = Object.freeze({
  // Sticky — across-session constraints, hard preferences, profile facts.
  constraint:        Number(process.env.SIRAGPT_DECAY_CONSTRAINT_MS) || 7 * ONE_DAY,
  profile_fact:      Number(process.env.SIRAGPT_DECAY_PROFILE_FACT_MS) || 30 * ONE_DAY,
  hidden_intent:     Number(process.env.SIRAGPT_DECAY_HIDDEN_INTENT_MS) || 2 * ONE_DAY,

  // Persistent — span the working session.
  entity:            Number(process.env.SIRAGPT_DECAY_ENTITY_MS) || 6 * ONE_HOUR,
  code_language:     Number(process.env.SIRAGPT_DECAY_CODE_LANGUAGE_MS) || 4 * ONE_HOUR,
  file_type:         Number(process.env.SIRAGPT_DECAY_FILE_TYPE_MS) || 4 * ONE_HOUR,
  goal:              Number(process.env.SIRAGPT_DECAY_GOAL_MS) || 12 * ONE_HOUR,
  preference:        Number(process.env.SIRAGPT_DECAY_PREFERENCE_MS) || 3 * ONE_DAY,

  // Normal — a turn or two of relevance.
  topic:             Number(process.env.SIRAGPT_DECAY_TOPIC_MS) || 30 * ONE_MINUTE,
  topic_token:       Number(process.env.SIRAGPT_DECAY_TOPIC_TOKEN_MS) || 20 * ONE_MINUTE,
  reference:         Number(process.env.SIRAGPT_DECAY_REFERENCE_MS) || 45 * ONE_MINUTE,
  number:            Number(process.env.SIRAGPT_DECAY_NUMBER_MS) || ONE_HOUR,
  domain_concept:    Number(process.env.SIRAGPT_DECAY_DOMAIN_CONCEPT_MS) || 90 * ONE_MINUTE,

  // Transient — fade fast.
  sentiment:         Number(process.env.SIRAGPT_DECAY_SENTIMENT_MS) || 10 * ONE_MINUTE,
  urgency:           Number(process.env.SIRAGPT_DECAY_URGENCY_MS) || 5 * ONE_MINUTE,
  modality:          Number(process.env.SIRAGPT_DECAY_MODALITY_MS) || 15 * ONE_MINUTE,
  cross_lingual_concept: Number(process.env.SIRAGPT_DECAY_CROSS_LINGUAL_MS) || 45 * ONE_MINUTE,
});

function halfLifeMsFor(kind) {
  if (!kind) return DEFAULT_HALF_LIFE_MS;
  const k = String(kind).toLowerCase();
  if (POLICIES[k] !== undefined) return POLICIES[k];
  // partial-match fallback: strip namespaced prefix like "action.create" → "action"
  const base = k.split('.')[0];
  if (POLICIES[base] !== undefined) return POLICIES[base];
  return DEFAULT_HALF_LIFE_MS;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function decay(strength, ageMs, kind = null) {
  const s = clamp01(strength);
  if (s === 0) return 0;
  if (!Number.isFinite(ageMs) || ageMs <= 0) return s;
  const hl = halfLifeMsFor(kind);
  if (hl <= 0) return 0;
  return clamp01(s * Math.pow(0.5, ageMs / hl));
}

function classifyKind(kind) {
  const hl = halfLifeMsFor(kind);
  if (hl >= ONE_DAY) return 'sticky';
  if (hl >= 2 * ONE_HOUR) return 'persistent';
  if (hl >= 20 * ONE_MINUTE) return 'normal';
  return 'transient';
}

function listPolicies() {
  return Object.entries(POLICIES).map(([kind, halfLifeMs]) => ({
    kind,
    halfLifeMs,
    classification: classifyKind(kind),
    halfLifeHuman: humaniseMs(halfLifeMs),
  }));
}

function humaniseMs(ms) {
  if (ms >= ONE_DAY) return `${Math.round(ms / ONE_DAY)}d`;
  if (ms >= ONE_HOUR) return `${Math.round(ms / ONE_HOUR)}h`;
  if (ms >= ONE_MINUTE) return `${Math.round(ms / ONE_MINUTE)}min`;
  return `${ms}ms`;
}

module.exports = {
  POLICIES,
  DEFAULT_HALF_LIFE_MS,
  halfLifeMsFor,
  decay,
  classifyKind,
  listPolicies,
  humaniseMs,
  ONE_MINUTE,
  ONE_HOUR,
  ONE_DAY,
};
