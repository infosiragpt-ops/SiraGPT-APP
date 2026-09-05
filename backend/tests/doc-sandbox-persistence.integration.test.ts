import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import { DocSandboxRepository, type ArtifactInput, type ArtifactKind, type AttemptLease, type PublicationGate } from '../src/modules/doc-sandbox/queue/repository';
import { createDocumentModelPolicy } from '../src/modules/doc-sandbox/model-policy';
import type { AnthropicEngineConfig } from '../src/modules/doc-sandbox/engine/types';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import { createDocumentModelCatalogFixture } from './doc-sandbox-model-catalog-fixture';

// Required integration suite: absence of an isolated real Postgres is a failure, never a green skip.
const rawUrl = process.env.DOC_SANDBOX_TEST_DATABASE_URL;
assert.ok(rawUrl, 'DOC_SANDBOX_TEST_DATABASE_URL is required (real isolated Postgres); this suite does not mock persistence');
const url = new URL(rawUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]', 'doc-sandbox-test-postgres'].includes(url.hostname), 'Persistence tests only operate on loopback or the explicitly named isolated Postgres test service');
const schemaName = `doc_sandbox_test_${randomUUID().replaceAll('-', '')}`;
url.searchParams.set('schema', schemaName);
url.searchParams.set('connection_limit', '15');
const admin = new PrismaClient({ datasources: { db: { url: rawUrl } } });
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const repo = new DocSandboxRepository(db);
const owner = 'doc-fixture-owner';
const other = 'doc-fixture-other';
const hash = 'a'.repeat(64);
const changedHash = 'b'.repeat(64);
const migrationPath = resolve(__dirname, '../prisma/migrations/20260905000000_doc_sandbox_core/migration.sql');
let initialized = false;
const errorCode = (code: string) => (error: unknown): boolean => error instanceof Error && error.message === code;
function artifact(kind: ArtifactKind, prefix: string = randomUUID(), name = 'tesis.docx'): ArtifactInput {
  return { kind, storageKey: `private-fixture/${prefix}/${kind}`, filename: name, mime: kind === 'input' || kind === 'output' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/json', size: 500, sha256: hash };
}
async function create(options: { userId?: string; idempotencyKey?: string; maxCostUsd?: string; filename?: string; mime?: string; ready?: boolean } = {}) {
  const input = artifact('input');
  if (options.filename) input.filename = options.filename;
  if (options.mime) input.mime = options.mime;
  return repo.createJob({ userId: options.userId ?? owner, idempotencyKey: options.idempotencyKey ?? randomUUID(), payloadHash: hash, instructionsKey: `private-fixture/${randomUUID()}/instructions`, inputs: [input], modelTier: 'mechanical', promptVersion: 'editor-test-v1', expiresAt: new Date(Date.now() + 86400_000), maxCostUsd: options.maxCostUsd ?? '5', ready: options.ready ?? true });
}
async function advanceToValidation(id: string): Promise<AttemptLease> {
  const lease = await repo.claimAttempt(id, 60_000);
  assert.ok(lease);
  await repo.transition(lease, 'planning');
  await repo.freezePlan(lease, `private-fixture/${id}/plan`, hash);
  await repo.transition(lease, 'editing');
  await repo.transition(lease, 'validating');
  return lease;
}
async function stage(lease: AttemptLease): Promise<PublicationGate> {
  const kinds: ArtifactKind[] = ['output', 'edit_plan', 'recipe', 'agent_result', 'validation_report', 'text_diff'];
  const files = kinds.map(kind => artifact(kind, lease.jobId));
  await repo.registerArtifacts(lease, files);
  return { planHash: hash, outcome: 'edited', validationReportKey: files.find(f => f.kind === 'validation_report')!.storageKey, levels: [1,2,3,4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: true, applicable: true })) };
}
before(async () => {
  // Identifier is generated locally and validated, never user input. No public tables are touched.
  assert.match(schemaName, /^doc_sandbox_test_[a-f0-9]{32}$/);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
  initialized = true;
  // Minimal real owner relation for a focused migration test; full application migration is a separate gate.
  await db.$executeRaw(Prisma.sql`CREATE TABLE users(id TEXT PRIMARY KEY)`);
  await createDocumentModelCatalogFixture(db);
  for (const statement of readFileSync(migrationPath, 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  await db.$executeRaw(Prisma.sql`INSERT INTO users(id) VALUES(${owner}),(${other})`);
});
after(async () => {
  await db.$disconnect();
  // Destruction is restricted to the validated, newly-created test schema.
  if (initialized) await admin.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
  await admin.$disconnect();
});

const catalogModels = { mechanical: { id: 'fixture-mechanical' }, academic: { id: 'fixture-academic' } } as AnthropicEngineConfig['models'];
test('real catalog supports Prisma implicit primary identity and exact selected model admission', async () => {
  const row = await db.aiModel.findUnique({ where: { name: 'fixture-mechanical' },
    select: { name: true, isActive: true, type: true, provider: true } });
  assert.deepEqual(row, { name: 'fixture-mechanical', isActive: true, type: 'TEXT', provider: 'anthropic' });
  const identity = await db.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`SELECT id,name FROM ai_models WHERE name='fixture-mechanical'`);
  assert.deepEqual(identity, [{ id: 'fixture-mechanical-id', name: 'fixture-mechanical' }]);
  const policy = createDocumentModelPolicy(catalogModels, db, (_name, plan) => plan === 'PRO');
  assert.equal(await policy('fixture-mechanical', 'PRO'), 'mechanical');
  assert.equal(await policy('fixture-academic', 'PRO'), 'academic');
  assert.equal(await policy('fixture-academic', 'FREE'), null);
  assert.equal(await policy('anthropic/fixture-mechanical', 'PRO'), null);
});

test('real catalog deactivation and provider/type changes immediately revoke document admission', async () => {
  const policy = createDocumentModelPolicy(catalogModels, db, () => true);
  try {
    await db.$executeRaw(Prisma.sql`UPDATE ai_models SET "isActive"=false WHERE name='fixture-mechanical'`);
    assert.equal(await policy('fixture-mechanical', 'PRO'), null);
    await db.$executeRaw(Prisma.sql`UPDATE ai_models SET "isActive"=true,provider='OpenRouter' WHERE name='fixture-mechanical'`);
    assert.equal(await policy('fixture-mechanical', 'PRO'), null);
    await db.$executeRaw(Prisma.sql`UPDATE ai_models SET provider='anthropic',type='IMAGE' WHERE name='fixture-mechanical'`);
    assert.equal(await policy('fixture-mechanical', 'PRO'), null);
  } finally {
    await db.$executeRaw(Prisma.sql`UPDATE ai_models SET "isActive"=true,provider='anthropic',type='TEXT' WHERE name='fixture-mechanical'`);
  }
  assert.equal(await policy('fixture-mechanical', 'PRO'), 'mechanical');
});

test('a real missing catalog identity fails closed as not ready without exposing Prisma details', async () => {
  // Reproduce the exact former fixture defect in this disposable schema only.
  await db.$executeRaw(Prisma.sql`ALTER TABLE ai_models RENAME COLUMN id TO fixture_hidden_id`);
  try {
    await assert.rejects(db.aiModel.findUnique({ where: { name: 'fixture-mechanical' },
      select: { name: true, isActive: true, type: true, provider: true } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2022');
    await assert.rejects(createDocumentModelPolicy(catalogModels, db, () => true)('fixture-mechanical', 'PRO'),
      (error: unknown) => error instanceof DocSandboxError && error.code === 'E_NOT_READY' && error.status === 503 &&
        !error.message.includes('ai_models') && !error.message.includes('Prisma'));
  } finally {
    await db.$executeRaw(Prisma.sql`ALTER TABLE ai_models RENAME COLUMN fixture_hidden_id TO id`);
  }
  assert.equal(await createDocumentModelPolicy(catalogModels, db, () => true)('fixture-mechanical', 'PRO'), 'mechanical');
});

test('admission is atomic and idempotent under ten concurrent real DB requests', async () => {
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 10 }, () => create({ idempotencyKey: key })));
  assert.equal(new Set(results.map(r => r.job.id)).size, 1);
  assert.equal(results.filter(r => r.created).length, 1);
  const id = results[0]!.job.id;
  assert.equal((await repo.artifactsInternal(id)).length, 1);
  const events = await repo.listEventsOwned(id, owner);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.seq, 1);
  assert.equal(events[0]!.outbox, 'enqueue');
  const pending = await repo.pendingOutbox();
  assert.ok(pending.some(e => e.jobId === id));
  await repo.acknowledgeOutbox(events[0]!.id);
  assert.ok(!(await repo.pendingOutbox()).some(e => e.id === events[0]!.id));
  await assert.rejects(repo.createJob({ userId: owner, idempotencyKey: key, payloadHash: changedHash, instructionsKey: 'different-encrypted-object', inputs: [artifact('input')], modelTier: 'mechanical', promptVersion: 'v1', expiresAt: new Date(Date.now() + 100000) }), errorCode('DOC_CONFLICT'));
});

