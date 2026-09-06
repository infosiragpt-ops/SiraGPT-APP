import { Queue, type ConnectionOptions, type QueueOptions } from 'bullmq';
import type { DocSandboxRepository, DurableDocumentEvent } from './repository';

export const DOC_QUEUE_NAME = 'doc-edit';
export interface DocQueuePayload { jobId: string; }
export interface DocQueueNotice { code: 'DOC_QUEUE_ERROR'; }

/** Redis is delivery only. DB outbox survives failed enqueue and retains the authoritative job. */
export class DocSandboxQueue {
  readonly queue: Queue<DocQueuePayload>;
  // The application bridge owns and closes the existing Redis factory's connection.
  constructor(onError: (notice: DocQueueNotice) => void, connection: ConnectionOptions, runtimeOptions: Pick<QueueOptions, 'skipVersionCheck'> = {}) {
    this.queue = new Queue<DocQueuePayload>(DOC_QUEUE_NAME, {
      connection, ...runtimeOptions,
      defaultJobOptions: { attempts: 1, removeOnComplete: { age: 86_400, count: 2000 }, removeOnFail: { age: 604_800, count: 2000 } },
    });
    this.queue.on('error', () => onError({ code: 'DOC_QUEUE_ERROR' }));
  }
  async enqueue(event: DurableDocumentEvent): Promise<void> {
    if (event.outbox !== 'enqueue') throw new Error('DOC_INVALID_OUTBOX_EVENT');
    if (this.queue.closing) throw new Error('DOC_QUEUE_CLOSED');
    // Each DB retry/recovery has a fresh event. Duplicate dispatch of that event deduplicates in BullMQ.
    const jobId = `doc-${event.id}`;
    await this.queue.add('edit', { jobId: event.jobId }, { jobId });
    if (this.queue.closing) throw new Error('DOC_QUEUE_CLOSED');
    // BullMQ can resolve add() during closing without persisting. Never acknowledge a phantom delivery.
    const stored = await this.queue.getJob(jobId);
    if (!stored || stored.data.jobId !== event.jobId) throw new Error('DOC_QUEUE_DELIVERY_UNCONFIRMED');
  }
  async dispatchOutbox(repository: DocSandboxRepository, limit = 100): Promise<number> {
    const events = await repository.pendingOutbox(limit, 'enqueue');
    let dispatched = 0;
    for (const event of events) {
      if (event.outbox !== 'enqueue') continue; // cleanup reconciler owns its own durable acknowledgements
      await this.enqueue(event);
      await repository.acknowledgeOutbox(event.id);
      dispatched += 1;
    }
    return dispatched;
  }
  async close(): Promise<void> { await this.queue.close(); }
}
