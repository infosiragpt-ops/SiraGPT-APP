import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { DocumentSandboxProcessor, type DocumentProcessorConfig } from '../src/modules/doc-sandbox/queue/processor';
import { DocSandboxRepository, DocumentRepositoryError, type AttemptLease } from '../src/modules/doc-sandbox/queue/repository';
import { createPrivateDocumentS3Client, PrivateDocumentStorage } from '../src/modules/doc-sandbox/storage/private-storage';
import { IndependentDocumentValidator, DocumentValidationError } from '../src/modules/doc-sandbox/validation';
import { DocSandboxError, publicError } from '../src/modules/doc-sandbox/types/errors';
import { emptyUsage } from '../src/modules/doc-sandbox/engine/cost';
import { sha256 } from '../src/modules/doc-sandbox/engine/artifacts';
import type { SandboxSession } from '../src/modules/doc-sandbox/engine/types';

// This suite exercises constructor/pure mapping/pre-IO guards, not process().
// Real clients are present (never connected); validation is NOT mocked. Private
// helpers are intentionally invoked with bracket access rather than adding a
// production-only export or substituting implementations just for coverage.
const db = new PrismaClient({ datasources: { db: {
  url: 'postgresql://synthetic:synthetic@127.0.0.1:1/doc_sandbox_unit?connect_timeout=1',
} } });
const client = createPrivateDocumentS3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1',
  credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, forcePathStyle: true });
after(async () => { client.destroy(); await db.$disconnect(); });
const dependencies = {
  repository: new DocSandboxRepository(db),
  storage: new PrivateDocumentStorage(client, { bucket: 'synthetic', key: Buffer.alloc(32, 1), keyId: 'v1', maxBytes: 64 }),
  validator: new IndependentDocumentValidator({ image: `sha256:${'a'.repeat(64)}` }),
  engineFactory: (): never => { throw new Error('Provider construction is outside this pre-IO unit suite'); },
};
const config: DocumentProcessorConfig = { maxTurns: 20, maxTokens: 1000, timeoutMs: 10_000 };
const processor = new DocumentSandboxProcessor(dependencies, config);
const lease: AttemptLease = { jobId: 'unit-job', token: 'unit-lease', fence: 1, attempt: 1 };
const session: SandboxSession = { id: 'unit-session', jobId: lease.jobId, userId: 'unit-owner', attempt: 1 };
const isCode = (expected: string) => (error: unknown): boolean => error instanceof DocSandboxError && error.code === expected;
const invalidRepositoryInput = (error: unknown): boolean =>
  error instanceof DocumentRepositoryError && error.code === 'DOC_INVALID_INPUT';

test('processor construction enforces bounded integer leases and positive finite budgets', () => {
  for (const leaseMs of [0, -1, 2999, 3000.1, 300_001, Infinity, NaN]) {
    assert.throws(() => new DocumentSandboxProcessor(dependencies, { ...config, leaseMs }), isCode('E_NOT_READY'));
  }
  for (const field of ['maxTurns', 'maxTokens', 'timeoutMs'] as const) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new DocumentSandboxProcessor(dependencies, { ...config, [field]: value }), isCode('E_NOT_READY'));
    }
  }
  for (const leaseMs of [undefined, 3000, 300_000]) {
    assert.ok(new DocumentSandboxProcessor(dependencies, { ...config, leaseMs }) instanceof DocumentSandboxProcessor);
  }
});

test('processor preserves already classified errors including their public status', () => {
  for (const [code, status] of [['E_PARAMS', 413], ['E_TIMEOUT', 408], ['E_QUOTA', 429], ['E_CANCELLED', 409]] as const) {
    const original = new DocSandboxError(code, status, { cause: new Error('synthetic private detail') });
    assert.equal(processor['normalize'](original), original);
    assert.equal(JSON.stringify(publicError(processor['normalize'](original))).includes('synthetic private detail'), false);
  }
});

test('processor distinguishes expired/fenced work, budget exhaustion and repository conflicts', () => {
  const cases: Array<[ConstructorParameters<typeof DocumentRepositoryError>[0], string, number]> = [
    ['DOC_BUDGET_EXCEEDED', 'E_QUOTA', 429], ['DOC_STALE_LEASE', 'E_CANCELLED', 409],
    ['DOC_DELETED', 'E_CANCELLED', 409], ['DOC_EXPIRED', 'E_CANCELLED', 409],
    ['DOC_NOT_FOUND', 'E_CONFLICT', 409], ['DOC_FORBIDDEN', 'E_CONFLICT', 409],
    ['DOC_CONFLICT', 'E_CONFLICT', 409], ['DOC_INVALID_TRANSITION', 'E_CONFLICT', 409],
    ['DOC_VALIDATION_GATE', 'E_CONFLICT', 409], ['DOC_INVALID_INPUT', 'E_CONFLICT', 409],
    ['DOC_CLEANUP_PENDING', 'E_CONFLICT', 409],
  ];
  for (const [source, code, status] of cases) {
    const result = processor['normalize'](new DocumentRepositoryError(source));
    assert.equal(result.code, code);
    assert.equal(result.status, status);
  }
});