test('crashed unready admission is tombstoned after grace and late upload acknowledgement cannot resurrect it', async () => {
  const stale = await create({ ready: false });
  const fresh = await create({ ready: false });
  const completedUpload = await create({ ready: true });
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET created_at=clock_timestamp()-interval '16 minutes' WHERE id IN (${stale.job.id},${completedUpload.job.id})`);
  await Promise.all([repo.recoverUndeliveredJobs(), new DocSandboxRepository(db).recoverUndeliveredJobs()]);
  const dead = await repo.getInternal(stale.job.id);
  assert.equal(dead.status, 'cancelled'); assert.ok(dead.deletedAt);
  assert.equal(dead.cleanupPending, true); assert.equal(dead.errorCode, 'DOC_ADMISSION_ABANDONED');
  assert.deepEqual(dead.inputKeys, stale.job.inputKeys);
  assert.equal(dead.instructionsKey, stale.job.instructionsKey);
  await assert.rejects(repo.markInputsReadyOwned(dead.id, owner));
  assert.equal(await repo.claimAttempt(dead.id, 60_000), null);
  const outbox = await repo.pendingOutbox(500);
  assert.equal(outbox.filter(event => event.jobId === dead.id && event.outbox === 'cleanup').length, 1);
  assert.equal(outbox.filter(event => event.jobId === dead.id && event.outbox === 'enqueue').length, 0);
  assert.equal((await repo.getOwned(fresh.job.id, owner)).admissionReady, false);
  assert.equal((await repo.getOwned(completedUpload.job.id, owner)).status, 'queued');
});

test('real foreign key rejects nonexistent owner', async () => {
  await assert.rejects(create({ userId: 'missing-owner' }));
});

test('unready admission reserves all original keys without enqueue or claiming until upload acknowledgement', async () => {
  const { job } = await create({ ready: false });
  assert.equal(job.admissionReady, false);
  assert.equal(job.storageKeys.length, 2);
  assert.equal(await repo.claimAttempt(job.id, 60_000), null);
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=${job.id}`);
  await repo.recoverUndeliveredJobs(1000);
  assert.ok(!(await repo.pendingOutbox(500, 'enqueue')).some(e => e.jobId === job.id));
  await assert.rejects(repo.markInputsReadyOwned(job.id, other), errorCode('DOC_FORBIDDEN'));
  await repo.markInputsReadyOwned(job.id, owner);
  await repo.markInputsReadyOwned(job.id, owner);
  assert.equal((await repo.pendingOutbox(500, 'enqueue')).filter(e => e.jobId === job.id).length, 1);
  assert.ok(await repo.claimAttempt(job.id, 60_000));
});

