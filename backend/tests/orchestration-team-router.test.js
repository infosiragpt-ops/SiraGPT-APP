'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { selectTeam } = require('../src/orchestration/multi-agent/team-router');

test('selects thesis team for academic intents', () => {
  const team = selectTeam('escribe la tesis con formato APA');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

test('selects thesis team for investigación', () => {
  const team = selectTeam('necesito investigar este paper');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

test('selects code team for development intents', () => {
  const team = selectTeam('debug este código del repo');
  assert.deepEqual(team, ['planner', 'coder', 'reviewer']);
});

test('selects default team for general intents', () => {
  const team = selectTeam('hola, ¿cómo estás?');
  assert.deepEqual(team, ['planner', 'critic', 'finalizer']);
});

test('selectTeam returns default for empty input', () => {
  const team = selectTeam('');
  assert.deepEqual(team, ['planner', 'critic', 'finalizer']);
});
