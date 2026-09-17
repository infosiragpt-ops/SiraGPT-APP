'use strict';

/**
 * Safari chat stuck on "Pensando…": POST /api/ai/generate returned 409
 * in ~50ms with no first token. applyGenerateFairQueue3h63 used to
 * call idempotentGenerateByRequestId (marks pending) and then
 * applyFairGenerateQueueClosed, which saw duplicate_turn on the same
 * request and rejected every turn.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ad = require('../src/services/agent-runner/engine-adapter');
const w63 = require('../src/services/agent-runner/engine-3h63');

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'routes', 'ai.js');
const src = fs.readFileSync(ROUTE_PATH, 'utf8');

function fairQueueWrapperSource() {
  const start = src.indexOf('function applyGenerateFairQueue3h63');
  assert.ok(start >= 0, 'applyGenerateFairQueue3h63 must exist');
  const end = src.indexOf('function startGenerateSseHeartbeat', start);
  assert.ok(end > start, 'wrapper must end before startGenerateSseHeartbeat');
  return src.slice(start, end);
}

test('fair-queue wrapper does not pre-claim request idempotency', () => {
  const block = fairQueueWrapperSource();
  const orchestratorIdx = block.indexOf('applyFairGenerateQueueClosed');
  assert.ok(orchestratorIdx > 0, 'wrapper must call applyFairGenerateQueueClosed');
  const pre = block.slice(0, orchestratorIdx);
  assert.doesNotMatch(
    pre,
    /idempotentGenerateByRequestId\s*\(/,
    'pre-orchestrator must not mark the request pending',
  );
  assert.doesNotMatch(
    pre,
    /dropDuplicateInFlightGenerate\s*\(/,
    'pre-orchestrator must not claim the in-flight map',
  );
  assert.doesNotMatch(
    pre,
    /acquireFairGenerateLock\s*\(/,
    'pre-orchestrator must not take the fair lock twice',
  );
  assert.match(
    block.slice(orchestratorIdx),
    /idempotentGenerateByRequestId:\s*ad\.idempotentGenerateByRequestId/,
    'orchestrator still receives the live helper',
  );
});

test('double-claiming requestId 409s the same turn (the production bug)', () => {
  ad.resetGenerateByRequestId();
  ad.resetInFlightGenerate();
  ad.resetFairGenerateLock?.();
  ad.resetGenerateRateLimit?.();
  const args = {
    sessionKey: 'stream-safari',
    producerId: 'stream-safari',
    requestId: 'pino-req-1',
    waitedMs: 0,
    acquireFairGenerateLock: ad.acquireFairGenerateLock,
    releaseFairGenerateLock: ad.releaseFairGenerateLock,
    queueMaxWait60sThen503: ad.queueMaxWait60sThen503,
    dropDuplicateInFlightGenerate: ad.dropDuplicateInFlightGenerate,
    idempotentGenerateByRequestId: ad.idempotentGenerateByRequestId,
    sessionGenerateRateLimit: ad.sessionGenerateRateLimit,
  };
  ad.idempotentGenerateByRequestId(args.sessionKey, args.requestId);
  const rejected = w63.applyFairGenerateQueueClosed(args);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.code, 'duplicate_turn');
});

test('a single orchestrator claim lets the first generate through', () => {
  ad.resetGenerateByRequestId();
  ad.resetInFlightGenerate();
  ad.resetFairGenerateLock?.();
  ad.resetGenerateRateLimit?.();
  const first = w63.applyFairGenerateQueueClosed({
    sessionKey: 'stream-ok',
    producerId: 'stream-ok',
    requestId: 'pino-req-2',
    waitedMs: 0,
    acquireFairGenerateLock: ad.acquireFairGenerateLock,
    releaseFairGenerateLock: ad.releaseFairGenerateLock,
    queueMaxWait60sThen503: ad.queueMaxWait60sThen503,
    dropDuplicateInFlightGenerate: ad.dropDuplicateInFlightGenerate,
    idempotentGenerateByRequestId: ad.idempotentGenerateByRequestId,
    sessionGenerateRateLimit: ad.sessionGenerateRateLimit,
  });
  assert.equal(first.ok, true);
  assert.equal(first.code, null);
});

test('fair-queue 409 JSON is retryable so the client does not freeze Pensando', () => {
  const idx = src.indexOf("if (fair && fair.ok === false)");
  assert.ok(idx >= 0);
  const block = src.slice(idx, idx + 900);
  assert.match(block, /retryable:\s*fairRetryable/);
  assert.match(block, /generateLog\.warn\(\s*'queue\.rejected'/);
});
