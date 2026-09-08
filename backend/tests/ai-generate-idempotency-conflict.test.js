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

test('in-memory idempotency mismatch drops the stale Map entry instead of 409', () => {
  const mismatchIdx = generateIdempotencySource.indexOf(
    'activeTurn.requestFingerprint !== generateIdempotencyRequestHash',
  );
  assert.ok(mismatchIdx >= 0, 'in-memory fingerprint mismatch check must exist');
  const mismatchBlock = generateIdempotencySource.slice(mismatchIdx, mismatchIdx + 520);

  assert.match(
    mismatchBlock,
    /generateLog\.warn\(\s*'idempotency\.stale_turn_dropped'/,
    'mismatch must log the stale-turn drop',
  );
  assert.match(
    mismatchBlock,
    /activeGenerateTurns\.delete\(activeGenerateTurnKey\)/,
    'mismatch must delete the stale Map entry when it still points at that turn',
  );
  assert.doesNotMatch(
    mismatchBlock,
    /respondGenerateTurnError/,
    'in-memory mismatch must not call respondGenerateTurnError',
  );
  assert.doesNotMatch(
    mismatchBlock,
    /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/,
    'in-memory mismatch must not return the reused-key 409',
  );
});

test('waitForActiveTurn failure does not 409 turn_in_progress — retry claims ownership', () => {
  const waitIdx = generateIdempotencySource.indexOf('const activeWait = await waitForActiveTurn(activeTurn)');
  assert.ok(waitIdx >= 0, 'active wait must exist');
  const waitBlock = generateIdempotencySource.slice(waitIdx, waitIdx + 1400);

  assert.match(
    waitBlock,
    /activeWait\.outcome === 'replay'/,
    'replay outcome must still stream the completed owner',
  );
  assert.match(
    waitBlock,
    /activeGenerateTurns\.delete\(activeGenerateTurnKey\)/,
    'non-replay wait must drop the stale Map entry when it still points at that turn',
  );
  assert.match(
    waitBlock,
    /createActiveGenerateTurn\(\s*activeGenerateTurnKey,\s*generateIdempotencyRequestHash/,
    'non-replay wait must continue as the new owner',
  );
  assert.match(
    waitBlock,
    /claimStreamController\([\s\S]*?\{ replaceOwner: true \}/,
    'new owner must claim the stream controller like the empty-slot branch',
  );
  assert.doesNotMatch(
    waitBlock,
    /turn_in_progress/,
    'non-replay wait must not return turn_in_progress',
  );
  assert.doesNotMatch(
    waitBlock,
    /respondGenerateTurnError/,
    'non-replay wait must not call respondGenerateTurnError',
  );
});

test('aborted or closed request releases an incomplete activeGenerateTurns owner', () => {
  assert.match(
    src,
    /function releaseIncompleteActiveGenerateTurn\(turn, reason\)/,
    'incomplete-owner release helper must exist',
  );
  assert.match(
    src,
    /if \(!turn \|\| turn\.settled\) return false;/,
    'completed owners must stay in the Map for replay',
  );
  assert.match(
    src,
    /generateLog\.info\(\s*'client\.detached',[\s\S]{0,240}source:\s*'response_close'[\s\S]{0,240}releaseIncompleteActiveGenerateTurn\(\s*req\._activeGenerateTurn,/,
    'socket close before completion must drop a zombie owner',
  );
  assert.match(
    src,
    /generateLog\.info\(\s*'client\.detached',[\s\S]{0,240}source:\s*'request_abort'[\s\S]{0,240}releaseIncompleteActiveGenerateTurn\(\s*req\._activeGenerateTurn,/,
    'request abort before completion must drop a zombie owner',
  );
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
  assert.match(
    hookBlock,
    /return;/,
    'post-hook must return so it never writes SSE onto a JSON error',
  );
  assert.ok(
    hookBlock.indexOf('return;') < hookBlock.indexOf('let __resp'),
    '4xx guard must run before the SSE replace-frame write',
  );
});
