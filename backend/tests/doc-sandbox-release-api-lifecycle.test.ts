import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Router } from 'express';
import { createDocumentModule, waitForDocumentStartup, withDocumentStartupCleanup } from '../src/modules/doc-sandbox';
import { DocumentReadinessLease, waitForDocumentOperation } from '../src/modules/doc-sandbox/readiness';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Pure lifecycle/precondition tests: real promises, abort signals and timers.
// No Redis/DB/provider/validator substitutes, no document validation or runtime
// isolation claims. An unavailable dependency is a tripwire, never a success.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('readiness refuses invalid lease durations before it can admit a job', () => {
  for (const ttl of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => new DocumentReadinessLease(ttl), { message: 'DOC_READINESS_TTL' });
  }
});

test('readiness is initially closed, expires at the boundary and needs a fresh confirmation', () => {
  const lease = new DocumentReadinessLease(50);
  assert.equal(lease.isReady(0), false);
  const ticket = lease.ticket();
  assert.equal(lease.confirm(ticket, 100), true);
  assert.equal(lease.isReady(149), true);
  assert.equal(lease.isReady(150), false);
  assert.equal(lease.confirm(ticket, 151), true);
  assert.equal(lease.isReady(200), true);
  assert.equal(lease.isReady(201), false);
});

test('an invalidation fences late successful probes and only a new ticket can reopen admission', () => {
  const lease = new DocumentReadinessLease(50);
  const oldTicket = lease.ticket();
  lease.confirm(oldTicket, 100);
  lease.invalidate();
  assert.equal(lease.isReady(101), false);
  assert.notEqual(lease.ticket(), oldTicket);
  assert.equal(lease.confirm(oldTicket, 102), false);
  assert.equal(lease.isReady(102), false);
  assert.equal(lease.confirm(lease.ticket(), 103), true);
  assert.equal(lease.isReady(104), true);
});

test('stop permanently closes the lease even when later probes hold a current ticket', () => {
  const lease = new DocumentReadinessLease(50);
  lease.confirm(lease.ticket(), 100);
  lease.stop();
  const stoppedTicket = lease.ticket();
  assert.equal(lease.confirm(stoppedTicket, 101), false);
  lease.invalidate();
  assert.equal(lease.confirm(lease.ticket(), 102), false);
  lease.stop();
  assert.equal(lease.isReady(103), false);
});

test('independent leases cannot renew or revoke another worker admission', () => {
  const first = new DocumentReadinessLease(50);
  const second = new DocumentReadinessLease(50);
  first.confirm(first.ticket(), 100);
  assert.equal(second.isReady(101), false);
  second.confirm(second.ticket(), 100);
  first.stop();
  assert.equal(second.isReady(101), true);
});

for (const [name, wait] of [
  ['operation', waitForDocumentOperation],
  ['startup', waitForDocumentStartup],
] as const) {
  test(`${name} wait returns the actual resolved value and removes its abort listener`, async () => {
    const controller = new AbortController();
    const value = { ready: true };
    assert.equal(await wait(Promise.resolve(value), controller.signal, 1000), value);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${name} wait preserves rejection identity and removes its abort listener`, async () => {
    const controller = new AbortController();
    const failure = new Error('synthetic-operation-failure');
    await assert.rejects(wait(Promise.reject(failure), controller.signal, 1000), error => error === failure);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${name} wait rejects an already-aborted pending operation`, async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = deferred<void>();
    await assert.rejects(wait(operation.promise, controller.signal, 1000), { message: 'DOC_START_ABORTED' });
    operation.resolve();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${name} wait cancellation detaches listeners and cannot be replaced by late completion`, async () => {
    const controller = new AbortController();
    const operation = deferred<void>();
    const waiting = wait(operation.promise, controller.signal, 1000);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await assert.rejects(waiting, { message: 'DOC_START_ABORTED' });
    operation.resolve();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(waiting, { message: 'DOC_START_ABORTED' });
  });

  test(`${name} wait has a real bounded timeout and safely observes a late rejection`, async () => {
    const controller = new AbortController();
    const operation = deferred<void>();
    const waiting = wait(operation.promise, controller.signal, 5);
    await assert.rejects(waiting, { message: 'DOC_START_TIMEOUT' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    operation.reject(new Error('synthetic-late-rejection'));
    await assert.rejects(waiting, { message: 'DOC_START_TIMEOUT' });
  });
}

test('successful startup does not run failure cleanup', async () => {
  const calls: string[] = [];
  await withDocumentStartupCleanup(async () => { calls.push('construct'); }, async () => { calls.push('cleanup'); });
  assert.deepEqual(calls, ['construct']);
});

test('synchronous startup failure waits for cleanup and returns only the sanitized error', async () => {
  const cleanup = deferred<void>();
  const calls: string[] = [];
  const starting = withDocumentStartupCleanup(() => { throw new Error('synthetic-private-startup-details'); }, async () => {
    calls.push('cleanup-start'); await cleanup.promise; calls.push('cleanup-finish');
  });
  const rejected = assert.rejects(starting, { message: 'DOC_START_FAILED' });
  assert.deepEqual(calls, ['cleanup-start']);
  cleanup.resolve();
  await rejected;
  assert.deepEqual(calls, ['cleanup-start', 'cleanup-finish']);
});

test('an asynchronous construction and cleanup failure cannot disclose either internal cause', async () => {
  const failure = await withDocumentStartupCleanup(
    async () => { throw new Error('synthetic-private-construction'); },
    async () => { throw new Error('synthetic-private-cleanup'); },
  ).then(() => assert.fail('startup unexpectedly succeeded'), error => error as Error);
  assert.equal(failure.message, 'DOC_START_FAILED');
  assert.equal(failure.cause, undefined);
  assert.equal(String(failure).includes('synthetic-private'), false);
});

function unavailableDependencies(): Parameters<typeof createDocumentModule>[0] {
  const unexpected = (): never => assert.fail('disabled/invalid module accessed an I/O dependency');
  return {
    authenticate: Router(),
    get prisma() { return unexpected(); },
    get admissionPolicy() { return unexpected(); },
    get createRedisConnection() { return unexpected(); },
    get runtimeOptions() { return unexpected(); },
    get metrics() { return unexpected(); },
    get isModelPlanEligible() { return unexpected(); },
    get notice() { return unexpected(); },
  };
}

test('disabled module lifecycle performs no I/O construction or reconciliation', async () => {
  const previous = process.env.DOC_SANDBOX_ENGINE;
  try {
    delete process.env.DOC_SANDBOX_ENGINE;
    const module = createDocumentModule(unavailableDependencies());
    assert.equal(typeof module.router, 'function');
    await module.start(); await module.start();
    await module.close(); await module.close();
  } finally {
    if (previous === undefined) delete process.env.DOC_SANDBOX_ENGINE;
    else process.env.DOC_SANDBOX_ENGINE = previous;
  }
});

test('invalid engine configuration fails before touching any I/O dependency', () => {
  const previous = process.env.DOC_SANDBOX_ENGINE;
  try {
    process.env.DOC_SANDBOX_ENGINE = 'unsupported-release-test-engine';
    assert.throws(() => createDocumentModule(unavailableDependencies()), error =>
      error instanceof DocSandboxError && error.code === 'E_NOT_READY' && error.status === 503);
  } finally {
    if (previous === undefined) delete process.env.DOC_SANDBOX_ENGINE;
    else process.env.DOC_SANDBOX_ENGINE = previous;
  }
});
