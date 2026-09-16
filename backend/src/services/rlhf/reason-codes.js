'use strict';

/**
 * Fixed reason codes for rich thumbs / regenerate / pairwise feedback.
 *
 * Stable English snake_case tokens (exports + DB). Spanish labels are
 * for docs and any future UI — they are not persisted. Unknown codes
 * are dropped (fail-open) so a typo cannot poison the ledger.
 */

const REASON_CODES = Object.freeze([
  'invented',
  'wrong_file',
  'bad_math',
  'wrong_tone',
  'incomplete',
  'off_topic',
  'too_long',
  'too_short',
  'harmful',
  'other',
]);

/** Chat thumbs historically accepted this subset; it stays a subset of REASON_CODES. */
const DISLIKE_REASONS = REASON_CODES;

const REASON_LABELS_ES = Object.freeze({
  invented: 'Inventó datos',
  wrong_file: 'Archivo equivocado',
  bad_math: 'Cálculo incorrecto',
  wrong_tone: 'Tono inadecuado',
  incomplete: 'Incompleto',
  off_topic: 'Fuera de tema',
  too_long: 'Demasiado largo',
  too_short: 'Demasiado corto',
  harmful: 'Inseguro o dañino',
  other: 'Otro',
});

const REASON_CODE_MAX = 32;
const NOTES_MAX = 500;

function normalizeReasonCode(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase().slice(0, REASON_CODE_MAX);
  if (!s) return null;
  return REASON_CODES.includes(s) ? s : null;
}

function normalizeNotes(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return t.length <= NOTES_MAX ? t : t.slice(0, NOTES_MAX);
}

/**
 * Accept the existing thumbs payload (`reason` = enum) plus the richer
 * `reasonCode` + free-text `notes`. If `reason` is not a known code it
 * is treated as the free-text note.
 */
function resolveFeedbackReasons({ reason, reasonCode, notes } = {}) {
  const fromCode = normalizeReasonCode(reasonCode);
  const fromReasonAsCode = normalizeReasonCode(reason);
  const code = fromCode || fromReasonAsCode;
  const note = normalizeNotes(notes)
    || (fromReasonAsCode ? null : normalizeNotes(reason));
  return { reasonCode: code, notes: note };
}

function isReasonCode(value) {
  return normalizeReasonCode(value) != null;
}

module.exports = {
  REASON_CODES,
  DISLIKE_REASONS,
  REASON_LABELS_ES,
  REASON_CODE_MAX,
  NOTES_MAX,
  normalizeReasonCode,
  normalizeNotes,
  resolveFeedbackReasons,
  isReasonCode,
};
