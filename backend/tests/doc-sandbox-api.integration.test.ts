import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { Prisma } from '@prisma/client';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import express, { type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createDocumentRouter } from '../src/modules/doc-sandbox/api/router';
import { createDocumentModelPolicy } from '../src/modules/doc-sandbox/model-policy';
import { createDocumentIntegrationFixture, type DocumentIntegrationFixture } from './doc-sandbox-integration-fixture';

let fixture: DocumentIntegrationFixture;
let server: Server;
let origin: string;
const aborted = new Set<string>();
const notices: string[] = [];
const noticeEvents = new EventEmitter();
// Router-only admission state. No validator result or successful edited document
// is simulated; real isolation readiness is a separate integration gate.
let admissionOpen = true;
const testToken = (which: 'owner' | 'other' = 'owner'): string => `Bearer fixture-${which}-only`;
const identity = (req: Request): string | undefined => (req as Request & { user?: { id: string } }).user?.id;

before(async () => {
  fixture = await createDocumentIntegrationFixture();
  const app = express(); app.use(express.json());
  // Explicit test identity middleware. This does NOT verify production JWT, OAuth, cookies or CSRF.
  const authenticate: RequestHandler = (req, res, next) => {
    const token = req.get('Authorization');
    const userId = token === testToken() ? fixture.owner : token === testToken('other') ? fixture.other : undefined;
    if (!userId) { res.status(401).json({ code: 'FIXTURE_AUTH_REQUIRED' }); return; }
    (req as Request & { user: { id: string } }).user = { id: userId }; next();
  };
  // Real rate limiter with fixture settings, not a substitute for the existing application's policy tests.
  const admissionPolicy = rateLimit({ windowMs: 60_000, limit: 50, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => identity(req) ?? 'unauthenticated' });
  app.use('/api/docs/jobs', createDocumentRouter({ authenticate, admissionPolicy,
    repository: fixture.repository, storage: fixture.storage, tickets: fixture.tickets, config: fixture.config,
    isReady: () => admissionOpen,
    resolveModel: createDocumentModelPolicy(fixture.config.engine.models, fixture.db, (_name, plan) => plan === 'FREE'),
    abort: id => { aborted.add(id); }, notice: code => { notices.push(code); noticeEvents.emit('notice', code); } }));
  app.use('/api/docs', (_req, res) => res.status(200).send('fixture documentation alias'));
  server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  if (fixture) await fixture.close();
});
async function api(path = '', init: RequestInit = {}, as: 'owner' | 'other' = 'owner'): Promise<Response> {
  return fetch(`${origin}/api/docs/jobs${path}`, { ...init, headers: { Authorization: testToken(as), ...init.headers }, signal: AbortSignal.timeout(15_000) });
}
function multipart(bytes = Buffer.from('Fixture content — línea dos\r\n'), name = 'Original con ñ.txt', instructions = 'No cambies nada; conserva el archivo', mode = 'preserve'): FormData {
  const body = new FormData();
  body.append('instructions', instructions); body.append('mode', mode);
  body.append('files[]', new Blob([new Uint8Array(bytes)]), name);
  return body;
}
async function createHttp(as: 'owner' | 'other' = 'owner') {
  const bytes = Buffer.from('Fixture content — línea dos\r\n');
  const key = randomUUID();
  const response = await api('', { method: 'POST', headers: { 'Idempotency-Key': key }, body: multipart(bytes) }, as);
  assert.equal(response.status, 202, await response.clone().text());
  const body: unknown = await response.json();
  assert.ok(body && typeof body === 'object' && 'jobId' in body && typeof body.jobId === 'string');
  return { id: body.jobId, key, bytes };
}
async function createRealFailureReport() {
  const created = await createHttp();
  const lease = await fixture.repository.claimAttempt(created.id, 60_000); assert.ok(lease);
  const bytes = Buffer.from(JSON.stringify({ passed: false, checksNotExecuted: [1, 2, 3, 4], error: { code: 'DOC_FIXTURE_NO_ENGINE_EXECUTED' } }));
  const scope = { userId: fixture.owner, jobId: created.id };
  const stored = fixture.storage.prepare(scope, bytes);
  await fixture.repository.reserveStorageKeys(lease, [stored.key]);
  await fixture.storage.putPrepared(scope, stored, bytes);
  const artifactId = randomUUID();
  await fixture.repository.failAttempt(lease, 'DOC_FIXTURE_NO_ENGINE_EXECUTED', false, {
    id: artifactId, kind: 'validation_report', storageKey: stored.key, filename: 'Reporte sin ejecución.json',
    mime: 'application/json', size: bytes.length, sha256: stored.sha256,
  });
  return { ...created, artifactId, reportBytes: bytes };
}

