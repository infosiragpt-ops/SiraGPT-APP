import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import express, { Router, type Request, type RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { rateLimit } from 'express-rate-limit';
import { createDocumentModule, waitForDocumentStartup, withDocumentStartupCleanup } from '../src/modules/doc-sandbox';
import { DocumentReadinessLease, waitForDocumentOperation } from '../src/modules/doc-sandbox/readiness';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import { createDocumentRouter } from '../src/modules/doc-sandbox/api/router';
import { loadDocumentSandboxConfig } from '../src/modules/doc-sandbox/config';
import { createDocumentModelPolicy } from '../src/modules/doc-sandbox/model-policy';
import { DocSandboxRepository } from '../src/modules/doc-sandbox/queue/repository';
import { createPrivateDocumentS3Client, DocumentDownloadTickets, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';

// Lifecycle/precondition tests: real promises, abort signals, timers and HTTP.
// No Redis/DB/provider/validator substitutes, no document validation or runtime
// isolation claims. An unavailable dependency is a tripwire, never a success.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('readiness refuses invalid lease durations before it can admit a job', () => {
  for (const ttl of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => new DocumentReadinessLease(ttl), { message: 'DOC_READINESS_TTL' });
  }
});

test('readiness is initially closed, expires at the boundary and needs a fresh confirmation', () => {
  const lease = new DocumentReadinessLease(50);
  assert.equal(lease.isReady(0), false);
  const ticket = lease.ticket();
  assert.equal(lease.confirm(ticket, 100), true);
  assert.equal(lease.isReady(149), true);
  assert.equal(lease.isReady(150), false);
  assert.equal(lease.confirm(ticket, 151), true);
  assert.equal(lease.isReady(200), true);
  assert.equal(lease.isReady(201), false);
});

test('an invalidation fences late successful probes and only a new ticket can reopen admission', () => {
  const lease = new DocumentReadinessLease(50);
  const oldTicket = lease.ticket();
  lease.confirm(oldTicket, 100);
  lease.invalidate();
  assert.equal(lease.isReady(101), false);
  assert.notEqual(lease.ticket(), oldTicket);
  assert.equal(lease.confirm(oldTicket, 102), false);
  assert.equal(lease.isReady(102), false);
  assert.equal(lease.confirm(lease.ticket(), 103), true);
  assert.equal(lease.isReady(104), true);
});

test('stop permanently closes the lease even when later probes hold a current ticket', () => {
  const lease = new DocumentReadinessLease(50);
  lease.confirm(lease.ticket(), 100);
  lease.stop();
  const stoppedTicket = lease.ticket();
  assert.equal(lease.confirm(stoppedTicket, 101), false);
  lease.invalidate();
  assert.equal(lease.confirm(lease.ticket(), 102), false);
  lease.stop();
  assert.equal(lease.isReady(103), false);
});

test('independent leases cannot renew or revoke another worker admission', () => {
  const first = new DocumentReadinessLease(50);
  const second = new DocumentReadinessLease(50);
  first.confirm(first.ticket(), 100);
  assert.equal(second.isReady(101), false);
  second.confirm(second.ticket(), 100);
  first.stop();
  assert.equal(second.isReady(101), true);
});