test('an acknowledged job lost from Redis is re-delivered from Postgres without duplicate pending events', async () => {
  const { job } = await create();
  const event = (await repo.pendingOutbox(500, 'enqueue')).find(e => e.jobId === job.id)!;
  await repo.acknowledgeOutbox(event.id);
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=${job.id}`);
  assert.ok(await repo.recoverUndeliveredJobs(1000) >= 1);
  const pending = (await repo.pendingOutbox(500, 'enqueue')).filter(e => e.jobId === job.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.type, 'delivery_recovered');
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=${job.id}`);
  await repo.recoverUndeliveredJobs(1000);
  assert.equal((await repo.pendingOutbox(500, 'enqueue')).filter(e => e.jobId === job.id).length, 1);
});

test('owner checks apply to job, artifacts, events, cancel and delete', async () => {
  const { job } = await create();
  for (const action of [() => repo.getOwned(job.id, other), () => repo.artifactsOwned(job.id, other), () => repo.listEventsOwned(job.id, other), () => repo.cancelOwned(job.id, other), () => repo.deleteOwned(job.id, other)]) await assert.rejects(action(), errorCode('DOC_FORBIDDEN'));
  assert.equal((await repo.getOwned(job.id, owner)).status, 'queued');
});

test('lost admission recovery is scoped by owner and rejects deleted/expired jobs', async () => {
  const key = randomUUID();
  const { job } = await create({ idempotencyKey: key });
  assert.equal((await repo.getByIdempotencyKeyOwned(key, owner)).id, job.id);
  assert.equal((await repo.getByIdempotencyKeyOwned(key, owner)).outcome, null);
  await assert.rejects(repo.getByIdempotencyKeyOwned(key, other), errorCode('DOC_NOT_FOUND'));
  await assert.rejects(repo.getByIdempotencyKeyOwned(randomUUID(), owner), errorCode('DOC_NOT_FOUND'));
  await repo.deleteOwned(job.id, owner);
  await assert.rejects(repo.getByIdempotencyKeyOwned(key, owner), errorCode('DOC_DELETED'));
  const expiredKey = randomUUID();
  const expired = await create({ idempotencyKey: expiredKey });
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired.job.id}`);
  await assert.rejects(repo.getByIdempotencyKeyOwned(expiredKey, owner), errorCode('DOC_EXPIRED'));
});

test('DB preservation gate requires every original metadata hash and publishes done/outcome/warning atomically', async () => {
  // This exercises the SQL publication contract, not a document validator. Real
  // scanned-PDF validation is a separate non-mocked tool suite.
  const inputs = [artifact('input', randomUUID(), 'first.pdf'), artifact('input', randomUUID(), 'second.pdf')]
    .map((entry, index) => ({ ...entry, mime: 'application/pdf', sha256: index ? changedHash : hash }));
  const { job } = await repo.createJob({ userId: owner, idempotencyKey: randomUUID(), payloadHash: hash,
    instructionsKey: `private-fixture/${randomUUID()}/instructions`, inputs, modelTier: 'mechanical',
    promptVersion: 'editor-test-v1', expiresAt: new Date(Date.now() + 86400_000), maxCostUsd: '5', ready: true });
  const originals = await repo.artifactsInternal(job.id);
  const lease = await repo.claimAttempt(job.id, 60_000); assert.ok(lease);
  await repo.transition(lease, 'planning');
  await assert.rejects(repo.transition(lease, 'validating'), errorCode('DOC_VALIDATION_GATE'));
  await repo.freezePlan(lease, `private-fixture/${job.id}/edit_plan`, hash);
  await repo.transition(lease, 'validating');
  const outputs = originals.map((original, index) => ({ kind: 'output' as const, storageKey: `private-fixture/${job.id}/output-${index}`,
    filename: original.filename, mime: original.mime, size: original.size, sha256: original.sha256 }));
  const evidence = (['edit_plan','recipe','agent_result','validation_report','text_diff'] as const).map(kind => artifact(kind, job.id));
  await repo.registerArtifacts(lease, [...outputs, ...evidence]);
  const gate: PublicationGate = { planHash: hash, outcome: 'not_possible',
    validationReportKey: evidence.find(entry => entry.kind === 'validation_report')!.storageKey,
    levels: [1,2,3,4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: true, applicable: true })),
    preservedInputs: originals.map((original, index) => ({ inputId: original.id, outputStorageKey: outputs[index]!.storageKey, sha256: original.sha256 })) };
  await assert.rejects(repo.publishValidated(lease, { ...gate, preservedInputs: undefined }), errorCode('DOC_VALIDATION_GATE'));
  await assert.rejects(repo.publishValidated(lease, { ...gate, preservedInputs: gate.preservedInputs!.slice(0, 1) }), errorCode('DOC_VALIDATION_GATE'));
  await assert.rejects(repo.publishValidated(lease, { ...gate, preservedInputs: [gate.preservedInputs![0]!, gate.preservedInputs![0]!] }), errorCode('DOC_VALIDATION_GATE'));
  await assert.rejects(repo.publishValidated(lease, { ...gate, preservedInputs: gate.preservedInputs!.map(item => ({ ...item, sha256: hash })) }), errorCode('DOC_VALIDATION_GATE'));
  await assert.rejects(repo.publishValidated(lease, { ...gate, levels: gate.levels.map(level => ({ ...level, passed: level.level !== 3 })) }), errorCode('DOC_VALIDATION_GATE'));
  assert.equal((await repo.getOwned(job.id, owner)).outcome, null);
  assert.deepEqual(await repo.artifactsOwned(job.id, owner), []);
  assert.equal((await repo.listEventsOwned(job.id, owner)).some(event => event.payload.code === 'E_NOT_POSSIBLE'), false);
  await Promise.all([repo.publishValidated(lease, gate), repo.publishValidated(lease, gate)]);
  const published = await repo.getOwned(job.id, owner);
  assert.equal(published.status, 'done'); assert.equal(published.outcome, 'not_possible'); assert.equal(published.errorCode, null);
  assert.equal(published.outputKeys.length, 2); assert.equal(published.editPlanHash, hash);
  const events = await repo.listEventsOwned(job.id, owner);
  assert.equal(events.filter(event => event.payload.code === 'E_NOT_POSSIBLE').length, 1);
  assert.equal(events.filter(event => event.payload.status === 'done' && event.payload.outcome === 'not_possible').length, 1);
  await assert.rejects(repo.publishValidated(lease, { ...gate, outcome: 'edited' }), errorCode('DOC_STALE_LEASE'));
  await repo.deleteOwned(job.id, owner);
  await assert.rejects(repo.getOwned(job.id, owner), errorCode('DOC_DELETED'));
});

test('DB cannot mark done without an explicit outcome, or report unchanged after a changed hash', async () => {
  const { job } = await create();
  await assert.rejects(db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status='done',edit_plan_hash=${hash},validation_report_key='report' WHERE id=${job.id}`));
  const lease = await advanceToValidation(job.id);
  const gate = await stage(lease);
  await db.$executeRaw(Prisma.sql`UPDATE doc_job_artifacts SET sha256=${changedHash} WHERE job_id=${job.id} AND kind='output'`);
  await assert.rejects(repo.publishValidated(lease, { ...gate, outcome: 'unchanged' }), errorCode('DOC_VALIDATION_GATE'));
  await db.$executeRaw(Prisma.sql`UPDATE doc_job_artifacts SET sha256=${hash} WHERE job_id=${job.id} AND kind='output'`);
  await repo.publishValidated(lease, { ...gate, outcome: 'unchanged' });
  assert.equal((await repo.getOwned(job.id, owner)).outcome, 'unchanged');
});

