'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runBrainPipeline, shouldShip, renderBrainAuditBlock } = require('../src/services/sira/cortex-pipeline-orchestrator');

// ─── Basic structure ─────────────────────────────────────────

test('runBrainPipeline: tolerates empty input', () => {
  const v = runBrainPipeline();
  assert.ok(v);
  assert.ok(['ship', 'hold_for_review', 'repair', 'abort'].includes(v.decision));
  assert.ok(Array.isArray(v.reasons));
  assert.equal(typeof v.latency_ms, 'number');
});

test('runBrainPipeline: ships a clean answer with positive signals', () => {
  const v = runBrainPipeline({
    answer: 'La propuesta de Acme Corp asciende a $1,200,000 USD y se entrega el 2026-09-30.',
    evidence: 'Acme Corp propone $1,200,000 USD con entrega el 2026-09-30.',
    envelope: {
      intent_analysis: { primary_intent: { id: 'analyze_document', confidence: 0.9 } },
      raw_input: { user_message: 'Analiza la propuesta de Acme Corp' },
    },
    intentConfidence: 0.9,
    retrieval: { score: 0.85, has_evidence: true },
    quality: { overall: 88 },
  });
  assert.equal(v.decision, 'ship');
  assert.equal(v.blocking_flags, 0);
});

test('runBrainPipeline: high hallucination forces repair', () => {
  const v = runBrainPipeline({
    answer: 'Revenue was $99,999,999 and "we cured cancer yesterday" with 312% growth.',
    evidence: 'Routine quarterly update.',
    envelope: { intent_analysis: { primary_intent: { id: 'analyze_document', confidence: 0.9 } } },
    intentConfidence: 0.9,
  });
  assert.ok(['repair', 'abort'].includes(v.decision));
  assert.ok(v.reasons.some(r => /hallucination/.test(r)));
});

test('runBrainPipeline: blocking plan defects elevate decision', () => {
  const v = runBrainPipeline({
    answer: 'Plain answer.',
    plan: {
      steps: [
        { id: 'a', depends_on: ['b'] },
        { id: 'b', depends_on: ['a'] }, // cycle
      ],
    },
  });
  assert.ok(['repair', 'abort'].includes(v.decision));
  assert.ok(v.repair_hints.length > 0);
});

test('runBrainPipeline: skips stages when their inputs are absent', () => {
  const v = runBrainPipeline({ envelope: null });
  assert.equal(v.stage_results.plan_critic, null);
  assert.equal(v.stage_results.answer_validator, null);
  assert.equal(v.stage_results.hallucination_scanner, null);
});

test('runBrainPipeline: cross-signal incoherence triggers repair', () => {
  const v = runBrainPipeline({
    answer: 'Hello.',
    evidence: 'irrelevant text',
    envelope: {
      intent_analysis: { primary_intent: { id: 'research_with_citations', confidence: 0.9 } },
    },
    classification: { type: 'invoice' },
    intentConfidence: 0.9,
  });
  // intent=research_with_citations + classification=invoice is a mismatch
  assert.ok(v.stage_results.cross_signal_coherence.flags.some(f => f.code === 'intent_vs_classification_mismatch'));
});

test('shouldShip: only true for ship verdict', () => {
  assert.equal(shouldShip({ decision: 'ship' }), true);
  assert.equal(shouldShip({ decision: 'repair' }), false);
  assert.equal(shouldShip({ decision: 'abort' }), false);
  assert.equal(shouldShip(null), false);
});

// ─── Audit rendering ───────────────────────────────────────

test('renderBrainAuditBlock: emits markdown with decision and stages', () => {
  const v = runBrainPipeline({
    answer: 'Plain answer.',
    evidence: 'irrelevant',
  });
  const md = renderBrainAuditBlock(v);
  assert.match(md, /COGNITIVE PIPELINE AUDIT/);
  assert.match(md, /Decision/);
});

test('renderBrainAuditBlock: empty verdict yields empty string', () => {
  assert.equal(renderBrainAuditBlock(null), '');
});