for (const [name, wait] of [
  ['operation', waitForDocumentOperation],
  ['startup', waitForDocumentStartup],
] as const) {
  test(`${name} wait returns the actual resolved value and removes its abort listener`, async () => {
    const controller = new AbortController();
    const value = { ready: true };
    assert.equal(await wait(Promise.resolve(value), controller.signal, 1000), value);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${name} wait preserves rejection identity and removes its abort listener`, async () => {
    const controller = new AbortController();
    const failure = new Error('synthetic-operation-failure');
    await assert.rejects(wait(Promise.reject(failure), controller.signal, 1000), error => error === failure);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${name} wait rejects an already-aborted pending operation`, async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = deferred<void>();
    await assert.rejects(wait(operation.promise, controller.signal, 1000), { message: 'DOC_START_ABORTED' });
    operation.resolve();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${name} wait cancellation detaches listeners and cannot be replaced by late completion`, async () => {
    const controller = new AbortController();
    const operation = deferred<void>();
    const waiting = wait(operation.promise, controller.signal, 1000);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await assert.rejects(waiting, { message: 'DOC_START_ABORTED' });
    operation.resolve();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(waiting, { message: 'DOC_START_ABORTED' });
  });

  test(`${name} wait has a real bounded timeout and safely observes a late rejection`, async () => {
    const controller = new AbortController();
    const operation = deferred<void>();
    const waiting = wait(operation.promise, controller.signal, 5);
    await assert.rejects(waiting, { message: 'DOC_START_TIMEOUT' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    operation.reject(new Error('synthetic-late-rejection'));
    await assert.rejects(waiting, { message: 'DOC_START_TIMEOUT' });
  });
}

test('successful startup does not run failure cleanup', async () => {
  const calls: string[] = [];
  await withDocumentStartupCleanup(async () => { calls.push('construct'); }, async () => { calls.push('cleanup'); });
  assert.deepEqual(calls, ['construct']);
});

test('synchronous startup failure waits for cleanup and returns only the sanitized error', async () => {
  const cleanup = deferred<void>();
  const calls: string[] = [];
  const starting = withDocumentStartupCleanup(() => { throw new Error('synthetic-private-startup-details'); }, async () => {
    calls.push('cleanup-start'); await cleanup.promise; calls.push('cleanup-finish');
  });
  const rejected = assert.rejects(starting, { message: 'DOC_START_FAILED' });
  assert.deepEqual(calls, ['cleanup-start']);
  cleanup.resolve();
  await rejected;
  assert.deepEqual(calls, ['cleanup-start', 'cleanup-finish']);
});

test('an asynchronous construction and cleanup failure cannot disclose either internal cause', async () => {
  const failure = await withDocumentStartupCleanup(
    async () => { throw new Error('synthetic-private-construction'); },
    async () => { throw new Error('synthetic-private-cleanup'); },
  ).then(() => assert.fail('startup unexpectedly succeeded'), error => error as Error);
  assert.equal(failure.message, 'DOC_START_FAILED');
  assert.equal(failure.cause, undefined);
  assert.equal(String(failure).includes('synthetic-private'), false);
});

function unavailableDependencies(): Parameters<typeof createDocumentModule>[0] {
  const unexpected = (): never => assert.fail('disabled/invalid module accessed an I/O dependency');
  return {
    authenticate: Router(),
    get prisma() { return unexpected(); },
    get admissionPolicy() { return unexpected(); },
    get createRedisConnection() { return unexpected(); },
    get runtimeOptions() { return unexpected(); },
    get metrics() { return unexpected(); },
    get isModelPlanEligible() { return unexpected(); },
    get notice() { return unexpected(); },
  };
}

test('disabled module lifecycle performs no I/O construction or reconciliation', async () => {
  const previous = process.env.DOC_SANDBOX_ENGINE;
  try {
    delete process.env.DOC_SANDBOX_ENGINE;
    const module = createDocumentModule(unavailableDependencies());
    assert.equal(typeof module.router, 'function');
    await module.start(); await module.start();
    await module.close(); await module.close();
  } finally {
    if (previous === undefined) delete process.env.DOC_SANDBOX_ENGINE;
    else process.env.DOC_SANDBOX_ENGINE = previous;
  }
});

test('invalid engine configuration fails before touching any I/O dependency', () => {
  const previous = process.env.DOC_SANDBOX_ENGINE;
  try {
    process.env.DOC_SANDBOX_ENGINE = 'unsupported-release-test-engine';
    assert.throws(() => createDocumentModule(unavailableDependencies()), error =>
      error instanceof DocSandboxError && error.code === 'E_NOT_READY' && error.status === 503);
  } finally {
    if (previous === undefined) delete process.env.DOC_SANDBOX_ENGINE;
    else process.env.DOC_SANDBOX_ENGINE = previous;
  }
});

// Only identity is supplied by a test boundary. This does not exercise JWT,
// OAuth, cookies or the application's account/plan middleware. No catalog row,
// model policy, repository, storage, validator or provider is substituted.
const fixtureAuthenticate: RequestHandler = (req, res, next) => {
  if (req.get('Authorization') !== 'Bearer local-admission-fixture') {
    res.status(401).json({ code: 'FIXTURE_AUTH_REQUIRED' }); return;
  }
  (req as Request & { user: { id: string; plan: string } }).user = {
    id: req.get('X-Fixture-Owner') ?? 'local-owner', plan: 'FREE',
  };
  next();
};

async function listen(server: TcpServer | HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: TcpServer | HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
}
function form(fields: Record<string, string> = {}, bytes = 4): FormData {
  const body = new FormData();
  body.set('instructions', 'Conserva el documento');
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  body.append('files[]', new Blob([new Uint8Array(bytes)]), 'original.txt');
  return body;
}
async function withHttpAdmission(run: (fixture: {
  api(path?: string, init?: RequestInit): Promise<Response>;
  lease: DocumentReadinessLease; tickets: DocumentDownloadTickets; notices: string[];
  attempts(): number;
}) => Promise<void>): Promise<void> {
  let ioAttempts = 0;
  // Real SDKs point only here. A connection is an observable test failure,
  // never a successful fake DB/S3 response. There is no external service URL.
  const tripwire = createTcpServer(socket => { ioAttempts++; socket.destroy(); });
  let prisma: PrismaClient | undefined;
  let s3: ReturnType<typeof createPrivateDocumentS3Client> | undefined;
  let server: HttpServer | undefined;
  try {
    const unavailable = await listen(tripwire);
    const database = new URL(`postgresql://local:fixture-only@127.0.0.1:${new URL(unavailable).port}/not_a_database`);
    database.searchParams.set('connect_timeout', '1');
    prisma = new PrismaClient({ datasources: { db: { url: database.toString() } } });
    s3 = createPrivateDocumentS3Client({ endpoint: unavailable, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'local-fixture', secretAccessKey: 'local-fixture-only' } });
    const key = randomBytes(32);
    const model = { prices: { version: 'local-unused', inputPerMillionUsd: 1, outputPerMillionUsd: 1,
      cacheReadPerMillionUsd: 1, cacheWritePerMillionUsd: 1, executionPerHourUsd: 0, minimumExecutionSeconds: 0 },
      maxOutputTokensPerTurn: 256, reservationUsdPerTurn: 1 };
    const config = loadDocumentSandboxConfig({ DOC_SANDBOX_ENGINE: 'anthropic',
      DOC_SANDBOX_MODELS_JSON: JSON.stringify({ mechanical: { ...model, id: 'local-mechanical' }, academic: { ...model, id: 'local-academic' } }),
      DOC_SANDBOX_SKILL_VERSIONS_JSON: JSON.stringify({ docx: 'local-pinned', xlsx: 'local-pinned', pptx: 'local-pinned', pdf: 'local-pinned' }),
      DOC_SANDBOX_VALIDATOR_IMAGE: `sha256:${'a'.repeat(64)}`, DOC_SANDBOX_VALIDATION_STAGING_ROOT: '/tmp/local-validator-not-started',
      DOC_SANDBOX_ENCRYPTION_KEY: key.toString('base64'), DOC_SANDBOX_MAX_COST_USD: '1', DOC_SANDBOX_MAX_FILE_BYTES: '32',
      REDIS_URL: 'redis://127.0.0.1:1', ANTHROPIC_API_KEY: 'local-unused-no-provider', R2_BUCKET: 'local-fixture',
      R2_ACCOUNT_ID: 'local-fixture', R2_ACCESS_KEY_ID: 'local-fixture', R2_SECRET_ACCESS_KEY: 'local-fixture-only' });
    assert.ok(config);
    const lease = new DocumentReadinessLease(60_000);
    const tickets = new DocumentDownloadTickets(key); const notices: string[] = [];
    const app = express(); app.use(express.json());
    app.use('/api/docs/jobs', createDocumentRouter({ authenticate: fixtureAuthenticate,
      admissionPolicy: rateLimit({ windowMs: 60_000, limit: 1000, standardHeaders: true, legacyHeaders: false }),
      repository: new DocSandboxRepository(prisma),
      storage: new PrivateDocumentStorage(s3, { bucket: 'local-fixture', key, keyId: 'local', maxBytes: 1024 }),
      tickets, config, isReady: () => lease.isReady(),
      resolveModel: createDocumentModelPolicy(config.engine.models, prisma, () => assert.fail('pre-I/O rejection reached plan eligibility')),
      abort: () => assert.fail('pre-I/O rejection attempted to cancel a worker'), notice: code => { notices.push(code); } }));
    server = createHttpServer(app);
    const origin = await listen(server);
    await run({ lease, tickets, notices, attempts: () => ioAttempts,
      api: (path = '', init = {}) => fetch(`${origin}/api/docs/jobs${path}`, { ...init,
        headers: { Authorization: 'Bearer local-admission-fixture', ...init.headers }, signal: AbortSignal.timeout(5000) }) });
  } finally {
    // Every acquired resource is released even if a later constructor/listen or
    // another cleanup fails. Stop accepting HTTP before closing SDK clients.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => server && close(server)),
      Promise.resolve().then(() => prisma?.$disconnect()),
      Promise.resolve().then(() => s3?.destroy()),
      Promise.resolve().then(() => close(tripwire)),
    ]);
    assert.equal(ioAttempts, 0, 'a rejected HTTP request reached real DB/S3 I/O');
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'HTTP fixture cleanup failed');
  }
}
async function expectError(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('content-disposition'), null);
  const body: unknown = await response.json();
  assert.ok(body && typeof body === 'object' && 'code' in body);
  assert.equal(body.code, code); assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
}

