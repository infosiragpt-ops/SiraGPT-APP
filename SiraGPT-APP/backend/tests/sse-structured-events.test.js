'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStructuredEmitter, EVENT_TYPES } = require('../src/services/sira/sse-structured-events');

function buffered() {
  const buffer = [];
  return { sink: { buffer }, buffer };
}

test('EVENT_TYPES lists all canonical event names', () => {
  for (const expected of ['brain_audit', 'validator_complete', 'hallucination_flagged', 'confidence_calculated', 'coherence_evaluated', 'plan_critiqued', 'skill_selected', 'tool_error_classified', 'memory_promotion', 'repair_triggered', 'brain_delivery']) {
    assert.ok(EVENT_TYPES.includes(expected));
  }
});

test('createStructuredEmitter: brainAudit emits expected payload', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.brainAudit({ decision: 'ship', blocking_flags: 0, warning_flags: 1, latency_ms: 7, reasons: ['ok'], repair_hints: [] });
  assert.equal(buffer.length, 1);
  assert.equal(buffer[0].type, 'brain_audit');
  assert.equal(buffer[0].payload.decision, 'ship');
  assert.equal(buffer[0].payload.latency_ms, 7);
});

test('createStructuredEmitter: validatorComplete normalises counts', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.validatorComplete({
    validator: 'answer_validator',
    score: 0.78,
    checks: [
      { status: 'passed' }, { status: 'passed' }, { status: 'failed' }, { status: 'warning' },
    ],
  });
  assert.equal(buffer[0].payload.failed, 1);
  assert.equal(buffer[0].payload.warning, 1);
  assert.equal(buffer[0].payload.total, 4);
});

test('createStructuredEmitter: hallucinationFlagged compacts counts', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.hallucinationFlagged({
    overallRisk: 'high',
    totalFlags: 5,
    unsupportedNumbers: ['1', '2'],
    fabricatedQuotes: ['"foo"'],
    citationDrift: [],
  });
  assert.equal(buffer[0].payload.risk, 'high');
  assert.equal(buffer[0].payload.numbers, 2);
  assert.equal(buffer[0].payload.quotes, 1);
});

test('createStructuredEmitter: confidenceCalculated includes dominant_risk', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.confidenceCalculated({ composite: 0.82, recommendation: 'ship', dominantRisk: { source: 'retrieval' }, coverage: 0.7 });
  assert.equal(buffer[0].payload.dominant_risk, 'retrieval');
});

test('createStructuredEmitter: coherenceEvaluated emits verdict', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.coherenceEvaluated({ verdict: 'partially_coherent', score: 80, summary: { blocking: 0, warning: 1 } });
  assert.equal(buffer[0].payload.verdict, 'partially_coherent');
});

test('createStructuredEmitter: planCritiqued summarises severity + counts', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.planCritiqued({ verdict: 'revise', severity: 'warning', summary: { issue_count: 2, blocking_count: 0 } });
  assert.equal(buffer[0].payload.verdict, 'revise');
});

test('createStructuredEmitter: skillSelected emits id + estimated_cost', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.skillSelected({ id: 'rag_grounded_qa', label: 'RAG QA', estimated_cost: { llm_calls: 2 } }, { id: 'text_answer' });
  assert.equal(buffer[0].payload.id, 'rag_grounded_qa');
  assert.equal(buffer[0].payload.intent, 'text_answer');
});

test('createStructuredEmitter: toolErrorClassified surfaces strategy', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.toolErrorClassified({ category: 'rate_limit', severity: 'transient', retryable: true, strategy: 'retry_with_backoff', retryAfterMs: 5000, telemetry: { toolName: 'web_search' } });
  assert.equal(buffer[0].payload.strategy, 'retry_with_backoff');
  assert.equal(buffer[0].payload.tool, 'web_search');
});

test('createStructuredEmitter: memoryPromotion includes summary counts', () => {
  const { sink, buffer } = buffered();
  const em = createStructuredEmitter(sink);
  em.memoryPromotion({ summary: { promote_count: 3, monitor_count: 1, skip_count: 4, avg_score: 0.41 } });
  assert.equal(buffer[0].payload.promote, 3);
  assert.equal(buffer[0].payload.skip, 4);
});

test('createStructuredEmitter: returns null for missing input', () => {
  const { sink } = buffered();
  const em = createStructuredEmitter(sink);
  assert.equal(em.brainAudit(null), null);
  assert.equal(em.validatorComplete(null), null);
  assert.equal(em.hallucinationFlagged(null), null);
});

test('createStructuredEmitter: emitter without sink does not throw', () => {
  const em = createStructuredEmitter(null);
  // Just verify we can call every method without errors
  em.brainAudit({ decision: 'ship', blocking_flags: 0, warning_flags: 0, latency_ms: 1, reasons: [] });
  em.brainDelivery('ship');
  em.repairTriggered(['foo']);
});

test('createStructuredEmitter: emitter wraps a function sink', () => {
  const events = [];
  const em = createStructuredEmitter((e) => events.push(e));
  em.brainAudit({ decision: 'ship', blocking_flags: 0, warning_flags: 0, latency_ms: 1, reasons: [] });
  assert.equal(events.length, 1);
});
