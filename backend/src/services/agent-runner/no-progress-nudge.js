'use strict';

/**
 * Recovery nudge for the no-progress guard (3H59 cutSubtaskIfNoProgress,
 * applied by 3H61 enforceSubtaskProgressClosed in loop.js).
 *
 * Production 2026-10-08: a deck was built, then describe_image failed twice
 * (the loop's text model cannot see images) and a python crop failed once;
 * three failed tool calls in a row cut the turn, and nothing was delivered
 * although outputs/ held the finished file. The guard now speaks ONCE before
 * it cuts: the model learns which calls failed and is told to change
 * approach (verify what already exists, or report honestly). Three more
 * consecutive failures after the nudge still cut the turn, so a loop that
 * keeps spinning ends as before, one round later.
 */

const NO_PROGRESS_NUDGE_PREFIX = 'RECOVERY REQUIRED:';
const MAX_ERROR_CHARS = 160;

function failurePreview(step) {
  const raw = String((step && step.resultPreview) || '')
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS - 1)}…` : raw;
}

/** "1) describe_image: la descripción de imagen falló: …" per failed step. */
function describeFailedSteps(steps = []) {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step && step.ok === false)
    .map((step, i) => `${i + 1}) ${step.tool || 'tool'}: ${failurePreview(step) || 'failed without detail'}`);
}

function noProgressNudge(failedSteps = []) {
  const lines = describeFailedSteps(failedSteps);
  const n = Math.max(1, lines.length);
  return [
    `${NO_PROGRESS_NUDGE_PREFIX} the last ${n} tool calls failed in a row. The turn is cut if the next ${n} fail too.`,
    ...(lines.length ? ['Failed:', ...lines] : []),
    'Do NOT repeat a failed call with the same approach: a tool that fails like this is unavailable in this turn. Switch tools or skip that step.',
    'If the deliverable already exists under /workspace/outputs, do NOT rebuild it: call inspect_document and verify_visual (after=<that file>, no before, checklist=<requirements>) on it and finish.',
    'If the task cannot be completed without the failing step, stop and say plainly in Spanish what was done and what was not — never pretend it worked.',
  ].join('\n');
}

module.exports = {
  NO_PROGRESS_NUDGE_PREFIX,
  MAX_ERROR_CHARS,
  describeFailedSteps,
  noProgressNudge,
};
