export interface ReadinessEventSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
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

/** Owns observation subscriptions and a single outstanding operation. A caller
 * timeout cancels its wait, not ownership of work still using shared resources.
 * This primitive does not query Redis or decide whether a worker is ready.
 */
export class DocumentProbeLifetime {
  closed = false;
  private pending: Promise<boolean> | undefined;
  private readonly observed = new Map<ReadinessEventSource, () => void>();
  private readonly events = ['close', 'end', 'reconnecting', 'error'];
  constructor(private readonly invalidate: () => void) {}

  observe(source: ReadinessEventSource): void {
    if (this.observed.has(source) || this.closed) return;
    const listener = (): void => this.invalidate();
    for (const event of this.events) source.on(event, listener);
    this.observed.set(source, listener);
  }

  async run(operation: () => Promise<boolean>, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (this.closed || signal.aborted) return false;
    if (!this.pending) {
      const current = operation().catch(() => false);
      this.pending = current;
      void current.finally(() => { if (this.pending === current) this.pending = undefined; });
    }
    try { return await waitForDocumentOperation(this.pending, signal, timeoutMs); }
    catch { return false; }
  }

  close(): void {
    this.closed = true;
    for (const [source, listener] of this.observed) for (const event of this.events) source.off(event, listener);
    this.observed.clear();
  }
}
