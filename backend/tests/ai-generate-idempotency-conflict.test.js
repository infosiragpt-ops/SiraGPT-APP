'use strict';

/**
 * Persist the production generate hotfix:
 * Safari/Cloudflare retried POST /api/ai/generate with the same
 * streamId/idempotencyKey but a new prompt. The route used to 409
 * IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD, then generate's
 * finally wrote SSE frames onto that JSON response (Caddy EOF / 502
 * on /agentes).
 *
 * The generate handler is too large to load in-process, so this file
 * asserts the live wiring on source — same pattern as
 * ai-generate-chat-idor-guard.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'routes', 'ai.js');
const src = fs.readFileSync(ROUTE_PATH, 'utf8');

const preflightIdx = src.indexOf('// ─── Prompt-injection preflight');
const activeStart = src.indexOf('const activeGenerateTurnKey = buildActiveGenerateTurnKey');
assert.ok(activeStart >= 0 && preflightIdx > activeStart, 'generate idempotency block must exist');
const generateIdempotencySource = src.slice(activeStart, preflightIdx);

test('idempotency payload conflict does not 409 or call respondGenerateTurnError', () => {
  const conflictIdx = generateIdempotencySource.indexOf('if (duplicateTurn?.idempotencyConflict)');
  assert.ok(conflictIdx >= 0, 'duplicateTurn idempotencyConflict branch must exist');
  const conflictBlock = generateIdempotencySource.slice(conflictIdx, conflictIdx + 280);

  assert.match(
    conflictBlock,
    /generateLog\.warn\(\s*'idempotency\.payload_conflict'/,
    'conflict must log and continue as a new turn',
  );
  assert.doesNotMatch(
    conflictBlock,
    /respondGenerateTurnError/,
    'payload conflict must not call respondGenerateTurnError',
  );
  assert.doesNotMatch(
    conflictBlock,
    /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/,
    'payload conflict must not return the reused-key 409',
  );
  assert.doesNotMatch(
    conflictBlock,
    /status\(409\)/,
    'payload conflict must not send HTTP 409',
  );
});

test('in-memory payload conflict blocks a live owner but permits a settled transport-id reuse', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'chat-turn-idempotency.js'), 'utf8');
  assert.match(service, /activeTurn\.requestFingerprint !== requestFingerprint[\s\S]*?if \(!activeTurn\.settled\) return \{ outcome: 'conflict' \}/);
  assert.match(service, /if \(turns\.get\(key\) === activeTurn\) turns\.delete\(key\)/);
  assert.match(generateIdempotencySource, /activeClaim\.outcome === 'conflict'[\s\S]*?code: 'idempotency_conflict'/);
  assert.match(generateIdempotencySource, /onMismatch: \(\) => generateLog\.warn\('idempotency\.stale_turn_dropped'/);
});

test('an active owner cannot be replaced after a follower wait times out', () => {
  assert.match(generateIdempotencySource, /const activeClaim = await claimActiveGenerateTurn\(\{/);
  assert.match(generateIdempotencySource, /activeClaim\.outcome === 'replay'[\s\S]*?streamDuplicateTurnReplay/);
  assert.match(
    generateIdempotencySource,
    /activeClaim\.outcome === 'in_progress'[\s\S]*?return respondGenerateTurnError\(res, \{[\s\S]*?code: 'turn_in_progress'[\s\S]*?retryable: true/,
  );
  assert.ok(
    generateIdempotencySource.indexOf("activeClaim.outcome === 'in_progress'")
      < generateIdempotencySource.indexOf('req._activeGenerateTurn = activeClaim.turn'),
    'only an actual new owner may run generation',
  );
});

test('socket detachment preserves the background owner until its finally settles', () => {
  assert.match(
    src,
    /res\.on\('close',[\s\S]{0,240}clientGone = true;[\s\S]{0,240}source: 'response_close'/,
    'socket close must mark the client detached',
  );
  assert.match(
    src,
    /req\.on\('aborted',[\s\S]{0,240}clientGone = true;[\s\S]{0,240}source: 'request_abort'/,
    'request abort must mark the client detached',
  );
  assert.doesNotMatch(src, /releaseIncompleteActiveGenerateTurn/);
  assert.match(src, /if \(req\._activeGenerateTurn\) \{[\s\S]*?req\._activeGenerateTurn\.reject\(new Error\('generate turn ended before persistence'\)\)/);
});

test('generate finally skips SSE post-hook writes onto a JSON 4xx', () => {
  const hookIdx = src.indexOf('if (req._filterCtx && !req._filterCtx._postRan)');
  assert.ok(hookIdx >= 0, 'filter post-hook block must exist');
  const hookBlock = src.slice(hookIdx, hookIdx + 420);

  assert.match(
    hookBlock,
    /res\.headersSent && res\.statusCode >= 400 && res\.statusCode < 500/,
    'post-hook must bail when headers are already a 4xx JSON error',
  );
  assert.match(
    hookBlock,
    /if\s*\(\s*!res\.writableEnded\s*\)/,
    'post-hook must end the response if it is still open',
  );
  assert.match(hookBlock, /res\.end\(\)/);
  assert.match(hookBlock, /\}\s*else \{/,
    'post-hook must skip SSE writes for JSON errors without skipping owner/controller cleanup');
  assert.doesNotMatch(hookBlock, /return;/);
  const cleanupIdx = src.indexOf('streamControllers.delete(__streamControllerKey)', hookIdx);
  assert.ok(cleanupIdx > hookIdx, 'controller cleanup must remain reachable after a 4xx');
});
