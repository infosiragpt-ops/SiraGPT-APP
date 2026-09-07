import { Router, type RequestHandler } from 'express';
import { Worker, type ConnectionOptions, type QueueOptions, type Processor } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { loadDocumentSandboxConfig, type DocumentSandboxConfig } from './config';
import { createDocumentRouter } from './api/router';
import { DocSandboxRepository } from './queue/repository';
import { DocSandboxQueue, DOC_QUEUE_NAME, type DocQueueFactory, type DocQueueNotice, type DocQueuePayload } from './queue/queue';
import { DocumentSandboxProcessor } from './queue/processor';
import { reconcileDocumentCleanup } from './queue/cleanup';
import { AnthropicDocumentProviderClient } from './engine/provider-client';
import { AnthropicSandboxEngine } from './engine/anthropic-engine';
import { IndependentDocumentValidator } from './validation';
import { createPrivateDocumentS3Client, DocumentDownloadTickets, PrivateDocumentStorage } from './storage/private-storage';
import { DocumentMetrics, type MetricsRegistry } from './observability/metrics';
import { createDocumentModelPolicy } from './model-policy';
import { DocumentReadinessLease, createDocumentWorkerReadinessProbe, DOCUMENT_READINESS_INTERVAL_MS,
  waitForDocumentOperation } from './readiness';
import { DocumentBackgroundLoop, drainDocumentOperations } from './background-lifecycle';

export interface DocumentWorkerLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  waitUntilReady(): Promise<unknown>;
  run(): Promise<unknown>;
  close(force?: boolean): Promise<unknown>;
}
export type DocumentWorkerFactory = (
  name: string,
  processor: Processor<DocQueuePayload>,
  options: { connection: ConnectionOptions; concurrency: number; lockDuration: number; autorun: boolean } & Pick<QueueOptions, 'skipVersionCheck'>,
) => DocumentWorkerLike;

