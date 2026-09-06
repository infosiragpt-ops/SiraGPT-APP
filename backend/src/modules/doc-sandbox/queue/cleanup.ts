import type { DocSandboxRepository } from './repository';
import type { PrivateDocumentStorage } from '../storage/private-storage';
import type { DocumentProviderClient } from '../engine/provider-client';

/** No success is recorded until the remote delete succeeds and DB acknowledges it. */
export async function reconcileDocumentCleanup(repository: DocSandboxRepository, storage: PrivateDocumentStorage,
  provider: DocumentProviderClient, signal: AbortSignal, notice: (code: string) => void): Promise<void> {
  for (const job of await repository.jobsNeedingCleanup(10)) {
    signal.throwIfAborted();
    const jobSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
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
        // Include every key generation and orphan not yet attached as an artifact.
        const keys = new Set([...job.storageKeys, ...await storage.list(scope, jobSignal)]);
        for (const key of keys) {
          await storage.remove(scope, key, jobSignal);
          await repository.markStorageKeysPurged(job.id, [key]);
        }
        for (const artifact of await repository.artifactsInternal(job.id)) await repository.markArtifactPurged(job.id, artifact.id);
        // No claim that deleting provider Files terminates the remote container.
      }
      await repository.finishCleanup(job.id);
    } catch { notice('DOC_CLEANUP_PENDING'); }
  }
  for (const event of await repository.pendingOutbox(100, 'cleanup')) {
    const job = await repository.getInternal(event.jobId);
    if (!job.cleanupPending) await repository.acknowledgeOutbox(event.id);
  }
}
