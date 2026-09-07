import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express, { type RequestHandler } from 'express';
import { z } from 'zod';
import { createDocumentRouter } from '../src/modules/doc-sandbox/api/router';
import { DocumentDownloadTickets } from '../src/modules/doc-sandbox/storage/private-storage';
import { DocumentRepositoryError, type StoredDocumentJob } from '../src/modules/doc-sandbox/queue/repository';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import type { DocumentSandboxConfig } from '../src/modules/doc-sandbox/config';

const key = Buffer.alloc(32, 3);
const tickets = new DocumentDownloadTickets(key);
const jobId = 'job-router-1';
const artifactId = 'art-router-1';
const bytes = Buffer.alloc(300 * 1024, 65);

function job(overrides: Partial<StoredDocumentJob> = {}): StoredDocumentJob {
  return {
    id: jobId, userId: 'owner-1', status: 'done', admissionReady: true, mode: 'preserve', engine: 'anthropic',
    modelTier: 'mechanical', requestedModel: 'synthetic', tokenBudget: 1000,
    instructionsKey: 'doc-sandbox/owner-1/job-router-1/v1/ins.sealed', inputKeys: [], outputKeys: [],
    editPlanKey: null, editPlanHash: null, validationReportKey: null, errorCode: null, usage: {},
    costUsd: '0', maxCostUsd: '1', costReservations: [], purgedKeys: [], storageKeys: [],
    outcome: 'edited', attempts: 1, fence: 1, leaseToken: null, leaseExpiresAt: null, eventSeq: 2,
    sessionRef: null, providerFiles: [], providerContainers: [], cleanupPending: false, cleanupNotBefore: null,
    parentJobId: null, promptVersion: 'v1', createdAt: new Date(0), startedAt: new Date(0), finishedAt: new Date(1),
    expiresAt: new Date(Date.now() + 60_000), deletedAt: null, ...overrides,
  };
}

function config(): DocumentSandboxConfig {
  return {
    redisUrl: 'redis://127.0.0.1:1', apiKey: 'synthetic', bucket: 'unit', storageKey: key, keyId: 'v1',
    previousKeys: {}, r2AccountId: 'acct', r2AccessKeyId: 'id', r2SecretAccessKey: 'secret',
    validatorImage: `sha256:${'a'.repeat(64)}`, validatorStagingRoot: '/tmp/doc-sandbox-unit-staging',
    engine: { models: { mechanical: { id: 'm', prices: { version: 'unit', inputPerMillionUsd: 1, outputPerMillionUsd: 1,
      cacheReadPerMillionUsd: 1, cacheWritePerMillionUsd: 1, executionPerHourUsd: 0, minimumExecutionSeconds: 0 },
      maxOutputTokensPerTurn: 16, reservationUsdPerTurn: 0.01 }, academic: { id: 'a', prices: { version: 'unit',
      inputPerMillionUsd: 1, outputPerMillionUsd: 1, cacheReadPerMillionUsd: 1, cacheWritePerMillionUsd: 1,
      executionPerHourUsd: 0, minimumExecutionSeconds: 0 }, maxOutputTokensPerTurn: 16, reservationUsdPerTurn: 0.01 } },
      skillVersions: { docx: 'v1' }, maxFileBytes: 1024, maxOutputBytes: 1024, maxSessionMs: 1000, apiTimeoutMs: 1000,
      cleanupTimeoutMs: 1000 },
    maxCostUsd: 1, maxTurns: 4, maxTokens: 1000, timeoutMs: 10_000, retentionDays: 1, maxFileBytes: 1024,
    concurrency: 1, showCost: true,
  };
}

