'use strict';

const test = require('node:test');
const assert = require('node:assert');

const replay = require('../src/services/attribution-replay-engine');

const makeSnapshot = (overrides = {}) => ({
  prompt: 'build a chart of revenue',
  primaryIntent: { text: 'build', kind: 'action' },
  confidence: 0.8,
  hopsDepth: 1,
  planNodes: 2,
  suppressionConflicts: 0,
  language: 'en',
  multiHopDepth: 1,
  ...overrides,
});

const identityRunner = ({ snapshot }) => ({
  primaryIntent: snapshot.primaryIntent,
  intentConfidence: snapshot.confidence,
  multiHopDepth: snapshot.hopsDepth,
  planNodes: snapshot.planNodes,
  suppressionConflicts: snapshot.suppressionConflicts,
  language: snapshot.language,
});

test('missing snapshot returns ok=false', () => {
  assert.strictEqual(replay.replay({}).ok, false);
});

test('identical input → verdict identical', () => {
  const r = replay.replay({ snapshot: makeSnapshot(), runnerFn: identityRunner });
  assert.strictEqual(r.verdict, 'identical');
  assert.strictEqual(r.matches, true);
});

test('numeric drift → verdict drift', () => {
  const snap = makeSnapshot({ confidence: 0.8 });
  const r = replay.replay({
    snapshot: snap,
    runnerFn: () => ({
      primaryIntent: snap.primaryIntent,
      intentConfidence: 0.95, multiHopDepth: 1, planNodes: 2,
      suppressionConflicts: 0, language: 'en',
    }),
  });
  assert.strictEqual(r.verdict, 'drift');
  assert.ok(r.diffs.some((d) => d.field === 'confidence'));
});

test('primary-intent change → verdict regression', () => {
  const snap = makeSnapshot();
  const r = replay.replay({
    snapshot: snap,
    runnerFn: () => ({
      primaryIntent: { text: 'fix', kind: 'action' },
      intentConfidence: snap.confidence,
      multiHopDepth: snap.hopsDepth,
      planNodes: snap.planNodes,
      suppressionConflicts: snap.suppressionConflicts,
      language: snap.language,
    }),
  });
  assert.strictEqual(r.verdict, 'regression');
});

test('tolerance suppresses small numeric drift', () => {
  const snap = makeSnapshot({ confidence: 0.8 });
  const r = replay.replay({
    snapshot: snap,
    runnerFn: () => ({
      primaryIntent: snap.primaryIntent,
      intentConfidence: 0.82, multiHopDepth: 1, planNodes: 2,
      suppressionConflicts: 0, language: 'en',
    }),
    opts: { numericTolerance: 0.1 },
  });
  assert.strictEqual(r.verdict, 'identical');
});

test('language change → verdict drift', () => {
  const snap = makeSnapshot({ language: 'en' });
  const r = replay.replay({
    snapshot: snap,
    runnerFn: () => ({
      primaryIntent: snap.primaryIntent,
      intentConfidence: snap.confidence,
      multiHopDepth: snap.hopsDepth,
      planNodes: snap.planNodes,
      suppressionConflicts: snap.suppressionConflicts,
      language: 'es',
    }),
  });
  assert.strictEqual(r.verdict, 'drift');
});

test('runner throws → ok=false with error', () => {
  const r = replay.replay({ snapshot: makeSnapshot(), runnerFn: () => { throw new Error('boom'); } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('boom'));
});

test('runner returns unusable shape → ok=false', () => {
  const r = replay.replay({ snapshot: makeSnapshot(), runnerFn: () => ({ available: false }) });
  assert.strictEqual(r.ok, false);
});

test('diffFields: numeric within tolerance ignored', () => {
  assert.strictEqual(replay.diffFields({ confidence: 0.8 }, { confidence: 0.81 }, 0.05).length, 0);
});

test('diffFields: category change flagged', () => {
  const diffs = replay.diffFields({ primaryIntent: { text: 'build' } }, { primaryIntent: { text: 'fix' } });
  assert.ok(diffs.some((d) => d.kind === 'category' && d.field === 'primaryIntent.text'));
});

test('diffFields: added / removed flags', () => {
  const removed = replay.diffFields({ confidence: 0.5 }, {});
  assert.ok(removed.some((d) => d.kind === 'removed'));
  const added = replay.diffFields({}, { confidence: 0.5 });
  assert.ok(added.some((d) => d.kind === 'added'));
});

test('classifyVerdict: paths', () => {
  assert.strictEqual(replay.classifyVerdict([]), 'identical');
  assert.strictEqual(replay.classifyVerdict([{ field: 'confidence', kind: 'numeric', delta: 0.1 }]), 'drift');
  assert.strictEqual(replay.classifyVerdict([{ field: 'primaryIntent.text', kind: 'category', expected: 'a', actual: 'b' }]), 'regression');
});

test('buildReplayBlock: identical block', () => {
  const r = replay.replay({ snapshot: makeSnapshot(), runnerFn: identityRunner });
  const block = replay.buildReplayBlock(r);
  assert.ok(block.includes('<replay_report>'));
  assert.ok(block.includes('identical'));
});

test('buildReplayBlock: error block surfaces error', () => {
  const block = replay.buildReplayBlock({ ok: false, error: 'oops' });
  assert.ok(block.includes('Error: oops'));
});

test('hot path: 100 replays under 100ms', () => {
  const snap = makeSnapshot();
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) replay.replay({ snapshot: snap, runnerFn: identityRunner });
  assert.ok(Date.now() - t0 < 100);
});
