import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DocSandboxRepository, DocumentRepositoryError, type AttemptLease, type ArtifactInput,
  type CreateDocumentJob, type PublicationGate } from '../src/modules/doc-sandbox/queue/repository';

// In-memory SQL stand-in. Queries never leave this process; this is not a
// Postgres transaction or isolation proof.
function sqlText(query: unknown): string {
  if (query && typeof query === 'object' && 'strings' in query) {
    const tagged = query as { strings: readonly string[]; values: readonly unknown[] };
    return tagged.strings.reduce((acc, part, index) => acc + part + (index < tagged.values.length ? String(tagged.values[index]) : ''), '');
  }
  return String(query);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function dbJob(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'job-1', user_id: 'owner-1', status: 'queued', admission_ready: true, mode: 'preserve', engine: 'anthropic',
    model_tier: 'mechanical', requested_model: 'synthetic', token_budget: 1000,
    quota_reserved_tokens: 1000n, quota_epoch: 1n, quota_settled_tokens: null, quota_settled_at: null,
    instructions_key: 'doc-sandbox/owner-1/job-1/v1/ins.sealed', input_keys: ['doc-sandbox/owner-1/job-1/v1/in.sealed'],
    output_keys: [], edit_plan_key: null, edit_plan_hash: null, validation_report_key: null, error_code: null,
    usage: {}, cost_usd: new Prisma.Decimal('0'), max_cost_usd: new Prisma.Decimal('5'),
    cost_reservations: [], purged_keys: [], storage_keys: ['doc-sandbox/owner-1/job-1/v1/ins.sealed'],
    outcome: null, attempts: 0, fence: 0, lease_token: null, lease_expires_at: null, event_seq: 0,
    session_ref: null, provider_files: [], provider_containers: [], attempt_leases: [],
    cleanup_pending: false, cleanup_not_before: null, parent_job_id: null, payload_hash: 'a'.repeat(64),
    prompt_version: 'v1', created_at: now, started_at: null, finished_at: null,
    expires_at: new Date(now.getTime() + 3_600_000), deleted_at: null, idempotency_key: 'request-one',
    ...overrides,
  };
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'art-in', job_id: 'job-1', attempt: 0, kind: 'input',
    storage_key: 'doc-sandbox/owner-1/job-1/v1/in.sealed', filename: 'informe.txt',
    mime: 'text/plain', size: 8n, sha256: 'a'.repeat(64), published: false, purged_at: null, ...overrides,
  };
}