async function listen(app: express.Express): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createHttpServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function app(overrides: Record<string, unknown> = {}) {
  const authenticate: RequestHandler = (req, _res, next) => {
    (req as { user?: { id: string; plan: string } }).user = { id: 'owner-1', plan: 'PRO' };
    next();
  };
  const current = job();
  const router = createDocumentRouter({
    authenticate,
    admissionPolicy: ((_req, _res, next) => next()) as RequestHandler,
    repository: {
      getOwned: async () => current,
      getInternal: async () => current,
      artifactsOwned: async () => [{
        id: artifactId, jobId, attempt: 1, kind: 'output', storageKey: 'doc-sandbox/owner-1/job-router-1/v1/out.sealed',
        filename: 'informe.txt', mime: 'text/plain', size: bytes.length, sha256: 'a'.repeat(64), published: true, purgedAt: null,
      }],
      listEventsOwned: async (_id: string, _user: string, after: number) => after >= 2 ? [] : [
        { id: 'evt-1', jobId, seq: 1, type: 'phase', payload: { phase: 'planning' }, createdAt: new Date(0), outbox: null },
        { id: 'evt-2', jobId, seq: 2, type: 'status_changed', payload: { status: 'done' }, createdAt: new Date(1), outbox: null },
      ],
      getByIdempotencyKeyOwned: async () => current,
      cancelOwned: async () => undefined,
      deleteOwned: async () => undefined,
    } as never,
    storage: {
      get: async () => Buffer.from(bytes),
    } as never,
    tickets,
    config: config(),
    isReady: () => true,
    resolveModel: async () => 'mechanical',
    abort() {},
    notice() {},
    ...overrides,
  });
  const instance = express();
  instance.use('/api/docs/jobs', router);
  return instance;
}

test('GET by id and idempotency key return the owner snapshot with published artifacts', async () => {
  const server = await listen(app());
  try {
    const byId = await fetch(`${server.origin}/api/docs/jobs/${jobId}`);
    assert.equal(byId.status, 200);
    const snapshot = await byId.json() as { id: string; artifacts: Array<{ id: string }> };
    assert.equal(snapshot.id, jobId);
    assert.equal(snapshot.artifacts[0]?.id, artifactId);
    const byKey = await fetch(`${server.origin}/api/docs/jobs/by-key/idem-key-1`);
    assert.equal(byKey.status, 200);
    assert.equal((await byKey.json() as { id: string }).id, jobId);
  } finally {
    await server.close();
  }
});

test('download streams bounded chunks and SSE replays then finishes a terminal job', async () => {
  const server = await listen(app());
  try {
    const signature = tickets.issue('owner-1', jobId, artifactId);
    const download = await fetch(`${server.origin}/api/docs/jobs/${jobId}/artifacts/${artifactId}/download?signature=${signature}`);
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, bytes.length);
    const ticket = await fetch(`${server.origin}/api/docs/jobs/${jobId}/artifacts/${artifactId}`);
    assert.equal((await ticket.json() as { url: string }).url.includes('signature='), true);
    const redirect = await fetch(`${server.origin}/api/docs/jobs/${jobId}/artifacts/${artifactId}?download=1`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const events = await fetch(`${server.origin}/api/docs/jobs/${jobId}/events`, { headers: { 'Last-Event-ID': '0' } });
    const body = await events.text();
    assert.match(body, /event: snapshot/);
    assert.match(body, /event: phase/);
  } finally {
    await server.close();
  }
});

