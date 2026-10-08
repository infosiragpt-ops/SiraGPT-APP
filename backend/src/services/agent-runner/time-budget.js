'use strict';

/**
 * Time budget of a document turn (agent-runner loop).
 *
 * The loop ran under a hard wall it never saw: on 2026-10-07 four document
 * turns kept regenerating a deck after a vision veto and were cut by the wall
 * with a file in outputs/ and nothing delivered (edits:0, 395–408 s). Once the
 * remaining time drops under the threshold the loop tells the model ONCE to
 * stop starting new rounds and close: verify what exists, fix only the ✗
 * items, or report honestly what could not be verified.
 */

// Threshold: 30 % of the wall, raised to half of it on short walls, never
// above 90 s (a 6-min wall nudges at 108 s left, an 8-min wall at 144 s).
const MAX_THRESHOLD_MS = 90_000;

function timeBudgetThresholdMs(wallMs) {
  const wall = Number(wallMs);
  if (!Number.isFinite(wall) || wall <= 0) return 0;
  return Math.max(Math.min(MAX_THRESHOLD_MS, wall * 0.5), wall * 0.3);
}

function shouldNudgeTimeBudget({ elapsedMs, wallMs, nudged = false } = {}) {
  if (nudged) return false;
  const wall = Number(wallMs);
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(wall) || wall <= 0 || !Number.isFinite(elapsed) || elapsed < 0) return false;
  return wall - elapsed <= timeBudgetThresholdMs(wall);
}

function timeBudgetNudge(remainingMs) {
  const secs = Math.max(0, Math.round(Number(remainingMs) / 1000) || 0);
  return [
    `TIME BUDGET: about ${secs} s remain in this turn before it is cut, and a cut turn delivers NOTHING.`,
    'Do NOT start another full regeneration or new research now.',
    'If a deliverable already exists in outputs/: run inspect_document + verify_visual on it if it was not verified yet, or fix ONLY the ✗ items with the smallest change and verify once; then finish with your summary.',
    'If nothing can be verified in the remaining time, finish NOW and say plainly in Spanish what was produced and what could not be verified — never pretend it worked.',
  ].join('\n');
}

module.exports = {
  MAX_THRESHOLD_MS,
  timeBudgetThresholdMs,
  shouldNudgeTimeBudget,
  timeBudgetNudge,
};
