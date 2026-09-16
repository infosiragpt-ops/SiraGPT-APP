'use strict';

/**
 * Document-analysis RLCD flags.
 *
 * Independent of the #722 decision-ledger master switch
 * (`SIRAGPT_RLCD_ENABLED`, default ON). Documents stay OFF until
 * `SIRAGPT_RLCD_DOCUMENTS` is explicitly enabled so production can
 * keep ledger telemetry without changing document Q&A.
 */

const { envFlagOn, envFlagOff } = require('../rlhf/flags');

const DEFAULT_DEFER_THRESHOLD = 0.45;
const DEFAULT_MAX_DEFER_RATE = 0.25;
const MIN_THRESHOLD = 0.05;
const MAX_THRESHOLD = 0.95;
const MIN_DEFER_RATE = 0;
const MAX_DEFER_RATE = 1;

function isDocumentEnabled(env = process.env) {
  return envFlagOn(env.SIRAGPT_RLCD_DOCUMENTS);
}

function deferThreshold(env = process.env) {
  const n = Number(env.SIRAGPT_RLCD_DEFER_THRESHOLD);
  if (!Number.isFinite(n)) return DEFAULT_DEFER_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, n));
}

function maxDeferRate(env = process.env) {
  const n = Number(env.SIRAGPT_RLCD_MAX_DEFER_RATE);
  if (!Number.isFinite(n)) return DEFAULT_MAX_DEFER_RATE;
  return Math.min(MAX_DEFER_RATE, Math.max(MIN_DEFER_RATE, n));
}

function isPhraseEnabled(env = process.env) {
  if (!isDocumentEnabled(env)) return false;
  return !envFlagOff(env.SIRAGPT_RLCD_PHRASE);
}

function isPromptEnabled(env = process.env) {
  if (!isDocumentEnabled(env)) return false;
  return !envFlagOff(env.SIRAGPT_RLCD_PROMPT);
}

module.exports = {
  isDocumentEnabled,
  // Back-compat alias used by older document-only callers.
  isRlcdEnabled: isDocumentEnabled,
  deferThreshold,
  maxDeferRate,
  isPhraseEnabled,
  isPromptEnabled,
  DEFAULT_DEFER_THRESHOLD,
  DEFAULT_MAX_DEFER_RATE,
};