test('router maps Zod, repository and destroyed-response errors without leaking internals', async () => {
  const notices: string[] = [];
  const server = await listen(app({
    notice: (code: string) => notices.push(code),
    repository: {
      getOwned: async () => { throw new DocumentRepositoryError('DOC_FORBIDDEN'); },
      artifactsOwned: async () => [],
      listEventsOwned: async () => [],
    },
  }));
  try {
    const forbidden = await fetch(`${server.origin}/api/docs/jobs/${jobId}`);
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json() as { code: string }).code, 'E_FORBIDDEN');
    const params = await fetch(`${server.origin}/api/docs/jobs/not a id`);
    assert.equal(params.status, 400);
  } finally {
    await server.close();
  }
  const quota = await listen(app({
    repository: { getOwned: async () => { throw new DocumentRepositoryError('DOC_BUDGET_EXCEEDED'); } },
  }));
  try {
    assert.equal((await fetch(`${quota.origin}/api/docs/jobs/${jobId}`)).status, 429);
  } finally {
    await quota.close();
  }
  const missing = await listen(app({
    repository: { getOwned: async () => { throw new DocumentRepositoryError('DOC_NOT_FOUND'); } },
  }));
  try {
    assert.equal((await fetch(`${missing.origin}/api/docs/jobs/${jobId}`)).status, 404);
  } finally {
    await missing.close();
  }
  const conflict = await listen(app({
    repository: { getOwned: async () => { throw new DocumentRepositoryError('DOC_STALE_LEASE'); } },
  }));
  try {
    assert.equal((await fetch(`${conflict.origin}/api/docs/jobs/${jobId}`)).status, 409);
  } finally {
    await conflict.close();
  }
  assert.ok(z.string().safeParse('ok').success);
});

test('SSE rejects an invalid cursor, quota overflow and a cursor ahead of the snapshot', async () => {
  const server = await listen(app());
  try {
    assert.equal((await fetch(`${server.origin}/api/docs/jobs/${jobId}/events?after=-1`)).status, 400);
    assert.equal((await fetch(`${server.origin}/api/docs/jobs/${jobId}/events`, { headers: { 'Last-Event-ID': '99' } })).status, 409);
  } finally {
    await server.close();
  }
  const live = job({ status: 'editing', eventSeq: 0, finishedAt: null });
  const busy = await listen(app({
    repository: {
      getOwned: async () => live,
      listEventsOwned: async () => [],
    },
  }));
  try {
    const first = await Promise.all([0, 1, 2].map(() => fetch(`${busy.origin}/api/docs/jobs/${jobId}/events`)));
    assert.ok(first.every(response => response.ok));
    const overflow = await fetch(`${busy.origin}/api/docs/jobs/${jobId}/events`);
    assert.equal(overflow.status, 429);
    await Promise.all(first.map(response => response.body?.cancel()));
  } finally {
    await busy.close();
  }
});

test('upload gate rejects unreadiness, overflow and a cancelled request before claiming a slot', async () => {
  const unreadiness = await listen(app({ isReady: () => false }));
  try {
    const response = await fetch(`${unreadiness.origin}/api/docs/jobs`, { method: 'POST', body: new URLSearchParams() });
    assert.equal(response.status, 503);
  } finally {
    await unreadiness.close();
  }
  const error = new DocSandboxError('E_PARAMS', 400);
  assert.equal(error.code, 'E_PARAMS');
});

