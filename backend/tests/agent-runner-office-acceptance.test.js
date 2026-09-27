'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessOfficeEval, sseError } = require('../src/services/agent-runner/evals/office-acceptance');

function stagePair(tool, callId, ok = true) {
  return [
    { type: 'stage', step: 'tool_call', tool, callId, kind: tool === 'verify_visual' ? 'check' : 'edit', status: 'running' },
    { type: 'stage', step: 'tool_result', tool, callId, kind: tool === 'verify_visual' ? 'check' : 'edit', status: ok ? 'done' : 'error', ok },
  ];
}

const goodStages = [...stagePair('office_edit', 'edit-1'), ...stagePair('verify_visual', 'verify-1')];
const graded = { ok: true, checks: [{ name: 'archivo correcto', ok: true }] };

test('office eval accepts a graded file only with a successful visual stage and persisted trace', () => {
  const result = assessOfficeEval({ graded, stages: goodStages, persistedStages: goodStages, errors: [] });
  assert.equal(result.ok, true);
  assert.ok(result.checks.every((check) => check.ok));
});

test('office eval fails when the visual check is absent, failed, or unpaired', () => {
  for (const stages of [
    stagePair('office_edit', 'edit-1'),
    [...stagePair('office_edit', 'edit-1'), ...stagePair('verify_visual', 'verify-1', false)],
    [...stagePair('office_edit', 'edit-1'), { type: 'stage', step: 'tool_call', tool: 'verify_visual', callId: 'verify-1', kind: 'check', status: 'running' }],
  ]) {
    const result = assessOfficeEval({ graded, stages, persistedStages: goodStages, errors: [] });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.name === 'verificación visual en etapas' && !check.ok));
  }
});

test('office eval fails when the successful visual stage is not persisted with the same callId', () => {
  for (const persistedStages of [[], stagePair('office_edit', 'edit-1'), stagePair('verify_visual', 'other-id')]) {
    const result = assessOfficeEval({ graded, stages: goodStages, persistedStages, errors: [] });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.name === 'verificación visual en trace persistido' && !check.ok));
  }
});

test('office eval fails on SSE errors even if the delivered file is correct', () => {
  const result = assessOfficeEval({ graded, stages: goodStages, persistedStages: goodStages, errors: ['E_PROVIDER'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.name === 'stream sin error' && !check.ok));
  assert.equal(sseError({ type: 'error', code: 'E_PROVIDER' }), 'E_PROVIDER');
  assert.equal(sseError({ type: 'stage', step: 'error', preview: 'falló' }), 'stream_error');
  assert.equal(sseError({ type: 'done', ok: false, code: 'E_TIMEOUT' }), 'E_TIMEOUT');
  assert.equal(sseError({ type: 'stage', step: 'tool_result', ok: false }), null);
});

test('office eval never accepts a failed independent file grade', () => {
  const result = assessOfficeEval({ graded: { ok: false, checks: [{ name: 'archivo correcto', ok: false }] }, stages: goodStages, persistedStages: goodStages, errors: [] });
  assert.equal(result.ok, false);
});
