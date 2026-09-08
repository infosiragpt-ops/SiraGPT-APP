import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { DocumentProbeLifetime } from '../src/modules/doc-sandbox/probe-lifetime';

// The primitive owns native asynchronous operations/subscriptions only. These
// are not Redis/worker substitutes and make no assertion of service readiness.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('concurrent waits share one operation and a settled operation permits a new one', async () => {
  const lifetime = new DocumentProbeLifetime(() => {});
  const pending = deferred<boolean>(); let calls = 0;
  const run = () => { calls++; return pending.promise; };
  const controller = new AbortController();
  const one = lifetime.run(run, controller.signal, 1000);
  const two = lifetime.run(run, controller.signal, 1000);
  assert.equal(calls, 1);
  pending.resolve(true);
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.equal(await lifetime.run(async () => { calls++; return false; }, controller.signal, 1000), false);
  assert.equal(calls, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  lifetime.close();
});

test('timeout retains an unsettled operation rather than accumulating replacements', async () => {
  const lifetime = new DocumentProbeLifetime(() => {});
  const pending = deferred<boolean>(); let calls = 0;
  const run = () => { calls++; return pending.promise; };
  const signal = new AbortController().signal;
  assert.equal(await lifetime.run(run, signal, 5), false);
  const waiting = lifetime.run(run, signal, 1000);
  assert.equal(calls, 1);
  pending.resolve(false);
  assert.equal(await waiting, false);
  assert.equal(await lifetime.run(async () => { calls++; return true; }, signal, 1000), true);
  assert.equal(calls, 2);
  lifetime.close();
});

test('cancellation belongs to each waiter and never cancels shared operation ownership', async () => {
  const lifetime = new DocumentProbeLifetime(() => {});
  const pending = deferred<boolean>(); let calls = 0;
  const run = () => { calls++; return pending.promise; };
  const cancelled = new AbortController(), surviving = new AbortController();
  const one = lifetime.run(run, cancelled.signal, 1000);
  const two = lifetime.run(run, surviving.signal, 1000);
  cancelled.abort(); assert.equal(await one, false);
  assert.equal(calls, 1);
  pending.resolve(true); assert.equal(await two, true);
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0);
  assert.equal(getEventListeners(surviving.signal, 'abort').length, 0);
  lifetime.close();
});

test('pre-aborted and closed lifetime cannot start work or install event handlers', async () => {
  const lifetime = new DocumentProbeLifetime(() => assert.fail('unexpected invalidation'));
  const aborted = new AbortController(); aborted.abort();
  const operation = async (): Promise<boolean> => assert.fail('unexpected work');
  assert.equal(await lifetime.run(operation, aborted.signal, 100), false);
  lifetime.close(); lifetime.close();
  assert.equal(await lifetime.run(operation, new AbortController().signal, 100), false);
  const events = new EventEmitter(); lifetime.observe(events);
  assert.equal(events.eventNames().length, 0);
});

test('an operation rejection is observed and releases ownership for a later attempt', async () => {
  const lifetime = new DocumentProbeLifetime(() => {});
  const signal = new AbortController().signal;
  assert.equal(await lifetime.run(async () => { throw new Error('private operation error'); }, signal, 100), false);
  assert.equal(await lifetime.run(async () => true, signal, 100), true);
  lifetime.close();
});

test('native event subscriptions are deduplicated and removed without affecting other subscribers', () => {
  let invalidations = 0, others = 0;
  const lifetime = new DocumentProbeLifetime(() => { invalidations++; });
  const first = new EventEmitter(), second = new EventEmitter();
  first.on('error', () => { others++; });
  lifetime.observe(first); lifetime.observe(first); lifetime.observe(second);
  for (const event of ['close', 'end', 'reconnecting', 'error']) {
    first.emit(event); second.emit(event);
  }
  assert.equal(invalidations, 8); assert.equal(others, 1);
  assert.equal(first.listenerCount('error'), 2);
  lifetime.close();
  assert.equal(first.listenerCount('error'), 1);
  assert.equal(second.eventNames().length, 0);
  first.emit('error'); first.emit('close');
  assert.equal(others, 2); assert.equal(invalidations, 8);
});
