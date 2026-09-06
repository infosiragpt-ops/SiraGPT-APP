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
        const removeKnown = async (keys: ReadonlyArray<string>): Promise<void> => {
          let confirmed: string[] = [];
          const flush = async (): Promise<void> => {
            if (!confirmed.length) return;
            await repository.markStorageKeysPurged(job.id, confirmed);
            confirmed = [];
          };
          try {
            for (const key of keys) {
              jobSignal.throwIfAborted();
              await storage.remove(scope, key, jobSignal);
              confirmed.push(key);
              if (confirmed.length >= 100) await flush();
            }
          } finally {
            // Acknowledging confirmed deletes remains necessary after cancellation.
            // An uncertain DELETE stays in the pre-existing journal for retry.
            await flush();
          }
        };
        // Make durable progress even if LIST fails. Do not redo acknowledged
        // known keys on every time-bounded pass; LIST below still sees late PUTs.
        const alreadyPurged = new Set(job.purgedKeys);
        await removeKnown(job.storageKeys.filter(key => !alreadyPurged.has(key)));
        for await (const keys of storage.iterPages(scope, jobSignal)) {
          jobSignal.throwIfAborted();
          if (!keys.length) continue;
          await repository.reserveCleanupStorageKeys(job.id, [...keys]);
          jobSignal.throwIfAborted();
          await removeKnown(keys);
        }
        // A write behind the traversal cursor must prevent a false completion.
        // No token is retained between reconciliation passes.
        for await (const keys of storage.iterPages(scope, jobSignal)) {
          jobSignal.throwIfAborted();
          if (keys.length) {
            await repository.reserveCleanupStorageKeys(job.id, [...keys]);
            throw new Error('DOC_CLEANUP_PENDING');
          }
        }
        for (const artifact of await repository.artifactsInternal(job.id)) {
          jobSignal.throwIfAborted();
          if (!artifact.purgedAt) await repository.markArtifactPurged(job.id, artifact.id);
        }
        // No claim that deleting provider Files terminates the remote container.
      }
      jobSignal.throwIfAborted();
      await repository.finishCleanup(job.id);
    } catch { notice('DOC_CLEANUP_PENDING'); }
  }
  for (const event of await repository.pendingOutbox(100, 'cleanup')) {
    const job = await repository.getInternal(event.jobId);
    if (!job.cleanupPending) await repository.acknowledgeOutbox(event.id);
  }
}
