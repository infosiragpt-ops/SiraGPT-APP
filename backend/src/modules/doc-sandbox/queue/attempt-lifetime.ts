import { DocSandboxError } from '../types/errors';

/** Owns only local cancellation resources for one delivery. It never renews a
 * lease or extends the fixed job deadline across retries. Repository heartbeat
 * failures use the same controller, independently of this local deadline. */
export class DocumentAttemptLifetime {
  readonly controller = new AbortController();
  timedOut = false;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly cancel = (): void => this.controller.abort();

  constructor(private readonly externalSignal?: AbortSignal) {
    externalSignal?.addEventListener('abort', this.cancel, { once: true });
    if (externalSignal?.aborted) this.cancel();
  }

  expireAt(jobDeadline: number): void {
    const remainingMs = jobDeadline - Date.now();
    if (remainingMs <= 0) throw new DocSandboxError('E_TIMEOUT', 408);
    this.deadlineTimer = setTimeout(() => { this.timedOut = true; this.controller.abort(); }, remainingMs);
  }

  dispose(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.externalSignal?.removeEventListener('abort', this.cancel);
  }
}