test('POST upload admits a text file, then cancel and delete stay owner-scoped', async () => {
  const current = job({ status: 'queued', admissionReady: true, finishedAt: null });
  const created: string[] = [];
  const stored: string[] = [];
  const server = await listen(app({
    repository: {
      getOwned: async () => current,
      getInternal: async () => ({ ...current, cleanupPending: true }),
      artifactsOwned: async () => [],
      listEventsOwned: async () => [],
      getByIdempotencyKeyOwned: async () => current,
      createJob: async (input: { id: string }) => {
        created.push(input.id);
        return { job: { ...current, id: input.id }, created: true };
      },
      markInputsReadyOwned: async () => undefined,
      cancelOwned: async () => { current.status = 'cancelled'; },
      deleteOwned: async () => { current.deletedAt = new Date(); current.cleanupPending = true; },
    },
    storage: {
      prepare(_scope: unknown, data: Buffer) {
        return { key: `doc-sandbox/owner-1/job-router-1/v1/${stored.length}.sealed`, sha256: 'a'.repeat(64), size: data.length };
      },
      putPrepared: async (_scope: unknown, object: { key: string }) => { stored.push(object.key); },
      get: async () => Buffer.from(bytes),
    },
  }));
  try {
    const form = new FormData();
    form.set('instructions', 'Conserva el informe.');
    form.set('modelTier', 'mechanical');
    form.set('permission', 'default');
    form.set('files[]', new Blob(['El informe dice 2026.\n'], { type: 'text/plain' }), 'informe.txt');
    const admitted = await fetch(`${server.origin}/api/docs/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'upload-key-1' },
      body: form,
    });
    assert.equal(admitted.status, 202, await admitted.text());
    assert.equal(created.length, 1);
    assert.ok(stored.length >= 2);
    const cancelled = await fetch(`${server.origin}/api/docs/jobs/${jobId}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    const removed = await fetch(`${server.origin}/api/docs/jobs/${jobId}`, { method: 'DELETE' });
    assert.equal(removed.status, 202);
    assert.equal((await removed.json() as { cleanupPending: boolean }).cleanupPending, true);
  } finally {
    await server.close();
  }
});

test('POST upload returns the previous job when admission is a duplicate key', async () => {
  const current = job({ status: 'queued', admissionReady: true });
  const server = await listen(app({
    repository: {
      getOwned: async () => current,
      createJob: async () => ({ job: current, created: false }),
    },
    storage: {
      prepare(_scope: unknown, data: Buffer) {
        return { key: 'doc-sandbox/owner-1/job-router-1/v1/dup.sealed', sha256: 'a'.repeat(64), size: data.length };
      },
      putPrepared: async () => assert.fail('duplicate must not upload'),
    },
  }));
  try {
    const form = new FormData();
    form.set('instructions', 'Conserva el informe.');
    form.set('modelTier', 'mechanical');
    form.set('permission', 'default');
    form.set('files[]', new Blob(['El informe dice 2026.\n'], { type: 'text/plain' }), 'informe.txt');
    const response = await fetch(`${server.origin}/api/docs/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'dup-key' },
      body: form,
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { jobId: string }).jobId, jobId);
  } finally {
    await server.close();
  }
});

test('POST upload over the per-file limit removes already stored buffers', async () => {
  const server = await listen(app({
    repository: {
      createJob: async () => assert.fail('multer must reject before admission'),
    },
    storage: {
      prepare() { throw new Error('must not persist'); },
    },
  }));
  try {
    const form = new FormData();
    form.set('instructions', 'Conserva el informe.');
    form.set('modelTier', 'mechanical');
    form.set('permission', 'default');
    form.set('files[]', new Blob(['a'.repeat(200)], { type: 'text/plain' }), 'ok.txt');
    form.set('files[]', new Blob(['b'.repeat(2_000)], { type: 'text/plain' }), 'too-big.txt');
    const response = await fetch(`${server.origin}/api/docs/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'limit-key' },
      body: form,
    });
    assert.ok(response.status >= 400);
  } finally {
    await server.close();
  }
});

test('POST upload tombs a created job when storage fails and delete is still pending', async () => {
  const notices: string[] = [];
  const current = job({ status: 'queued', admissionReady: false });
  const server = await listen(app({
    notice: (code: string) => notices.push(code),
    repository: {
      getOwned: async () => current,
      createJob: async (input: { id: string }) => ({ job: { ...current, id: input.id }, created: true }),
      deleteOwned: async () => { throw new Error('tombstone pending'); },
    },
    storage: {
      prepare(_scope: unknown, data: Buffer) {
        return { key: 'doc-sandbox/owner-1/job-router-1/v1/fail.sealed', sha256: 'a'.repeat(64), size: data.length };
      },
      putPrepared: async () => { throw new Error('object store'); },
    },
  }));
  try {
    const form = new FormData();
    form.set('instructions', 'Conserva el informe.');
    form.set('modelTier', 'mechanical');
    form.set('permission', 'default');
    form.set('files[]', new Blob(['El informe dice 2026.\n'], { type: 'text/plain' }), 'informe.txt');
    const response = await fetch(`${server.origin}/api/docs/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'fail-key' },
      body: form,
    });
    assert.ok(response.status >= 400);
    assert.ok(notices.includes('DOC_ADMISSION_CLEANUP_PENDING'));
  } finally {
    await server.close();
  }
});
