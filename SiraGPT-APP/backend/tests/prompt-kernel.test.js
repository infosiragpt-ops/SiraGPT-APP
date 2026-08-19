'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const kernel = require('../src/services/prompt-kernel');

const ALL_KINDS = [
  'master-prompt', 'openclaw-runtime', 'llm-understanding-packet', 'conversation-understanding',
  'universal-contract', 'enterprise-execution', 'memory', 'cross-chat', 'attribution',
  'circuit-attribution', 'saliency-state', 'intent-attribution-graph', 'feedback', 'evidence',
  'document-enrichment', 'cowork', 'web-search', 'pr5-grounding',
];

describe('planBlocks — pruning easy turns', () => {
  test('trivial low-risk turn prunes the attribution theater + heavy policy', () => {
    const plan = kernel.planBlocks({
      intent: 'text_answer',
      difficulty: { bucket: 'trivial' },
      risk: { level: 'low' },
      presentKinds: ALL_KINDS,
    });
    // theater + heavy policy dropped
    for (const k of ['attribution', 'circuit-attribution', 'saliency-state', 'intent-attribution-graph', 'enterprise-execution', 'openclaw-runtime', 'llm-understanding-packet']) {
      assert.ok(plan.drop.includes(k), `expected ${k} dropped`);
    }
    // load-bearing kept
    for (const k of ['master-prompt', 'universal-contract', 'conversation-understanding', 'evidence', 'memory']) {
      assert.ok(plan.keep.includes(k), `expected ${k} kept`);
      assert.ok(!plan.drop.includes(k));
    }
  });

  test('simple low-risk light intent also prunes', () => {
    const plan = kernel.planBlocks({
      intent: 'text_answer', difficulty: { bucket: 'simple' }, risk: { level: 'low' }, presentKinds: ALL_KINDS,
    });
    assert.ok(plan.drop.length > 0);
    assert.match(plan.rationale, /pruned/);
  });
});

describe('planBlocks — keeping the full stack', () => {
  test('complex turn keeps everything', () => {
    const plan = kernel.planBlocks({
      intent: 'text_answer', difficulty: { bucket: 'complex' }, risk: { level: 'low' }, presentKinds: ALL_KINDS,
    });
    assert.equal(plan.drop.length, 0);
    assert.match(plan.rationale, /kept_full_stack/);
  });

  test('high-risk trivial still keeps the stack', () => {
    const plan = kernel.planBlocks({
      intent: 'text_answer', difficulty: { bucket: 'trivial' }, risk: { level: 'high' }, presentKinds: ALL_KINDS,
    });
    assert.equal(plan.drop.length, 0);
  });

  test('agentic/deliverable intent keeps the stack even when short', () => {
    for (const intent of ['agent_task', 'web_app_build', 'webdev', 'doc', 'math']) {
      const plan = kernel.planBlocks({
        intent, difficulty: { bucket: 'trivial' }, risk: { level: 'low' }, presentKinds: ALL_KINDS,
      });
      assert.equal(plan.drop.length, 0, `intent ${intent} should keep stack`);
    }
  });

  test('ambiguous signal keeps the stack', () => {
    const plan = kernel.planBlocks({
      intent: 'text_answer', difficulty: { bucket: 'trivial' }, risk: { level: 'low' },
      signals: { ambiguous: true }, presentKinds: ALL_KINDS,
    });
    assert.equal(plan.drop.length, 0);
  });
});

describe('applyPlan', () => {
  test('removes dropped kinds, preserves order of the rest', () => {
    const blocks = ALL_KINDS.map((k) => ({ kind: k, text: `x-${k}`, cacheable: false }));
    const plan = kernel.planBlocks({
      intent: 'text_answer', difficulty: { bucket: 'trivial' }, risk: { level: 'low' }, presentKinds: ALL_KINDS,
    });
    const out = kernel.applyPlan(blocks, plan);
    const outKinds = out.map((b) => b.kind);
    assert.ok(!outKinds.includes('saliency-state'));
    assert.ok(outKinds.includes('master-prompt'));
    assert.ok(out.length < blocks.length);
    // master-prompt remains first
    assert.equal(outKinds[0], 'master-prompt');
  });

  test('empty drop → unchanged copy', () => {
    const blocks = [{ kind: 'master-prompt', text: 'a' }];
    const out = kernel.applyPlan(blocks, { drop: [] });
    assert.deepEqual(out.map((b) => b.kind), ['master-prompt']);
    assert.notEqual(out, blocks); // new array
  });

  test('never drops a load-bearing kind even if asked', () => {
    // applyPlan honours the plan, but planBlocks never puts ALWAYS_KEEP in drop.
    const plan = kernel.planBlocks({
      intent: 'text_answer', difficulty: { bucket: 'trivial' }, risk: { level: 'low' },
      presentKinds: ['master-prompt', 'evidence', 'memory', 'saliency-state'],
    });
    assert.ok(!plan.drop.includes('evidence'));
    assert.ok(!plan.drop.includes('memory'));
    assert.ok(!plan.drop.includes('master-prompt'));
  });
});

describe('summarizeForLog', () => {
  test('single line', () => {
    const plan = kernel.planBlocks({ intent: 'text_answer', difficulty: { bucket: 'trivial' }, risk: { level: 'low' }, presentKinds: ALL_KINDS });
    const line = kernel.summarizeForLog(plan);
    assert.match(line, /^\[prompt-kernel\]/);
    assert.ok(!line.includes('\n'));
  });
});
