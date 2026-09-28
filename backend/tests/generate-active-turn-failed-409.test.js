'use strict';

/**
 * Item 7 (prod 2026-09-28): `ai.generate.idempotency.active_turn_wait_failed`
 * in bursts of 20–30 identical requests (agents' parallel evals). When the
 * owner of an idempotency key failed, EVERY waiting follower used to become
 * a new owner and start its own generate. Followers now re-wait on whoever
 * claimed the key first (bounded to 3 hops) and replay its result, so one
 * generate runs per key; the surviving retry still owns the turn (the
 * «retry claims ownership» contract in ai-generate-idempotency-conflict).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ALLOWED_EVENTS } = require('../src/services/ai/generate-request-observability');

const SRC = path.join(__dirname, '..', 'src');

test('followers of a failed owner re-wait on the new owner instead of each starting a generate', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'ai.js'), 'utf8');
  const start = src.indexOf('let activeWait = await waitForActiveTurn(activeTurn);');
  assert.ok(start > 0, 'wait present');
  const block = src.slice(start, start + 1600);
  assert.match(block, /for \(let hop = 0; hop < 3 && activeWait\.outcome !== 'replay'; hop \+= 1\)/, 'bounded follow loop');
  assert.match(block, /const claimed = activeGenerateTurns\.get\(activeGenerateTurnKey\);/);
  assert.match(block, /if \(!claimed \|\| claimed === activeTurn\) break;/, 'no new owner yet → this request claims the key');
  assert.match(block, /activeWait = await waitForActiveTurn\(activeTurn\);/, 'follower waits on the claimed owner');
  assert.match(block, /return streamDuplicateTurnReplay\(res, activeWait\.turn, model\);/, 'a finished new owner is replayed');
  assert.doesNotMatch(block, /respondGenerateTurnError\(res, \{\s*code: 'active_turn_failed'/, 'no 409 for the surviving retry');
  // The surviving request still becomes the owner (existing contract).
  assert.match(block, /createActiveGenerateTurn\(\s*activeGenerateTurnKey,\s*generateIdempotencyRequestHash/);
  assert.ok(ALLOWED_EVENTS.has('idempotency.active_turn_followed'));
  assert.ok(ALLOWED_EVENTS.has('idempotency.active_turn_wait_failed'));
});
