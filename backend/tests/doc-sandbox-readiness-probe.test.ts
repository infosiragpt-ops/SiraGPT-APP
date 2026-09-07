import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentReadinessLease, createDocumentWorkerReadinessProbe, waitForDocumentOperation,
  DOCUMENT_READINESS_INTERVAL_MS, DOCUMENT_READINESS_PROBE_MS, DOCUMENT_READINESS_TTL_MS,
} from '../src/modules/doc-sandbox/readiness';
import type { ReadinessRedisClient, ReadinessQueue, ReadinessWorker } from '../src/modules/doc-sandbox/readiness';

// In-process Redis/BullMQ stand-ins. This is not a live PING against a worker.
function client(status = 'ready', ping: () => Promise<string> = async () => 'PONG'): ReadinessRedisClient {
  const listeners = new Map<string, Set<() => void>>();
  return {
    status,
    ping,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener); listeners.set(event, set);
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
  };
}

function pair(overrides: Partial<{ running: boolean; status: string; ping: () => Promise<string> }> = {}) {
  const redis = client(overrides.status ?? 'ready', overrides.ping);
  const queue: ReadinessQueue = { client: Promise.resolve(redis) };
  const worker: ReadinessWorker = {
    client: Promise.resolve(redis),
    waitUntilReady: async () => redis,
    isRunning: () => overrides.running ?? true,
  };
  return { redis, queue, worker };
}

test('readiness constants remain the documented lease/probe/interval budget', () => {
  assert.equal(DOCUMENT_READINESS_TTL_MS, 30_000);
  assert.equal(DOCUMENT_READINESS_PROBE_MS, 12_000);
  assert.equal(DOCUMENT_READINESS_INTERVAL_MS, 5000);
  assert.throws(() => new DocumentReadinessLease(0), /DOC_READINESS_TTL/);
  assert.throws(() => new DocumentReadinessLease(Number.NaN), /DOC_READINESS_TTL/);
});

test('waitForDocumentOperation rejects an already-aborted start and a timeout', async () => {
  const aborted = AbortSignal.abort();
  await assert.rejects(waitForDocumentOperation(new Promise(() => undefined), aborted, 50), /DOC_START_ABORTED/);
  const live = new AbortController();
  await assert.rejects(waitForDocumentOperation(new Promise(() => undefined), live.signal, 20), /DOC_START_TIMEOUT/);
  const done = waitForDocumentOperation(Promise.resolve('ok'), new AbortController().signal, 50);
  assert.equal(await done, 'ok');
});

test('probe fails closed when closed, aborted or the worker is not running', async () => {
  const { queue, worker } = pair({ running: false });
  const probe = createDocumentWorkerReadinessProbe(queue, worker, () => undefined, 50);
  assert.equal(await probe.check(new AbortController().signal), false);
  const live = pair();
  const other = createDocumentWorkerReadinessProbe(live.queue, live.worker, () => undefined, 50);
  assert.equal(await other.check(AbortSignal.abort()), false);
  other.close();
  assert.equal(await other.check(new AbortController().signal), false);
});

test('probe requires ready clients and a PONG from every observed connection', async () => {
  const healthy = pair();
  const invalidate: string[] = [];
  const probe = createDocumentWorkerReadinessProbe(healthy.queue, healthy.worker, () => invalidate.push('x'), 200);
  assert.equal(await probe.check(new AbortController().signal), true);
  healthy.redis.on; // retain observation
  const down = pair({ status: 'wait' });
  const waiting = createDocumentWorkerReadinessProbe(down.queue, down.worker, () => undefined, 50);
  assert.equal(await waiting.check(new AbortController().signal), false);
  const rejected = pair({ ping: async () => { throw new Error('blackhole'); } });
  const failing = createDocumentWorkerReadinessProbe(rejected.queue, rejected.worker, () => undefined, 50);
  assert.equal(await failing.check(new AbortController().signal), false);
  const wrong = pair({ ping: async () => 'OK' });
  const mismatch = createDocumentWorkerReadinessProbe(wrong.queue, wrong.worker, () => undefined, 50);
  assert.equal(await mismatch.check(new AbortController().signal), false);
  probe.close(); waiting.close(); failing.close(); mismatch.close();
  assert.equal(invalidate.length, 0);
});

test('a second check reuses the in-flight probe and close unsubscribes listeners', async () => {
  let pings = 0;
  let release!: (value: string) => void;
  const hanging = new Promise<string>(resolve => { release = resolve; });
  const redis = client('ready', async () => { pings += 1; return hanging; });
  const queue: ReadinessQueue = { client: Promise.resolve(redis) };
  const worker: ReadinessWorker = {
    client: Promise.resolve(redis),
    waitUntilReady: async () => redis,
    isRunning: () => true,
  };
  const events: string[] = [];
  const originalOn = redis.on.bind(redis);
  redis.on = (event, listener) => { events.push(event); return originalOn(event, listener); };
  const probe = createDocumentWorkerReadinessProbe(queue, worker, () => undefined, 80);
  const first = probe.check(new AbortController().signal);
  const second = probe.check(new AbortController().signal);
  assert.equal(await first, false); // timeout while ping hangs
  assert.equal(await second, false);
  release('PONG');
  assert.equal(pings, 3);
  assert.deepEqual(events, ['close', 'end', 'reconnecting', 'error']);
  probe.close();
  const again = pair();
  const closed = createDocumentWorkerReadinessProbe(again.queue, again.worker, () => undefined, 50);
  closed.close();
  // Observing after close must not attach more listeners.
  assert.equal(await closed.check(new AbortController().signal), false);
});

test('a client that drops after observation invalidates the lease', async () => {
  const listeners: Array<() => void> = [];
  const redis: ReadinessRedisClient = {
    status: 'ready',
    ping: async () => 'PONG',
    on(_event, listener) { listeners.push(listener); return this; },
    off() { return this; },
  };
  const queue: ReadinessQueue = { client: Promise.resolve(redis) };
  const worker: ReadinessWorker = {
    client: Promise.resolve(redis),
    waitUntilReady: async () => redis,
    isRunning: () => true,
  };
  let invalidated = 0;
  const probe = createDocumentWorkerReadinessProbe(queue, worker, () => { invalidated += 1; }, 200);
  assert.equal(await probe.check(new AbortController().signal), true);
  listeners[0]!();
  assert.equal(invalidated, 1);
  probe.close();
});
