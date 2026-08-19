'use strict';

const metrics = require('../../utils/metrics');

const CYCLES = 'siragpt_codex_proactive_cycles_total';
const QUALITY = 'siragpt_codex_proactive_quality_total';
const DURATION = 'siragpt_codex_proactive_cycle_duration_seconds';
const BUDGET = 'siragpt_codex_proactive_budget_blocked';

metrics.registerCounter(CYCLES, {
  help: 'Autonomous Codex company cycles by bounded action and department',
  labels: ['action', 'department'],
  maxSeries: 128,
});
metrics.registerCounter(QUALITY, {
  help: 'Terminal proactive quality-gate outcomes',
  labels: ['outcome', 'gate'],
  maxSeries: 32,
});
metrics.registerHistogram(DURATION, {
  help: 'Autonomous Codex company cycle duration in seconds',
  labels: ['action'],
  buckets: [0.05, 0.25, 1, 2.5, 5, 15, 30, 60],
  maxSeries: 32,
});
metrics.registerGauge(BUDGET, {
  help: 'Whether the most recently evaluated proactive project was cost-blocked',
  labels: [],
  maxSeries: 1,
});

function token(value, fallback = 'unknown') {
  const normalized = String(value || fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return normalized.slice(0, 64) || fallback;
}

function recordCycle({ action, department, durationMs = 0 } = {}) {
  try {
    metrics.counter(CYCLES, { action: token(action), department: token(department, 'none') }, 1);
    metrics.observe(DURATION, { action: token(action) }, Math.max(0, Number(durationMs) || 0) / 1000);
  } catch { /* instrumentation never breaks autonomy */ }
}

function recordQuality({ outcome, gate } = {}) {
  try {
    metrics.counter(QUALITY, { outcome: token(outcome), gate: token(gate) }, 1);
  } catch { /* instrumentation never breaks autonomy */ }
}

function setBudgetBlocked(blocked) {
  try { metrics.gauge(BUDGET, {}, blocked ? 1 : 0); } catch { /* no-op */ }
}

module.exports = {
  CYCLES,
  QUALITY,
  DURATION,
  BUDGET,
  recordCycle,
  recordQuality,
  setBudgetBlocked,
};