function client(job = dbJob(), extras: { users?: Record<string, unknown>[]; artifacts?: Record<string, unknown>[]; events?: Record<string, unknown>[] } = {}) {
  const users = extras.users ?? [{
    id: 'owner-1', deletedAt: null, plan: 'PRO', isSuperAdmin: false, apiUsage: 0n, monthlyLimit: 100_000n, docQuotaEpoch: 1n,
  }];
  const artifacts = extras.artifacts ?? [artifactRow()];
  const events = extras.events ?? [];
  const queries: string[] = [];
  const db = {
    async $queryRaw(query: unknown) {
      const text = sqlText(query);
      queries.push(text);
      if (text.includes('FROM users')) return users;
      if (text.includes('clock_timestamp() AS now')) return [{ now: new Date() }];
      if (text.includes('FROM pg_advisory_xact_lock')) return [{ locked: 1 }];
      if (text.includes('FROM doc_jobs') && text.includes('idempotency_key') && text.includes('FOR UPDATE')) return [];
      if (text.includes('idempotency_key')) return [job];
      if (text.includes('RETURNING event_seq')) {
        job.event_seq = Number(job.event_seq) + 1;
        return [{ event_seq: job.event_seq }];
      }
      if (text.includes('FROM doc_job_artifacts') && text.includes("kind='input'")) {
        return artifacts.filter(item => item.kind === 'input' && item.purged_at == null);
      }
      if (text.includes('FROM doc_job_artifacts') && text.includes('FOR UPDATE')) {
        return artifacts.filter(item => item.job_id === job.id && item.purged_at == null);
      }
      if (text.includes('FROM doc_job_artifacts a JOIN doc_jobs')) {
        return artifacts.filter(item => item.published === true && item.purged_at == null);
      }
      if (text.includes('FROM doc_job_artifacts') && text.includes('RETURNING storage_key')) {
        const row = artifacts[0];
        if (row) row.purged_at = new Date();
        return row ? [{ storage_key: row.storage_key }] : [];
      }
      if (text.includes('count(*) AS count')) {
        return [{ count: BigInt(artifacts.filter(item => item.purged_at == null).length) }];
      }
      if (text.includes('FROM doc_job_events e JOIN doc_jobs')) return events;
      if (text.includes('FROM doc_job_events') && text.includes('outbox')) return events;
      if (text.includes('FROM doc_job_artifacts') && text.includes('ANY')) return [];
      if (text.includes('FROM doc_job_artifacts')) return artifacts;
      if (text.includes('FROM doc_jobs') && text.includes('quota_settled_at')) return [{ id: job.id, user_id: job.user_id }];
      if (text.includes('FROM doc_jobs') && text.includes('expires_at<=')) return [];
      if (text.includes('FROM doc_jobs') && text.includes('cleanup_pending')) return [job];
      if (text.includes('FROM doc_jobs') && text.includes('lease_expires_at')) return [];
      if (text.includes('FROM doc_jobs') && text.includes('admission_ready=false')) return [];
      if (text.includes('FROM doc_jobs') && text.includes('admission_ready=true')) return [];
      if (text.includes('FROM doc_jobs')) return [job];
      return [];
    },
    async $executeRaw(query: unknown) {
      queries.push(sqlText(query));
      return 1;
    },
  };
  const api = {
    queries, job, artifacts, users, events,
    $queryRaw: db.$queryRaw.bind(db),
    $executeRaw: db.$executeRaw.bind(db),
    async $transaction<T>(fn: (tx: Pick<typeof db, '$queryRaw' | '$executeRaw'>) => Promise<T>): Promise<T> {
      return fn({ $queryRaw: (...args: Parameters<typeof api.$queryRaw>) => api.$queryRaw(...args),
        $executeRaw: (...args: Parameters<typeof api.$executeRaw>) => api.$executeRaw(...args) });
    },
  };
  return api;
}

const lease: AttemptLease = { jobId: 'job-1', token: 'lease-1', fence: 1, attempt: 1 };
const artifact: ArtifactInput = {
  kind: 'input', storageKey: 'doc-sandbox/owner-1/job-1/v1/in.sealed', filename: 'informe.txt',
  mime: 'text/plain', size: 8, sha256: 'a'.repeat(64),
};

function admission(): CreateDocumentJob {
  return {
    userId: 'owner-1', idempotencyKey: 'request-one', payloadHash: 'a'.repeat(64),
    instructionsKey: 'doc-sandbox/owner-1/job-1/v1/ins.sealed', inputs: [artifact],
    modelTier: 'mechanical', requestedModel: 'synthetic', maxTokens: 1000,
    promptVersion: 'v1', expiresAt: new Date(Date.now() + 3600_000), maxCostUsd: '1.00000000', ready: true,
  };
}

function leasedJob() {
  return dbJob({
    status: 'inspecting', attempts: 1, fence: 1, lease_token: 'lease-1',
    lease_expires_at: new Date(Date.now() + 30_000),
    attempt_leases: [{ attempt: 1, tokenHash: hashToken('lease-1') }],
    admission_ready: true,
  });
}

test('createJob inserts a ready admission and returns the mapped job', async () => {
  const prisma = client();
  const repository = new DocSandboxRepository(prisma);
  const result = await repository.createJob(admission());
  assert.equal(result.created, true);
  assert.equal(result.job.userId, 'owner-1');
  assert.equal(result.job.requestedModel, 'synthetic');
  assert.ok(prisma.queries.some(query => query.includes('INSERT INTO doc_jobs')));
});

