/**
 * Unit tests for the importance + decay scoring additions to
 * long-term-memory.js. Pure-function level — the LLM extraction path
 * is NOT exercised here, that needs OPENAI_API_KEY and is covered in
 * integration tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  importanceScore,
  decayScore,
  upsertFactMeta,
  getFactMeta,
  normalizeFact,
  HALF_LIFE_DAYS,
} = require('../src/services/long-term-memory');

test('normalizeFact lowercases and collapses whitespace', () => {
  assert.equal(normalizeFact('  The  USER  Likes  Tea  '), 'the user likes tea');
});

test('importanceScore: 1 mention → 0.1, 10 mentions → 1.0, 20 mentions caps at 1.0', () => {
  assert.equal(importanceScore(1), 0.1);
  assert.equal(importanceScore(10), 1);
  assert.equal(importanceScore(20), 1);
});

test('decayScore: age 0 → 1, age = half-life → 0.5, far future → near 0', () => {
  assert.equal(decayScore(0), 1);
  assert.ok(Math.abs(decayScore(HALF_LIFE_DAYS) - 0.5) < 1e-9);
  assert.ok(decayScore(HALF_LIFE_DAYS * 10) < 0.01);
});

test('upsertFactMeta: first call returns mentions=1, repeat calls increment', () => {
  const userId = `test-user-${Math.random()}`;
  const a = upsertFactMeta(userId, 'user likes tea');
  assert.equal(a.mentions, 1);
  const b = upsertFactMeta(userId, 'user likes tea');
  assert.equal(b.mentions, 2);
  const c = upsertFactMeta(userId, 'User Likes Tea'); // case/space variants match
  assert.equal(c.mentions, 3);
});

test('upsertFactMeta: distinct facts tracked separately', () => {
  const userId = `test-user-${Math.random()}`;
  upsertFactMeta(userId, 'user likes tea');
  const second = upsertFactMeta(userId, 'user speaks spanish');
  assert.equal(second.mentions, 1);
});

test('getFactMeta: unseen fact returns default mentions=1', () => {
  const userId = `test-user-${Math.random()}`;
  const meta = getFactMeta(userId, 'never stored');
  assert.equal(meta.mentions, 1);
  assert.equal(meta.ageDays, 0);
});

test('getFactMeta: after upsert reports mentions and non-negative age', () => {
  const userId = `test-user-${Math.random()}`;
  upsertFactMeta(userId, 'user speaks spanish');
  upsertFactMeta(userId, 'user speaks spanish');
  const meta = getFactMeta(userId, 'user speaks spanish');
  assert.equal(meta.mentions, 2);
  assert.ok(meta.ageDays >= 0);
});
