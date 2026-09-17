/** A completion-paced loop owns one timer and retains its last operation.
 * Stopping prevents new work; it never pretends in-flight cleanup has finished.
 * Callers retain responsibility for classifying/reporting operation failures.
 */
export class DocumentBackgroundLoop {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private generation = 0;

  constructor(private readonly operation: () => Promise<void>, private readonly intervalMs: number) {}

  start(delayMs = 0): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const generation = this.generation;
    if (delayMs > 0) this.timer = setTimeout(() => this.tick(generation), delayMs);
    else this.tick(generation);
  }

  private tick(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.current = this.operation().finally(() => {
      if (!this.stopped && generation === this.generation) this.timer = setTimeout(() => this.tick(generation), this.intervalMs);
    });
  }

  pause(): void {
    this.started = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
  }

  stop(): void {
    this.stopped = true;
    this.pause();
  }

  pending(): Promise<void> | undefined { return this.current; }
}

/** Release resources only after every retained operation settles. A timeout
 * transfers responsibility to the same drain, not to another cleanup attempt.
 */
export async function drainDocumentOperations(operations: Iterable<Promise<unknown>>, release: () => Promise<void>,
  pendingNotice: () => void, timeoutMs = 20_000): Promise<void> {
  const drain = Promise.allSettled([...operations]);
  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([drain.then(() => true), new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  })]);
  if (timer) clearTimeout(timer);
  if (finished) await release();
  else { pendingNotice(); void drain.then(release).catch(pendingNotice); }
}
