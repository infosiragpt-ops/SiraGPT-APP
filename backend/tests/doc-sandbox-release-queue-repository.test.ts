import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { DocSandboxRepository, DocumentRepositoryError, type ArtifactInput, type AttemptLease,
  type CreateDocumentJob, type JsonObject, type PublicationGate } from '../src/modules/doc-sandbox/queue/repository';

// These are pre-IO unit guards, NOT persistence/transaction integration tests.
// The genuine Prisma client is never connected. Any unexpected DB operation
// fails this suite instead of getting a fabricated response from a DB mock.
const prisma = new PrismaClient({ datasources: { db: {
  url: 'postgresql://synthetic:synthetic@127.0.0.1:1/doc_sandbox_unit?connect_timeout=1',
} } });
const repository = new DocSandboxRepository(prisma);
after(() => prisma.$disconnect());
const invalid = (error: unknown): boolean => error instanceof DocumentRepositoryError && error.code === 'DOC_INVALID_INPUT';
const lease: AttemptLease = { jobId: 'synthetic-job', token: 'synthetic-lease', fence: 1, attempt: 1 };
const artifact: ArtifactInput = { kind: 'input', storageKey: 'private/source', filename: 'source.txt', mime: 'text/plain', size: 8, sha256: 'a'.repeat(64) };
const admission = (): CreateDocumentJob => ({ userId: 'synthetic-owner', idempotencyKey: 'request-one',
  payloadHash: 'a'.repeat(64), instructionsKey: 'private/instructions', inputs: [{ ...artifact }],
  modelTier: 'mechanical', requestedModel: 'synthetic-model', maxTokens: 1000,
  promptVersion: 'test-v1', expiresAt: new Date(Date.now() + 3600_000), maxCostUsd: '1.00000000' });

test('repository rejects invalid token and requested-model admission before DB IO', async () => {
  for (const maxTokens of [0, -1, 1.5, 500_001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(repository.createJob({ ...admission(), maxTokens }), invalid);
  }
  for (const requestedModel of ['', 'm'.repeat(201)]) {
    await assert.rejects(repository.createJob({ ...admission(), requestedModel }), invalid);
  }
});

test('repository rejects absent scope, malformed identity/hash, expired admission and file-count limits', async () => {
  const cases: Partial<CreateDocumentJob>[] = [
    { userId: '' }, { idempotencyKey: '' }, { idempotencyKey: 'k'.repeat(201) },
    { payloadHash: 'A'.repeat(64) }, { payloadHash: 'a'.repeat(63) }, { instructionsKey: '' },
    { expiresAt: new Date(0) }, { expiresAt: new Date(NaN) }, { inputs: [] },
    { inputs: Array.from({ length: 11 }, () => ({ ...artifact })) },
  ];
  for (const change of cases) await assert.rejects(repository.createJob({ ...admission(), ...change }), invalid);
});

test('repository validates every original metadata field and rejects pre-published artifact kinds', async () => {
  const cases: Partial<ArtifactInput>[] = [
    { storageKey: '' }, { filename: '' }, { mime: '' }, { sha256: 'bad' },
    { size: -1 }, { size: NaN }, { size: Infinity }, { size: 1.25 }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'output' }, { kind: 'validation_report' },
  ];
  for (const change of cases) {
    await assert.rejects(repository.createJob({ ...admission(), inputs: [{ ...artifact, ...change }] }), invalid);
  }
});

test('repository money syntax rejects negative, exponent, non-finite and over-precision across all ledger entry points', async () => {
  for (const money of ['', '-1', 'NaN', 'Infinity', '1e2', ' 1', '1 ', '.5', '1.', '0.000000001', '10000000000']) {
    await assert.rejects(repository.createJob({ ...admission(), maxCostUsd: money }), invalid);
    await assert.rejects(repository.recordUsage(lease, {}, money), invalid);
    await assert.rejects(repository.reserveCost(lease, 'request', money), invalid);
    await assert.rejects(repository.settleCost(lease, 'request', money, 0), invalid);
  }
});

