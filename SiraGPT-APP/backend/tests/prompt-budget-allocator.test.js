'use strict';

const test = require('node:test');
const assert = require('node:assert');

const allocator = require('../src/services/prompt-budget-allocator');

const mkBlock = (kind, chars) => ({ kind, text: 'x'.repeat(chars), cacheable: true });

test('estimateTokens: chars/4 ceiling, floor at 1 for non-empty', () => {
  assert.strictEqual(allocator.estimateTokens(''), 0);
  assert.strictEqual(allocator.estimateTokens('x'), 1);
  assert.strictEqual(allocator.estimateTokens('xxxx'), 1);
  assert.strictEqual(allocator.estimateTokens('xxxxx'), 2);
  assert.strictEqual(allocator.estimateTokens('x'.repeat(40)), 10);
});

test('allocate: under budget — no trimming', () => {
  const blocks = [mkBlock('master-prompt', 400), mkBlock('memory', 200)];
  const a = allocator.allocate(blocks, { budgetTokens: 1000 });
  assert.strictEqual(a.overBudgetBefore, false);
  assert.strictEqual(a.overBudgetAfter, false);
  assert.strictEqual(a.trimmedBlocks.length, 0);
});

test('allocate: tier-0 blocks are preserved at full size', () => {
  const blocks = [
    mkBlock('master-prompt', 8000),
    mkBlock('cowork', 8000),
    mkBlock('web-search', 8000),
  ];
  const a = allocator.allocate(blocks, { budgetTokens: 3000 });
  const masterBlock = a.blocks.find((b) => b.kind === 'master-prompt');
  assert.strictEqual(masterBlock.allocatedTokens, masterBlock.originalTokens);
});

test('allocate: trims lower tiers first', () => {
  const blocks = [
    mkBlock('master-prompt', 4000),
    mkBlock('circuit-attribution', 4000),
    mkBlock('memory', 4000),
    mkBlock('evidence', 4000),
  ];
  const a = allocator.allocate(blocks, { budgetTokens: 2500 });
  const evidence = a.blocks.find((b) => b.kind === 'evidence');
  const memory = a.blocks.find((b) => b.kind === 'memory');
  const circuit = a.blocks.find((b) => b.kind === 'circuit-attribution');
  assert.ok(evidence.ratio <= memory.ratio + 0.05, `evidence ${evidence.ratio} should be ≤ memory ${memory.ratio}`);
  assert.ok(memory.ratio <= circuit.ratio + 0.05, `memory ${memory.ratio} should be ≤ circuit ${circuit.ratio}`);
});

test('allocate: respects per-tier min ratios for high tiers when possible', () => {
  const blocks = [
    mkBlock('master-prompt', 200),
    mkBlock('intent-attribution-graph', 8000),
    mkBlock('evidence', 8000),
  ];
  const a = allocator.allocate(blocks, { budgetTokens: 3000 });
  const iag = a.blocks.find((b) => b.kind === 'intent-attribution-graph');
  assert.ok(iag.ratio >= 0.59, `expected ≥ 0.6 ratio, got ${iag.ratio}`);
});

test('allocate: returns trimmedBlocks list when trimming happens', () => {
  const blocks = [
    mkBlock('master-prompt', 1000),
    mkBlock('memory', 8000),
    mkBlock('evidence', 8000),
  ];
  const a = allocator.allocate(blocks, { budgetTokens: 2000 });
  assert.ok(a.trimmedBlocks.length >= 1);
});

test('applyAllocation produces trimmed-text blocks', () => {
  const blocks = [mkBlock('master-prompt', 200), mkBlock('evidence', 4000)];
  const a = allocator.allocate(blocks, { budgetTokens: 200 });
  const trimmed = allocator.applyAllocation(blocks, a);
  assert.strictEqual(trimmed.length, 2);
  const evidence = trimmed.find((b) => b.kind === 'evidence');
  assert.ok(evidence.text.length < 4000);
  assert.ok(evidence.__trimmed);
});

test('applyAllocation preserves block when no trim needed', () => {
  const blocks = [mkBlock('master-prompt', 100)];
  const a = allocator.allocate(blocks, { budgetTokens: 1000 });
  const trimmed = allocator.applyAllocation(blocks, a);
  assert.strictEqual(trimmed[0].text.length, 100);
  assert.strictEqual(trimmed[0].__trimmed, undefined);
});

test('allocate: empty input returns sane defaults', () => {
  const a = allocator.allocate([]);
  assert.strictEqual(a.baselineTokens, 0);
  assert.strictEqual(a.finalTokens, 0);
  assert.strictEqual(a.blocks.length, 0);
});

test('allocate: unknown kinds default to lowest tier', () => {
  const blocks = [mkBlock('master-prompt', 4000), mkBlock('something-weird', 4000)];
  const a = allocator.allocate(blocks, { budgetTokens: 1500 });
  const weird = a.blocks.find((b) => b.kind === 'something-weird');
  assert.strictEqual(weird.tier, 3);
});

test('buildBudgetSummaryLine produces a one-line log message', () => {
  const blocks = [mkBlock('master-prompt', 200), mkBlock('evidence', 8000)];
  const a = allocator.allocate(blocks, { budgetTokens: 500 });
  const line = allocator.buildBudgetSummaryLine(a);
  assert.ok(line.includes('[prompt-budget]'));
  assert.ok(line.includes('baseline='));
  assert.ok(line.includes('final='));
});

test('hot path: 50 blocks under 50ms', () => {
  const blocks = Array.from({ length: 50 }, (_, i) => mkBlock(`kind_${i}`, 200 + (i % 8) * 50));
  const t0 = Date.now();
  const a = allocator.allocate(blocks, { budgetTokens: 5000 });
  allocator.applyAllocation(blocks, a);
  assert.ok(Date.now() - t0 < 50);
});