test('one DB lease wins concurrent delivery and normal transitions require a frozen plan', async () => {
  const { job } = await create();
  const leases = await Promise.all(Array.from({ length: 10 }, () => repo.claimAttempt(job.id, 60_000)));
  assert.equal(leases.filter(Boolean).length, 1);
  const lease = leases.find((v): v is AttemptLease => v !== null)!;
  await assert.rejects(repo.transition(lease, 'validating'), errorCode('DOC_INVALID_TRANSITION'));
  await repo.transition(lease, 'planning');
  await assert.rejects(repo.transition(lease, 'editing'), errorCode('DOC_VALIDATION_GATE'));
  await repo.freezePlan(lease, 'encrypted-plan-key', hash);
  await assert.rejects(repo.freezePlan(lease, 'malicious-new-plan', changedHash), errorCode('DOC_CONFLICT'));
  await repo.transition(lease, 'editing');
  await repo.heartbeat(lease, 60_000);
  assert.equal((await repo.getInternal(job.id)).attempts, 1);
});

test('publication is one atomic terminal event with all required private artifacts', async () => {
  const { job } = await create();
  const lease = await advanceToValidation(job.id);
  const gate = await stage(lease);
  assert.equal((await repo.artifactsOwned(job.id, owner)).length, 0);
  await assert.rejects(repo.publishValidated(lease, { ...gate, levels: gate.levels.slice(0, 3) }), errorCode('DOC_VALIDATION_GATE'));
  await assert.rejects(repo.publishValidated(lease, { ...gate, planHash: changedHash }), errorCode('DOC_VALIDATION_GATE'));
  await assert.rejects(repo.publishValidated(lease, { ...gate, levels: gate.levels.map(l => ({ ...l, passed: l.level !== 3 })) }), errorCode('DOC_VALIDATION_GATE'));
  await Promise.all([repo.publishValidated(lease, gate), repo.publishValidated(lease, gate)]);
  assert.equal((await repo.getOwned(job.id, owner)).status, 'done');
  assert.equal((await repo.artifactsOwned(job.id, owner)).filter(a => a.kind === 'output').length, 1);
  const events = await repo.listEventsOwned(job.id, owner);
  assert.equal(events.filter(e => e.payload.status === 'done').length, 1);
  assert.deepEqual(events.map(e => e.seq), events.map((_, index) => index + 1));
  assert.deepEqual((await repo.listEventsOwned(job.id, owner, 2)).map(e => e.seq), events.filter(e => e.seq > 2).map(e => e.seq));
});