test('repository rejects invalid lease durations and undelivered recovery ages before IO', async () => {
  for (const duration of [0, -1, 999, 1000.5, 300_001, NaN, Infinity]) {
    await assert.rejects(repository.claimAttempt(lease.jobId, duration), invalid);
    await assert.rejects(repository.heartbeat(lease, duration), invalid);
  }
  for (const age of [0, -1, 999, 1000.5, NaN, Infinity]) {
    await assert.rejects(repository.recoverUndeliveredJobs(age), invalid);
  }
});

test('public event guard excludes raw content, unknown fields, unsafe codes and malformed numeric metadata', async () => {
  for (const type of ['', 'status_changed', 'raw_response', 'deleted', 'enqueue']) {
    await assert.rejects(repository.appendEvent(lease, type, {}), invalid);
  }
  const payloads: JsonObject[] = [
    { text: 'synthetic private content' }, { instructions: 'synthetic' }, { provider: 'synthetic' },
    { phase: 'unknown' }, { phase: 1 }, { passed: 'true' }, { code: 'private message' },
    { code: 'A' }, { code: 'A'.repeat(81) }, { code: 'E_BAD\n' },
    { level: -1 }, { attempt: 1.5 }, { progress: NaN }, { durationMs: Infinity },
    { inputTokens: '1' }, { outputTokens: Number.MAX_SAFE_INTEGER + 1 }, { nested: { code: 'E_OK' } },
  ];
  for (const payload of payloads) await assert.rejects(repository.appendEvent(lease, 'warning', payload), invalid);
});

test('allowed event metadata cannot hide a later private field in the same public event', async () => {
  for (const phase of ['inspecting', 'planning', 'editing', 'validating', 'cleanup', 'uploading', 'downloading']) {
    const payload: JsonObject = { code: 'E_VALIDATION', phase, passed: false, level: 1, attempt: 0,
      progress: 0, durationMs: Number.MAX_SAFE_INTEGER, inputTokens: 0, outputTokens: 1,
      text: 'synthetic private document text' };
    const original = structuredClone(payload);
    await assert.rejects(repository.appendEvent(lease, 'validation_level', payload), invalid);
    assert.deepEqual(payload, original);
  }
  // Rejection of the complete event is the assertion; this does not claim that
  // permitted metadata alone was committed or delivered by SSE.
});

test('batch guards inspect later entries before any admission or cleanup-reservation write', async () => {
  await assert.rejects(repository.createJob({ ...admission(),
    inputs: [{ ...artifact }, { ...artifact, storageKey: 'private/second', sha256: 'invalid' }] }), invalid);
  await assert.rejects(repository.registerArtifacts(lease, [{ ...artifact, kind: 'output' }, { ...artifact }]), invalid);
  await assert.rejects(repository.reserveStorageKeys(lease, ['private/first', '']), invalid);
  await assert.rejects(repository.recordProviderFiles(lease, ['file_valid', '../another-owner/file']), invalid);
});

test('low-level artifact insertion rechecks metadata for both output and failure-report writes', async () => {
  // Exercise the real private guard with a genuine, disconnected Prisma client.
  // Invalid inputs must fail before INSERT; no fake transaction or artifact is
  // used to represent a successful publication/validation.
  for (const kind of ['output', 'validation_report'] as const) {
    for (const change of [{ sha256: 'invalid' }, { size: -1 }, { filename: '' }, { mime: '' }]) {
      const candidate = { ...artifact, kind, ...change };
      const original = structuredClone(candidate);
      await assert.rejects(repository['insertArtifact'](prisma, lease.jobId, lease.attempt, candidate, true), invalid);
      assert.deepEqual(candidate, original);
    }
  }
});

