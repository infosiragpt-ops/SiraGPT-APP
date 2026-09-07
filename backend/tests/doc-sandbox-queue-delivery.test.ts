import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocSandboxQueue, DOC_QUEUE_NAME, type DocQueuePayload } from '../src/modules/doc-sandbox/queue/queue';
import type { DocSandboxRepository, DurableDocumentEvent } from '../src/modules/doc-sandbox/queue/repository';
import type { Queue } from 'bullmq';

// In-process BullMQ stand-in. No Redis socket, ioredis client, or worker is opened.
class FakeQueue extends EventEmitter {
  readonly name: string;
  closing = false;
  jobs = new Map<string, { data: DocQueuePayload }>();
  constructor(name: string) { super(); this.name = name; }
  async add(_name: string, data: DocQueuePayload, opts: { jobId: string }) {
    if (this.closing) return undefined;
    const stored = { data };
    this.jobs.set(opts.jobId, stored);
    return stored;
  }
  async getJob(id: string) { return this.jobs.get(id); }
  async close() { this.closing = true; }
  async waitUntilReady() { return this; }
}

function fakeQueue() {
  const notices: string[] = [];
  const created: FakeQueue[] = [];
  const queue = new DocSandboxQueue(
    notice => notices.push(notice.code),
    { host: '127.0.0.1', port: 1 },
    { skipVersionCheck: true },
    (name) => {
      const instance = new FakeQueue(name);
      created.push(instance);
      return instance as unknown as Queue<DocQueuePayload>;
    },
  );
  return { queue, notices, created };
}

function event(overrides: Partial<DurableDocumentEvent> = {}): DurableDocumentEvent {
  return {
    id: 'evt-1', jobId: 'job-1', seq: 1, type: 'status_changed', payload: { status: 'queued' },
    createdAt: new Date(0), outbox: 'enqueue', ...overrides,
  };
}

test('queue name is the durable document delivery lane', () => {
  const { queue } = fakeQueue();
  assert.equal(DOC_QUEUE_NAME, 'doc-edit');
  assert.equal(queue.queue.name, 'doc-edit');
});

test('constructor error listener reports a stable operational code', () => {
  const { queue, notices } = fakeQueue();
  queue.queue.emit('error', new Error('synthetic redis'));
  assert.ok(notices.includes('DOC_QUEUE_ERROR'));
});

test('enqueue rejects a cleanup outbox event before touching BullMQ', async () => {
  const { queue } = fakeQueue();
  await assert.rejects(queue.enqueue(event({ outbox: 'cleanup' })), /DOC_INVALID_OUTBOX_EVENT/);
});

test('enqueue rejects when the local queue is already closing', async () => {
  const { queue } = fakeQueue();
  await queue.close();
  await assert.rejects(queue.enqueue(event()), /DOC_QUEUE_CLOSED/);
});

test('enqueue confirms the stored job identity before acknowledging', async () => {
  const { queue } = fakeQueue();
  await queue.enqueue(event());
  assert.deepEqual(await queue.queue.getJob('doc-evt-1'), { data: { jobId: 'job-1' } });
});

test('enqueue refuses a missing or mismatched stored delivery', async () => {
  const { queue } = fakeQueue();
  queue.queue.add = (async () => undefined) as typeof queue.queue.add;
  queue.queue.getJob = (async () => undefined) as typeof queue.queue.getJob;
  await assert.rejects(queue.enqueue(event()), /DOC_QUEUE_DELIVERY_UNCONFIRMED/);
  queue.queue.add = (async () => ({ data: { jobId: 'job-1' } })) as typeof queue.queue.add;
  queue.queue.getJob = (async () => ({ data: { jobId: 'other' } })) as typeof queue.queue.getJob;
  await assert.rejects(queue.enqueue(event()), /DOC_QUEUE_DELIVERY_UNCONFIRMED/);
});

test('enqueue that closes during add does not treat the phantom as delivered', async () => {
  const { queue } = fakeQueue();
  queue.queue.add = (async () => {
    await queue.close();
    return undefined;
  }) as typeof queue.queue.add;
  await assert.rejects(queue.enqueue(event()), /DOC_QUEUE_CLOSED/);
});

test('dispatchOutbox skips cleanup events and acknowledges only confirmed enqueue rows', async () => {
  const { queue } = fakeQueue();
  const acked: string[] = [];
  const repository = {
    pendingOutbox: async (limit: number, kind: string) => {
      assert.equal(limit, 50);
      assert.equal(kind, 'enqueue');
      return [
        event({ id: 'skip', outbox: 'cleanup', jobId: 'job-x' }),
        event({ id: 'ok', outbox: 'enqueue', jobId: 'job-2' }),
      ];
    },
    acknowledgeOutbox: async (id: string) => { acked.push(id); },
  } as unknown as DocSandboxRepository;
  assert.equal(await queue.dispatchOutbox(repository, 50), 1);
  assert.deepEqual(acked, ['ok']);
});
