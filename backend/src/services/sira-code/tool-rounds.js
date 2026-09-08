'use strict';

/**
 * Per-turn tool-round budget for SiraCode.
 *
 * Independent rewrite of the OpenCode last-step / `agent.steps` *idea*
 * (anomalyco/opencode, MIT). OpenCode disables tools after N LLM
 * steps and asks for a text wrap-up. SiraCode already has maxSteps
 * (LLM rounds). This guard counts *tool executions* in one user
 * turn — one LLM step can emit many calls — and stops with a
 * Spanish /agentes label. Not a vendor copy: no Effect runtime,
 * no MAX_STEPS prompt dump, no OpenRouter.
 */

const MAX_TOOL_ROUNDS_DEFAULT = 16;
const MAX_TOOL_ROUNDS_HARD = 32;
const TOOL_ROUNDS_STOP_REASON = 'tool_rounds';
const TOOL_ROUNDS_STAGE = 'toolRoundsExceeded';
const TOOL_ROUNDS_LABEL = 'Límite de herramientas alcanzado';

function resolveMaxToolRounds(raw, fallback = MAX_TOOL_ROUNDS_DEFAULT) {
  const n = Number(raw);
  const base = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.min(MAX_TOOL_ROUNDS_HARD, Math.max(1, base));
}

function isToolRoundsExceeded(count, max) {
  const used = Number(count) || 0;
  return used >= resolveMaxToolRounds(max);
}

function buildToolRoundsStop(opts = {}) {
  const max = resolveMaxToolRounds(opts.max);
  const count = Number(opts.count) || 0;
  return {
    stopReason: TOOL_ROUNDS_STOP_REASON,
    step: TOOL_ROUNDS_STAGE,
    label: TOOL_ROUNDS_LABEL,
    count,
    max,
    content: `ERROR: ${TOOL_ROUNDS_LABEL}`,
  };
}

module.exports = {
  MAX_TOOL_ROUNDS_DEFAULT,
  MAX_TOOL_ROUNDS_HARD,
  TOOL_ROUNDS_STOP_REASON,
  TOOL_ROUNDS_STAGE,
  TOOL_ROUNDS_LABEL,
  resolveMaxToolRounds,
  isToolRoundsExceeded,
  buildToolRoundsStop,
};
