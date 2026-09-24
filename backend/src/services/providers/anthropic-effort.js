'use strict';

/**
 * Composer "Esfuerzo" → Anthropic Messages API controls.
 *
 * Claude families take different knobs (checked against the Claude API
 * reference, 2026-09):
 *   - always_on  — Fable 5 / 5.1, Mythos 5 / 5.1, Opus 5.5: thinking can't be
 *                  configured off (`disabled` and `budget_tokens` are 400s);
 *                  depth is `output_config.effort` only.
 *   - opus5      — Opus 5: adaptive by default; `disabled` 400s at xhigh/max.
 *                  We never disable it and lower the effort instead.
 *   - adaptive   — Opus 4.6–4.8, Sonnet 4.6, Sonnet 5: `{type:"adaptive"}` +
 *                  effort; `disabled` accepted; `budget_tokens` 400s on 4.7+.
 *                  4.6 has no `xhigh`.
 *   - budget     — Haiku 4.5 and older 4.x / 3.7: `{type:"enabled",
 *                  budget_tokens}` (≥1024, < max_tokens); `effort` errors.
 *   - none       — anything else: no thinking controls at all.
 *
 * Thinking is summarized (`display: "summarized"`) so the stream carries
 * readable thinking deltas: they feed the «Pensó N s» trace and keep the
 * first-byte watchdog alive while the model reasons.
 */

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BUDGET_TOKENS = { medium: 2048, high: 4096, xhigh: 8192, max: 16384 };
const BUDGET_MIN = 1024;
const BUDGET_ANSWER_ROOM = 2048;
const BUDGET_MODEL_MAX_TOKENS = 64000;

function normalizeAnthropicModel(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, '')
    .replace(/(\d+)\.(\d+)/g, '$1-$2');
}

function anthropicThinkingFamily(model) {
  const id = normalizeAnthropicModel(model);
  if (!/^claude-/.test(id)) return 'none';
  if (/^claude-(?:fable|mythos)-5(?:-|$)/.test(id) || /^claude-opus-5-5(?:-|$)/.test(id)) return 'always_on';
  if (/^claude-opus-5(?:-|$)/.test(id)) return 'opus5';
  if (/^claude-(?:opus-4-[678]|sonnet-4-6|sonnet-5)(?:-|$)/.test(id)) return 'adaptive';
  if (/^claude-(?:haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4|sonnet-4|3-7-sonnet)(?:-|$)/.test(id)) return 'budget';
  return 'none';
}

function isFourSix(model) {
  return /^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(normalizeAnthropicModel(model));
}

/** True when `thinking: {type:"disabled"}` is accepted by this model. */
function anthropicAcceptsDisabledThinking(model) {
  const family = anthropicThinkingFamily(model);
  return family === 'adaptive' || family === 'budget';
}

function normalizeLevel(level) {
  const value = String(level || '').trim().toLowerCase();
  if (value === 'off' || value === 'none' || value === 'disabled') return 'disabled';
  if (value === 'minimal') return 'low';
  return LEVELS.includes(value) ? value : null;
}

function effortFor(model, level) {
  if (level === 'xhigh' && isFourSix(model)) return 'high';
  return level;
}

/**
 * Resolve the Anthropic request fields for a composer level.
 *
 * @param {object} args
 * @param {string} args.model        Claude model id (vendor prefix / dots ok)
 * @param {string|null} args.level   low|medium|high|xhigh|max|disabled|null
 * @param {boolean} args.explicit    the user's composer choice (vs default)
 * @param {number} [args.maxTokens]  current max_tokens of the request
 * @returns {{ thinking?: object, output_config?: object, max_tokens?: number }}
 */
function resolveAnthropicEffortControls({ model, level, explicit = false, maxTokens } = {}) {
  const family = anthropicThinkingFamily(model);
  const normalized = normalizeLevel(level);
  if (family === 'none') return {};

  const summarized = { type: 'adaptive', display: 'summarized' };

  // Trivial turns ("hola") and explicit disables.
  if (normalized === 'disabled') {
    if (family === 'always_on' || family === 'opus5') return { output_config: { effort: 'low' } };
    return { thinking: { type: 'disabled' } };
  }

  if (!explicit || !normalized) {
    // Implicit default: leave each model on its own default depth, but make
    // the always-thinking families stream a readable summary instead of a
    // silent pause (their default display is "omitted").
    return family === 'always_on' ? { thinking: summarized } : {};
  }

  if (family === 'budget') {
    if (normalized === 'low') return { thinking: { type: 'disabled' } };
    const current = Number(maxTokens) > 0 ? Math.trunc(Number(maxTokens)) : 16384;
    let budget = BUDGET_TOKENS[normalized];
    const nextMax = Math.min(BUDGET_MODEL_MAX_TOKENS, Math.max(current, budget + BUDGET_ANSWER_ROOM));
    if (budget >= nextMax) budget = nextMax - BUDGET_MIN;
    if (budget < BUDGET_MIN) return {};
    return {
      thinking: { type: 'enabled', budget_tokens: budget },
      ...(nextMax !== current ? { max_tokens: nextMax } : {}),
    };
  }

  const effort = effortFor(model, normalized);
  if (family === 'adaptive' && normalized === 'low' && /^claude-opus-4|^claude-sonnet-4/.test(normalizeAnthropicModel(model))) {
    // Opus/Sonnet 4.x run without thinking when `thinking` is omitted —
    // Bajo answers directly at low effort.
    return { output_config: { effort } };
  }
  return { thinking: summarized, output_config: { effort } };
}

/** Anthropic 400 caused by a thinking/effort field we added. */
function isAnthropicEffortParamError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || error?.error?.error?.message || error?.error?.message || '');
  return status === 400 && /thinking|effort|output_config|budget_tokens|display/i.test(message);
}

module.exports = {
  anthropicThinkingFamily,
  anthropicAcceptsDisabledThinking,
  resolveAnthropicEffortControls,
  isAnthropicEffortParamError,
  normalizeAnthropicModel,
  BUDGET_TOKENS,
};
