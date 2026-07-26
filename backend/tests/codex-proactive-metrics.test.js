'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/utils/metrics');
const proactiveMetrics = require('../src/services/codex/proactive-metrics');

test('proactive cycle, quality, duration, and budget metrics render as Prometheus series', () => {
  metrics._reset();
  proactiveMetrics.recordCycle({ action: 'proposed', department: 'CEO Office', durationMs: 250 });
  proactiveMetrics.recordQuality({ outcome: 'passed', gate: 'browser_check' });
  proactiveMetrics.setBudgetBlocked(true);

  const text = metrics.renderText();
  assert.match(text, /siragpt_codex_proactive_cycles_total\{action="proposed",department="ceo_office"\} 1/);
  assert.match(text, /siragpt_codex_proactive_quality_total\{outcome="passed",gate="browser_check"\} 1/);
  assert.match(text, /siragpt_codex_proactive_cycle_duration_seconds_count\{action="proposed"\} 1/);
  assert.match(text, /siragpt_codex_proactive_budget_blocked 1/);
});
