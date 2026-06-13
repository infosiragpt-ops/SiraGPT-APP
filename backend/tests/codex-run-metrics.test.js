'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAccumulator } = require('../src/services/codex/run-metrics');
const { isValidEvent } = require('../src/services/codex/event-types');

function advancingClock(startMs, stepMs = 1000) {
  let t = startMs - stepMs;
  return () => new Date((t += stepMs));
}

test('accumulator counts actions, lines read and tokens honestly', () => {
  const acc = createAccumulator({ run: { id: 'r1' }, clock: () => new Date(0) });
  acc.recordAction('terminal', 50);
  acc.recordAction('file_read', 10);
  acc.recordLinesRead(120);
  acc.recordLinesRead(0); // ignored
  acc.recordLlmUsage({ tokensIn: 100, tokensOut: 40 });
  acc.recordLlmUsage({ tokensIn: 10, tokensOut: 5 });
  const s = acc.snapshot();
  assert.deepEqual(s, { actionsCount: 2, itemsReadLines: 120, tokensIn: 110, tokensOut: 45 });
});

test('finalize computes timeWorkedMs from startedAt, folds diffstat, emits valid run_summary', async () => {
  const run = { id: 'r1', startedAt: new Date(1_000_000) };
  const acc = createAccumulator({ run, clock: () => new Date(1_000_000) });
  acc.recordAction('terminal');
  acc.recordLlmUsage({ tokensIn: 50, tokensOut: 50, provider: 'Cerebras' });

  const events = [];
  const eventStore = { appendEvent: async (runId, type, data) => { events.push({ type, data }); } };
  let upserted = null;
  const prisma = { codexRunMetric: { upsert: async (args) => { upserted = args; return {}; } } };
  // Cerebras → cost 0 provider_exact; resolve via the real ladder.
  const metric = await acc.finalize({
    diffstat: { additions: 12, deletions: 4 },
    userPlan: 'PRO',
    prisma,
    eventStore,
    env: {},
    clock: () => new Date(1_005_000), // 5s later
  });

  assert.equal(metric.timeWorkedMs, 5000);
  assert.equal(metric.additions, 12);
  assert.equal(metric.deletions, 4);
  assert.equal(metric.actionsCount, 1);
  assert.equal(metric.costSource, 'provider_exact'); // Cerebras
  assert.equal(metric.costOriginalUsd, 0);
  assert.equal(metric.costAppliedUsd, 0);
  // persisted + emitted
  assert.equal(upserted.where.runId, 'r1');
  const summary = events.find((e) => e.type === 'run_summary');
  assert.ok(summary);
  assert.equal(isValidEvent('run_summary', summary.data), true);
});

test('finalize resolves cost via an injected resolver and applies the plan multiplier', async () => {
  const run = { id: 'r1', startedAt: new Date(0) };
  const acc = createAccumulator({ run, clock: () => new Date(0) });
  acc.recordLlmUsage({ tokensIn: 1000, tokensOut: 500, provider: 'OpenRouter', generationId: 'g1' });
  acc.recordLlmUsage({ tokensIn: 1000, tokensOut: 500, provider: 'OpenRouter', generationId: 'g2' });

  // Each call costs $0.10 list → $0.20 original; PRO_MAX → ×0.9 → $0.18 applied.
  const costResolver = async () => ({ costUsd: 0.1, costSource: 'openrouter_generation' });
  const metric = await acc.finalize({ diffstat: { additions: 0, deletions: 0 }, userPlan: 'PRO_MAX', costResolver, clock: () => new Date(1000) });
  assert.equal(metric.costOriginalUsd, 0.2);
  assert.equal(metric.costAppliedUsd, 0.18);
  assert.equal(metric.costSource, 'openrouter_generation');
  assert.ok(metric.costOriginalUsd >= metric.costAppliedUsd);
});

test('finalize without a real prisma skips persistence but still emits the summary', async () => {
  const acc = createAccumulator({ run: { id: 'r1' }, clock: () => new Date(0) });
  const events = [];
  const metric = await acc.finalize({ diffstat: null, userPlan: 'FREE', prisma: undefined, eventStore: { appendEvent: async (r, t, d) => events.push({ t, d }) }, clock: () => new Date(0) });
  assert.equal(metric.additions, 0);
  assert.equal(metric.costAppliedUsd, 0);
  assert.equal(events.length, 1);
});
