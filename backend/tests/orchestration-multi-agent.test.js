'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { selectTeam } = require('../src/orchestration/multi-agent/team-router');

test('selectTeam detects thesis/APA intents and returns thesis team', () => {
  const team = selectTeam('escribir mi tesis doctoral');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

test('selectTeam detects academic intents: paper, investigación, bibliografía', () => {
  const cases = ['paper científico', 'investigación de campo', 'bibliografía APA'];
  cases.forEach(intent => {
    const team = selectTeam(intent);
    assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
  });
});

test('selectTeam detects code/refactor intents and returns code team', () => {
  const team = selectTeam('debug this TypeScript repo');
  assert.deepEqual(team, ['planner', 'coder', 'reviewer']);
});

test('selectTeam returns default team for generic intents', () => {
  const team = selectTeam('dame un consejo');
  assert.deepEqual(team, ['planner', 'critic', 'finalizer']);
});

test('selectTeam returns default team for empty intent', () => {
  const team = selectTeam('');
  assert.deepEqual(team, ['planner', 'critic', 'finalizer']);
});