test('real HTTP readiness rejects malformed multipart before parsing or opening DB/S3', async () => {
  await withHttpAdmission(async ({ api, lease, attempts }) => {
    const init = { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'no boundary' };
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await api('', init);
      assert.equal(response.headers.get('retry-after'), '30');
      await expectError(response, 503, 'E_NOT_READY');
    }
    assert.equal(attempts(), 0);
    assert.equal(lease.confirm(lease.ticket()), true);
    await expectError(await api('', { method: 'POST', body: form({ permission: 'read' }) }), 403, 'E_PLAN_GATE');
    lease.stop();
    await expectError(await api('', init), 503, 'E_NOT_READY');
  });
});

test('real HTTP schema and permission rejection releases upload slots without model/catalog I/O', async t => {
  await withHttpAdmission(async ({ api, lease, notices }) => {
    lease.confirm(lease.ticket());
    const cases: Array<[string, Record<string, string>, number, string]> = [
      ['read-only permission', { permission: 'read' }, 403, 'E_PLAN_GATE'],
      ['protected permission', { permission: 'protected' }, 403, 'E_PLAN_GATE'],
      ['empty instruction', { instructions: '   ' }, 400, 'E_PARAMS'],
      ['instruction bound', { instructions: 'x'.repeat(50_001) }, 400, 'E_PARAMS'],
      ['unapproved mode', { mode: 'reformat' }, 400, 'E_PARAMS'],
      ['unknown permission', { permission: 'admin' }, 400, 'E_PARAMS'],
      ['unknown model tier', { modelTier: 'maximum' }, 400, 'E_PARAMS'],
      ['unknown field', { execute: 'true' }, 400, 'E_PARAMS'],
      ['model absent from pinned config', { requestedModel: 'unconfigured' }, 400, 'E_PARAMS'],
    ];
    for (const [name, fields, status, code] of cases) await t.test(name, async () => {
      await expectError(await api('', { method: 'POST', body: form(fields) }), status, code);
      assert.equal(notices.at(-1), code);
    });
    // More than two consecutive failures exercise the real slot-release path.
    for (let index = 0; index < 3; index++) await expectError(await api('', {
      method: 'POST', body: form({ permission: 'protected' }),
    }), 403, 'E_PLAN_GATE');
  });
});

