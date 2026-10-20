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
    mkBlock('cowork', 4000),
  ];
  const a = allocator.allocate(blocks, { budgetTokens: 2500 });
  const cowork = a.blocks.find((b) => b.kind === 'cowork');
  const memory = a.blocks.find((b) => b.kind === 'memory');
  const circuit = a.blocks.find((b) => b.kind === 'circuit-attribution');
  assert.ok(cowork.ratio <= memory.ratio + 0.05, `cowork ${cowork.ratio} should be ≤ memory ${memory.ratio}`);
  assert.ok(memory.ratio <= circuit.ratio + 0.05, `memory ${memory.ratio} should be ≤ circuit ${circuit.ratio}`);
});

test('allocate: explicit user instructions and personalization are protected', () => {
  for (const kind of ['user-profile', 'constraints', 'response-posture', 'current-datetime', 'formatting-contract']) {
    assert.strictEqual(allocator.TIER_BY_KIND[kind], 0, `${kind} must never be trimmed`);
  }
  for (const kind of ['inferred-profile', 'extra-block', 'active-memory', 'feedback', 'evidence', 'web-search', 'project']) {
    assert.strictEqual(allocator.TIER_BY_KIND[kind], 1, `${kind} must outrank memory/cowork`);
  }
  assert.strictEqual(allocator.TIER_BY_KIND['enterprise-execution'], 3, 'the 100k-char operating prompt is cut first');
});

// Real shape of a heavy turn: a large protected master prompt, a giant
// agentic operating prompt, and small personalization/evidence blocks. The
// floors cannot fit, so the last resort runs. The fair share must keep the
// small blocks intact and take the cut from the giant one (the old uniform
// scaling left custom instructions and evidence at ~2-6%).
test('allocate: last resort keeps small blocks intact and cuts the giant one', () => {
  const blocks = [
    mkBlock('master-prompt', 30000),          // ~7.5k tokens, tier 0
    mkBlock('user-profile', 1200),            // tier 0
    mkBlock('enterprise-execution', 140000),  // ~35k tokens, tier 3
    mkBlock('inferred-profile', 800),
    mkBlock('feedback', 1600),
    mkBlock('extra-block', 1000),
    mkBlock('evidence', 11000),
  ];
  const a = allocator.allocate(blocks, { budgetTokens: 12000 });
  const ratio = (kind) => a.blocks.find((b) => b.kind === kind).ratio;
  assert.strictEqual(a.overBudgetAfter, false, `final ${a.finalTokens} must fit 12000`);
  assert.strictEqual(ratio('user-profile'), 1);
  assert.strictEqual(ratio('inferred-profile'), 1);
  assert.strictEqual(ratio('feedback'), 1);
  assert.strictEqual(ratio('extra-block'), 1);
  assert.ok(ratio('evidence') >= 0.8, `evidence kept ${ratio('evidence')}`);
  assert.ok(ratio('enterprise-execution') < 0.1, `enterprise ${ratio('enterprise-execution')} absorbs the cut`);
});

test('fairShare: small items keep their size, weights favour higher tiers', () => {
  assert.deepStrictEqual(allocator.fairShare([{ size: 10, weight: 1 }, { size: 1000, weight: 1 }], 100), [10, 90]);
  const [hi, lo] = allocator.fairShare([{ size: 1000, weight: 1 }, { size: 1000, weight: 0.4 }], 140);
  assert.ok(hi > lo, `${hi} > ${lo}`);
  assert.ok(hi + lo <= 140);
  assert.deepStrictEqual(allocator.fairShare([], 50), []);
  assert.deepStrictEqual(allocator.fairShare([{ size: 5, weight: 1 }], 0), [0]);
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
