'use strict';

/**
 * Item 7 (prod 2026-09-28): `ai.generate.idempotency.active_turn_wait_failed`
 * in bursts of 20–30 identical requests (agents' parallel evals). Followers
 * of a failed owner must get a retryable 409 JSON in Spanish — not start 20
 * fresh generates — and that exit must never become a «Fallos de respuesta»
 * row or a system issue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const classify = require('../src/services/observability/turn-failures/classify');
const { ALLOWED_EVENTS } = require('../src/services/ai/generate-request-observability');

const SRC = path.join(__dirname, '..', 'src');

test('the wait-failed branch answers a retryable 409 with a Spanish message and releases the key', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'ai.js'), 'utf8');
  const start = src.indexOf("generateLog.warnError('idempotency.active_turn_wait_failed', activeWait.error);");
  assert.ok(start > 0, 'branch present');
  const branch = src.slice(start, start + 900);
  assert.match(branch, /activeGenerateTurns\.delete\(activeGenerateTurnKey\)/, 'the dead owner entry is dropped so a later retry can own the turn');
  assert.match(branch, /return respondGenerateTurnError\(res, \{\s*code: 'active_turn_failed',/);
  assert.match(branch, /message: 'La generación anterior de este mismo mensaje falló\. Reintenta en unos segundos\.'/);
  assert.match(branch, /retryable: true,/);
  assert.match(branch, /retryAfterSeconds: 2,/);
  // The follower never falls through to createActiveGenerateTurn.
  assert.ok(branch.indexOf('return respondGenerateTurnError') < branch.indexOf('req._activeGenerateTurn = createActiveGenerateTurn'));
  // respondGenerateTurnError is a plain JSON 409 before headers are sent.
  assert.match(src, /function respondGenerateTurnError\(res, \{[\s\S]{0,400}?return res\.status\(409\)\.json\(\{ error: code, code, message, retryable \}\);/);
});

test('a 409 active_turn_failed JSON exit is not a recordable turn failure and the event stays a warn', () => {
  const body = { error: 'active_turn_failed', code: 'active_turn_failed', message: 'La generación anterior de este mismo mensaje falló. Reintenta en unos segundos.', retryable: true };
  assert.equal(classify.isRecordableHttpFailure(409, body), false, 'no «turn_failed» tracker row');
  assert.ok(ALLOWED_EVENTS.has('idempotency.active_turn_wait_failed'));
  // The generate logger writes through the pino sink (`warn`), not console.warn,
  // so the system-issues console hook never sees it either.
  const obs = fs.readFileSync(path.join(SRC, 'services', 'ai', 'generate-request-observability.js'), 'utf8');
  assert.match(obs, /warnError: \(event, error, fields\) => emit\('warn', event, \{/);
  assert.doesNotMatch(obs, /console\.warn\(/);
});