interface ApplicationDependencies {
  prisma: PrismaClient; authenticate: RequestHandler; admissionPolicy: RequestHandler;
  createRedisConnection(options: { label: string; maxRetriesPerRequest: number | null; enableOfflineQueue: boolean; connectTimeout: number; commandTimeout?: number }): ConnectionOptions;
  runtimeOptions: Pick<QueueOptions, 'skipVersionCheck'>;
  metrics: MetricsRegistry;
  isModelPlanEligible(modelName: string, userPlan: string): boolean;
  reconcileDeletedAccounts?(): Promise<void>;
  notice(code: string): void;
  createValidator?(config: DocumentSandboxConfig): IndependentDocumentValidator;
  createQueue?(onError: (notice: DocQueueNotice) => void, connection: ConnectionOptions, runtimeOptions: Pick<QueueOptions, 'skipVersionCheck'>): DocSandboxQueue;
  createWorker?: DocumentWorkerFactory;
  createReadinessProbe?: typeof createDocumentWorkerReadinessProbe;
  createQueueInstance?: DocQueueFactory;
}
export interface DocumentModule { router: Router; start(): Promise<void>; close(): Promise<void> }
/** Startup failures expose no connector bodies and always unwind partial resources. */
export async function withDocumentStartupCleanup(construct: () => void | Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  try { await construct(); }
  catch {
    try { await cleanup(); }
    finally { throw new Error('DOC_START_FAILED'); }
  }
}
export async function waitForDocumentStartup<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs = 10_000): Promise<T> {
  return waitForDocumentOperation(operation, signal, timeoutMs);
}
/** Imports never start timers/workers and cannot cause provider calls. */
export function createDocumentModule(deps: ApplicationDependencies): DocumentModule {
  const config = loadDocumentSandboxConfig();
  if (!config) {
    const router = Router(); router.use(deps.authenticate);
    router.get('/capabilities', (_req, res) => res.set('Cache-Control', 'no-store').json({
      enabled: false, ready: false, supported: false, modelTier: null, modes: [], formats: [], limits: null,
    }));
    router.use((_req, res) => { res.set('Cache-Control', 'no-store').status(503).json({ code: 'E_NOT_READY', message: 'La edición segura de documentos todavía no está habilitada.' }); });
    return { router, start: async () => {}, close: async () => {} };
  }
  const repository = new DocSandboxRepository(deps.prisma);
  const client = createPrivateDocumentS3Client({ region: 'auto', endpoint: config.r2Endpoint ?? `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey } });
  const storage = new PrivateDocumentStorage(client, { bucket: config.bucket, key: config.storageKey,
    keyId: config.keyId, previousKeys: config.previousKeys, maxBytes: config.engine.maxOutputBytes });
  const provider = new AnthropicDocumentProviderClient(config.apiKey);
  const validator = deps.createValidator?.(config)
    ?? new IndependentDocumentValidator({ image: config.validatorImage, runtime: 'runsc', stagingRoot: config.validatorStagingRoot });
  const metrics = new DocumentMetrics(deps.metrics);
  const processor = new DocumentSandboxProcessor({ repository, storage, validator,
    engineFactory: (persistence) => new AnthropicSandboxEngine(provider, config.engine, persistence),
    onNotice: ({ code }) => deps.notice(code),
    onPhase: (phase, seconds) => metrics.phase(phase, seconds),
    onValidation: (level, passed, applicable) => metrics.validation(level, passed, applicable),
  }, { maxTurns: config.maxTurns, maxTokens: config.maxTokens, timeoutMs: config.timeoutMs });
  const controllers = new Map<string, AbortController>();
  const inflight = new Set<Promise<void>>();
  let worker: DocumentWorkerLike | undefined; let queue: DocSandboxQueue | undefined;
  const connections: ConnectionOptions[] = [];
  let stopped = false; let started = false;
  let starting: Promise<void> | undefined;
  let validatorCleanupHealthy = true;
  const lifecycle = new AbortController();
  const readiness = new DocumentReadinessLease();
  let readinessProbe: ReturnType<typeof createDocumentWorkerReadinessProbe> | undefined;
  const router = createDocumentRouter({ authenticate: deps.authenticate, admissionPolicy: deps.admissionPolicy, repository, storage,
    tickets: new DocumentDownloadTickets(config.storageKey), config, notice: deps.notice,
    isReady: () => readiness.isReady() && !stopped,
    resolveModel: createDocumentModelPolicy(config.engine.models, deps.prisma, deps.isModelPlanEligible),
    abort: (id) => controllers.get(id)?.abort(),
  });
  const reconcile = async (): Promise<void> => {
    await repository.reconcileAccountQuota();
    await repository.expireJobs(); await repository.recoverExpiredLeases(); await repository.recoverUndeliveredJobs();
    await queue?.dispatchOutbox(repository);
  };
  const cleanupLoop = new DocumentBackgroundLoop(() =>
    reconcileDocumentCleanup(repository, storage, provider, lifecycle.signal, deps.notice)
      .then(() => deps.reconcileDeletedAccounts?.())
      .catch(() => deps.notice('DOC_CLEANUP_PENDING')), 30_000);
  const validatorCleanupLoop = new DocumentBackgroundLoop(() =>
    validator.reconcileOrphans().then(result => {
      validatorCleanupHealthy = result.pending === 0;
      if (result.pending) { readiness.invalidate(); deps.notice('DOC_VALIDATOR_CLEANUP_PENDING'); }
    }).catch(() => { validatorCleanupHealthy = false; readiness.invalidate(); deps.notice('DOC_VALIDATOR_CLEANUP_PENDING'); }), 30_000);
  const loop = new DocumentBackgroundLoop(() =>
    reconcile().catch(() => deps.notice('DOC_RECONCILIATION_FAILED')), 3000);
  const refreshReadiness = async (): Promise<boolean> => {
    const ticket = readiness.ticket();
    const healthy = await readinessProbe?.check(lifecycle.signal);
    if (!healthy || stopped || !validatorCleanupHealthy) { readiness.invalidate(); return false; }
    // A close/error during an in-flight PING invalidates its old result.
    return readiness.confirm(ticket);
  };
  const readinessLoop = new DocumentBackgroundLoop(() =>
    refreshReadiness().then(() => undefined).catch(() => { readiness.invalidate(); deps.notice('DOC_READINESS_FAILED'); }), DOCUMENT_READINESS_INTERVAL_MS);
  return { router,
    async start() {
      if (stopped) throw new Error('DOC_MODULE_CLOSED');
      if (starting) return starting;
      if (started) return;
      starting = withDocumentStartupCleanup(async () => {
      // Admission remains closed until the actual offline validator and queue
      // are usable. A healthy general API is not a document readiness signal.
      await validator.preflight(lifecycle.signal);
      if (stopped) throw new Error('DOC_MODULE_CLOSED');
      const delivery = deps.createRedisConnection({ label: 'doc-delivery', maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 10_000, commandTimeout: 10_000 });
      connections.push(delivery);
      const execution = deps.createRedisConnection({ label: 'doc-worker', maxRetriesPerRequest: null, enableOfflineQueue: true, connectTimeout: 10_000 });
      connections.push(execution);
      queue = (deps.createQueue ?? ((onError, connection, runtimeOptions) =>
        new DocSandboxQueue(onError, connection, runtimeOptions, deps.createQueueInstance)))(
        ({ code }) => { readiness.invalidate(); deps.notice(code); }, delivery, deps.runtimeOptions);
      worker = (deps.createWorker ?? ((name, processor, options) =>
        new Worker<DocQueuePayload>(name, processor, options)))(DOC_QUEUE_NAME, async (delivery) => {
        const jobId = delivery.data.jobId;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId) || Object.keys(delivery.data).length !== 1) throw new Error('DOC_INVALID_DELIVERY');
        if (controllers.has(jobId)) return; // duplicate delivery must not overwrite the active cancellation handle
        const controller = new AbortController();
        controllers.set(jobId, controller); metrics.active(controllers.size);
        const task = (async () => {
          const before = await repository.getInternal(jobId);
          try { await processor.process(jobId, controller.signal); }
          finally { metrics.completed(before, await repository.getInternal(jobId)); }
        })();
        inflight.add(task);
        try { await task; }
        finally { inflight.delete(task); controllers.delete(jobId); metrics.active(controllers.size); }
      }, { connection: execution, ...deps.runtimeOptions, concurrency: config.concurrency, lockDuration: 60_000, autorun: false });
      worker.on('error', () => { readiness.invalidate(); deps.notice('DOC_WORKER_ERROR'); });
      worker.on('failed', () => deps.notice('DOC_WORKER_DELIVERY_FAILED'));
      await waitForDocumentStartup(Promise.all([worker.waitUntilReady(), queue.queue.waitUntilReady()]), lifecycle.signal);
      if (stopped) throw new Error('DOC_MODULE_CLOSED');
      started = true;
      readinessProbe = (deps.createReadinessProbe ?? createDocumentWorkerReadinessProbe)(
        queue.queue as never, worker as never, () => readiness.invalidate());
      void worker.run().then(() => { readiness.invalidate(); }, () => { readiness.invalidate(); deps.notice('DOC_WORKER_STOPPED'); });
      if (!await refreshReadiness()) throw new Error('DOC_WORKER_NOT_READY');
      if (stopped) throw new Error('DOC_MODULE_CLOSED');
      readinessLoop.start(DOCUMENT_READINESS_INTERVAL_MS);
      loop.start(); cleanupLoop.start(); validatorCleanupLoop.start();
      }, async () => {
        readiness.invalidate(); readinessProbe?.close(); readinessProbe = undefined;
        readinessLoop.pause();
        const notice = (): void => { try { deps.notice('DOC_START_CLEANUP_PENDING'); } catch { /* Cleanup must still attempt every resource. */ } };
        if (worker) { try { await worker.close(true); } catch { notice(); } }
        if (queue) { try { await queue.close(); } catch { notice(); } }
        for (const connection of connections) {
          try { if ('disconnect' in connection && typeof connection.disconnect === 'function') connection.disconnect(); }
          catch { notice(); }
        }
        connections.length = 0; worker = undefined; queue = undefined; started = false;
      });
      try { await starting; }
      finally { starting = undefined; }
    },
    async close() {
      stopped = true; readiness.stop(); lifecycle.abort(); readinessProbe?.close();
      loop.stop(); cleanupLoop.stop(); readinessLoop.stop(); validatorCleanupLoop.stop();
      // A concurrent preflight/start must finish unwinding before releasing the
      // shared client or allowing a late worker to outlive this module.
      if (starting) { try { await starting; } catch { /* Already sanitized by startup cleanup. */ } }
      for (const controller of controllers.values()) controller.abort();
      await worker?.close(true);
      const background = [loop.pending(), cleanupLoop.pending(), validatorCleanupLoop.pending()]
        .filter((operation): operation is Promise<void> => operation !== undefined);
      const release = async (): Promise<void> => {
        await queue?.close();
        for (const connection of connections) if ('disconnect' in connection && typeof connection.disconnect === 'function') connection.disconnect();
        client.destroy();
      };
      await drainDocumentOperations([...inflight, ...background], release, () => deps.notice('DOC_SHUTDOWN_CLEANUP_PENDING'));
    },
  };
}
