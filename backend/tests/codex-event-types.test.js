'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  EVENT_TYPES,
  WIRE_ONLY_TYPES,
  isKnownEventType,
  isValidEvent,
  isPersistedEventType,
  buildEnvelope,
} = require('../src/services/codex/event-types');

// One valid payload per event type — the §5 catalog.
const VALID = {
  run_status: { status: 'running' },
  plan_proposed: { architecture: 'Vite SPA', pages: ['/'], components: ['Nav'], tasks: [{ id: 't1' }] },
  reasoning_start: { blockId: 'b1', label: 'Planning' },
  reasoning_delta: { blockId: 'b1', text: 'thinking…' },
  reasoning_end: { blockId: 'b1', durationMs: 47000 },
  action_start: { actionId: 'a1', kind: 'terminal', command: 'git status', groupId: 'g1' },
  action_end: { actionId: 'a1', status: 'done', outputSummary: 'clean', durationMs: 120, linesRead: 0 },
  narrative_delta: { text: 'Estoy creando el layout.' },
  checkpoint_created: { checkpointId: 'c1', commitSha: 'abc1234', title: 'feat: layout', createdAt: '2026-06-13' },
  run_summary: { metrics: { timeWorkedMs: 1000, actionsCount: 3, costSource: 'estimated' } },
  action_required: { patternId: 'openrouter_402', title: 'Sin créditos', rawError: '402', blockedCapabilities: ['gen'], remediationUrl: 'https://x' },
  heartbeat: {},
};

test('every catalog type has a valid example that passes isValidEvent', () => {
  for (const type of EVENT_TYPES) {
    assert.ok(type in VALID, `missing valid example for ${type}`);
    assert.equal(isValidEvent(type, VALID[type]), true, `valid example for ${type} should pass`);
  }
});

test('unknown event types are rejected', () => {
  assert.equal(isKnownEventType('nope'), false);
  assert.equal(isValidEvent('nope', {}), false);
  assert.equal(isValidEvent('', {}), false);
  assert.equal(isValidEvent(undefined, {}), false);
});

test('run_status rejects an invalid status', () => {
  assert.equal(isValidEvent('run_status', { status: 'banana' }), false);
  assert.equal(isValidEvent('run_status', {}), false);
});

test('action_start requires kind in the allowlist and a groupId', () => {
  assert.equal(isValidEvent('action_start', { actionId: 'a', kind: 'rm', groupId: 'g' }), false);
  assert.equal(isValidEvent('action_start', { actionId: 'a', kind: 'terminal' }), false); // no groupId
  assert.equal(isValidEvent('action_start', { actionId: 'a', kind: 'file_read', groupId: 'g', path: 'x.js' }), true);
});

test('action_end requires status done|error', () => {
  assert.equal(isValidEvent('action_end', { actionId: 'a', status: 'running' }), false);
  assert.equal(isValidEvent('action_end', { actionId: 'a', status: 'error' }), true);
});

test('plan_proposed requires architecture + the three arrays', () => {
  assert.equal(isValidEvent('plan_proposed', { architecture: 'x', pages: [], components: [], tasks: [] }), true);
  assert.equal(isValidEvent('plan_proposed', { architecture: 'x', pages: 'no', components: [], tasks: [] }), false);
  assert.equal(isValidEvent('plan_proposed', { pages: [], components: [], tasks: [] }), false);
});

test('reasoning_end requires a numeric durationMs', () => {
  assert.equal(isValidEvent('reasoning_end', { blockId: 'b', durationMs: '47' }), false);
  assert.equal(isValidEvent('reasoning_end', { blockId: 'b', durationMs: 47 }), true);
});

test('action_required requires patternId/title/rawError/blockedCapabilities', () => {
  assert.equal(isValidEvent('action_required', { patternId: 'p', title: 't', rawError: 'e', blockedCapabilities: [] }), true);
  assert.equal(isValidEvent('action_required', { patternId: 'p', title: 't', rawError: 'e', blockedCapabilities: 'no' }), false);
});

test('heartbeat is wire-only and not persistable; others are persistable', () => {
  assert.deepEqual([...WIRE_ONLY_TYPES], ['heartbeat']);
  assert.equal(isPersistedEventType('heartbeat'), false);
  assert.equal(isPersistedEventType('run_status'), true);
  assert.equal(isPersistedEventType('unknown'), false);
});

test('buildEnvelope wraps fields and defaults ts/data', () => {
  const e = buildEnvelope({ runId: 'r1', seq: 3, type: 'narrative_delta', data: { text: 'hi' }, ts: '2026-06-13T00:00:00.000Z' });
  assert.deepEqual(e, { runId: 'r1', seq: 3, ts: '2026-06-13T00:00:00.000Z', type: 'narrative_delta', data: { text: 'hi' } });
  const d = buildEnvelope({ runId: 'r1', seq: 1, type: 'heartbeat' });
  assert.deepEqual(d.data, {});
  assert.equal(typeof d.ts, 'string');
});
