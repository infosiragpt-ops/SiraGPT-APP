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