test('createJob returns the previous row when the idempotency payload matches', async () => {
  const existing = dbJob();
  const prisma = client(existing);
  prisma.$queryRaw = async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes('FROM users')) return prisma.users;
    if (text.includes('FROM pg_advisory_xact_lock')) return [{ locked: 1 }];
    if (text.includes('idempotency_key')) return [existing];
    if (text.includes('FROM doc_jobs')) return [existing];
    return [];
  };
  const repository = new DocSandboxRepository(prisma);
  const result = await repository.createJob(admission());
  assert.equal(result.created, false);
  assert.equal(result.job.id, 'job-1');
});

test('createJob rejects a deleted account, exhausted quota and conflicting payload', async () => {
  const deleted = client(dbJob(), { users: [{ id: 'owner-1', deletedAt: new Date(), plan: 'PRO', isSuperAdmin: false, apiUsage: 0n, monthlyLimit: 10n, docQuotaEpoch: 1n }] });
  await assert.rejects(new DocSandboxRepository(deleted).createJob(admission()),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_DELETED');
  const free = client(dbJob(), { users: [{ id: 'owner-1', deletedAt: null, plan: 'FREE', isSuperAdmin: false, apiUsage: 0n, monthlyLimit: 10n, docQuotaEpoch: 1n }] });
  await assert.rejects(new DocSandboxRepository(free).createJob(admission()),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_BUDGET_EXCEEDED');
  const conflict = dbJob({ payload_hash: 'b'.repeat(64) });
  const prisma = client(conflict);
  prisma.$queryRaw = async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes('FROM users')) return prisma.users;
    if (text.includes('FROM pg_advisory_xact_lock')) return [{ locked: 1 }];
    if (text.includes('idempotency_key')) return [conflict];
    return [];
  };
  await assert.rejects(new DocSandboxRepository(prisma).createJob(admission()),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_CONFLICT');
});

test('owner reads reject missing, foreign, deleted and expired jobs', async () => {
  const missing = client();
  missing.$queryRaw = async () => [];
  await assert.rejects(new DocSandboxRepository(missing).getOwned('job-1', 'owner-1'),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_NOT_FOUND');
  const foreign = client(dbJob({ user_id: 'other' }));
  await assert.rejects(new DocSandboxRepository(foreign).getOwned('job-1', 'owner-1'),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_FORBIDDEN');
  const tombstone = client(dbJob({ deleted_at: new Date() }));
  await assert.rejects(new DocSandboxRepository(tombstone).getOwned('job-1', 'owner-1'),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_DELETED');
  const expired = client(dbJob({ expires_at: new Date(0) }));
  await assert.rejects(new DocSandboxRepository(expired).getOwned('job-1', 'owner-1'),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_EXPIRED');
});

test('internal snapshot, artifacts and events map database rows', async () => {
  const prisma = client(dbJob(), {
    artifacts: [artifactRow({ published: true })],
    events: [{ id: 'evt-1', job_id: 'job-1', seq: 1, type: 'phase', payload: { phase: 'planning' }, created_at: new Date(), outbox: null }],
  });
  const repository = new DocSandboxRepository(prisma);
  const internal = await repository.getInternal('job-1');
  assert.equal(internal.id, 'job-1');
  assert.equal((await repository.artifactsInternal('job-1'))[0]?.filename, 'informe.txt');
  assert.equal((await repository.artifactsOwned('job-1', 'owner-1'))[0]?.kind, 'input');
  assert.equal((await repository.listEventsOwned('job-1', 'owner-1', 0, 10))[0]?.type, 'phase');
  await assert.rejects(repository.listEventsOwned('job-1', 'owner-1', -1),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_INVALID_INPUT');
  assert.equal((await repository.getByIdempotencyKeyOwned('request-one', 'owner-1')).id, 'job-1');
});

test('claimAttempt, heartbeat, transition and freezePlan follow the leased job', async () => {
  const row = leasedJob();
  row.status = 'queued';
  row.attempts = 0;
  row.fence = 0;
  row.lease_token = null;
  const prisma = client(row);
  const repository = new DocSandboxRepository(prisma);
  const claimed = await repository.claimAttempt('job-1', 10_000);
  assert.ok(claimed);
  assert.equal(claimed.jobId, 'job-1');
  assert.equal(claimed.attempt, 1);
  const live = client(leasedJob());
  const working = new DocSandboxRepository(live);
  await working.heartbeat(lease, 10_000);
  live.job.status = 'inspecting';
  await working.transition(lease, 'planning');
  live.job.status = 'planning';
  await working.freezePlan(lease, 'doc-sandbox/owner-1/job-1/v1/plan.sealed', 'b'.repeat(64));
  await working.recordSession(lease, 'session-1');
  await working.appendEvent(lease, 'phase', { phase: 'planning' });
  await working.reserveStorageKeys(lease, ['doc-sandbox/owner-1/job-1/v1/out.sealed']);
  await working.registerArtifacts(lease, [{
    kind: 'edit_plan', storageKey: 'doc-sandbox/owner-1/job-1/v1/plan.sealed', filename: 'edit_plan.json',
    mime: 'application/json', size: 2, sha256: 'b'.repeat(64),
  }]);
});

test('cost reservation and settlement update the durable ledger', async () => {
  const row = leasedJob();
  const prisma = client(row);
  const repository = new DocSandboxRepository(prisma);
  assert.equal(await repository.reserveCost(lease, 'req-1', '0.01000000'), true);
  row.cost_reservations = [{ requestId: 'req-1', attempt: 1, reservedUsd: '0.01000000', actualUsd: null, actualTokens: null }];
  await repository.settleCost(lease, 'req-1', '0.01000000', 12);
  assert.ok(prisma.queries.some(query => query.includes('cost_reservations')));
  await repository.recordUsage(lease, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costExact: true }, '0.01000000');
  await repository.recordProviderFiles(lease, ['file_abc']);
  row.provider_files = [{ fileId: 'file_abc', attempt: 1, deleted: false, failures: 0 }];
  await repository.recordContainer(lease, { id: 'ctr_1', expiresAt: null, stage: 'plan' });
  await repository.markProviderFileDeleted('job-1', 'file_abc', true);
});

test('publishValidated accepts a complete edited gate and is idempotent when already done', async () => {
  const planHash = 'c'.repeat(64);
  const reportKey = 'doc-sandbox/owner-1/job-1/v1/report.sealed';
  const outputKey = 'doc-sandbox/owner-1/job-1/v1/out.sealed';
  const row = leasedJob();
  row.status = 'validating';
  row.edit_plan_hash = planHash;
  row.edit_plan_key = 'doc-sandbox/owner-1/job-1/v1/plan.sealed';
  const artifacts = [
    artifactRow(),
    artifactRow({ id: 'art-out', kind: 'output', storage_key: outputKey, filename: 'informe.txt' }),
    artifactRow({ id: 'art-plan', kind: 'edit_plan', storage_key: row.edit_plan_key, sha256: planHash, filename: 'edit_plan.json' }),
    artifactRow({ id: 'art-recipe', kind: 'recipe', storage_key: 'doc-sandbox/owner-1/job-1/v1/recipe.sealed', filename: 'recipe.zip' }),
    artifactRow({ id: 'art-result', kind: 'agent_result', storage_key: 'doc-sandbox/owner-1/job-1/v1/result.sealed', filename: 'result.json' }),
    artifactRow({ id: 'art-report', kind: 'validation_report', storage_key: reportKey, filename: 'report.json' }),
    artifactRow({ id: 'art-diff', kind: 'text_diff', storage_key: 'doc-sandbox/owner-1/job-1/v1/diff.sealed', filename: 'text-diff.json' }),
  ];
  const prisma = client(row, { artifacts });
  const repository = new DocSandboxRepository(prisma);
  const gate: PublicationGate = {
    planHash, validationReportKey: reportKey, outcome: 'edited',
    levels: [1, 2, 3, 4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: true, applicable: true })),
  };
  await repository.publishValidated(lease, gate);
  row.status = 'done';
  row.deleted_at = null;
  row.validation_report_key = reportKey;
  row.outcome = 'edited';
  await repository.publishValidated(lease, gate);
});

test('failAttempt writes evidence and returns the next status', async () => {
  const row = leasedJob();
  const prisma = client(row);
  const repository = new DocSandboxRepository(prisma);
  const report: ArtifactInput = {
    id: 'rep-1', kind: 'validation_report',
    storageKey: 'doc-sandbox/owner-1/job-1/v1/fail.sealed', filename: 'validation-report-attempt-1.json',
    mime: 'application/json', size: 8, sha256: 'd'.repeat(64),
  };
  const next = await repository.failAttempt(lease, 'E_VALIDATION', true, report);
  assert.ok(next === 'queued' || next === 'failed');
});

test('cancel, delete, cleanup journals and quota reconciliation execute their SQL paths', async () => {
  const row = leasedJob();
  const prisma = client(row);
  const repository = new DocSandboxRepository(prisma);
  await repository.cancelOwned('job-1', 'owner-1');
  await repository.deleteOwned('job-1', 'owner-1');
  const queued = client(dbJob({ status: 'queued', admission_ready: false }));
  await new DocSandboxRepository(queued).markInputsReadyOwned('job-1', 'owner-1');
  await repository.acknowledgeOutbox('evt-1');
  row.deleted_at = new Date();
  row.cleanup_not_before = null;
  row.cleanup_pending = true;
  row.provider_files = [{ fileId: 'file_abc', attempt: 1, deleted: true, failures: 0 }];
  row.storage_keys = [];
  prisma.artifacts[0]!.purged_at = new Date();
  assert.equal(await repository.finishCleanup('job-1'), true);
  await repository.markArtifactPurged('job-1', 'art-in');
  await repository.markStorageKeysPurged('job-1', ['doc-sandbox/owner-1/job-1/v1/late.sealed']);
  await repository.reserveCleanupStorageKeys('job-1', ['doc-sandbox/owner-1/job-1/v1/late.sealed']);
  assert.ok(Array.isArray(await repository.jobsNeedingCleanup(10)));
  assert.ok(Array.isArray(await repository.providerFilesForCleanup('job-1')));
  assert.equal(await repository.expireJobs(10), 0);
  assert.equal(await repository.recoverExpiredLeases(10), 0);
  assert.equal(await repository.recoverUndeliveredJobs(60_000, 10), 0);
  row.status = 'done';
  row.cost_reservations = [{ requestId: 'req-1', attempt: 1, reservedUsd: '0.01', actualUsd: '0.01', actualTokens: 4 }];
  prisma.users[0]!.apiUsage = 1000n;
  prisma.users[0]!.docQuotaEpoch = 1n;
  assert.equal(await repository.reconcileAccountQuota(10), 1);
  const pending = await repository.pendingOutbox(10, 'enqueue');
  assert.ok(Array.isArray(pending));
});

test('reserveCleanupStorageKeys rejects an empty or duplicated page', async () => {
  const repository = new DocSandboxRepository(client(dbJob({ deleted_at: new Date() })));
  await assert.rejects(repository.reserveCleanupStorageKeys('job-1', []),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_INVALID_INPUT');
  await assert.rejects(repository.reserveCleanupStorageKeys('job-1', ['a', 'a']),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_INVALID_INPUT');
});

test('claimAttempt returns null when admission is not ready', async () => {
  const row = dbJob({ admission_ready: false });
  const repository = new DocSandboxRepository(client(row));
  assert.equal(await repository.claimAttempt('job-1', 10_000), null);
});

test('reserveCost rejects a second identical request id as already reserved', async () => {
  const row = leasedJob();
  row.cost_reservations = [{ requestId: 'req-1', attempt: 1, reservedUsd: '0.01', actualUsd: null }];
  const repository = new DocSandboxRepository(client(row));
  assert.equal(await repository.reserveCost(lease, 'req-1', '0.01000000'), false);
});

test('getInternal throws when the job is absent', async () => {
  const prisma = client();
  prisma.$queryRaw = async () => [];
  await assert.rejects(new DocSandboxRepository(prisma).getInternal(randomUUID()),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_NOT_FOUND');
});

test('publishValidated accepts preserved originals and unchanged output gates', async () => {
  const planHash = 'c'.repeat(64);
  const reportKey = 'doc-sandbox/owner-1/job-1/v1/report.sealed';
  const outputKey = 'doc-sandbox/owner-1/job-1/v1/out.sealed';
  const row = leasedJob();
  row.status = 'validating';
  row.edit_plan_hash = planHash;
  row.edit_plan_key = 'doc-sandbox/owner-1/job-1/v1/plan.sealed';
  const artifacts = [
    artifactRow(),
    artifactRow({ id: 'art-out', kind: 'output', storage_key: outputKey, filename: 'informe.txt', sha256: 'a'.repeat(64), size: 8n }),
    artifactRow({ id: 'art-plan', kind: 'edit_plan', storage_key: row.edit_plan_key, sha256: planHash, filename: 'edit_plan.json' }),
    artifactRow({ id: 'art-recipe', kind: 'recipe', storage_key: 'doc-sandbox/owner-1/job-1/v1/recipe.sealed', filename: 'recipe.zip' }),
    artifactRow({ id: 'art-result', kind: 'agent_result', storage_key: 'doc-sandbox/owner-1/job-1/v1/result.sealed', filename: 'result.json' }),
    artifactRow({ id: 'art-report', kind: 'validation_report', storage_key: reportKey, filename: 'report.json' }),
    artifactRow({ id: 'art-diff', kind: 'text_diff', storage_key: 'doc-sandbox/owner-1/job-1/v1/diff.sealed', filename: 'text-diff.json' }),
  ];
  const preserved = client(row, { artifacts });
  const repository = new DocSandboxRepository(preserved);
  await repository.publishValidated(lease, {
    planHash, validationReportKey: reportKey, outcome: 'not_possible',
    preservedInputs: [{ inputId: 'art-in', outputStorageKey: outputKey, sha256: 'a'.repeat(64) }],
    levels: [1, 2, 3, 4].map(level => ({
      level: level as 1 | 2 | 3 | 4,
      passed: level === 1 || level === 4 ? true : false,
      applicable: level === 1 || level === 4,
      ...(level === 2 || level === 3 ? { reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' } : {}),
    })),
  });
  const unchanged = client({ ...row, outcome: null }, { artifacts });
  await new DocSandboxRepository(unchanged).publishValidated(lease, {
    planHash, validationReportKey: reportKey, outcome: 'unchanged',
    levels: [1, 2, 3, 4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: true, applicable: true })),
  });
});

test('failAttempt persists a reserved evidence batch and recoveries replay durable rows', async () => {
  const row = leasedJob();
  row.storage_keys.push('doc-sandbox/owner-1/job-1/v1/fail.sealed');
  const prisma = client(row);
  const repository = new DocSandboxRepository(prisma);
  const report: ArtifactInput = {
    id: 'rep-1', kind: 'validation_report',
    storageKey: 'doc-sandbox/owner-1/job-1/v1/fail.sealed', filename: 'validation-report-attempt-1.json',
    mime: 'application/json', size: 8, sha256: 'd'.repeat(64),
  };
  await repository.failAttempt(lease, 'E_VALIDATION', true, report, {
    artifacts: [],
    mode: { kind: 'single' },
  });
  const expired = client(dbJob({
    status: 'inspecting', attempts: 1, lease_expires_at: new Date(0), expires_at: new Date(Date.now() + 60_000),
  }));
  expired.$queryRaw = async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes('RETURNING event_seq')) {
      expired.job.event_seq = Number(expired.job.event_seq) + 1;
      return [{ event_seq: expired.job.event_seq }];
    }
    if (text.includes('lease_expires_at')) return [expired.job];
    if (text.includes('clock_timestamp() AS now')) return [{ now: new Date() }];
    if (text.includes('FROM doc_jobs')) return [expired.job];
    return [];
  };
  assert.equal(await new DocSandboxRepository(expired).recoverExpiredLeases(10), 1);
  const abandoned = client(dbJob({ admission_ready: false, created_at: new Date(0) }));
  abandoned.$queryRaw = async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes('RETURNING event_seq')) {
      abandoned.job.event_seq = Number(abandoned.job.event_seq) + 1;
      return [{ event_seq: abandoned.job.event_seq }];
    }
    if (text.includes('admission_ready=false')) return [abandoned.job];
    if (text.includes('FROM doc_jobs')) return [abandoned.job];
    return [];
  };
  assert.equal(await new DocSandboxRepository(abandoned).recoverAbandonedAdmissions(10), 1);
  const undelivered = client(dbJob({ status: 'queued', admission_ready: true }));
  undelivered.$queryRaw = async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes('RETURNING event_seq')) {
      undelivered.job.event_seq = Number(undelivered.job.event_seq) + 1;
      return [{ event_seq: undelivered.job.event_seq }];
    }
    if (text.includes('admission_ready=false')) return [];
    if (text.includes('admission_ready=true')) return [undelivered.job];
    if (text.includes('FROM doc_jobs')) return [undelivered.job];
    return [];
  };
  assert.equal(await new DocSandboxRepository(undelivered).recoverUndeliveredJobs(60_000, 10), 1);
});

