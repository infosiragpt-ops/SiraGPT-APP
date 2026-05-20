'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { selectTeam } = require('../src/orchestration/multi-agent/team-router');

// ── Thesis / academic team ─────────────────────────────────────────

test('selectTeam returns thesis team for tesis intent', () => {
  const team = selectTeam('escribir tesis');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

test('selectTeam returns thesis team for paper intent', () => {
  const team = selectTeam('write a research paper');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

test('selectTeam returns thesis team for investigacion intent', () => {
  const team = selectTeam('hacer investigación científica');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

test('selectTeam returns thesis team for bibliografia intent', () => {
  const team = selectTeam('generar bibliografía');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

// ── Code / engineering team ────────────────────────────────────────

test('selectTeam returns code team for code intent', () => {
  const team = selectTeam('write code for a REST API');
  assert.deepEqual(team, ['planner', 'coder', 'reviewer']);
});

test('selectTeam returns code team for debug intent', () => {
  const team = selectTeam('debug the production error');
  assert.deepEqual(team, ['planner', 'coder', 'reviewer']);
});

test('selectTeam returns code team for refactor intent', () => {
  const team = selectTeam('refactor the auth module');
  assert.deepEqual(team, ['planner', 'coder', 'reviewer']);
});

test('selectTeam returns code team for repo intent', () => {
  const team = selectTeam('analyze github repository');
  assert.deepEqual(team, ['planner', 'coder', 'reviewer']);
});

// ── Default team ───────────────────────────────────────────────────

test('selectTeam returns default team for generic intent', () => {
  const team = selectTeam('explain photosynthesis');
  assert.deepEqual(team, ['planner', 'critic', 'finalizer']);
});

test('selectTeam returns default team for empty intent', () => {
  const team = selectTeam('');
  assert.deepEqual(team, ['planner', 'critic', 'finalizer']);
});

test('selectTeam returns default team for undefined input', () => {
  const team = selectTeam();
  assert.deepEqual(team, ['planner', 'critic', 'finalizer']);
});

// ── Case insensitivity ─────────────────────────────────────────────

test('selectTeam handles mixed case', () => {
  const team = selectTeam('TESIS de Maestría');
  assert.deepEqual(team, ['thesis-writer', 'apa-reviewer', 'citation-verifier']);
});

test('selectTeam handles REFACTOR in uppercase', () => {
  const team = selectTeam('REFACTOR all the things');
  assert.deepEqual(team, ['planner', 'coder', 'reviewer']);
});