test('repository rejects invalid plan, storage reservation and session identities before DB IO', async () => {
  await assert.rejects(repository.freezePlan(lease, '', 'a'.repeat(64)), invalid);
  await assert.rejects(repository.freezePlan(lease, 'private/plan', 'not-a-hash'), invalid);
  for (const keys of [[], [''], ['x'.repeat(1501)]]) await assert.rejects(repository.reserveStorageKeys(lease, keys), invalid);
  for (const session of ['', 'x'.repeat(501)]) await assert.rejects(repository.recordSession(lease, session), invalid);
  for (const key of ['', 'x'.repeat(201)]) await assert.rejects(repository.getByIdempotencyKeyOwned(key, 'owner'), invalid);
  await assert.rejects(repository.getByIdempotencyKeyOwned('valid', ''), invalid);
  await assert.rejects(repository.registerArtifacts(lease, [artifact]), invalid);
  // An empty cleanup key list is a true no-op; it must not need a live database.
  assert.equal(await repository.markStorageKeysPurged(lease.jobId, []), undefined);
});

test('provider cleanup references and cost request IDs cannot contain paths or exceed bounds', async () => {
  for (const id of ['', '../other', 'file/id', 'id\n', 'a'.repeat(201)]) {
    await assert.rejects(repository.recordProviderFiles(lease, [id]), invalid);
    await assert.rejects(repository.recordContainer(lease, { id, stage: 'edit', expiresAt: null }), invalid);
  }
  await assert.rejects(repository.recordContainer(lease, { id: 'valid', stage: 'plan', expiresAt: 'not-a-date' }), invalid);
  for (const id of ['', '../other', 'x'.repeat(151)]) await assert.rejects(repository.reserveCost(lease, id, '0.1'), invalid);
  for (const tokens of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(repository.settleCost(lease, 'request', '0.1', tokens), invalid);
  }
});

test('failure metadata rejects raw exception messages and non-report artifacts', async () => {
  for (const code of ['', 'private exception', 'E\n', 'E'.repeat(81)]) {
    await assert.rejects(repository.failAttempt(lease, code, false), invalid);
  }
  await assert.rejects(repository.failAttempt(lease, 'E_VALIDATION', true, { ...artifact, kind: 'output' }), invalid);
});

test('publication preflight rejects incomplete/duplicate/failed levels without trusting synthetic claims', async () => {
  // Deliberately invalid gate values only. No fabricated "passing validation"
  // is allowed to reach DB publication or stand in for a real validator report.
  const base: PublicationGate = { planHash: 'a'.repeat(64), validationReportKey: 'private/report', outcome: 'edited', levels: [] };
  const gates: PublicationGate[] = [base, { ...base, planHash: 'bad' }, { ...base, validationReportKey: '' },
    { ...base, levels: Array.from({ length: 4 }, () => ({ level: 1 as const, passed: true, applicable: true })) },
    { ...base, levels: [1, 2, 3, 4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: false, applicable: true })) },
    { ...base, levels: [1, 2, 3, 4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: false, applicable: false, reasonCode: 'UNKNOWN' })) },
  ];
  for (const gate of gates) {
    await assert.rejects(repository.publishValidated(lease, gate), (error: unknown) =>
      error instanceof DocumentRepositoryError && error.code === 'DOC_VALIDATION_GATE');
  }
});

test('plain-text exceptions cannot excuse structural or content validation, or an applicable failure', async () => {
  for (const rejectedLevel of [1, 2, 3, 4] as const) {
    const gate: PublicationGate = { planHash: 'a'.repeat(64), validationReportKey: 'private/report', outcome: 'unchanged',
      levels: ([1, 2, 3, 4] as const).map(level => ({ level,
        passed: level !== rejectedLevel,
        applicable: level === rejectedLevel ? (level === 2 || level === 3) : true,
        reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' })) };
    // Levels 1/4 may never be waived. Levels 2/3 here are explicitly applicable
    // and failed, so adding the exception's name must not make them pass either.
    await assert.rejects(repository.publishValidated(lease, gate), (error: unknown) =>
      error instanceof DocumentRepositoryError && error.code === 'DOC_VALIDATION_GATE');
  }
});
