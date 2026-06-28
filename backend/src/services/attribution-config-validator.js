'use strict';

/**
 * attribution-config-validator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sanity-checks every env-tunable knob the attribution stack uses and
 * reports incoherent configurations. Pure JS, no side effects, no env
 * mutation — reads `process.env` on each call so it reflects runtime.
 *
 * Public API:
 *   validate(env?)                → ConfigReport
 *   buildValidationBlock(report)  → string
 *   listRules()                   → Rule[]
 */

// Parse a numeric env, preserving an explicitly-set 0/NaN so the validator
// actually flags a bad value — `Number(x) || default` silently swallowed an
// explicit 0 (and any non-numeric value) by falling back to the default.
function num(raw, fallback) {
  return raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
}

const RULES = Object.freeze([
  { id: 'saliency_threshold_order', severity: 'error', description: 'live threshold must be > fading threshold',
    check: (e) => (num(e.SIRAGPT_SALIENCY_LIVE_THRESHOLD, 0.50)) > (num(e.SIRAGPT_SALIENCY_FADING_THRESHOLD, 0.15)) },
  { id: 'saliency_thresholds_in_range', severity: 'error', description: 'live and fading thresholds must be in (0, 1]',
    check: (e) => {
      const l = num(e.SIRAGPT_SALIENCY_LIVE_THRESHOLD, 0.50);
      const f = num(e.SIRAGPT_SALIENCY_FADING_THRESHOLD, 0.15);
      return l > 0 && l <= 1 && f > 0 && f <= 1;
    } },
  { id: 'saliency_halflife_positive', severity: 'error', description: 'saliency half-life must be > 0 ms',
    check: (e) => {
      if (e.SIRAGPT_SALIENCY_HALFLIFE_MS === undefined) return true;
      const v = Number(e.SIRAGPT_SALIENCY_HALFLIFE_MS);
      return Number.isFinite(v) && v > 0;
    } },
  { id: 'saliency_dead_age_gt_halflife', severity: 'warning', description: 'dead-age should be ≥ 2 × half-life',
    // SIRAGPT_SALIENCY_DEAD_AGE_MS is already in milliseconds (saliency-decay-
    // tracker default 6*60*60*1000). The old `num(...,6) * 60*60*1000` treated it
    // as hours and multiplied any ms value by 3.6M, so the coherence check was
    // always true and never warned. Compare ms-to-ms.
    check: (e) => num(e.SIRAGPT_SALIENCY_DEAD_AGE_MS, 6 * 60 * 60 * 1000) >= 2 * num(e.SIRAGPT_SALIENCY_HALFLIFE_MS, 1_800_000) },

  { id: 'anomaly_buffer_gt_min_samples', severity: 'error', description: 'buffer size must allow min samples + 2',
    check: (e) => (num(e.SIRAGPT_ANOMALY_BUFFER_SIZE, 12)) >= (num(e.SIRAGPT_ANOMALY_MIN_SAMPLES, 3)) + 2 },
  { id: 'anomaly_z_threshold_positive', severity: 'error', description: 'z-score threshold must be > 0',
    check: (e) => {
      if (e.SIRAGPT_ANOMALY_Z_THRESHOLD === undefined) return true;
      const v = Number(e.SIRAGPT_ANOMALY_Z_THRESHOLD);
      return Number.isFinite(v) && v > 0;
    } },

  { id: 'reflection_threshold_order', severity: 'error', description: 'accept threshold must be > soft threshold',
    check: (e) => (num(e.SIRAGPT_REFLECTION_ACCEPT_THRESHOLD, 0.65)) > (num(e.SIRAGPT_REFLECTION_SOFT_THRESHOLD, 0.45)) },
  { id: 'reflection_thresholds_in_range', severity: 'error', description: 'reflection thresholds must be in (0, 1]',
    check: (e) => {
      const a = num(e.SIRAGPT_REFLECTION_ACCEPT_THRESHOLD, 0.65);
      const s = num(e.SIRAGPT_REFLECTION_SOFT_THRESHOLD, 0.45);
      return a > 0 && a <= 1 && s > 0 && s <= 1;
    } },
  { id: 'reflection_max_retries_positive', severity: 'warning', description: 'max retries should be ≥ 1',
    check: (e) => {
      if (e.SIRAGPT_REFLECTION_MAX_RETRIES === undefined) return true;
      const v = Number(e.SIRAGPT_REFLECTION_MAX_RETRIES);
      return Number.isFinite(v) && v >= 1;
    } },

  { id: 'prompt_budget_min', severity: 'error', description: 'prompt budget tokens must be ≥ 512',
    check: (e) => (num(e.SIRAGPT_PROMPT_BUDGET_TOKENS, 12_000)) >= 512 },
  { id: 'prompt_budget_sane', severity: 'warning', description: 'prompt budget < 1024 is likely a typo',
    check: (e) => (num(e.SIRAGPT_PROMPT_BUDGET_TOKENS, 12_000)) >= 1024 },

  { id: 'attr_cache_ttl_min', severity: 'warning', description: 'attribution-cache TTL < 30 s is suspiciously short',
    check: (e) => (num(e.SIRAGPT_ATTR_CACHE_TTL_MS, 600_000)) >= 30_000 },
  { id: 'attr_cache_size_min', severity: 'warning', description: 'attribution-cache MAX < 32 is suspiciously small',
    check: (e) => (num(e.SIRAGPT_ATTR_CACHE_MAX, 256)) >= 32 },

  { id: 'supernode_threshold_order', severity: 'warning', description: 'semantic threshold should be ≥ lexical threshold',
    check: (e) => (num(e.SIRAGPT_SUPERNODE_SEM_THRESHOLD, 0.85)) >= (num(e.SIRAGPT_SUPERNODE_LEX_THRESHOLD, 0.30)) },

  { id: 'rollup_window_min', severity: 'warning', description: 'rollup window < 64 samples is too small for stable percentiles',
    check: (e) => (num(e.SIRAGPT_ROLLUP_WINDOW_SIZE, 1024)) >= 64 },

  { id: 'momentum_threshold_order', severity: 'error', description: 'high threshold must be > low threshold',
    check: (e) => (num(e.SIRAGPT_MOMENTUM_HIGH_THRESHOLD, 0.70)) > (num(e.SIRAGPT_MOMENTUM_LOW_THRESHOLD, 0.40)) },
  { id: 'momentum_buffer_min_turns', severity: 'error', description: 'buffer size must allow min turns + 1',
    check: (e) => (num(e.SIRAGPT_MOMENTUM_BUFFER_SIZE, 12)) >= (num(e.SIRAGPT_MOMENTUM_MIN_TURNS, 2)) + 1 },

  { id: 'snapshot_max_min', severity: 'warning', description: 'snapshot MAX < 32 will roll over very fast',
    check: (e) => (num(e.SIRAGPT_ATTRIBUTION_SNAPSHOT_MAX, 512)) >= 32 },

  { id: 'perf_history_min', severity: 'warning', description: 'perf history < 8 produces unstable p50/p95',
    check: (e) => (num(e.SIRAGPT_PERF_HISTORY_SIZE, 256)) >= 8 },
]);

function validate(env = process.env) {
  const failures = [];
  const warnings = [];
  for (const rule of RULES) {
    let pass;
    try { pass = !!rule.check(env); }
    catch (_) { pass = false; }
    if (pass) continue;
    const record = { id: rule.id, severity: rule.severity, description: rule.description };
    (rule.severity === 'error' ? failures : warnings).push(record);
  }
  return {
    ok: failures.length === 0,
    failures, warnings,
    checked: RULES.length,
    timestamp: new Date().toISOString(),
  };
}

function buildValidationBlock(report) {
  if (!report) return '';
  const lines = ['\n\n<attribution_config_validation>'];
  lines.push(`Checked ${report.checked} rules — ${report.failures.length} error(s), ${report.warnings.length} warning(s).`);
  for (const f of report.failures) lines.push(`  ❌ ${f.id}: ${f.description}`);
  for (const w of report.warnings.slice(0, 6)) lines.push(`  ⚠ ${w.id}: ${w.description}`);
  lines.push('</attribution_config_validation>');
  return lines.join('\n');
}

const listRules = () => RULES.map((r) => ({ id: r.id, severity: r.severity, description: r.description }));

module.exports = { validate, buildValidationBlock, listRules, RULES };
