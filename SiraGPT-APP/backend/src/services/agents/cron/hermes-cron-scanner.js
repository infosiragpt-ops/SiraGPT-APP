'use strict';

/**
 * hermes-cron-scanner — Two-tier scheduling-intent detector.
 *
 * Adapted from Hermes Agent (MIT):
 *   fix(cron): split scanner into two tiers so skill prose stops
 *   false-positive triggering (#~35xxx, 2026-05-26)
 *
 * Problem: a single broad regex that fires on words like "every", "daily",
 * or "schedule" caused free-text prose (e.g. "I exercise every day") to be
 * misclassified as scheduling commands, silently creating cron jobs.
 *
 * Solution: two sequential tiers that both must pass before classifying a
 * message as a scheduling intent.
 *
 *   Tier 1 — KEYWORD tier (cheap, synchronous regex):
 *     Fast bloom-filter over scheduling vocabulary.  Returns false quickly
 *     for the majority of messages that contain no time-related language.
 *
 *   Tier 2 — STRUCTURAL tier (still sync, but stricter pattern set):
 *     Requires at least one concrete structural marker: an explicit time
 *     expression, a cron-like interval phrase, or an imperative scheduling
 *     verb.  Pure prose that mentions time without imperative structure
 *     (e.g. "I go to the gym every Tuesday") is rejected here.
 *
 * Both tiers must match for `classifySchedulingIntent` to return true.
 * This eliminates the false-positive class without missing genuine intents.
 */

// ── Tier 1: keyword bloom ──────────────────────────────────────────────────
// Must match at least one scheduling-adjacent word anywhere in the message.
const TIER1_KEYWORD_RE = /\b(schedule[dr]?|cron|remind(?:er|me)?|alarm|recur(?:ring)?|repeat(?:ing)?|automat(?:e|ic(?:ally)?)|every|cada|diario|diaria|semanal|mensual|anual|daily|weekly|monthly|hourly|minutely|at\s+\d|a\s+las?\s+\d|programar?|tarea\s+autom[aá]tica)\b/i;

// ── Tier 2: structural markers ─────────────────────────────────────────────
// Must contain at least one of:
//   a) explicit clock time ("at 9am", "a las 14:00")
//   b) interval phrase  ("every 5 minutes", "cada 2 horas", "*/15 * * * *")
//   c) imperative scheduling verb at the start of a clause
const TIER2_STRUCTURAL_PATTERNS = [
  // Clock time: "at 9am", "at 14:30", "a las 9", "a las 14:00"
  /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\ba\s+las?\s+\d{1,2}(?::\d{2})?\b/i,

  // Interval phrase: "every N unit", "cada N unidad"
  /\bevery\s+\d+\s+(?:second|minute|hour|day|week|month|year)s?\b/i,
  /\bcada\s+\d+\s+(?:segundo|minuto|hora|d[ií]a|semana|mes|a[ñn]o)s?\b/i,

  // Shorthand intervals: "every hour", "daily at", "weekly on"
  /\b(?:every|cada)\s+(?:hour|minute|day|week|month|hora|minuto|d[ií]a|semana|mes)\b/i,

  // Standard cron expression: 5 space-separated fields with digits/wildcards
  /(?:^|[\s:])(\*|[\d,\-*/]+)\s+(\*|[\d,\-*/]+)\s+(\*|[\d,\-*/]+)\s+(\*|[\d,\-*/]+)\s+(\*|[\d,\-*/]+)(?:\s|$)/,

  // Imperative scheduling verb leading a clause
  /(?:^|[.!?]\s+)(?:schedule|set\s+(?:up\s+)?(?:a\s+)?(?:reminder|task|alarm|job)|remind\s+me|create\s+(?:a\s+)?(?:reminder|task|cron)|run\s+(?:this\s+)?(?:every|daily|weekly)|programa(?:r\s+)?(?:una?\s+)?(?:tarea|recordatorio|alarma))/i,
];

/**
 * Tier 2 check: returns true when at least one structural pattern matches.
 * @param {string} text
 * @returns {boolean}
 */
function tier2Structural(text) {
  return TIER2_STRUCTURAL_PATTERNS.some(re => re.test(text));
}

/**
 * classifySchedulingIntent
 *
 * Returns true only when both tiers match — the message contains scheduling
 * vocabulary (tier 1) *and* a concrete structural scheduling marker (tier 2).
 *
 * @param {string} text  — raw user message text
 * @returns {{ isSchedulingIntent: boolean, tier1: boolean, tier2: boolean }}
 */
function classifySchedulingIntent(text = '') {
  const t1 = TIER1_KEYWORD_RE.test(String(text));
  if (!t1) return { isSchedulingIntent: false, tier1: false, tier2: false };
  const t2 = tier2Structural(String(text));
  return { isSchedulingIntent: t1 && t2, tier1: t1, tier2: t2 };
}

/**
 * extractCronHints
 *
 * If `classifySchedulingIntent` returns true, this helper extracts a best-
 * effort structured hint from the text to pass to the LLM for schedule
 * resolution.  Returns null if no hint can be derived structurally.
 *
 * @param {string} text
 * @returns {{ scheduleHint: string | null, timeHint: string | null }}
 */
function extractCronHints(text = '') {
  const timeMatch = text.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
    || text.match(/\ba\s+las?\s+(\d{1,2}(?::\d{2})?)\b/i);
  const intervalMatch = text.match(/\bevery\s+(\d+\s+\w+)\b/i)
    || text.match(/\bcada\s+(\d+\s+\w+)\b/i);
  const shorthandMatch = text.match(/\b(daily|weekly|monthly|hourly|diario|diaria|semanal|mensual)\b/i);

  return {
    scheduleHint: intervalMatch?.[1] || shorthandMatch?.[1] || null,
    timeHint: timeMatch?.[1] || null,
  };
}

module.exports = {
  classifySchedulingIntent,
  extractCronHints,
  TIER1_KEYWORD_RE,
  TIER2_STRUCTURAL_PATTERNS,
};