test('finishCleanup retains containers and uncertain reservations instead of closing the tombstone', async () => {
  const retained = leasedJob();
  retained.deleted_at = new Date();
  retained.cleanup_pending = true;
  retained.storage_keys = [];
  retained.provider_files = [];
  retained.provider_containers = [{ id: 'ctr', attempt: 1, expiresAt: null, stage: 'plan' }];
  const first = client(retained);
  first.artifacts[0]!.purged_at = new Date();
  assert.equal(await new DocSandboxRepository(first).finishCleanup('job-1'), false);
  const uncertain = leasedJob();
  uncertain.deleted_at = new Date();
  uncertain.cleanup_pending = true;
  uncertain.storage_keys = [];
  uncertain.provider_files = [];
  uncertain.provider_containers = [];
  uncertain.cost_reservations = [{ requestId: 'req', attempt: 1, reservedUsd: '0.01', actualUsd: null }];
  const second = client(uncertain);
  second.artifacts[0]!.purged_at = new Date();
  assert.equal(await new DocSandboxRepository(second).finishCleanup('job-1'), false);
  await assert.rejects(new DocSandboxRepository(client(leasedJob())).reserveCleanupStorageKeys('job-1', ['nope']),
    (error: unknown) => error instanceof DocumentRepositoryError);
  await assert.rejects(new DocSandboxRepository(client(leasedJob())).markProviderFileDeleted('job-1', 'missing', true),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_NOT_FOUND');
  const grace = leasedJob();
  grace.cleanup_not_before = new Date(Date.now() + 60_000);
  await assert.rejects(new DocSandboxRepository(client(grace)).markArtifactPurged('job-1', 'art-in'),
    (error: unknown) => error instanceof DocumentRepositoryError && error.code === 'DOC_CLEANUP_PENDING');
  const expiring = client(dbJob({ expires_at: new Date(0) }));
  expiring.$queryRaw = async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes('RETURNING event_seq')) {
      expiring.job.event_seq = Number(expiring.job.event_seq) + 1;
      return [{ event_seq: expiring.job.event_seq }];
    }
    if (text.includes('expires_at<=')) return [{ id: expiring.job.id, user_id: expiring.job.user_id }];
    if (text.includes('FROM doc_jobs')) return [expiring.job];
    if (text.includes('FROM users')) return expiring.users;
    return [];
  };
  assert.equal(await new DocSandboxRepository(expiring).expireJobs(10), 1);
  assert.ok(Array.isArray(await new DocSandboxRepository(client(leasedJob())).pendingOutbox(10)));
  assert.deepEqual(await new DocSandboxRepository(client(dbJob({
    cleanup_not_before: new Date(Date.now() + 60_000),
    provider_files: [{ fileId: 'file', attempt: 1, deleted: false, failures: 0 }],
  }))).providerFilesForCleanup('job-1'), []);
});