function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Real integration barrier not reached: ${label}`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function waitForDatabaseBarrier(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    if (await check()) return;
    // Backoff between reads, not a guessed ordering delay: the condition is
    // always observed in real PostgreSQL before advancing the HTTP race.
    await pause(10);
  } while (Date.now() < deadline);
  assert.fail(`Real PostgreSQL barrier not reached: ${label}`);
}
function observeHttpClose(key: string) {
  const closed = barrier<void>();
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers['idempotency-key'] === key) res.once('close', () => closed.release());
  };
  server.on('request', onRequest);
  return { closed: closed.promise, dispose: () => server.off('request', onRequest) };
}
async function fixtureObjectKeys(): Promise<string[]> {
  const keys: string[] = []; let cursor: string | undefined;
  do {
    const page = await fixture.s3.send(new ListObjectsV2Command({ Bucket: fixture.bucket, ContinuationToken: cursor }));
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (cursor);
  return keys.sort();
}

test('real HTTP disconnect while the catalog SQL waits creates no job and uploads no object', { timeout: 30_000 }, async () => {
  const key = randomUUID();
  const controller = new AbortController();
  const close = observeHttpClose(key);
  const lockAcquired = barrier<void>(); const unlock = barrier<void>();
  const routeUnwound = barrier<string>();
  const onNotice = (code: string): void => { routeUnwound.release(code); };
  const beforeObjects = await fixtureObjectKeys();
  const beforeCount = await fixture.db.$queryRaw<Array<{ count: number }>>(Prisma.sql`SELECT COUNT(*)::int AS count FROM doc_jobs`);
  // ACCESS EXCLUSIVE blocks the production policy's actual Prisma SELECT.
  // No model-policy method, repository or object-storage operation is mocked.
  const locked = fixture.db.$transaction(async db => {
    await db.$executeRaw(Prisma.sql`LOCK TABLE ai_models IN ACCESS EXCLUSIVE MODE`);
    lockAcquired.release(); await unlock.promise;
  }, { maxWait: 10_000, timeout: 25_000 });
  let posted: Promise<{ response: Response } | { error: unknown }> | undefined;
  try {
    await bounded(lockAcquired.promise, 'catalog lock acquired');
    noticeEvents.on('notice', onNotice);
    posted = fetch(`${origin}/api/docs/jobs`, { method: 'POST', body: multipart(),
      headers: { Authorization: testToken(), 'Idempotency-Key': key },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(response => ({ response }), (error: unknown) => ({ error }));
    await waitForDatabaseBarrier(async () => {
      const [row] = await fixture.db.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(
        SELECT 1 FROM pg_locks WHERE locktype='relation' AND relation='ai_models'::regclass
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND mode='AccessShareLock' AND NOT granted
      ) AS waiting`);
      return row?.waiting === true;
    }, 'request is waiting on the real catalog SELECT');
    controller.abort(new DOMException('Fixture caller disconnected before admission', 'AbortError'));
    const result = await bounded(posted, 'client fetch aborted');
    assert.ok('error' in result && result.error instanceof Error && result.error.name === 'AbortError');
    await bounded(close.closed, 'server observed the HTTP close');
    unlock.release(); await locked;
    // The router's real error telemetry is emitted only after the handler has
    // unwound; checking earlier could miss a late createJob after the unlock.
    assert.equal(await bounded(routeUnwound.promise, 'aborted route fully unwound'), 'E_CANCELLED');
    const rows = await fixture.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM doc_jobs WHERE user_id=${fixture.owner} AND idempotency_key=${key}`);
    assert.deepEqual(rows, []);
    assert.deepEqual(await fixture.db.$queryRaw(Prisma.sql`SELECT COUNT(*)::int AS count FROM doc_jobs`), beforeCount);
    assert.deepEqual(await fixtureObjectKeys(), beforeObjects);
    assert.equal((await api(`/by-key/${key}`)).status, 404);
  } finally {
    controller.abort(); unlock.release();
    await locked.catch(() => {});
    if (posted) await posted;
    noticeEvents.off('notice', onNotice); close.dispose();
  }
});

test('two disconnected handlers keep admission slots until their real SQL awaits unwind', { timeout: 30_000 }, async () => {
  const pending = [0, 1].map(() => {
    const key = randomUUID();
    return { key, controller: new AbortController(), close: observeHttpClose(key) };
  });
  const thirdKey = randomUUID();
  const lockAcquired = barrier<void>(); const unlock = barrier<void>();
  const routesUnwound = barrier<void>(); let cancellationNotices = 0;
  const onNotice = (code: string): void => { if (code === 'E_CANCELLED' && ++cancellationNotices === 2) routesUnwound.release(); };
  const beforeObjects = await fixtureObjectKeys();
  let inspectLock: Prisma.TransactionClient | undefined;
  const locked = fixture.db.$transaction(async db => {
    await db.$executeRaw(Prisma.sql`LOCK TABLE ai_models IN ACCESS EXCLUSIVE MODE`);
    inspectLock = db; lockAcquired.release(); await unlock.promise;
  }, { maxWait: 10_000, timeout: 25_000 });
  const posted: Array<Promise<{ response: Response } | { error: unknown }>> = [];
  try {
    await bounded(lockAcquired.promise, 'two-handler catalog lock acquired');
    noticeEvents.on('notice', onNotice);
    for (const entry of pending) {
      posted.push(fetch(`${origin}/api/docs/jobs`, { method: 'POST', body: multipart(),
        headers: { Authorization: testToken(), 'Idempotency-Key': entry.key },
        signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15_000)]) })
        .then(response => ({ response }), (error: unknown) => ({ error })));
    }
    const waitingCount = async (): Promise<number> => {
      assert.ok(inspectLock);
      // Inspect through the lock-owning transaction: even a three-connection
      // CI pool still has room for the two genuine blocked Prisma queries.
      const [row] = await inspectLock.$queryRaw<Array<{ count: number }>>(Prisma.sql`SELECT COUNT(*)::int AS count
        FROM pg_locks WHERE locktype='relation' AND relation='ai_models'::regclass
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND mode='AccessShareLock' AND NOT granted`);
      return row?.count ?? 0;
    };
    await waitForDatabaseBarrier(async () => await waitingCount() === 2, 'both handlers are inside real catalog SQL');
    for (const entry of pending) entry.controller.abort(new DOMException('Fixture disconnected with SQL pending', 'AbortError'));
    const results = await bounded(Promise.all(posted), 'both client requests aborted');
    for (const result of results) assert.ok('error' in result && result.error instanceof Error && result.error.name === 'AbortError');
    await bounded(Promise.all(pending.map(entry => entry.close.closed)), 'both server responses are closed');
    assert.equal(await waitingCount(), 2, 'HTTP close must not be mistaken for SQL completion');
    // A parser would reject this body with 400. The occupied admission gate
    // must instead reject with 429, before parsing or reading the catalog.
    const third = await api('', { method: 'POST', headers: { 'Idempotency-Key': thirdKey, 'Content-Type': 'multipart/form-data' }, body: 'invalid multipart' });
    assert.equal(third.status, 429); assert.equal((await third.json()).code, 'E_QUOTA');
    assert.equal(await waitingCount(), 2, 'no third catalog query entered the gate');
    assert.ok(inspectLock);
    assert.deepEqual(await inspectLock.$queryRaw(Prisma.sql`SELECT id FROM doc_jobs
      WHERE user_id=${fixture.owner} AND idempotency_key IN (${Prisma.join([...pending.map(entry => entry.key), thirdKey])})`), []);
    unlock.release(); await locked;
    await bounded(routesUnwound.promise, 'both disconnected handlers fully unwound');
    assert.deepEqual(await fixtureObjectKeys(), beforeObjects);
    assert.deepEqual(await fixture.db.$queryRaw(Prisma.sql`SELECT id FROM doc_jobs
      WHERE user_id=${fixture.owner} AND idempotency_key IN (${Prisma.join([...pending.map(entry => entry.key), thirdKey])})`), []);
    const admitted = await api('', { method: 'POST', headers: { 'Idempotency-Key': thirdKey }, body: multipart() });
    assert.equal(admitted.status, 202, 'finally must release admission capacity after both SQL awaits end');
    const snapshot = await admitted.json(); assert.equal(snapshot.admissionReady, true);
  } finally {
    for (const entry of pending) entry.controller.abort();
    unlock.release(); await locked.catch(() => {}); await Promise.all(posted);
    noticeEvents.off('notice', onNotice);
    for (const entry of pending) entry.close.dispose();
  }
});

test('HTTP disconnect after the real readiness commit starts remains recoverable by the same key', { timeout: 30_000 }, async () => {
  const key = randomUUID(); const advisoryClass = 1900711; const advisoryId = randomInt(1, 2_147_483_647);
  assert.match(key, /^[a-f0-9-]{36}$/);
  const lockAcquired = barrier<void>(); const unlock = barrier<void>();
  const controller = new AbortController(); const close = observeHttpClose(key);
  let functionCreated = false; let triggerCreated = false;
  let locked: Promise<unknown> | undefined;
  let posted: Promise<{ response: Response } | { error: unknown }> | undefined;
  try {
    // This trigger exists only in the fixture's isolated schema and does not
    // alter outcomes: it delays the actual UPDATE inside markInputsReadyOwned.
    // SQL identifiers are fixed; embedded values are locally generated UUID/ints.
    await fixture.db.$executeRawUnsafe(`CREATE FUNCTION fixture_wait_document_ack() RETURNS trigger AS $$
      BEGIN
        IF NOT OLD.admission_ready AND NEW.admission_ready AND NEW.idempotency_key = '${key}' THEN
          PERFORM pg_advisory_xact_lock(${advisoryClass}, ${advisoryId});
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    functionCreated = true;
    await fixture.db.$executeRaw(Prisma.sql`CREATE TRIGGER fixture_wait_document_ack
      BEFORE UPDATE ON doc_jobs FOR EACH ROW EXECUTE FUNCTION fixture_wait_document_ack()`);
    triggerCreated = true;
    locked = fixture.db.$transaction(async db => {
      await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${advisoryClass}::integer, ${advisoryId}::integer)`);
      lockAcquired.release(); await unlock.promise;
    }, { maxWait: 10_000, timeout: 25_000 });
    await bounded(lockAcquired.promise, 'ACK advisory lock acquired');
    posted = fetch(`${origin}/api/docs/jobs`, { method: 'POST', body: multipart(),
      headers: { Authorization: testToken(), 'Idempotency-Key': key },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(response => ({ response }), (error: unknown) => ({ error }));
    await waitForDatabaseBarrier(async () => {
      const [row] = await fixture.db.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(
        SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=${advisoryClass}::oid
        AND objid=${advisoryId}::oid AND objsubid=2 AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      ) AS waiting`);
      return row?.waiting === true;
    }, 'markInputsReadyOwned is inside the actual readiness UPDATE');
    const beforeAck = await fixture.repository.getByIdempotencyKeyOwned(key, fixture.owner);
    assert.equal(beforeAck.admissionReady, false);
    const input = (await fixture.repository.artifactsInternal(beforeAck.id)).find(artifact => artifact.kind === 'input');
    assert.ok(input);
    assert.deepEqual(await fixture.storage.get({ userId: fixture.owner, jobId: beforeAck.id }, input.storageKey, input.sha256), Buffer.from('Fixture content — línea dos\r\n'));
    controller.abort(new DOMException('Fixture caller disconnected after ACK began', 'AbortError'));
    const result = await bounded(posted, 'ACK client fetch aborted');
    assert.ok('error' in result && result.error instanceof Error && result.error.name === 'AbortError');
    await bounded(close.closed, 'ACK server observed the HTTP close');
    unlock.release(); await locked;
    // Once markInputsReadyOwned begins, the commit is no longer revoked by a
    // lost response. Its immutable input and original idempotency key survive.
    await waitForDatabaseBarrier(async () => (await fixture.repository.getByIdempotencyKeyOwned(key, fixture.owner)).admissionReady,
      'readiness and enqueue transaction committed despite lost response');
    const recovered = await api(`/by-key/${key}`);
    assert.equal(recovered.status, 200);
    const snapshot = await recovered.json();
    assert.equal(snapshot.id, beforeAck.id); assert.equal(snapshot.admissionReady, true); assert.equal(snapshot.status, 'queued');
    assert.equal((await fixture.repository.getOwned(beforeAck.id, fixture.owner)).deletedAt, null);
    assert.equal((await fixture.repository.pendingOutbox(500, 'enqueue')).filter(event => event.jobId === beforeAck.id).length, 1);
    const duplicate = await api('', { method: 'POST', headers: { 'Idempotency-Key': key }, body: multipart() });
    assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).id, beforeAck.id);
    const rows = await fixture.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM doc_jobs WHERE user_id=${fixture.owner} AND idempotency_key=${key}`);
    assert.deepEqual(rows, [{ id: beforeAck.id }]);
    assert.equal((await fixture.repository.pendingOutbox(500, 'enqueue')).filter(event => event.jobId === beforeAck.id).length, 1);
  } finally {
    controller.abort(); unlock.release();
    if (locked) await locked.catch(() => {});
    if (posted) await posted;
    if (triggerCreated) await fixture.db.$executeRaw(Prisma.sql`DROP TRIGGER fixture_wait_document_ack ON doc_jobs`);
    if (functionCreated) await fixture.db.$executeRaw(Prisma.sql`DROP FUNCTION fixture_wait_document_ack()`);
    close.dispose();
  }
});

test('all real HTTP job routes require fixture authentication before docs alias or database access', async () => {
  for (const [method, path] of [['GET', '/capabilities'], ['GET', '/by-key/missing'], ['GET', '/missing'], ['GET', '/missing/events'], ['GET', '/missing/artifacts/missing'], ['POST', ''], ['POST', '/missing/cancel'], ['DELETE', '/missing']] as const) {
    const response = await fetch(`${origin}/api/docs/jobs${path}`, { method, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 401);
  }
});

test('capabilities reflect real catalog publication and closed admission rejects before multipart parsing', async () => {
  const capability = await api('/capabilities?model=fixture-mechanical');
  assert.equal(capability.status, 200);
  assert.deepEqual((await capability.json()).modelTier, 'mechanical');
  admissionOpen = false;
  try {
    assert.equal((await (await api('/capabilities?model=fixture-mechanical')).json()).ready, false);
    const response = await api('', { method: 'POST', headers: { 'Content-Type': 'broken-multipart' } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'E_NOT_READY');
  } finally { admissionOpen = true; }
  await fixture.db.$executeRaw`UPDATE ai_models SET "isActive"=false WHERE name='fixture-mechanical'`;
  try {
    const body = await (await api('/capabilities?model=fixture-mechanical')).json();
    assert.equal(body.supported, false); assert.equal(body.modelTier, null);
    const denied = await api('', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: multipart() });
    assert.equal(denied.status, 400);
  } finally { await fixture.db.$executeRaw`UPDATE ai_models SET "isActive"=true WHERE name='fixture-mechanical'`; }
});

test('owner can recover a lost admission response by key without exposing another owner job', async () => {
  const created = await createHttp();
  const recovered = await api(`/by-key/${created.key}`);
  assert.equal(recovered.status, 200);
  const snapshot = await recovered.json();
  assert.equal(snapshot.id, created.id); assert.equal(snapshot.admissionReady, true);
  assert.equal((await api(`/by-key/${created.key}`, {}, 'other')).status, 404);
  assert.equal((await api('/by-key/not-present')).status, 404);
});

test('read/protected permissions and mismatched selected model cannot create an edit job', async () => {
  for (const permission of ['read', 'protected']) {
    const body = multipart(); body.append('permission', permission);
    const response = await api('', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'E_PLAN_GATE');
  }
  const body = multipart(); body.append('requestedModel', 'fixture-academic');
  const response = await api('', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body });
  assert.equal(response.status, 400);
});

test('stable artifact route issues only an owner-scoped fresh signed redirect, revoked on deletion', async () => {
  const created = await createRealFailureReport();
  const stable = `/${created.id}/artifacts/${created.artifactId}?download=1`;
  const response = await api(stable, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.ok(response.headers.get('location')?.startsWith(`/api/docs/jobs/${created.id}/artifacts/${created.artifactId}/download?signature=`));
  assert.equal((await api(stable, { redirect: 'manual' }, 'other')).status, 403);
  assert.deepEqual(Buffer.from(await (await api(stable)).arrayBuffer()), created.reportBytes);
  await api(`/${created.id}`, { method: 'DELETE' });
  assert.equal((await api(stable, { redirect: 'manual' })).status, 404);
});

test('real multipart admission stores encrypted exact inputs, returns 202 and enqueues only after acknowledgement', async () => {
  const created = await createHttp();
  const job = await fixture.repository.getOwned(created.id, fixture.owner);
  assert.equal(job.status, 'queued'); assert.equal(job.admissionReady, true);
  const artifacts = await fixture.repository.artifactsInternal(created.id);
  const input = artifacts.find(a => a.kind === 'input'); assert.ok(input);
  assert.equal(input.filename, 'Original con ñ.txt');
  assert.deepEqual(await fixture.storage.get({ userId: fixture.owner, jobId: created.id }, input.storageKey, input.sha256), created.bytes);
  const instructions = await fixture.storage.get({ userId: fixture.owner, jobId: created.id }, job.instructionsKey);
  assert.equal(instructions.toString(), 'No cambies nada; conserva el archivo');
  assert.equal((await fixture.repository.pendingOutbox(500, 'enqueue')).filter(e => e.jobId === created.id).length, 1);
  const snapshot = await api(`/${created.id}`);
  assert.equal(snapshot.status, 200);
  const text = await snapshot.text();
  assert.ok(!text.includes(job.instructionsKey)); assert.ok(!text.includes('Fixture content')); assert.ok(!text.includes('leaseToken'));
  assert.equal(snapshot.headers.get('cache-control'), 'private, no-store');
});

test('same multipart idempotency key returns the original job without a second upload or new job', async () => {
  const created = await createHttp();
  const beforeKeys = await fixture.storage.list({ userId: fixture.owner, jobId: created.id });
  const repeated = await api('', { method: 'POST', headers: { 'Idempotency-Key': created.key }, body: multipart(created.bytes) });
  assert.equal(repeated.status, 202);
  const body = await repeated.json() as { jobId: string };
  assert.equal(body.jobId, created.id);
  assert.deepEqual(await fixture.storage.list({ userId: fixture.owner, jobId: created.id }), beforeKeys);
  const changed = await api('', { method: 'POST', headers: { 'Idempotency-Key': created.key }, body: multipart(created.bytes, 'different.txt', 'Another instruction') });
  assert.equal(changed.status, 409);
});

test('unsupported mode, mismatched PDF-to-DOCX bytes and oversized upload fail through real multipart parser', async () => {
  for (const [body, expected] of [
    [multipart(Buffer.from('text'), 'fixture.txt', 'edit', 'approval'), 400],
    [multipart(Buffer.from('%PDF-1.7\nfixture'), 'fake.docx'), 415],
    [multipart(Buffer.alloc(fixture.config.maxFileBytes + 1, 65), 'too-large.txt'), 400],
  ] as const) {
    const response = await api('', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body });
    assert.equal(response.status, expected, await response.clone().text());
  }
});

test('IDOR is denied across job snapshot, events, artifacts, cancel and delete with real persisted ownership', async () => {
  const created = await createRealFailureReport();
  for (const [method, path] of [['GET', `/${created.id}`], ['GET', `/${created.id}/events`], ['GET', `/${created.id}/artifacts/${created.artifactId}`], ['POST', `/${created.id}/cancel`], ['DELETE', `/${created.id}`]] as const) {
    const response = await api(path, { method }, 'other');
    assert.equal(response.status, 403, path);
  }
  assert.equal((await fixture.repository.getOwned(created.id, fixture.owner)).status, 'failed');
});

test('signed report download returns exact real S3 bytes, rejects tampering and is revoked by DELETE', async () => {
  // A real failure report is downloadable; this deliberately does not fabricate a validated output.
  const created = await createRealFailureReport();
  const ticketResponse = await api(`/${created.id}/artifacts/${created.artifactId}`);
  assert.equal(ticketResponse.status, 200);
  const ticket = await ticketResponse.json() as { url: string; expiresIn: number };
  assert.equal(ticket.expiresIn, 600); assert.ok(ticket.url.startsWith('/api/docs/jobs/'));
  const download = await fetch(`${origin}${ticket.url}`, { headers: { Authorization: testToken() } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), created.reportBytes);
  assert.ok(download.headers.get('content-disposition')?.includes(encodeURIComponent('Reporte sin ejecución.json')));
  const other = await fetch(`${origin}${ticket.url}`, { headers: { Authorization: testToken('other') } });
  assert.equal(other.status, 403);
  const tampered = new URL(ticket.url, origin);
  tampered.searchParams.set('signature', `${tampered.searchParams.get('signature')}A`);
  assert.equal((await fetch(tampered, { headers: { Authorization: testToken() } })).status, 403);
  assert.equal((await api(`/${created.id}`, { method: 'DELETE' })).status, 202);
  const revoked = await fetch(`${origin}${ticket.url}`, { headers: { Authorization: testToken() } });
  assert.equal(revoked.status, 404);
  assert.equal((await api(`/${created.id}`)).status, 404);
  assert.ok(aborted.has(created.id));
  assert.equal((await fixture.repository.getInternal(created.id)).cleanupPending, true);
});

test('real SSE replays durable sequences after Last-Event-ID and terminates at the persisted terminal state', async () => {
  const created = await createRealFailureReport();
  const initial = await api(`/${created.id}/events`);
  assert.equal(initial.status, 200);
  assert.match(initial.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await initial.text();
  assert.ok(text.includes('event: snapshot'));
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
  assert.ok(ids.length >= 3);
  const replay = await api(`/${created.id}/events`, { headers: { 'Last-Event-ID': String(ids[0]) } });
  const replayIds = [...(await replay.text()).matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
  assert.deepEqual(replayIds, ids.slice(1));
  assert.ok(!text.includes('private-')); assert.ok(!text.includes('leaseToken')); assert.ok(!text.includes('Fixture content'));
  assert.equal((await api(`/${created.id}/events`, { headers: { 'Last-Event-ID': '99999' } })).status, 409);
});

test('HTTP cancellation is idempotent, invokes abort and prevents a previously claimed worker transition', async () => {
  const created = await createHttp();
  const lease = await fixture.repository.claimAttempt(created.id, 60_000); assert.ok(lease);
  assert.equal((await api(`/${created.id}/cancel`, { method: 'POST' })).status, 200);
  assert.equal((await api(`/${created.id}/cancel`, { method: 'POST' })).status, 200);
  assert.ok(aborted.has(created.id));
  await assert.rejects(fixture.repository.transition(lease, 'planning'));
  assert.equal((await fixture.repository.getOwned(created.id, fixture.owner)).status, 'cancelled');
});

test('real fixture rate limiter is reached through admission without creating documents', async () => {
  let rejected = false;
  for (let i = 0; i < 51; i += 1) {
    const response = await api('', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() } });
    if (response.status === 429) { rejected = true; break; }
  }
  assert.ok(rejected);
  assert.ok(notices.every(code => /^E_[A-Z_]+$/.test(code)), 'public error notices must contain only codes');
});