test('real Multer file/field/count failures release pre-handler slots and never query a model', async t => {
  await withHttpAdmission(async ({ api, lease }) => {
    lease.confirm(lease.ticket());
    const oversized = form({}, 33);
    const tooMany = form();
    for (let index = 0; index < 10; index++) tooMany.append('files[]', new Blob(['x']), `${index}.txt`);
    const wrongField = new FormData(); wrongField.set('instructions', 'Conservar'); wrongField.append('file', new Blob(['x']), 'original.txt');
    const tooManyFields = form({ a: '1', b: '2', c: '3', d: '4', e: '5' });
    const tooLongField = form({ instructions: 'x'.repeat(200_001) });
    for (const [name, body, status] of [
      // Multer's limit errors deliberately share the router's E_PARAMS/400 mapping.
      ['file size', oversized, 400], ['file count', tooMany, 400], ['unexpected file field', wrongField, 400],
      ['field count', tooManyFields, 400], ['field byte bound', tooLongField, 400],
    ] as const) await t.test(name, async () => { await expectError(await api('', { method: 'POST', body }), status, 'E_PARAMS'); });
    await expectError(await api('', { method: 'POST', body: form({ permission: 'read' }) }), 403, 'E_PLAN_GATE');
  });
});

test('real HTTP rejects malformed owners, identifiers, replay cursors and signed-download claims before I/O', async t => {
  await withHttpAdmission(async ({ api, lease, tickets }) => {
    lease.confirm(lease.ticket());
    for (const [name, path, init] of [
      ['job identifier', '/bad%20job', {}],
      ['idempotency syntax', '/by-key/bad%20key', {}],
      ['idempotency bound', `/by-key/${'a'.repeat(201)}`, {}],
      ['cancel identifier', '/bad%20job/cancel', { method: 'POST' }],
      ['delete identifier', '/bad%20job', { method: 'DELETE' }],
      ['artifact identifier', '/job/artifacts/bad%20artifact', {}],
      ['event cursor negative', '/job/events?after=-1', {}],
      ['event cursor fractional', '/job/events?after=1.5', {}],
      ['event cursor infinite', '/job/events?after=Infinity', {}],
      ['event cursor unsafe integer', `/job/events?after=${Number.MAX_SAFE_INTEGER + 1}`, {}],
      ['Last-Event-ID takes precedence', '/job/events?after=0', { headers: { 'Last-Event-ID': 'invalid' } }],
      ['missing download signature', '/job/artifacts/artifact/download', {}],
    ] as const) await t.test(name, async () => { await expectError(await api(path, init), 400, 'E_PARAMS'); });
    for (const [method, path] of [['GET', '/job'], ['POST', '/job/cancel'], ['DELETE', '/job'], ['GET', '/job/events']] as const) {
      await expectError(await api(path, { method, headers: { 'X-Fixture-Owner': '../other' } }), 401, 'E_FORBIDDEN');
    }
    // Owner parsing precedes the handler's listener/timer allocation. Invalid
    // identities still release the pre-handler upload slot on response finish.
    for (let index = 0; index < 4; index++) await expectError(await api('', {
      method: 'POST', body: form(), headers: { 'X-Fixture-Owner': '../other' },
    }), 401, 'E_FORBIDDEN');
    await expectError(await api('', { method: 'POST', body: form({ permission: 'read' }) }), 403, 'E_PLAN_GATE');
    for (const signature of [
      'malformed', tickets.issue('other-owner', 'job', 'artifact'), tickets.issue('local-owner', 'other-job', 'artifact'),
      tickets.issue('local-owner', 'job', 'other-artifact'), tickets.issue('local-owner', 'job', 'artifact', 1, 0),
      tickets.issue('local-owner', 'job', 'artifact', 600, Date.now() + 60_000),
    ]) await expectError(await api(`/job/artifacts/artifact/download?signature=${encodeURIComponent(signature)}`), 403, 'E_FORBIDDEN');
  });
});

