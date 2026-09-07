import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, type RequestHandler } from 'express';
import { createDocumentModule, waitForDocumentStartup, withDocumentStartupCleanup } from '../src/modules/doc-sandbox';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import { DocSandboxQueue, type DocQueuePayload } from '../src/modules/doc-sandbox/queue/queue';
import type { Queue } from 'bullmq';
import type { Processor } from 'bullmq';

function env(): NodeJS.ProcessEnv {
  const key = Buffer.alloc(32, 11).toString('base64');
  const model = { id: 'synthetic-mechanical-model', prices: { version: 'unit', inputPerMillionUsd: 1,
    outputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 1.25,
    executionPerHourUsd: 0, minimumExecutionSeconds: 0 }, maxOutputTokensPerTurn: 1024, reservationUsdPerTurn: 0.05 };
  return {
    DOC_SANDBOX_ENGINE: 'anthropic',
    DOC_SANDBOX_MODELS_JSON: JSON.stringify({ mechanical: model, academic: { ...model, id: 'synthetic-academic-model' } }),
    DOC_SANDBOX_SKILL_VERSIONS_JSON: JSON.stringify({ docx: 'v1', xlsx: 'v1', pptx: 'v1', pdf: 'v1' }),
    DOC_SANDBOX_VALIDATOR_IMAGE: `sha256:${'a'.repeat(64)}`,
    DOC_SANDBOX_VALIDATION_STAGING_ROOT: '/tmp/doc-sandbox-unit-staging',
    DOC_SANDBOX_ENCRYPTION_KEY: key,
    DOC_SANDBOX_ENCRYPTION_KEY_ID: 'v1',
    DOC_SANDBOX_MAX_COST_USD: '0.25',
    REDIS_URL: 'redis://127.0.0.1:1',
    ANTHROPIC_API_KEY: 'synthetic-not-a-provider-key',
    R2_BUCKET: 'synthetic-test-bucket',
    R2_ACCOUNT_ID: 'synthetic-test-account',
    R2_ACCESS_KEY_ID: 'synthetic-test-access',
    R2_SECRET_ACCESS_KEY: 'synthetic-test-secret',
  };
}

function deps() {
  const authenticate: RequestHandler = (_req, _res, next) => next();
  return {
    prisma: { $transaction: async () => undefined, $queryRaw: async () => [], $executeRaw: async () => 0 } as never,
    authenticate,
    admissionPolicy: Router(),
    createRedisConnection: () => ({ host: '127.0.0.1', port: 1, lazyConnect: true }),
    runtimeOptions: { skipVersionCheck: true as const },
    metrics: {
      registerCounter() {}, registerGauge() {}, registerHistogram() {},
      counter() {}, gauge() {}, observe() {},
    },
    isModelPlanEligible: () => false,
    notice() {},
  };
}

test('startup helpers succeed and still sanitize a later cleanup failure', async () => {
  await withDocumentStartupCleanup(() => undefined, async () => undefined);
  assert.equal(await waitForDocumentStartup(Promise.resolve(7), new AbortController().signal, 50), 7);
  await assert.rejects(waitForDocumentStartup(new Promise(() => undefined), AbortSignal.abort(), 20), /DOC_START_ABORTED/);
});

