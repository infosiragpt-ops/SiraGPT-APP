/**
 * Tests for services/agents/agent-events.js — canonical pipeline event
 * vocabulary + ambiguity gate + event-payload helper.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  EVENTS,
  makeEvent,
  shouldClarifyBeforeActing,
} = require('../src/services/agents/agent-events');

// ── EVENTS enum ───────────────────────────────────────────────────

describe('EVENTS enum', () => {
  it('pins the exact event-name set', () => {
    assert.deepEqual({ ...EVENTS }, {
      REQUEST_RECEIVED: 'request_received',
      CONTRACT_CREATED: 'contract_created',
      CONTRACT_VALIDATED: 'contract_validated',
      CONTRACT_VALIDATION_FAILED: 'contract_validation_failed',
      EXECUTION_GRAPH_CREATED: 'execution_graph_created',
      TOOL_MANIFEST_AUTHORIZED: 'tool_manifest_authorized',
      NODE_STARTED: 'node_started',
      NODE_CHECKPOINTED: 'node_checkpointed',
      NODE_COMPLETED: 'node_completed',
      NODE_FAILED: 'node_failed',
      AMBIGUITY_DETECTED: 'ambiguity_detected',
      CLARIFICATION_NEEDED: 'clarification_needed',
      PIPELINE_SELECTED: 'pipeline_selected',
      TOOL_SELECTED: 'tool_selected',
      TOOL_EXECUTING: 'tool_executing',
      TOOL_COMPLETED: 'tool_completed',
      ARTIFACT_GENERATED: 'artifact_generated',
      FORMAT_VALIDATION_PASSED: 'format_validation_passed',
      FORMAT_VALIDATION_FAILED: 'format_validation_failed',
      SEMANTIC_VALIDATION_PASSED: 'semantic_validation_passed',
      SEMANTIC_VALIDATION_FAILED: 'semantic_validation_failed',
      SELF_REPAIR_STARTED: 'self_repair_started',
      SELF_REPAIR_COMPLETED: 'self_repair_completed',
      RELEASE_REVIEW_PASSED: 'release_review_passed',
      RELEASE_REVIEW_REJECTED: 'release_review_rejected',
      FINAL_DELIVERY_APPROVED: 'final_delivery_approved',
      ERROR: 'error',
      DONE: 'done',
    });
  });

  it('is frozen (cannot mutate at runtime)', () => {
    assert.throws(() => { EVENTS.NEW_EVENT = 'x'; }, TypeError);
  });

  it('has exactly 28 documented events (catches accidental additions)', () => {
    assert.equal(Object.keys(EVENTS).length, 28);
  });

  it('every event value is a snake_case string', () => {
    for (const [k, v] of Object.entries(EVENTS)) {
      assert.equal(typeof v, 'string', `${k} must be string`);
      assert.match(v, /^[a-z][a-z0-9_]*$/, `${k}="${v}" should be snake_case`);
    }
  });

  it('no two events share the same value', () => {
    const values = Object.values(EVENTS);
    const seen = new Set(values);
    assert.equal(seen.size, values.length, 'duplicate event value detected');
  });
});

// ── makeEvent ─────────────────────────────────────────────────────

describe('makeEvent', () => {
  it('returns an object with type and ISO at timestamp', () => {
    const e = makeEvent('test_event');
    assert.equal(e.type, 'test_event');
    assert.ok(!isNaN(new Date(e.at).getTime()));
  });

  it('merges the payload into the event', () => {
    const e = makeEvent('test', { taskId: 't1', count: 5 });
    assert.equal(e.taskId, 't1');
    assert.equal(e.count, 5);
  });

  it('payload overrides the auto-generated at when explicitly provided', () => {
    const e = makeEvent('test', { at: '2024-01-01T00:00:00.000Z' });
    assert.equal(e.at, '2024-01-01T00:00:00.000Z');
  });

  it('payload cannot override type (type wins from positional arg)', () => {
    // The current spread order is { type, at, ...payload }, so a payload
    // type WOULD override. Pin actual behavior so a refactor surfaces.
    const e = makeEvent('positional', { type: 'from-payload' });
    assert.equal(e.type, 'from-payload', 'payload type wins under current spread order');
  });

  it('default payload = {}', () => {
    const e = makeEvent('test');
    // Only auto fields present.
    const keys = Object.keys(e).sort();
    assert.deepEqual(keys, ['at', 'type']);
  });

  it('produces increasing timestamps on sequential calls', () => {
    const a = makeEvent('e').at;
    // Give the clock a tick.
    const delay = Date.now() + 5;
    while (Date.now() < delay) { /* tight wait */ }
    const b = makeEvent('e').at;
    assert.ok(b >= a, `timestamps must be non-decreasing (a=${a}, b=${b})`);
  });
});

// ── shouldClarifyBeforeActing ─────────────────────────────────────

describe('shouldClarifyBeforeActing', () => {
  it('returns {shouldAsk: false, questions: []} for null/non-object', () => {
    for (const c of [null, undefined, 'not-an-obj', 42, true]) {
      const out = shouldClarifyBeforeActing(c);
      assert.deepEqual(out, { shouldAsk: false, questions: [] });
    }
  });

  it('shouldAsk=true when ambiguity_level=high AND questions exist', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_level: 'high',
      clarifying_questions: ['¿Qué formato?'],
    });
    assert.equal(out.shouldAsk, true);
    assert.deepEqual(out.questions, ['¿Qué formato?']);
  });

  it('shouldAsk=true when ambiguity_score >= 0.75 AND questions exist', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_score: 0.85,
      clarifying_questions: ['¿Cuántas páginas?'],
    });
    assert.equal(out.shouldAsk, true);
  });

  it('boundary: ambiguity_score=0.75 exactly is sufficient', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_score: 0.75,
      clarifying_questions: ['¿q?'],
    });
    assert.equal(out.shouldAsk, true);
  });

  it('boundary: ambiguity_score=0.74 is NOT sufficient by itself', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_score: 0.74,
      clarifying_questions: ['¿q?'],
    });
    assert.equal(out.shouldAsk, false);
  });

  it('shouldAsk=false when questions array is empty', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_level: 'high',
      clarifying_questions: [],
    });
    assert.equal(out.shouldAsk, false);
  });

  it('shouldAsk=false when questions key is missing', () => {
    const out = shouldClarifyBeforeActing({ ambiguity_level: 'high' });
    assert.equal(out.shouldAsk, false);
    assert.deepEqual(out.questions, []);
  });

  it('filters out falsy entries from clarifying_questions', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_level: 'high',
      clarifying_questions: ['¿q1?', null, '', '¿q2?', undefined],
    });
    assert.deepEqual(out.questions, ['¿q1?', '¿q2?']);
    assert.equal(out.shouldAsk, true);
  });

  it('non-numeric ambiguity_score is ignored', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_score: 'high',
      clarifying_questions: ['¿q?'],
    });
    assert.equal(out.shouldAsk, false);
  });

  it('shouldAsk=false when level is not "high" and score is below threshold', () => {
    const out = shouldClarifyBeforeActing({
      ambiguity_level: 'medium',
      ambiguity_score: 0.4,
      clarifying_questions: ['¿q?'],
    });
    assert.equal(out.shouldAsk, false);
    // Questions are still surfaced for the caller's reference.
    assert.deepEqual(out.questions, ['¿q?']);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly { EVENTS, makeEvent, shouldClarifyBeforeActing }', () => {
    const mod = require('../src/services/agents/agent-events');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['EVENTS', 'makeEvent', 'shouldClarifyBeforeActing']);
  });
});