test('validation cannot be declared non-applicable for Office or any structural/textual check', async () => {
  const { job } = await create();
  const lease = await advanceToValidation(job.id);
  const gate = await stage(lease);
  await assert.rejects(repo.publishValidated(lease, { ...gate, levels: gate.levels.map(l => ({ ...l, applicable: l.level !== 3, reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' })) }), errorCode('DOC_VALIDATION_GATE'));
  await assert.rejects(repo.publishValidated(lease, { ...gate, levels: gate.levels.map(l => ({ ...l, applicable: l.level !== 1, reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' })) }), errorCode('DOC_VALIDATION_GATE'));
});

test('missing output or report never publishes an artifact', async () => {
  const { job } = await create();
  const lease = await advanceToValidation(job.id);
  await repo.registerArtifacts(lease, [artifact('output', job.id)]);
  await assert.rejects(repo.publishValidated(lease, { planHash: hash, outcome: 'edited', validationReportKey: 'absent-report', levels: [1,2,3,4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: true, applicable: true })) }), errorCode('DOC_VALIDATION_GATE'));
  assert.equal((await repo.artifactsOwned(job.id, owner)).length, 0);
});

test('cancel wins against a stale worker and remote IDs arriving later remain cleanup-only', async () => {
  const { job } = await create();
  const lease = await advanceToValidation(job.id);
  const gate = await stage(lease);
  await repo.cancelOwned(job.id, owner);
  await repo.cancelOwned(job.id, owner);
  await assert.rejects(repo.publishValidated(lease, gate), errorCode('DOC_STALE_LEASE'));
  await assert.rejects(repo.heartbeat(lease, 60_000), errorCode('DOC_STALE_LEASE'));
  await repo.recordProviderFiles(lease, ['file_late_upload']);
  const snapshot = await repo.getInternal(job.id);
  assert.equal(snapshot.status, 'cancelled');
  assert.equal(snapshot.providerFiles.length, 1);
  assert.equal(snapshot.providerFiles[0]!.deleted, false);
  assert.equal((await repo.artifactsOwned(job.id, owner)).length, 0);
  await assert.rejects(repo.recordProviderFiles({ ...lease, token: randomUUID() }, ['file_foreign']), errorCode('DOC_STALE_LEASE'));
});

test('delete revokes previously published outputs and remains idempotent until every object is purged', async () => {
  const { job } = await create();
  const lease = await advanceToValidation(job.id);
  const gate = await stage(lease);
  await repo.recordProviderFiles(lease, ['file_private_input']);
  await repo.publishValidated(lease, gate);
  await repo.deleteOwned(job.id, owner);
  await repo.deleteOwned(job.id, owner);
  await assert.rejects(repo.getOwned(job.id, owner), errorCode('DOC_DELETED'));
  await assert.rejects(repo.artifactsOwned(job.id, owner), errorCode('DOC_DELETED'));
  await assert.rejects(repo.publishValidated(lease, gate), errorCode('DOC_STALE_LEASE'));
  assert.equal(await repo.finishCleanup(job.id), false);
  assert.ok((await repo.getInternal(job.id)).cleanupNotBefore);
  await assert.rejects(repo.markStorageKeysPurged(job.id, [job.instructionsKey]), errorCode('DOC_CLEANUP_PENDING'));
  assert.ok(!(await repo.jobsNeedingCleanup(500)).some(j => j.id === job.id));
  // Simulate passage of the fixed quiescence period; never sleep 15 minutes in tests.
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=clock_timestamp()-interval '1 second' WHERE id=${job.id}`);
  await repo.markProviderFileDeleted(job.id, 'file_private_input', false);
  assert.equal((await repo.getInternal(job.id)).providerFiles[0]!.failures, 1);
  await repo.markProviderFileDeleted(job.id, 'file_private_input', true);
  for (const a of await repo.artifactsInternal(job.id)) await repo.markArtifactPurged(job.id, a.id);
  assert.equal(await repo.finishCleanup(job.id), false, 'encrypted instructions and plan references also need deletion');
  const snapshot = await repo.getInternal(job.id);
  await repo.markStorageKeysPurged(job.id, [snapshot.instructionsKey, snapshot.editPlanKey!, snapshot.validationReportKey!]);
  assert.equal(await repo.finishCleanup(job.id), true);
  assert.equal((await repo.getInternal(job.id)).cleanupPending, false);
});

test('validation failure retries from immutable input keys at most three total attempts', async () => {
  const { job } = await create();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const lease = await repo.claimAttempt(job.id, 60_000);
    assert.ok(lease);
    assert.equal(lease.attempt, attempt);
    const status = await repo.failAttempt(lease, 'DOC_VALIDATION_FAILED', true, artifact('validation_report'));
    assert.equal(status, attempt < 3 ? 'queued' : 'failed');
    await assert.rejects(repo.heartbeat(lease, 60_000), errorCode('DOC_STALE_LEASE'));
    assert.deepEqual((await repo.getInternal(job.id)).inputKeys, job.inputKeys);
  }
  assert.equal(await repo.claimAttempt(job.id, 60_000), null);
  assert.equal((await repo.artifactsOwned(job.id, owner)).filter(a => a.kind === 'validation_report').length, 3);
  assert.equal((await repo.artifactsOwned(job.id, owner)).filter(a => a.kind === 'output').length, 0);
});

test('a fresh repository recovers an expired worker lease and rejects the old fence', async () => {
  const { job } = await create();
  const lease = await repo.claimAttempt(job.id, 60_000);
  assert.ok(lease);
  await repo.recordProviderFiles(lease, ['file_orphan']);
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${job.id}`);
  const restarted = new DocSandboxRepository(db);
  assert.ok(await restarted.recoverExpiredLeases() >= 1);
  assert.equal((await restarted.getInternal(job.id)).status, 'queued');
  await assert.rejects(restarted.transition(lease, 'planning'), errorCode('DOC_STALE_LEASE'));
  const replacement = await restarted.claimAttempt(job.id, 60_000);
  assert.ok(replacement);
  assert.equal(replacement.attempt, 2);
  assert.ok(replacement.fence > lease.fence);
  await repo.recordProviderFiles(lease, ['file_arrived_after_recovery']);
  assert.equal((await restarted.getInternal(job.id)).providerFiles.length, 2);
});

test('SIGKILL of a real worker process leaves a durable lease recoverable by another worker', async () => {
  const { job } = await create();
  const modulePath = resolve(__dirname, '../src/modules/doc-sandbox/queue/repository.ts');
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), '-e', `
    const { PrismaClient } = require('@prisma/client');
    const { DocSandboxRepository } = require(process.env.DOC_TEST_REPOSITORY);
    const db = new PrismaClient({ datasources: { db: { url: process.env.DOC_TEST_URL } } });
    const repo = new DocSandboxRepository(db);
    repo.claimAttempt(process.env.DOC_TEST_JOB_ID, 60000).then(lease => {
      process.send(lease);
      setInterval(() => {}, 1000);
    }).catch(() => process.exit(1));
  `], { cwd: resolve(__dirname, '..'), env: { ...process.env, DOC_TEST_URL: url.toString(), DOC_TEST_JOB_ID: job.id, DOC_TEST_REPOSITORY: modulePath }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const oldLease = await new Promise<AttemptLease>((resolveLease, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture worker did not claim a lease')), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture worker exited before claiming')); });
      child.once('message', (message: unknown) => {
        clearTimeout(timer);
        if (!message || typeof message !== 'object' || !('jobId' in message) || message.jobId !== job.id || !('token' in message) || typeof message.token !== 'string' || !('fence' in message) || typeof message.fence !== 'number' || !('attempt' in message) || typeof message.attempt !== 'number') return reject(new Error('invalid fixture lease'));
        resolveLease({ jobId: job.id, token: message.token, fence: message.fence, attempt: message.attempt });
      });
    });
    const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    child.kill('SIGKILL');
    await exited;
    assert.equal((await repo.getInternal(job.id)).status, 'inspecting');
    // Move the lease deadline back instead of sleeping a minute; recovery still runs real SQL.
    await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${job.id}`);
    assert.ok(await repo.recoverExpiredLeases() >= 1);
    await assert.rejects(repo.heartbeat(oldLease, 60_000), errorCode('DOC_STALE_LEASE'));
    const replacement = await repo.claimAttempt(job.id, 60_000);
    assert.ok(replacement);
    assert.equal(replacement.attempt, 2);
    assert.ok(replacement.fence > oldLease.fence);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('budget reservations persist across uncertain calls and charge late responses after cancellation', async () => {
  const { job } = await create({ maxCostUsd: '5' });
  const lease = await repo.claimAttempt(job.id, 60_000);
  assert.ok(lease);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.reserveCost(lease, `request_${i}`, '1').then(() => 'reserved', () => 'blocked')));
  assert.equal(results.filter(x => x === 'reserved').length, 5);
  assert.equal(results.filter(x => x === 'blocked').length, 5);
  const first = (await repo.getInternal(job.id)).costReservations[0]!;
  assert.equal(await repo.reserveCost(lease, first.requestId, '1'), false, 'repeat request must not cause a second network call');
  await assert.rejects(repo.reserveCost(lease, 'overflow', '0.00000001'), errorCode('DOC_BUDGET_EXCEEDED'));
  await repo.settleCost(lease, first.requestId, '0.25');
  await repo.settleCost(lease, first.requestId, '0.25');
  assert.equal((await repo.getInternal(job.id)).costUsd, '0.25');
  await repo.cancelOwned(job.id, owner);
  const second = (await repo.getInternal(job.id)).costReservations[1]!;
  await repo.settleCost(lease, second.requestId, '0.5');
  assert.equal((await repo.getInternal(job.id)).costUsd, '0.75');
  assert.equal((await repo.getInternal(job.id)).status, 'cancelled');
});

test('zero configured budget rejects paid work rather than assuming unlimited credit', async () => {
  const { job } = await create({ maxCostUsd: '0' });
  const lease = await repo.claimAttempt(job.id, 60_000);
  assert.ok(lease);
  await assert.rejects(repo.reserveCost(lease, 'request_zero', '0.01'), errorCode('DOC_BUDGET_EXCEEDED'));
});

test('safe worker events reject raw document content and fencing applies to metadata too', async () => {
  const { job } = await create();
  const lease = await repo.claimAttempt(job.id, 60_000);
  assert.ok(lease);
  await repo.appendEvent(lease, 'phase', { phase: 'inspecting', attempt: 1 });
  await assert.rejects(repo.appendEvent(lease, 'agent_message', { message: 'private document content' }), errorCode('DOC_INVALID_INPUT'));
  await assert.rejects(repo.appendEvent(lease, 'tool_call', { command: 'cat /secret' }), errorCode('DOC_INVALID_INPUT'));
  await repo.cancelOwned(job.id, owner);
  await assert.rejects(repo.appendEvent(lease, 'phase', { phase: 'editing' }), errorCode('DOC_STALE_LEASE'));
});

test('deleting Files never certifies remote containers deleted; unknown expiration remains pending', async () => {
  const { job } = await create();
  const lease = await advanceToValidation(job.id);
  await repo.recordProviderFiles(lease, ['file_container_fixture']);
  await repo.recordContainer(lease, { id: 'container_plan_fixture', expiresAt: null, stage: 'plan' });
  await repo.recordContainer(lease, { id: 'container_edit_fixture', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), stage: 'edit' });
  const gate = await stage(lease);
  await repo.publishValidated(lease, gate);
  await repo.markProviderFileDeleted(job.id, 'file_container_fixture', true);
  assert.equal(await repo.finishCleanup(job.id), false);
  assert.equal((await repo.getInternal(job.id)).cleanupPending, true);
  assert.equal((await repo.getInternal(job.id)).providerContainers.length, 2);
  await repo.recordContainer(lease, { id: 'container_plan_fixture', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), stage: 'plan' });
  const current = await repo.getInternal(job.id);
  assert.ok(current.providerContainers.every(c => c.expiresAt !== null));
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET provider_containers=${JSON.stringify(current.providerContainers.map(c => ({ ...c, expiresAt: new Date(Date.now() - 1000).toISOString() })))}::jsonb,cleanup_not_before=clock_timestamp()-interval '1 second' WHERE id=${job.id}`);
  assert.equal(await repo.finishCleanup(job.id), true);
});

test('ten different jobs keep artifacts, event sequences and outputs disjoint in real Postgres', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const { job } = await create();
    const lease = await advanceToValidation(job.id);
    const gate = await stage(lease);
    await repo.publishValidated(lease, gate);
    const outputs = (await repo.artifactsOwned(job.id, owner)).filter(a => a.kind === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]!.storageKey, `private-fixture/${job.id}/output`);
    return { job, outputs };
  }));
  assert.equal(new Set(results.flatMap(r => r.outputs.map(a => a.storageKey))).size, 10);
});

test('expired jobs are tombstoned and events contain metadata, not input text or provider IDs', async () => {
  const { job } = await create();
  await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${job.id}`);
  await assert.rejects(repo.getOwned(job.id, owner), errorCode('DOC_EXPIRED'));
  assert.ok(await repo.expireJobs() >= 1);
  assert.ok((await repo.getInternal(job.id)).deletedAt);
  const rows = await db.$queryRaw<Array<{ payload: unknown }>>(Prisma.sql`SELECT payload FROM doc_job_events`);
  for (const row of rows) {
    const serialized = JSON.stringify(row.payload);
    assert.ok(!serialized.includes('file_'));
    assert.ok(!serialized.includes('private-fixture'));
    assert.ok(!serialized.includes('instructions'));
  }
});
