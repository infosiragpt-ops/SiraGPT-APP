'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { upsertMonotonicStep, inferPhase } = require('../src/services/agents/run-trace');

test('run-trace upserts the same step_id', () => {
  const once = upsertMonotonicStep([], { id: 's1', label: 'Analizando solicitud', status: 'running' });
  const twice = upsertMonotonicStep(once, { id: 's1', label: 'Analizando solicitud', status: 'running' });
  assert.equal(twice.length, 1);
});

test('run-trace blocks phase regression and counts a retry', () => {
  const first = upsertMonotonicStep([], {
    id: 's1',
    label: 'Preparando respuesta final',
    status: 'running',
  });
  assert.equal(inferPhase(first[0]), 'redactando');
  const next = upsertMonotonicStep(first, {
    id: 's2',
    label: 'Sintetizando evidencia',
    status: 'running',
  });
  assert.equal(next.length, 1);
  assert.ok((next[0].retryCount || 1) >= 2);
});
