import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentAttemptLifetime } from '../src/modules/doc-sandbox/queue/attempt-lifetime';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Real AbortSignals, listeners, timer callbacks and wall time. No fake clock,
// no repository, service replacement or externally observed IO.
test('lifetime propagates an already aborted caller and cleans its listener', () => {
  const external = AbortSignal.abort();
  const before = getEventListeners(external, 'abort').length;
  const lifetime = new DocumentAttemptLifetime(external);
  assert.equal(lifetime.controller.signal.aborted, true);
  assert.equal(lifetime.timedOut, false);
  lifetime.dispose();
  assert.equal(getEventListeners(external, 'abort').length, before);
});

test('caller cancellation propagates once without pretending a deadline expired', () => {
  const external = new AbortController();
  const lifetime = new DocumentAttemptLifetime(external.signal);
  assert.equal(lifetime.controller.signal.aborted, false);
  assert.equal(getEventListeners(external.signal, 'abort').length, 1);
  external.abort();
  external.abort();
  assert.equal(lifetime.controller.signal.aborted, true);
  assert.equal(lifetime.timedOut, false);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
  lifetime.dispose();
});

test('real deadline callback aborts the attempt and records timeout provenance', async () => {
  const lifetime = new DocumentAttemptLifetime();
  const deadline = Date.now() + 25;
  try {
    const aborted = new Promise<void>(resolve => lifetime.controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    lifetime.expireAt(deadline);
    assert.equal(lifetime.timedOut, false);
    await aborted;
    assert.equal(lifetime.controller.signal.aborted, true);
    assert.equal(lifetime.timedOut, true);
    assert.ok(Date.now() >= deadline - 1);
  } finally { lifetime.dispose(); }
});

test('a past fixed job deadline rejects immediately instead of granting a fresh attempt budget', () => {
  const lifetime = new DocumentAttemptLifetime();
  try {
    assert.throws(() => lifetime.expireAt(Date.now() - 1), (error: unknown) => error instanceof DocSandboxError
      && error.code === 'E_TIMEOUT' && error.status === 408);
    // Existing processing normalizes the explicit error; the callback flag is
    // reserved for asynchronous deadline expiration, not an early throw.
    assert.equal(lifetime.timedOut, false);
    assert.equal(lifetime.controller.signal.aborted, false);
  } finally { lifetime.dispose(); }
});

test('disposing after completion removes listeners and prevents a late timer from marking timeout', async () => {
  const external = new AbortController();
  const lifetime = new DocumentAttemptLifetime(external.signal);
  lifetime.expireAt(Date.now() + 20);
  lifetime.dispose();
  lifetime.dispose();
  external.abort();
  await delay(40);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
  assert.equal(lifetime.controller.signal.aborted, false);
  assert.equal(lifetime.timedOut, false);
});

test('heartbeat-driven controller abort is not misclassified as timeout before disposal', async () => {
  const lifetime = new DocumentAttemptLifetime();
  lifetime.expireAt(Date.now() + 20);
  lifetime.controller.abort();
  assert.equal(lifetime.controller.signal.aborted, true);
  assert.equal(lifetime.timedOut, false);
  lifetime.dispose();
  await delay(40);
  assert.equal(lifetime.timedOut, false);
});

test('cancellation without final disposal preserves the original fixed deadline accounting', async () => {
  const external = new AbortController();
  const lifetime = new DocumentAttemptLifetime(external.signal);
  try {
    lifetime.expireAt(Date.now() + 20);
    external.abort();
    assert.equal(lifetime.timedOut, false);
    await delay(40);
    assert.equal(lifetime.timedOut, true);
  } finally { lifetime.dispose(); }
});
