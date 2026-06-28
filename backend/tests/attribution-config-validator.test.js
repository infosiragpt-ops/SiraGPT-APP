'use strict';

const test = require('node:test');
const assert = require('node:assert');

const validator = require('../src/services/attribution-config-validator');

test('validate: defaults (empty env) → ok=true', () => {
  const r = validator.validate({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.failures.length, 0);
  assert.ok(r.checked > 0);
  assert.ok(r.timestamp);
});

test('validate: saliency thresholds inverted → error', () => {
  const r = validator.validate({
    SIRAGPT_SALIENCY_LIVE_THRESHOLD: '0.10',
    SIRAGPT_SALIENCY_FADING_THRESHOLD: '0.20',
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.id === 'saliency_threshold_order'));
});

test('validate: saliency thresholds out of range → error', () => {
  const r = validator.validate({
    SIRAGPT_SALIENCY_LIVE_THRESHOLD: '1.5',
    SIRAGPT_SALIENCY_FADING_THRESHOLD: '0.5',
  });
  assert.ok(r.failures.some((f) => f.id === 'saliency_thresholds_in_range'));
});

test('validate: dead-age (ms) below 2×half-life warns; the env is compared as ms', () => {
  // DEAD_AGE_MS and HALFLIFE_MS are both milliseconds. 1,000,000 ms < 2×1,800,000.
  // The old rule multiplied DEAD_AGE by 3.6M (as if hours) so the warning never
  // fired for any ms value.
  const warn = validator.validate({
    SIRAGPT_SALIENCY_DEAD_AGE_MS: '1000000',
    SIRAGPT_SALIENCY_HALFLIFE_MS: '1800000',
  });
  assert.ok(warn.warnings.some((w) => w.id === 'saliency_dead_age_gt_halflife'), 'should warn when dead-age < 2×half-life');

  // A compliant ms config does NOT warn.
  const ok = validator.validate({
    SIRAGPT_SALIENCY_DEAD_AGE_MS: '5000000',
    SIRAGPT_SALIENCY_HALFLIFE_MS: '1800000',
  });
  assert.ok(!ok.warnings.some((w) => w.id === 'saliency_dead_age_gt_halflife'));
});

test('validate: saliency half-life zero → error', () => {
  const r = validator.validate({ SIRAGPT_SALIENCY_HALFLIFE_MS: '0' });
  assert.ok(r.failures.some((f) => f.id === 'saliency_halflife_positive'));
});

test('validate: anomaly buffer smaller than min samples → error', () => {
  const r = validator.validate({
    SIRAGPT_ANOMALY_BUFFER_SIZE: '3',
    SIRAGPT_ANOMALY_MIN_SAMPLES: '5',
  });
  assert.ok(r.failures.some((f) => f.id === 'anomaly_buffer_gt_min_samples'));
});

test('validate: anomaly z-threshold zero → error', () => {
  const r = validator.validate({ SIRAGPT_ANOMALY_Z_THRESHOLD: '0' });
  assert.ok(r.failures.some((f) => f.id === 'anomaly_z_threshold_positive'));
});

test('validate: reflection thresholds inverted → error', () => {
  const r = validator.validate({
    SIRAGPT_REFLECTION_ACCEPT_THRESHOLD: '0.3',
    SIRAGPT_REFLECTION_SOFT_THRESHOLD: '0.5',
  });
  assert.ok(r.failures.some((f) => f.id === 'reflection_threshold_order'));
});

test('validate: reflection thresholds out of range → error', () => {
  const r = validator.validate({
    SIRAGPT_REFLECTION_ACCEPT_THRESHOLD: '2',
    SIRAGPT_REFLECTION_SOFT_THRESHOLD: '0.5',
  });
  assert.ok(r.failures.some((f) => f.id === 'reflection_thresholds_in_range'));
});

test('validate: max retries < 1 → warning, not error', () => {
  const r = validator.validate({ SIRAGPT_REFLECTION_MAX_RETRIES: '0' });
  assert.ok(r.warnings.some((w) => w.id === 'reflection_max_retries_positive'));
});

test('validate: prompt budget below floor → error', () => {
  const r = validator.validate({ SIRAGPT_PROMPT_BUDGET_TOKENS: '100' });
  assert.ok(r.failures.some((f) => f.id === 'prompt_budget_min'));
});

test('validate: prompt budget at typo level → warning', () => {
  const r = validator.validate({ SIRAGPT_PROMPT_BUDGET_TOKENS: '800' });
  assert.ok(r.warnings.some((w) => w.id === 'prompt_budget_sane'));
});

test('validate: cache TTL too short → warning', () => {
  const r = validator.validate({ SIRAGPT_ATTR_CACHE_TTL_MS: '1000' });
  assert.ok(r.warnings.some((w) => w.id === 'attr_cache_ttl_min'));
});

test('validate: supernode thresholds inverted → warning', () => {
  const r = validator.validate({
    SIRAGPT_SUPERNODE_LEX_THRESHOLD: '0.90',
    SIRAGPT_SUPERNODE_SEM_THRESHOLD: '0.30',
  });
  assert.ok(r.warnings.some((w) => w.id === 'supernode_threshold_order'));
});

test('validate: rollup window too small → warning', () => {
  const r = validator.validate({ SIRAGPT_ROLLUP_WINDOW_SIZE: '16' });
  assert.ok(r.warnings.some((w) => w.id === 'rollup_window_min'));
});

test('validate: momentum thresholds inverted → error', () => {
  const r = validator.validate({
    SIRAGPT_MOMENTUM_HIGH_THRESHOLD: '0.30',
    SIRAGPT_MOMENTUM_LOW_THRESHOLD: '0.50',
  });
  assert.ok(r.failures.some((f) => f.id === 'momentum_threshold_order'));
});

test('validate: momentum buffer too small for min turns → error', () => {
  const r = validator.validate({
    SIRAGPT_MOMENTUM_BUFFER_SIZE: '2',
    SIRAGPT_MOMENTUM_MIN_TURNS: '5',
  });
  assert.ok(r.failures.some((f) => f.id === 'momentum_buffer_min_turns'));
});

test('validate: snapshot MAX too small → warning', () => {
  const r = validator.validate({ SIRAGPT_ATTRIBUTION_SNAPSHOT_MAX: '8' });
  assert.ok(r.warnings.some((w) => w.id === 'snapshot_max_min'));
});

test('validate: perf history too small → warning', () => {
  const r = validator.validate({ SIRAGPT_PERF_HISTORY_SIZE: '4' });
  assert.ok(r.warnings.some((w) => w.id === 'perf_history_min'));
});

test('buildValidationBlock: returns prompt text', () => {
  const r = validator.validate({ SIRAGPT_SALIENCY_LIVE_THRESHOLD: '0.10' });
  const block = validator.buildValidationBlock(r);
  assert.ok(block.includes('<attribution_config_validation>'));
  assert.ok(block.includes('error'));
});

test('listRules: returns rule metadata', () => {
  const rules = validator.listRules();
  assert.ok(rules.length > 10);
  for (const r of rules) {
    assert.ok(r.id);
    assert.ok(r.description);
    assert.ok(['error', 'warning'].includes(r.severity));
  }
});

test('validate: ok=false when any error rule fires', () => {
  const r = validator.validate({ SIRAGPT_SALIENCY_LIVE_THRESHOLD: '0.1', SIRAGPT_SALIENCY_FADING_THRESHOLD: '0.2' });
  assert.strictEqual(r.ok, false);
});

test('validate: ok=true when only warnings', () => {
  const r = validator.validate({ SIRAGPT_PROMPT_BUDGET_TOKENS: '800' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.length >= 1);
});

test('hot path: 100 validations under 200ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) validator.validate({ SIRAGPT_PROMPT_BUDGET_TOKENS: '12000' });
  assert.ok(Date.now() - t0 < 500);
});

test('explicit 0 / non-numeric values are flagged, not silently defaulted', () => {
  // Regression: `Number(x) || default` made an explicit 0 (or "abc") fall back
  // to the default for the check, so a catastrophic value passed validation.
  assert.equal(validator.validate({}).ok, true, 'empty env uses defaults → ok');
  assert.equal(validator.validate({ SIRAGPT_PROMPT_BUDGET_TOKENS: '0' }).ok, false, 'explicit 0 budget is flagged');
  assert.equal(validator.validate({ SIRAGPT_PROMPT_BUDGET_TOKENS: 'abc' }).ok, false, 'non-numeric budget is flagged');
});