test('processor separates unavailable/unsafe validator infrastructure from document validation failures', () => {
  const cases: Array<[string, string, number]> = [
    ['E_CANCELLED', 'E_CANCELLED', 409], ['VALIDATOR_TIMEOUT', 'E_TIMEOUT', 408],
    ['LIBREOFFICE_TIMEOUT', 'E_TIMEOUT', 408], ['VALIDATOR_UNAVAILABLE', 'E_NOT_READY', 503],
    ['VALIDATOR_RUNTIME_FAILED', 'E_NOT_READY', 503], ['VALIDATOR_IMAGE_UNPINNED', 'E_NOT_READY', 503],
    ['VALIDATOR_RUNTIME_UNSAFE', 'E_NOT_READY', 503], ['INPUT_HASH_OR_SIZE', 'E_VALIDATION', 422],
    ['OFFICE_PART_CHANGED', 'E_VALIDATION', 422], ['VALIDATOR_INVALID_RESPONSE', 'E_VALIDATION', 422],
  ];
  for (const [source, code, status] of cases) {
    const result = processor['normalize'](new DocumentValidationError(source, 'synthetic document content'));
    assert.equal(result.code, code);
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(publicError(result)).includes('synthetic document content'), false);
  }
});

test('unknown failures cannot inject provider text or masquerade as typed validation/cancellation', () => {
  for (const error of [new Error('synthetic secret'), { code: 'E_CANCELLED', message: 'synthetic secret' },
    { name: 'DocumentValidationError', code: 'INPUT_HASH_OR_SIZE' }, null, undefined, 0, 'synthetic secret']) {
    const result = processor['normalize'](error);
    assert.equal(result.code, 'E_PROVIDER');
    assert.equal(result.status, 500);
    assert.equal(JSON.stringify(publicError(result)).includes('synthetic secret'), false);
  }
});

test('processor refuses corrupted and oversized artifact bytes before reserving or uploading storage', async () => {
  const data = Buffer.from('synthetic'), before = Buffer.from(data);
  const artifact = { name: 'out.txt', kind: 'output' as const, data, mime: 'text/plain', sha256: '0'.repeat(64) };
  await assert.rejects(processor['persist'](lease, { userId: 'unit-owner', jobId: lease.jobId }, artifact), isCode('E_VALIDATION'));
  const large = Buffer.alloc(65, 1);
  await assert.rejects(processor['persist'](lease, { userId: 'unit-owner', jobId: lease.jobId },
    { ...artifact, data: large, sha256: sha256(large) }), isCode('E_PARAMS'));
  assert.deepEqual(data, before);
});

test('provider reservation callback rejects non-finite/negative money before ledger or provider access', async () => {
  const persistence = processor['enginePersistence'](lease, emptyUsage(), 0);
  for (const usd of [-1, NaN, Infinity, -Infinity]) {
    await assert.rejects(persistence.reserve(session, { requestId: 'request', usd }), isCode('E_QUOTA'));
    await assert.rejects(persistence.settle(session, { requestId: 'request', usage: { ...emptyUsage(), costUsd: usd }, uncertain: false }), isCode('E_QUOTA'));
  }
});

test('provider reference callbacks propagate real repository guards without swallowing invalid identities', async () => {
  const persistence = processor['enginePersistence'](lease, emptyUsage(), 0);
  for (const id of ['', 's'.repeat(501)]) {
    await assert.rejects(persistence.sessionCreated({ ...session, id }), invalidRepositoryInput);
  }
  for (const id of ['', '../another-owner/file', 'id\n', 'a'.repeat(201)]) {
    await assert.rejects(persistence.containerCreated(session, { id, stage: 'edit', expiresAt: null }), invalidRepositoryInput);
    await assert.rejects(persistence.fileChanged(session, { id, kind: 'output', state: 'known' }), invalidRepositoryInput);
  }
  await assert.rejects(persistence.containerCreated(session, {
    id: 'container_valid', stage: 'plan', expiresAt: 'not-a-date',
  }), invalidRepositoryInput);
});

test('valid-price provider callbacks still reject invalid request IDs and unsafe token totals before DB IO', async () => {
  const persistence = processor['enginePersistence'](lease, emptyUsage(), 0);
  // Finite positive charges exercise the real money conversion; the later
  // repository guard rejects the request before it can reserve any budget.
  for (const requestId of ['', '../another-request', 'a'.repeat(151)]) {
    await assert.rejects(persistence.reserve(session, { requestId, usd: 0.000000001 }), invalidRepositoryInput);
  }
  for (const tokenCount of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(persistence.settle(session, { requestId: 'request', uncertain: false,
      usage: { ...emptyUsage(), costUsd: 0.1, inputTokens: tokenCount } }), invalidRepositoryInput);
  }
  await assert.rejects(persistence.settle(session, { requestId: 'request', uncertain: false,
    usage: { ...emptyUsage(), costUsd: 0.1, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } }), invalidRepositoryInput);
});

test('processor event forwarding cannot inject lifecycle transitions or unsafe numeric metadata', async () => {
  await assert.rejects(processor['recordEvent'](lease, { type: 'status_changed',
    payload: { status: 'done', text: 'synthetic provider claim' } }), invalidRepositoryInput);
  for (const key of ['level', 'durationMs']) {
    await assert.rejects(processor['recordEvent'](lease, { type: 'validation_level',
      payload: { [key]: Number.MAX_VALUE } }), invalidRepositoryInput);
  }
  // This proves pre-IO rejection only, not correct SSE sanitization/delivery;
  // that positive path requires the real database-backed event stream.
});

test('uncertain or unknown-price settlement does not release its durable reservation', async () => {
  const persistence = processor['enginePersistence'](lease, emptyUsage(), 0);
  // Success here means the genuine repository was not called: no DB service
  // exists in this suite. It does not assert settlement persistence or billing.
  assert.equal(await persistence.settle(session, { requestId: 'unknown-request', usage: emptyUsage(), uncertain: true }), undefined);
  assert.equal(await persistence.settle(session, { requestId: 'unknown-request', usage: { ...emptyUsage(), costUsd: null, costExact: false }, uncertain: false }), undefined);
});
