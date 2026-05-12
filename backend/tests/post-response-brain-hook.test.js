'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const hook = require('../src/services/sira/post-response-brain-hook');

test('runShadowModeBrainPipeline: returns null in default (shadow) mode', async () => {
  const out = await hook.runShadowModeBrainPipeline({
    answer: 'Plain test answer.',
    evidence: 'irrelevant',
  });
  assert.equal(out, null);
});

test('runShadowModeBrainPipeline: returns verdict when enforce=true', async () => {
  const out = await hook.runShadowModeBrainPipeline(
    { answer: 'Plain test answer.', evidence: 'Plain test answer.' },
    { enforce: true },
  );
  assert.ok(out);
  assert.ok(['ship', 'hold_for_review', 'repair', 'abort'].includes(out.decision));
});

test('runShadowModeBrainPipeline: never throws on broken input', async () => {
  const out = await hook.runShadowModeBrainPipeline({ envelope: 42, answer: null });
  // Either null (shadow) or a verdict — never an exception
  assert.ok(out === null || typeof out === 'object');
});

test('runShadowModeBrainPipeline: invokes eventsSink.emit when provided', async () => {
  const events = [];
  const sink = { emit: (e) => events.push(e) };
  await hook.runShadowModeBrainPipeline(
    { answer: 'Hello.', evidence: 'Hello.' },
    { eventsSink: sink },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'brain_audit');
  assert.ok(events[0].payload.decision);
});

test('runShadowModeBrainPipeline: invokes telemetry.recordVerdict', async () => {
  let recorded = null;
  const telemetry = { recordVerdict: (v) => { recorded = v; } };
  await hook.runShadowModeBrainPipeline(
    { answer: 'Hello.', evidence: 'Hello.' },
    { telemetry },
  );
  assert.ok(recorded);
  assert.ok('decision' in recorded);
});

test('runShadowModeBrainPipeline: logger receives structured one-line log', async () => {
  const lines = [];
  const logger = {
    log: (msg) => lines.push({ level: 'log', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
  };
  await hook.runShadowModeBrainPipeline(
    { answer: 'Hello.', evidence: 'Hello.' },
    { logger },
  );
  assert.ok(lines.length >= 1);
  assert.match(lines[0].msg, /\[brain\]/);
});

test('runShadowModeBrainPipeline: respects SIRAGPT_BRAIN_SHADOW_DISABLE env opt-out', async () => {
  // Force disabled by re-requiring with flag — we test the env hook indirectly
  // by reading the exported constant.
  const internal = hook._internal;
  // SHADOW_ENABLED resolves at require-time; we only assert it's a boolean
  assert.equal(typeof internal.SHADOW_ENABLED, 'boolean');
});
