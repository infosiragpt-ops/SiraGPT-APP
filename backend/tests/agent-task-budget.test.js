'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveAgentTaskBudget } = require('../src/routes/agent-task');

const HEAVY_STEPS = 60;
const HEAVY_RUNTIME_MS = 2 * 60 * 60 * 1000;
const INTERACTIVE_STEPS = 28;
const INTERACTIVE_RUNTIME_MS = 8 * 60 * 1000;

test('plain interactive chat (no explicit budget, no auto-document) is bounded tightly', () => {
  const budget = resolveAgentTaskBudget({
    maxStepsRaw: undefined,
    maxRuntimeMsRaw: undefined,
    documentPolicy: { mode: 'doc_suggested', autoGenerate: false },
  });
  assert.equal(budget.maxSteps, INTERACTIVE_STEPS);
  assert.equal(budget.maxRuntimeMs, INTERACTIVE_RUNTIME_MS);
  // The whole point of the fix: a misrouted chat must not inherit the old
  // 60-step / 2-hour runaway ceiling.
  assert.ok(budget.maxSteps < HEAVY_STEPS);
  assert.ok(budget.maxRuntimeMs < HEAVY_RUNTIME_MS);
});

test('missing documentPolicy still falls back to the interactive (safe) budget', () => {
  const budget = resolveAgentTaskBudget({});
  assert.equal(budget.maxSteps, INTERACTIVE_STEPS);
  assert.equal(budget.maxRuntimeMs, INTERACTIVE_RUNTIME_MS);
});

test('auto-generate document tasks keep the generous heavy budget', () => {
  const budget = resolveAgentTaskBudget({
    maxStepsRaw: undefined,
    maxRuntimeMsRaw: undefined,
    documentPolicy: { mode: 'doc_required', autoGenerate: true },
  });
  assert.equal(budget.maxSteps, HEAVY_STEPS);
  assert.equal(budget.maxRuntimeMs, HEAVY_RUNTIME_MS);
});

test('explicit caller values always win over the gated defaults', () => {
  const budget = resolveAgentTaskBudget({
    maxStepsRaw: '15',
    maxRuntimeMsRaw: String(90 * 1000),
    documentPolicy: { autoGenerate: false },
  });
  assert.equal(budget.maxSteps, 15);
  assert.equal(budget.maxRuntimeMs, 90 * 1000);
});

test('an explicitly large step count (e.g. document cycle maxSteps=80) is treated as heavy for runtime', () => {
  // The professional document-cycle route passes maxSteps=80 but no runtime;
  // it must NOT be capped at the 8-minute interactive runtime.
  const budget = resolveAgentTaskBudget({
    maxStepsRaw: '80',
    maxRuntimeMsRaw: undefined,
    documentPolicy: { autoGenerate: false },
  });
  assert.equal(budget.maxSteps, 80);
  assert.equal(budget.maxRuntimeMs, HEAVY_RUNTIME_MS);
});
