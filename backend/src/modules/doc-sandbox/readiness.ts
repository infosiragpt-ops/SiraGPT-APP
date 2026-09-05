/** Readiness is a renewable capability lease, never a permanent startup bit. */
export const DOCUMENT_READINESS_TTL_MS = 30_000;
export const DOCUMENT_READINESS_PROBE_MS = 12_000;
export const DOCUMENT_READINESS_INTERVAL_MS = 5000;

export class DocumentReadinessLease {
  private generation = 0;
  private expiresAt = 0;
  private stopped = false;
  constructor(private readonly ttlMs = DOCUMENT_READINESS_TTL_MS) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('DOC_READINESS_TTL');
  }
  ticket(): number { return this.generation; }
  invalidate(): void { this.generation++; this.expiresAt = 0; }
  confirm(ticket: number, now = Date.now()): boolean {
    if (this.stopped || ticket !== this.generation) return false;
    this.expiresAt = now + this.ttlMs;
    return true;
  }
  isReady(now = Date.now()): boolean { return !this.stopped && this.expiresAt > now; }
  stop(): void { this.stopped = true; this.invalidate(); }
}

export interface ReadinessRedisClient {
  status: string;
  ping(): Promise<string>;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}
export interface ReadinessQueue { client: Promise<ReadinessRedisClient>; }
export interface ReadinessWorker extends ReadinessQueue {
  waitUntilReady(): Promise<ReadinessRedisClient>;
  isRunning(): boolean;
}

export async function waitForDocumentOperation<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('DOC_START_ABORTED'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('DOC_START_TIMEOUT')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
}

/** Reads all three actual Redis clients, including BullMQ's blocking duplicate.
 * At most one outstanding probe is retained if a socket blackholes. No new
 * connections, synthetic queue jobs, Redis writes or isolation claims.
 */
export function createDocumentWorkerReadinessProbe(queue: ReadinessQueue, worker: ReadinessWorker,
  invalidate: () => void, timeoutMs = DOCUMENT_READINESS_PROBE_MS): { check(signal: AbortSignal): Promise<boolean>; close(): void } {
  let pending: Promise<boolean> | undefined;
  let closed = false;
  const observed = new Map<ReadinessRedisClient, () => void>();
  const events = ['close', 'end', 'reconnecting', 'error'];
  const observe = (client: ReadinessRedisClient): void => {
    if (observed.has(client) || closed) return;
    const listener = (): void => invalidate();
    for (const event of events) client.on(event, listener);
    observed.set(client, listener);
  };
  return {
    async check(signal: AbortSignal): Promise<boolean> {
      if (closed || signal.aborted || !worker.isRunning()) return false;
      if (!pending) {
        const current = (async () => {
          const clients = await Promise.all([queue.client, worker.client, worker.waitUntilReady()]);
          if (closed) return false;
          clients.forEach(observe);
          if (!worker.isRunning() || clients.some((client) => client.status !== 'ready')) return false;
          // BullMQ's blocking command is bounded at 10s (worker maximumBlockTimeout).
          // PING on that same connection queues behind it, so the production
          // probe budget must exceed 10s; a 1-2s timeout rejects healthy idle workers.
          // Keep ownership until EVERY ping settles: a producer timeout must
          // not allow another ping to accumulate on still-blackholed worker sockets.
          const replies = await Promise.allSettled(clients.map((client) => client.ping()));
          return !closed && worker.isRunning() && replies.every((reply) => reply.status === 'fulfilled' && reply.value === 'PONG') &&
            clients.every((client) => client.status === 'ready');
        })().catch(() => false);
        pending = current;
        void current.finally(() => { if (pending === current) pending = undefined; });
      }
      try { return await waitForDocumentOperation(pending, signal, timeoutMs); }
      catch { return false; }
    },
    close(): void {
      closed = true;
      for (const [client, listener] of observed) for (const event of events) client.off(event, listener);
      observed.clear();
    },
  };
}