test('real HTTP capability probing cannot report an unavailable or unconfigured model supported', async () => {
  await withHttpAdmission(async ({ api, lease }) => {
    for (const ready of [false, true]) {
      if (ready) lease.confirm(lease.ticket());
      for (const path of ['/capabilities', '/capabilities?model=unconfigured']) {
        const response = await api(path); assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.ready, ready); assert.equal(payload.supported, false); assert.equal(payload.modelTier, null);
        assert.deepEqual(payload.modes, ['preserve']); assert.equal(payload.limits.maxFileBytes, 32);
      }
    }
    for (const path of ['/capabilities?model=', `/capabilities?model=${'x'.repeat(201)}`, '/capabilities?model=a&model=b']) {
      await expectError(await api(path), 400, 'E_PARAMS');
    }
  });
});

test('disabled module exposes only authenticated not-ready HTTP responses across start/close', async () => {
  const previous = process.env.DOC_SANDBOX_ENGINE;
  let server: HttpServer | undefined;
  try {
    delete process.env.DOC_SANDBOX_ENGINE;
    const deps = unavailableDependencies();
    deps.authenticate = fixtureAuthenticate;
    const module = createDocumentModule(deps);
    const app = express(); app.use('/api/docs/jobs', module.router);
    server = createHttpServer(app); const origin = await listen(server);
    for (const cycle of [module.start, module.close, module.start, module.close]) {
      await cycle();
      const capability = await fetch(`${origin}/api/docs/jobs/capabilities`, {
        headers: { Authorization: 'Bearer local-admission-fixture' }, signal: AbortSignal.timeout(5000),
      });
      assert.deepEqual(await capability.json(), { enabled: false, ready: false, supported: false,
        modelTier: null, modes: [], formats: [], limits: null });
      for (const [method, path] of [['POST', ''], ['GET', '/job'], ['GET', '/job/events'], ['GET', '/by-key/key'],
        ['GET', '/job/artifacts/artifact/download'], ['POST', '/job/cancel'], ['DELETE', '/job']] as const) {
        const response = await fetch(`${origin}/api/docs/jobs${path}`, { method,
          headers: { Authorization: 'Bearer local-admission-fixture' }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).code, 'E_NOT_READY');
      }
    }
    const anonymous = await fetch(`${origin}/api/docs/jobs/capabilities`, { signal: AbortSignal.timeout(5000) });
    assert.equal(anonymous.status, 401); assert.deepEqual(await anonymous.json(), { code: 'FIXTURE_AUTH_REQUIRED' });
  } finally {
    if (server) await close(server);
    if (previous === undefined) delete process.env.DOC_SANDBOX_ENGINE;
    else process.env.DOC_SANDBOX_ENGINE = previous;
  }
});