test('enabled module can be constructed and closed without starting workers', async () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, env());
    const module = createDocumentModule(deps());
    assert.equal(typeof module.router, 'function');
    await module.close();
    await module.close();
  } finally {
    for (const key of Object.keys(env())) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('invalid enabled configuration still fails before constructing I/O clients', () => {
  const previous = process.env.DOC_SANDBOX_ENGINE;
  try {
    process.env.DOC_SANDBOX_ENGINE = 'docker';
    assert.throws(() => createDocumentModule(deps()), (error: unknown) =>
      error instanceof DocSandboxError && error.code === 'E_NOT_READY');
  } finally {
    if (previous === undefined) delete process.env.DOC_SANDBOX_ENGINE;
    else process.env.DOC_SANDBOX_ENGINE = previous;
  }
});

test('startup helpers sanitize a failed construct even when cleanup also fails', async () => {
  await assert.rejects(withDocumentStartupCleanup(async () => { throw new Error('private'); }, async () => { throw new Error('cleanup'); }),
    { message: 'DOC_START_FAILED' });
});

class FakeDeliveryQueue extends EventEmitter {
  readonly name = 'doc-edit';
  closing = false;
  async add() { return { data: { jobId: 'job-1' } }; }
  async getJob() { return { data: { jobId: 'job-1' } }; }
  async close() { this.closing = true; }
  async waitUntilReady() { return this; }
}

class FakeWorker extends EventEmitter {
  running = false;
  private settle: (() => void) | undefined;
  async waitUntilReady() { return this; }
  isRunning() { return this.running; }
  run() {
    this.running = true;
    return new Promise<void>((resolve) => { this.settle = () => resolve(); });
  }
  async close() {
    this.running = false;
    this.settle?.();
  }
}

function withEnabledEnv(run: () => Promise<void>): Promise<void> {
  const previous = { ...process.env };
  Object.assign(process.env, env());
  return run().finally(() => {
    for (const key of Object.keys(env())) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test('enabled module starts and closes with injected queue, worker and readiness', async () => {
  await withEnabledEnv(async () => {
    const notices: string[] = [];
    let handler: Processor<DocQueuePayload> | undefined;
    const worker = new FakeWorker();
    const delivery = new FakeDeliveryQueue();
    const collaborators = {
      ...deps(),
      notice: (code: string) => notices.push(code),
      createValidator: () => ({
        preflight: async () => undefined,
        reconcileOrphans: async () => ({ examined: 0, purged: 0, pending: 0 }),
      } as never),
      createQueue: () => new DocSandboxQueue(() => undefined, { host: '127.0.0.1', port: 1 }, { skipVersionCheck: true },
        () => delivery as unknown as Queue<DocQueuePayload>),
      createWorker: (_name: string, processor: Processor<DocQueuePayload>) => {
        handler = processor;
        return worker;
      },
      createReadinessProbe: () => ({
        check: async () => true,
        close() {},
      }),
    };
    const module = createDocumentModule(collaborators);
    await module.start();
    await module.start();
    assert.equal(typeof handler, 'function');
    await assert.rejects((handler as Processor<DocQueuePayload>)({ data: { jobId: 'bad id', extra: 1 } } as never, {} as never),
      /DOC_INVALID_DELIVERY/);
    const duplicate = (handler as Processor<DocQueuePayload>)({ data: { jobId: 'job-1' } } as never, {} as never);
    const second = (handler as Processor<DocQueuePayload>)({ data: { jobId: 'job-1' } } as never, {} as never);
    await Promise.allSettled([duplicate, second]);
    worker.emit('error', new Error('worker'));
    worker.emit('failed', {}, new Error('delivery'));
    await module.close();
    assert.ok(notices.includes('DOC_WORKER_ERROR'));
    assert.ok(notices.includes('DOC_WORKER_DELIVERY_FAILED'));
  });
});

test('enabled module start failure unwinds injected resources without leaking causes', async () => {
  await withEnabledEnv(async () => {
    await assert.rejects(createDocumentModule({
      ...deps(),
      createValidator: () => ({
        preflight: async () => { throw new Error('private docker details'); },
        reconcileOrphans: async () => ({ examined: 0, purged: 0, pending: 0 }),
      } as never),
    }).start(), { message: 'DOC_START_FAILED' });
  });
});

test('a closed module refuses a later start', async () => {
  await withEnabledEnv(async () => {
    const module = createDocumentModule({
      ...deps(),
      createValidator: () => ({
        preflight: async () => undefined,
        reconcileOrphans: async () => ({ examined: 0, purged: 0, pending: 0 }),
      } as never),
      createQueue: () => new DocSandboxQueue(() => undefined, { host: '127.0.0.1', port: 1 }, { skipVersionCheck: true },
        () => new FakeDeliveryQueue() as unknown as Queue<DocQueuePayload>),
      createWorker: () => new FakeWorker(),
      createReadinessProbe: () => ({ check: async () => true, close() {} }),
    });
    await module.close();
    await assert.rejects(module.start(), { message: 'DOC_MODULE_CLOSED' });
  });
});

test('start uses an injected queue factory when createQueue is omitted', async () => {
  await withEnabledEnv(async () => {
    const delivery = new FakeDeliveryQueue();
    const module = createDocumentModule({
      ...deps(),
      createValidator: () => ({
        preflight: async () => undefined,
        reconcileOrphans: async () => ({ examined: 0, purged: 0, pending: 0 }),
      } as never),
      createQueueInstance: () => delivery as unknown as Queue<DocQueuePayload>,
      createWorker: () => new FakeWorker(),
      createReadinessProbe: () => ({ check: async () => true, close() {} }),
    });
    await module.start();
    await module.close();
  });
});

test('startup cleanup reports when a Redis disconnect throws', async () => {
  await withEnabledEnv(async () => {
    await assert.rejects(createDocumentModule({
      ...deps(),
      createRedisConnection: () => ({
        host: '127.0.0.1', port: 1, lazyConnect: true,
        disconnect() { throw new Error('private socket'); },
      }),
      createValidator: () => ({
        preflight: async () => undefined,
        reconcileOrphans: async () => ({ examined: 0, purged: 0, pending: 0 }),
      } as never),
      createQueue: () => new DocSandboxQueue(() => undefined, { host: '127.0.0.1', port: 1 }, { skipVersionCheck: true },
        () => new FakeDeliveryQueue() as unknown as Queue<DocQueuePayload>),
      createWorker: () => new FakeWorker(),
      createReadinessProbe: () => ({ check: async () => false, close() {} }),
    }).start(), { message: 'DOC_START_FAILED' });
  });
});

test('start fails when the injected readiness probe reports an unhealthy worker', async () => {
  await withEnabledEnv(async () => {
    await assert.rejects(createDocumentModule({
      ...deps(),
      createValidator: () => ({
        preflight: async () => undefined,
        reconcileOrphans: async () => ({ examined: 0, purged: 0, pending: 0 }),
      } as never),
      createQueue: () => new DocSandboxQueue(() => undefined, { host: '127.0.0.1', port: 1 }, { skipVersionCheck: true },
        () => new FakeDeliveryQueue() as unknown as Queue<DocQueuePayload>),
      createWorker: () => new FakeWorker(),
      createReadinessProbe: () => ({ check: async () => false, close() {} }),
    }).start(), { message: 'DOC_START_FAILED' });
  });
});

