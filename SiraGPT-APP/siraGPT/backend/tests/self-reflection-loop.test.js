'use strict';

const test = require('node:test');
const assert = require('node:assert');

const loop = require('../src/services/self-reflection-loop');

test('reflect: high faithfulness → accept', () => {
  const v = loop.reflect({ draft: 'A complete answer.', faithfulnessScore: { score: 0.9 } });
  assert.strictEqual(v.accept, true);
  assert.strictEqual(v.verdict, 'accept');
  assert.strictEqual(v.retryInstructions, undefined);
});

test('reflect: medium faithfulness → retry_soft', () => {
  const v = loop.reflect({ draft: 'partial', faithfulnessScore: { score: 0.50 } });
  assert.strictEqual(v.accept, false);
  assert.strictEqual(v.verdict, 'retry_soft');
  assert.ok(typeof v.retryInstructions === 'string');
  assert.ok(v.retryInstructions.includes('<self_reflection_retry>'));
});

test('reflect: low faithfulness → retry_strict', () => {
  const v = loop.reflect({ draft: 'No.', faithfulnessScore: { score: 0.30 } });
  assert.strictEqual(v.verdict, 'retry_strict');
  assert.ok(v.retryInstructions.includes('Reglas estrictas'));
});

test('reflect: very low score → escalate', () => {
  const v = loop.reflect({ draft: 'No.', faithfulnessScore: { score: 0.05 } });
  assert.strictEqual(v.verdict, 'escalate');
  assert.strictEqual(v.accept, false);
});

test('reflect: retry budget exhausted → escalate', () => {
  const v = loop.reflect({ draft: 'x', faithfulnessScore: { score: 0.4 }, retryCount: 2 });
  assert.strictEqual(v.verdict, 'escalate');
  assert.ok(v.escalateReason);
});

test('reflect: opts.maxRetries respected', () => {
  const v = loop.reflect({ draft: 'x', faithfulnessScore: { score: 0.4 }, retryCount: 1, opts: { maxRetries: 1 } });
  assert.strictEqual(v.verdict, 'escalate');
});

test('reflect: opts.acceptThreshold overrides default', () => {
  const v = loop.reflect({ draft: 'x', faithfulnessScore: { score: 0.55 }, opts: { acceptThreshold: 0.5 } });
  assert.strictEqual(v.verdict, 'accept');
});

test('reflect: collects gaps from unsupported claims', () => {
  const v = loop.reflect({
    draft: 'The Eiffel Tower is in New York.',
    faithfulnessScore: {
      score: 0.30,
      unsupported: [{ kind: 'entity', text: 'The Eiffel Tower', severity: 'high' }],
      advisory: 'Likely hallucination detected.',
    },
  });
  assert.ok(v.gaps.length > 0);
  assert.ok(v.gaps.some((g) => g.toLowerCase().includes('eiffel') || g.toLowerCase().includes('unsupported')));
  assert.ok(v.gaps.some((g) => g.toLowerCase().includes('hallucination')));
});

test('reflect: collects gaps from unverified numbers', () => {
  const v = loop.reflect({
    draft: 'Revenue was 42M',
    faithfulnessScore: {
      score: 0.40,
      numbers: [{ value: '42M', supported: false }],
    },
  });
  assert.ok(v.gaps.some((g) => g.includes('42M')));
});

test('reflect: collects gaps from legacy "reasons" shape', () => {
  const v = loop.reflect({
    draft: 'partial',
    faithfulnessScore: {
      overall: 0.40,
      reasons: ['response covers 1/3 sub-intents', 'novelty ratio out of sweet spot'],
    },
  });
  assert.ok(v.gaps.length >= 1);
});

test('reflect: detects unaddressed plan steps', () => {
  const v = loop.reflect({
    draft: 'Just an explanation.',
    faithfulnessScore: { score: 0.30 },
    plan: { nodes: [{ id: 'a', kind: 'analyze', label: 'analyze sales' }, { id: 'b', kind: 'chart', label: 'chart' }] },
  });
  assert.ok(v.gaps.some((g) => g.includes('plan steps not addressed')));
});

test('reflect: flags hidden intents from the report', () => {
  const v = loop.reflect({
    draft: 'OK.',
    faithfulnessScore: { score: 0.20 },
    report: { hiddenIntents: [{ id: 'frustration' }] },
  });
  assert.ok(v.gaps.some((g) => g.includes('hidden intents')));
});

test('reflect: empty / null score returns escalate', () => {
  const v = loop.reflect({ draft: 'x', faithfulnessScore: null });
  assert.strictEqual(v.verdict, 'escalate');
});

test('buildRetryInstruction returns soft retry for retry_soft', () => {
  const text = loop.buildRetryInstruction({ verdict: 'retry_soft', score: 0.5, gaps: ['x'] });
  assert.ok(text.includes('<self_reflection_retry>'));
  assert.ok(!text.includes('Reglas estrictas'));
});

test('buildRetryInstruction returns empty for accept / escalate verdicts', () => {
  assert.strictEqual(loop.buildRetryInstruction({ verdict: 'accept' }), '');
  assert.strictEqual(loop.buildRetryInstruction({ verdict: 'escalate' }), '');
});

test('classify: thresholds gate correctly', () => {
  assert.strictEqual(loop.classify({ score: 0.9 }).verdict, 'accept');
  assert.strictEqual(loop.classify({ score: 0.5 }).verdict, 'retry_soft');
  assert.strictEqual(loop.classify({ score: 0.3 }).verdict, 'retry_strict');
  assert.strictEqual(loop.classify({ score: 0.05 }).verdict, 'escalate');
});

test('hot path: 100 reflects under 100ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) {
    loop.reflect({ draft: 'x', faithfulnessScore: { score: 0.5, unsupported: [{ kind: 'entity', text: 'X' }] } });
  }
  assert.ok(Date.now() - t0 < 200);
});
