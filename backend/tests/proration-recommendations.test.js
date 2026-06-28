'use strict';

// Unit tests for ProrationService.getPlanChangeRecommendations — the pure
// advice helper (no DB/Stripe) that had no direct coverage. Pins the three
// independent threshold rules and that they compose / stay silent correctly.

const test = require('node:test');
const assert = require('node:assert/strict');

const proration = require('../src/services/proration');

test('upgrade with < 7 days left → schedule_next_cycle (avoid prorated charge)', () => {
  const recs = proration.getPlanChangeRecommendations({ isUpgrade: true, isDowngrade: false, remainingDays: 5, netAmount: 10 });
  assert.ok(recs.some((r) => r.type === 'timing' && r.action === 'schedule_next_cycle'));
});

test('downgrade with > 20 days left → change_immediately (capture the credit)', () => {
  const recs = proration.getPlanChangeRecommendations({ isUpgrade: false, isDowngrade: true, remainingDays: 25, netAmount: -10 });
  assert.ok(recs.some((r) => r.type === 'timing' && r.action === 'change_immediately'));
});

test('a near-zero net amount (< $1) → cost change_immediately', () => {
  const recs = proration.getPlanChangeRecommendations({ isUpgrade: true, isDowngrade: false, remainingDays: 15, netAmount: 0.5 });
  assert.ok(recs.some((r) => r.type === 'cost' && r.action === 'change_immediately'));
});

test('no threshold tripped → no recommendations', () => {
  const recs = proration.getPlanChangeRecommendations({ isUpgrade: true, isDowngrade: false, remainingDays: 15, netAmount: 10 });
  assert.deepEqual(recs, []);
});

test('upgrade near cycle end AND a tiny net amount → both rules fire', () => {
  const recs = proration.getPlanChangeRecommendations({ isUpgrade: true, isDowngrade: false, remainingDays: 3, netAmount: 0.2 });
  assert.equal(recs.length, 2);
  assert.ok(recs.some((r) => r.action === 'schedule_next_cycle'));
  assert.ok(recs.some((r) => r.type === 'cost'));
});

test('boundary: exactly 7 days left (not < 7) does not trigger the upgrade-timing rule', () => {
  const recs = proration.getPlanChangeRecommendations({ isUpgrade: true, isDowngrade: false, remainingDays: 7, netAmount: 10 });
  assert.equal(recs.some((r) => r.action === 'schedule_next_cycle'), false);
});
