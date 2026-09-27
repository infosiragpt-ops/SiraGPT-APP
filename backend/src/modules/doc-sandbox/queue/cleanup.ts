import type { DocSandboxRepository } from './repository';
import type { PrivateDocumentStorage } from '../storage/private-storage';
import type { DocumentProviderClient } from '../engine/provider-client';
import { removeAndAcknowledge } from './acknowledged-deletion';

/** Log-safe context for a notice: identifiers and classes only, never messages, hosts, keys or bodies. */
export interface DocumentNoticeDetail { jobId?: string; stage?: string; reason?: string; retryInMs?: number }
export type DocumentNotice = (code: string, detail?: DocumentNoticeDetail) => void;

export const CLEANUP_RETRY_BASE_MS = 30_000;
export const CLEANUP_RETRY_MAX_MS = 3_600_000;
/** 30 s, 1 min, 2 min … capped at 1 h: a broken store costs one line per step, not one per pass. */
export function cleanupRetryDelayMs(failures: number): number {
  const exponent = Number.isFinite(failures) ? Math.max(0, Math.min(20, Math.floor(failures) - 1)) : 0;
  return Math.min(CLEANUP_RETRY_MAX_MS, CLEANUP_RETRY_BASE_MS * 2 ** exponent);
}
/** Consecutive cleanup failures per job in this process. The durable gate is cleanup_not_before. */
export class DocumentCleanupBackoff {
  private readonly failures = new Map<string, number>();
  constructor(private readonly maxTracked = 10_000) {}
  failed(jobId: string): number {
    const count = (this.failures.get(jobId) ?? 0) + 1;
    this.failures.delete(jobId);
    this.failures.set(jobId, count);
    if (this.failures.size > this.maxTracked) this.failures.delete(this.failures.keys().next().value!);
    return cleanupRetryDelayMs(count);
  }
  succeeded(jobId: string): void { this.failures.delete(jobId); }
  count(jobId: string): number { return this.failures.get(jobId) ?? 0; }
}

const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/;
/** Error class for logs: SDK/system/domain codes and HTTP status, never the message
 * (an ENOTFOUND message carries the bucket host, an S3 body can echo keys). */
export function documentFailureReason(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const { name, code, $metadata } = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const safeName = typeof name === 'string' && SAFE_TOKEN.test(name) && name !== 'Error' ? name : undefined;
  if (safeName === 'TimeoutError') return 'timeout';
  if (safeName === 'AbortError') return 'aborted';
  const status = $metadata?.httpStatusCode;
  if (typeof status === 'number' && Number.isInteger(status)) return safeName ? `s3_${status}:${safeName}` : `s3_${status}`;
  if (typeof code === 'string' && SAFE_TOKEN.test(code)) return code;
  return safeName ?? 'unknown';
}

class CleanupIncomplete extends Error {
  readonly code = 'DOC_OBJECTS_REMAIN';
  constructor() { super('DOC_CLEANUP_PENDING'); }
}

/** No success is recorded until the remote delete succeeds and DB acknowledges it.
 * With `backoff`, a failing job is deferred durably (30 s → 1 h) instead of retried every pass. */
export async function reconcileDocumentCleanup(repository: DocSandboxRepository, storage: PrivateDocumentStorage,
  provider: DocumentProviderClient, signal: AbortSignal, notice: DocumentNotice, backoff?: DocumentCleanupBackoff): Promise<void> {
  for (const job of await repository.jobsNeedingCleanup(10)) {
    signal.throwIfAborted();
    const jobSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let stage = 'provider_files';
    try {
      // Provider Files can be removed early. Container TTL and late-write grace remain durable gates.
      for (const file of await repository.providerFilesForCleanup(job.id)) {
        try {
          await provider.delete(file.fileId, { signal: jobSignal, timeoutMs: 10_000 });
          await repository.markProviderFileDeleted(job.id, file.fileId, true);
        } catch {
          await repository.markProviderFileDeleted(job.id, file.fileId, false);
          notice('DOC_PROVIDER_CLEANUP_PENDING');
        }
      }
      if (job.deletedAt && (!job.cleanupNotBefore || job.cleanupNotBefore.getTime() <= Date.now())) {
        const scope = { userId: job.userId, jobId: job.id };
        const removeKnown = (keys: ReadonlyArray<string>): Promise<void> => removeAndAcknowledge(keys, jobSignal,
          key => storage.remove(scope, key, jobSignal), confirmed => repository.markStorageKeysPurged(job.id, confirmed));
        // Make durable progress even if LIST fails. Do not redo acknowledged
        // known keys on every time-bounded pass; LIST below still sees late PUTs.
        const alreadyPurged = new Set(job.purgedKeys);
        stage = 'storage_delete';
        await removeKnown(job.storageKeys.filter(key => !alreadyPurged.has(key)));
        stage = 'storage_list';
        for await (const keys of storage.iterPages(scope, jobSignal)) {
          jobSignal.throwIfAborted();
          if (!keys.length) continue;
          await repository.reserveCleanupStorageKeys(job.id, [...keys]);
          jobSignal.throwIfAborted();
          await removeKnown(keys);
        }
        // A write behind the traversal cursor must prevent a false completion.
        // No token is retained between reconciliation passes.
        stage = 'storage_verify';
        for await (const keys of storage.iterPages(scope, jobSignal)) {
          jobSignal.throwIfAborted();
          if (keys.length) {
            await repository.reserveCleanupStorageKeys(job.id, [...keys]);
            throw new CleanupIncomplete();
          }
        }
        stage = 'artifacts';
        for (const artifact of await repository.artifactsInternal(job.id)) {
          jobSignal.throwIfAborted();
          if (!artifact.purgedAt) await repository.markArtifactPurged(job.id, artifact.id);
        }
        // No claim that deleting provider Files terminates the remote container.
      }
      jobSignal.throwIfAborted();
      stage = 'finish';
      await repository.finishCleanup(job.id);
      backoff?.succeeded(job.id);
    } catch (error) {
      if (signal.aborted) return; // shutdown is not a cleanup failure
      const retryInMs = backoff?.failed(job.id);
      if (retryInMs !== undefined) await repository.deferCleanup(job.id, retryInMs).catch(() => undefined);
      notice('DOC_CLEANUP_PENDING', { jobId: job.id, stage, reason: documentFailureReason(error),
        ...(retryInMs === undefined ? {} : { retryInMs }) });
    }
  }
  for (const event of await repository.pendingOutbox(100, 'cleanup')) {
    const job = await repository.getInternal(event.jobId);
    if (!job.cleanupPending) await repository.acknowledgeOutbox(event.id);
  }
}
