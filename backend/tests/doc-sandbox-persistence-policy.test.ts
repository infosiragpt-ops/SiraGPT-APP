import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { ArtifactInput, AttemptLease, CostReservation, CreateDocumentJob, DbArtifact, DbJob, PublicationGate } from '../src/modules/doc-sandbox/queue/repository';
import { DocumentRepositoryError } from '../src/modules/doc-sandbox/queue/repository';
import { assertOwnedAvailable, inputsNeedReady, providerFileDeletion, cleanupMayProceed, cleanupCompletion, providerFilesNeedingCleanup, accountQuotaSettlement, admissionReservation, assertOwned, cleanupStorageUpdate, costReservationUpdate, costSettlementUpdate, failureEvidenceIdentity, hashToken, providerContainersUpdate, providerFilesUpdate, publicationArtifacts, toArtifact, toEvent, toJob, validateArtifact, validateCode, validateCreateDocumentJob, validateEvent, validateMoney, validatePublicationGate, validatePublicationOutputs } from '../src/modules/doc-sandbox/queue/persistence-policy';

// Pure metadata inputs, NOT fabricated database responses. These unit tests
// prove policy decisions, not committed SQL, storage safety or document validity.
const now = new Date('2026-09-07T00:00:00Z');
const digest = 'a'.repeat(64);
const lease: AttemptLease = { jobId: 'job', token: 'lease', fence: 4, attempt: 2 };
const key = (name: string) => `doc-sandbox/owner/job/v1/${name}.sealed`;
const error = (code: DocumentRepositoryError['code']) => (value: unknown) => value instanceof DocumentRepositoryError && value.code === code;
const badInput = error('DOC_INVALID_INPUT'), gateError = error('DOC_VALIDATION_GATE'), stale = error('DOC_STALE_LEASE'), budget = error('DOC_BUDGET_EXCEEDED');
function row(changes: Partial<DbJob> = {}): DbJob {
  return { id: 'job', user_id: 'owner', status: 'validating', admission_ready: true, mode: 'document', engine: 'anthropic', model_tier: 'mechanical', requested_model: 'model', token_budget: 1000,
    quota_reserved_tokens: 1000n, quota_epoch: 3n, quota_settled_tokens: null, quota_settled_at: null,
    instructions_key: key('instructions'), input_keys: [key('input')], output_keys: [], edit_plan_key: key('plan'), edit_plan_hash: digest,
    validation_report_key: null, error_code: null, usage: { inputTokens: 3 }, cost_usd: new Prisma.Decimal('0.12'), max_cost_usd: new Prisma.Decimal('1.10'), cost_reservations: [], purged_keys: [], storage_keys: [key('input'), key('instructions'), key('plan')], outcome: null,
    attempts: 2, fence: 4, lease_token: lease.token, lease_expires_at: new Date(now.getTime() + 60_000), event_seq: 7, session_ref: 'session', provider_files: [], provider_containers: [], attempt_leases: [{ attempt: 2, tokenHash: hashToken(lease.token) }], cleanup_pending: false, cleanup_not_before: null,
    parent_job_id: null, payload_hash: digest, prompt_version: 'v1', created_at: now, started_at: now, finished_at: null, expires_at: new Date(now.getTime() + 3600_000), deleted_at: null, ...changes };
}
function artifact(kind: DbArtifact['kind'], changes: Partial<DbArtifact> = {}): DbArtifact {
  return { id: kind, job_id: 'job', attempt: 2, kind, storage_key: key(kind === 'edit_plan' ? 'plan' : kind), filename: `${kind}.txt`, mime: 'text/plain', size: 8n, sha256: digest, published: false, purged_at: null, ...changes };
}
function gate(changes: Partial<PublicationGate> = {}): PublicationGate {
  return { planHash: digest, validationReportKey: key('validation_report'), outcome: 'edited', levels: [1, 2, 3, 4].map(level => ({ level: level as 1 | 2 | 3 | 4, passed: true, applicable: true })), ...changes };
}
const inputArtifact: ArtifactInput = { id: 'input', kind: 'input', storageKey: key('input'), filename: 'source.txt', mime: 'text/plain', size: 8, sha256: digest };
const admission = (changes: Partial<CreateDocumentJob> = {}): CreateDocumentJob => ({ userId: 'owner', idempotencyKey: 'request', payloadHash: digest, instructionsKey: key('instructions'), inputs: [{ ...inputArtifact }], modelTier: 'mechanical', promptVersion: 'v1', expiresAt: new Date(now.getTime() + 1), requestedModel: 'model', maxTokens: 1000, ...changes });
const reserve = (changes: Partial<CostReservation> = {}): CostReservation => ({ requestId: 'request', attempt: 2, reservedUsd: '0.5', actualUsd: null, actualTokens: null, ...changes });

test('admission uses a supplied clock, valid metadata and default budget without mutating inputs', () => {
  const input = admission(), before = structuredClone(input);
  validateCreateDocumentJob(input, now); assert.deepEqual(input, before);
  validateCreateDocumentJob(admission({ maxTokens: 500_000, maxCostUsd: '9999999999.99999999' }), now);
  for (const change of [{ maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: 500_001 }, { requestedModel: '' }, { requestedModel: 'x'.repeat(201) }, { userId: '' }, { idempotencyKey: '' }, { payloadHash: 'wrong' }, { instructionsKey: '' }, { inputs: [] }, { expiresAt: now }, { expiresAt: new Date(NaN) }, { maxCostUsd: '-1' }, { inputs: [{ ...inputArtifact, kind: 'output' as const }] }]) assert.throws(() => validateCreateDocumentJob(admission(change), now), badInput);
});
test('metadata and events accept public scalar metadata, including zero/false, but never document contents', () => {
  validateArtifact(inputArtifact); validateCode('E_OK'); validateMoney('0.00000001');
  for (const type of ['phase', 'validation_level', 'warning', 'error', 'agent_message', 'tool_call']) validateEvent(type, { code: 'E_OK', phase: 'editing', passed: false, level: 0, attempt: 0, progress: 0, durationMs: 1, inputTokens: 1, outputTokens: 0 });
  assert.throws(() => validateArtifact({ ...inputArtifact, size: -1 }), badInput);
  assert.throws(() => validateCode('private text'), badInput); assert.throws(() => validateMoney('1e-8'), badInput);
  assert.throws(() => validateEvent('status_changed', {}), badInput);
  assert.throws(() => validateEvent('warning', { code: 'E_OK', text: 'private' }), badInput);
  assert.throws(() => validateEvent('warning', { phase: 'unknown' }), badInput);
});
test('monthly quota reservation preserves boundary, unlimited and superadmin semantics', () => {
  const account = { isSuperAdmin: false, plan: 'PRO', monthlyLimit: 1500n, apiUsage: 500n };
  for (const plan of ['PRO', 'PRO_MAX', 'ENTERPRISE']) assert.equal(admissionReservation({ ...account, plan }, 1000), 1000n);
  assert.throws(() => admissionReservation(account, 1001), budget);
  assert.throws(() => admissionReservation({ ...account, plan: 'FREE' }, 1), budget);
  assert.equal(admissionReservation({ ...account, monthlyLimit: 0n }, 500_000), 500_000n);
  assert.equal(admissionReservation({ ...account, plan: 'FREE', isSuperAdmin: true, apiUsage: 9999n }, 500_000), 0n);
});
test('row projection preserves temporal/ledger metadata but excludes internal authorization history', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const db = row(), result = toJob(db);
  assert.equal(result.userId, 'owner'); assert.equal(result.costUsd, '0.12'); assert.equal(result.maxCostUsd, '1.1');
  assert.equal(result.requestedModel, 'model'); assert.equal(result.tokenBudget, 1000);
  assert.equal(result.leaseToken, lease.token); assert.equal(result.leaseExpiresAt, db.lease_expires_at);
  assert.deepEqual(result.inputKeys, [key('input')]); assert.equal(result.expiresAt, db.expires_at);
  assert.equal(result.eventSeq, 7); assert.equal(result.sessionRef, 'session'); assert.equal(result.deletedAt, null);
  for (const internal of ['quota_epoch', 'quota_reserved_tokens', 'attempt_leases', 'payload_hash']) assert.equal(internal in result, false);
  const metadata = toArtifact(artifact('input', { size: 50_000_000n }));
  assert.equal(metadata.size, 50_000_000); assert.equal(metadata.jobId, 'job'); assert.equal(metadata.storageKey, key('input'));
  assert.deepEqual(toEvent({ id: 'event', job_id: 'job', seq: 8, type: 'warning', payload: { code: 'E_OK' }, created_at: now, outbox: 'cleanup' }), { id: 'event', jobId: 'job', seq: 8, type: 'warning', payload: { code: 'E_OK' }, createdAt: now, outbox: 'cleanup' });
  assertOwned(db, 'owner'); assert.throws(() => assertOwned(undefined, 'owner'), error('DOC_NOT_FOUND')); assert.throws(() => assertOwned(db, 'neighbor'), error('DOC_FORBIDDEN'));
});
test('late files retain historical authorization and deduplicate cleanup obligations without reviving lifecycle', () => {
  const db = row({ provider_files: [{ fileId: 'old', attempt: 1, deleted: true, failures: 2 }] });
  const before = structuredClone(db.provider_files), result = providerFilesUpdate(db, lease, ['old', 'new', 'new']);
  assert.deepEqual(result.files, [...before, { fileId: 'new', attempt: 2, deleted: false, failures: 0 }]);
  assert.equal(result.cleanupNow, false); assert.deepEqual(db.provider_files, before);
  for (const change of [{ deleted_at: now }, { status: 'done' as const }, { status: 'failed' as const }, { status: 'cancelled' as const }, { fence: 5 }]) assert.equal(providerFilesUpdate(row(change), lease, ['late']).cleanupNow, true);
  for (const change of [{ token: 'foreign' }, { attempt: 3 }]) assert.throws(() => providerFilesUpdate(db, { ...lease, ...change }, ['late']), stale);
});
test('container retention only extends; stage/attempt identities remain distinct and input snapshots immutable', () => {
  const base = { id: 'container', stage: 'edit' as const, expiresAt: null };
  const db = row(); db.provider_containers = providerContainersUpdate(db, lease, base);
  const known = new Date(now.getTime() + 1000).toISOString();
  db.provider_containers = providerContainersUpdate(db, lease, { ...base, expiresAt: known });
  const snapshot = structuredClone(db.provider_containers); Object.freeze(db.provider_containers[0]);
  assert.deepEqual(providerContainersUpdate(db, lease, base), snapshot);
  assert.deepEqual(providerContainersUpdate(db, lease, { ...base, expiresAt: now.toISOString() }), snapshot);
  const later = new Date(now.getTime() + 2000).toISOString();
  assert.equal(providerContainersUpdate(db, lease, { ...base, expiresAt: later })[0]!.expiresAt, later); assert.deepEqual(db.provider_containers, snapshot);
  assert.equal(providerContainersUpdate(db, lease, { ...base, stage: 'plan' }).length, 2);
  assert.equal(providerContainersUpdate(row({ provider_containers: [{ ...base, attempt: 1 }] }), lease, base).length, 2);
  assert.throws(() => providerContainersUpdate(db, { ...lease, token: 'wrong' }, base), stale);
});
test('cost reservation sums exact decimal costs and uncertain reservations, not settled reserved amounts', () => {
  const db = row({ cost_usd: new Prisma.Decimal('0.10'), max_cost_usd: new Prisma.Decimal('0.30'), cost_reservations: [reserve({ requestId: 'uncertain', reservedUsd: '0.10' }), reserve({ requestId: 'settled', reservedUsd: '100', actualUsd: '0.05', actualTokens: 10 })] });
  const account = { deletedAt: null, docQuotaEpoch: 3n }, result = costReservationUpdate(db, account, lease, 'new', '0.10');
  assert.equal(result!.length, 3); assert.deepEqual(result![2], reserve({ requestId: 'new', reservedUsd: '0.10' })); assert.equal(db.cost_reservations.length, 2);
  assert.throws(() => costReservationUpdate(db, account, lease, 'new', '0.10000001'), budget);
  assert.equal(costReservationUpdate(db, account, lease, 'uncertain', '999'), null);
  for (const invalid of [undefined, { ...account, deletedAt: now }, { ...account, docQuotaEpoch: 4n }]) assert.throws(() => costReservationUpdate(db, invalid, lease, 'uncertain', '0'), budget);
});
test('cost ledger ceiling includes zero-valued reservations while repeated requests remain no-ops', () => {
  const db = row({ cost_reservations: Array.from({ length: 600 }, (_, i) => reserve({ requestId: `r${i}`, reservedUsd: '0' })) });
  const account = { deletedAt: null, docQuotaEpoch: 3n };
  assert.equal(costReservationUpdate(db, account, lease, 'r0', '0'), null); assert.throws(() => costReservationUpdate(db, account, lease, 'new', '0'), budget);
});
test('late settlement is immutable, attempt-scoped and idempotent only for an exactly identical bill', () => {
  const db = row({ status: 'cancelled', deleted_at: now, fence: 5, cost_reservations: [Object.freeze(reserve())] });
  const result = costSettlementUpdate(db, lease, 'request', '0.20', 17)!;
  assert.equal(result[0]!.actualUsd, '0.20'); assert.equal(result[0]!.actualTokens, 17); assert.equal(db.cost_reservations[0]!.actualUsd, null);
  const settled = { ...db, cost_reservations: result };
  assert.equal(costSettlementUpdate(settled, lease, 'request', '0.20', 17), null);
  assert.throws(() => costSettlementUpdate(settled, lease, 'request', '0.2', 17), error('DOC_CONFLICT'));
  assert.throws(() => costSettlementUpdate(settled, lease, 'request', '0.20', 18), error('DOC_CONFLICT'));
  assert.throws(() => costSettlementUpdate(db, lease, 'absent', '0'), error('DOC_NOT_FOUND'));
  assert.throws(() => costSettlementUpdate(db, { ...lease, token: 'foreign' }, 'request', '0'), stale);
  assert.throws(() => costSettlementUpdate({ ...db, cost_reservations: [reserve({ attempt: 1 })] }, lease, 'request', '0'), error('DOC_NOT_FOUND'));
  const noTokens = costSettlementUpdate(db, lease, 'request', '0')!;
  assert.equal(noTokens[0]!.actualTokens, null); assert.equal(costSettlementUpdate({ ...db, cost_reservations: noTokens }, lease, 'request', '0'), null);
});
test('publication requires four distinct successful levels and only permits explicit plain text exceptions', () => {
  validatePublicationGate(gate());
  const plain = gate({ levels: gate().levels.map(l => l.level === 2 || l.level === 3 ? { ...l, applicable: false, passed: false, reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' } : l) });
  validatePublicationGate(plain);
  for (const candidate of [gate({ planHash: 'bad' }), gate({ validationReportKey: '' }), gate({ levels: gate().levels.slice(1) }), gate({ levels: [gate().levels[0]!, ...gate().levels.slice(0, 3)] }), gate({ levels: gate().levels.map(l => ({ ...l, passed: false })) }), gate({ levels: gate().levels.map(l => ({ ...l, applicable: false, reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' })) }), gate({ levels: plain.levels.map(l => ({ ...l, reasonCode: 'SKIP' })) })]) assert.throws(() => validatePublicationGate(candidate), gateError);
});
test('publication requires each mandatory artifact and exact frozen-plan metadata before checking outputs', () => {
  const required: DbArtifact['kind'][] = ['output', 'edit_plan', 'recipe', 'agent_result', 'validation_report', 'text_diff'], artifacts = required.map(kind => artifact(kind));
  assert.deepEqual(publicationArtifacts(row(), artifacts, gate()), [artifacts[0]]);
  for (const kind of required) assert.throws(() => publicationArtifacts(row(), artifacts.filter(a => a.kind !== kind), gate()), gateError);
  assert.throws(() => publicationArtifacts(row(), [...artifacts, artifact('edit_plan', { id: 'another' })], gate()), gateError);
  for (const change of [{ edit_plan_key: key('other') }, { edit_plan_hash: 'b'.repeat(64) }]) assert.throws(() => publicationArtifacts(row(change), artifacts, gate()), gateError);
  assert.throws(() => publicationArtifacts(row(), artifacts, gate({ validationReportKey: key('other-report') })), gateError);
});
test('edited/unchanged outcomes require one output and unchanged metadata, not merely an equal hash', () => {
  const input = artifact('input', { filename: 'source.txt' }), output = artifact('output', { filename: 'source.txt' });
  validatePublicationOutputs([input], [output], gate()); validatePublicationOutputs([input], [output], gate({ outcome: 'unchanged' }));
  for (const outputs of [[], [output, { ...output, id: 'extra' }]]) assert.throws(() => validatePublicationOutputs([input], outputs, gate()), gateError);
  assert.throws(() => validatePublicationOutputs([input], [output], gate({ preservedInputs: [] })), gateError);
  assert.throws(() => validatePublicationOutputs([], [output], gate({ outcome: 'unchanged' })), gateError);
  for (const change of [{ sha256: 'b'.repeat(64) }, { size: 9n }, { filename: 'renamed.txt' }, { mime: 'text/csv' }]) assert.throws(() => validatePublicationOutputs([input], [{ ...output, ...change }], gate({ outcome: 'unchanged' })), gateError);
});
test('not_possible requires a bijection of original identities to unchanged outputs', () => {
  const inputs = [artifact('input', { id: 'i1', filename: 'one.txt' }), artifact('input', { id: 'i2', filename: 'two.txt', sha256: 'b'.repeat(64), size: 11n })];
  const outputs = inputs.map((input, i) => ({ ...input, id: `o${i}`, kind: 'output' as const, storage_key: key(`out${i}`) }));
  const preservedInputs = inputs.map((input, i) => ({ inputId: input.id, outputStorageKey: outputs[i]!.storage_key, sha256: input.sha256 })), preservation = gate({ outcome: 'not_possible', preservedInputs });
  validatePublicationOutputs(inputs, outputs, preservation);
  assert.throws(() => validatePublicationOutputs(inputs, outputs, gate({ outcome: 'not_possible' })), gateError);
  assert.throws(() => validatePublicationOutputs(inputs, outputs.slice(1), preservation), gateError);
  assert.throws(() => validatePublicationOutputs(inputs, outputs, { ...preservation, preservedInputs: preservedInputs.slice(1) }), gateError);
  for (const change of [{ inputId: 'i2' }, { inputId: 'missing' }, { outputStorageKey: outputs[1]!.storage_key }, { outputStorageKey: key('missing') }, { sha256: 'bad' }, { sha256: 'c'.repeat(64) }]) assert.throws(() => validatePublicationOutputs(inputs, outputs, { ...preservation, preservedInputs: [{ ...preservedInputs[0]!, ...change }, preservedInputs[1]!] }), gateError);
  for (const change of [{ sha256: digest }, { size: 12n }, { filename: 'different.txt' }, { mime: 'text/html' }]) assert.throws(() => validatePublicationOutputs(inputs, [outputs[0]!, { ...outputs[1]!, ...change }], preservation), gateError);
});
test('N/A opening/visual exemptions cannot cross into paginated formats or mismatched MIME types', () => {
  const plain = gate({ levels: gate().levels.map(l => l.level === 2 || l.level === 3 ? { ...l, applicable: false, reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' } : l) });
  for (const [extension, mime] of Object.entries({ txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html' })) validatePublicationOutputs([artifact('input', { filename: `file.${extension.toUpperCase()}`, mime })], [artifact('output', { filename: `result.${extension}`, mime })], plain);
  for (const change of [{ filename: 'file.pdf', mime: 'application/pdf' }, { filename: 'file.docx' }, { filename: 'README', mime: 'text/plain' }, { filename: 'file.txt', mime: 'text/html' }]) {
    assert.throws(() => validatePublicationOutputs([artifact('input', change)], [artifact('output')], plain), gateError);
    assert.throws(() => validatePublicationOutputs([artifact('input')], [artifact('output', change)], plain), gateError);
  }
});
test('failure evidence uses unique reserved, unprotected identities scoped to the exact owner and job', () => {
  const batch = [{ ...inputArtifact, id: 'diff', kind: 'text_diff' as const, storageKey: key('diff'), filename: 'text-diff.json' }, { ...inputArtifact, id: 'report', kind: 'validation_report' as const, storageKey: key('report'), filename: 'report.json' }];
  const db = row({ storage_keys: [key('diff'), key('report')] }), identity = failureEvidenceIdentity(db, batch, { kind: 'single' });
  assert.deepEqual([...identity.ids], ['diff', 'report']); assert.deepEqual([...identity.keys], batch.map(a => a.storageKey));
  failureEvidenceIdentity(db, batch, { kind: 'preservation', groups: 1 });
  assert.throws(() => failureEvidenceIdentity(db, batch, { kind: 'preservation', groups: 2 }), badInput);
  for (const change of [{ storageKey: 'doc-sandbox/neighbor/job/v1/diff.sealed' }, { storageKey: 'doc-sandbox/owner/neighbor/v1/diff.sealed' }, { storageKey: key('../escape') }, { storageKey: key('unreserved') }, { id: 'bad/id' }, { id: 'x'.repeat(129) }, { id: 'report' }, { storageKey: key('report') }, { filename: 'report.json' }]) assert.throws(() => failureEvidenceIdentity(db, [{ ...batch[0]!, ...change }, batch[1]!], { kind: 'single' }), badInput);
  for (const field of ['input_keys', 'output_keys', 'purged_keys'] as const) assert.throws(() => failureEvidenceIdentity({ ...db, [field]: [key('diff')] }, batch, { kind: 'single' }), badInput);
  for (const field of ['instructions_key', 'edit_plan_key'] as const) assert.throws(() => failureEvidenceIdentity({ ...db, [field]: key('diff') }, batch, { kind: 'single' }), badInput);
});
test('cleanup journal requires grace expiry, rejects scope escapes and revokes late PUT acknowledgements', () => {
  const db = row({ deleted_at: now, cleanup_not_before: now, storage_keys: [key('old'), key('late')], purged_keys: [key('old'), key('late')] });
  const before = { known: [...db.storage_keys], purged: [...db.purged_keys] };
  assert.deepEqual(cleanupStorageUpdate(db, [key('late'), key('new')], now), { known: [key('old'), key('late'), key('new')], purged: [key('old')] });
  assert.deepEqual(db.storage_keys, before.known); assert.deepEqual(db.purged_keys, before.purged);
  assert.throws(() => cleanupStorageUpdate({ ...db, deleted_at: null }, [key('new')], now), error('DOC_CLEANUP_PENDING'));
  assert.throws(() => cleanupStorageUpdate({ ...db, cleanup_not_before: new Date(now.getTime() + 1) }, [key('new')], now), error('DOC_CLEANUP_PENDING'));
  assert.deepEqual(cleanupStorageUpdate({ ...db, cleanup_not_before: null }, [key('old')], now).purged, [key('late')]);
  for (const candidate of ['doc-sandbox/owner/job-other/v1/x.sealed', 'doc-sandbox/other/job/v1/x.sealed', key('../escape'), key('x') + '/extra', key('x').replace('.sealed', '.txt')]) assert.throws(() => cleanupStorageUpdate(db, [candidate], now), badInput);
});
test('quota settlement retains uncertain usage, respects reset epochs and sums authoritative tokens as bigint', () => {
  const account = { docQuotaEpoch: 3n, apiUsage: 1000n }, db = row({ status: 'done', cost_reservations: [reserve({ actualUsd: '0.01', actualTokens: 40 }), reserve({ requestId: 'second', actualUsd: '0.02', actualTokens: 60 })] });
  assert.deepEqual(accountQuotaSettlement(db, account), { actual: 100n, refundReservation: true });
  assert.deepEqual(accountQuotaSettlement(db, { ...account, docQuotaEpoch: 4n, apiUsage: 0n }), { actual: 100n, refundReservation: false });
  assert.deepEqual(accountQuotaSettlement({ ...db, quota_reserved_tokens: 0n }, { ...account, apiUsage: 0n }), { actual: 100n, refundReservation: false });
  assert.deepEqual(accountQuotaSettlement({ ...db, cost_reservations: [] }, account), { actual: 0n, refundReservation: true });
  const large = reserve({ actualUsd: '0', actualTokens: Number.MAX_SAFE_INTEGER });
  assert.equal(accountQuotaSettlement({ ...db, cost_reservations: [large, { ...large, requestId: 'large2' }] }, account)!.actual, BigInt(Number.MAX_SAFE_INTEGER) * 2n);
  for (const change of [{ quota_settled_at: now }, { status: 'queued' as const }, { status: 'validating' as const }]) assert.equal(accountQuotaSettlement({ ...db, ...change }, account), null);
  for (const incomplete of [reserve(), reserve({ actualUsd: '0.1' }), reserve({ actualUsd: '0.1', actualTokens: -1 }), reserve({ actualUsd: '0.1', actualTokens: 1.5 }), reserve({ actualUsd: '0.1', actualTokens: NaN })]) assert.equal(accountQuotaSettlement({ ...db, cost_reservations: [incomplete] }, account), null);
  assert.throws(() => accountQuotaSettlement(db, undefined), error('DOC_FORBIDDEN'));
  assert.throws(() => accountQuotaSettlement(db, { ...account, apiUsage: 999n }), error('DOC_CONFLICT'));
});

test('available-owner guard keeps ownership before tombstone and expiry, including the exact expiry boundary', () => {
  assertOwnedAvailable(row(), 'owner', now);
  assert.throws(() => assertOwnedAvailable(undefined, 'owner', now), error('DOC_NOT_FOUND'));
  assert.throws(() => assertOwnedAvailable(row({ deleted_at: now, expires_at: now }), 'neighbor', now), error('DOC_FORBIDDEN'));
  assert.throws(() => assertOwnedAvailable(row({ deleted_at: now, expires_at: now }), 'owner', now), error('DOC_DELETED'));
  assert.throws(() => assertOwnedAvailable(row({ expires_at: now }), 'owner', now), error('DOC_EXPIRED'));
});
test('ready admission is idempotent only for a live, unexpired queued job', () => {
  assert.equal(inputsNeedReady(row({ status: 'queued', admission_ready: false }), now), true);
  assert.equal(inputsNeedReady(row({ status: 'queued', admission_ready: true }), now), false);
  assert.throws(() => inputsNeedReady(row({ status: 'queued', deleted_at: now }), now), error('DOC_DELETED'));
  assert.throws(() => inputsNeedReady(row({ status: 'queued', expires_at: now }), now), error('DOC_EXPIRED'));
  assert.throws(() => inputsNeedReady(row({ status: 'inspecting' }), now), error('DOC_CONFLICT'));
});
test('provider delete acknowledgements do not mutate snapshots or revive an already-deleted file', () => {
  const files = [Object.freeze({ fileId: 'file', attempt: 1, deleted: false, failures: 0 }), Object.freeze({ fileId: 'other', attempt: 1, deleted: true, failures: 2 })];
  const failed = providerFileDeletion(files, 'file', false);
  assert.equal(failed[0]!.failures, 1); assert.equal(files[0]!.failures, 0); assert.equal(failed[0]!.deleted, false);
  const deleted = providerFileDeletion(failed, 'file', true);
  assert.equal(deleted[0]!.deleted, true); assert.equal(deleted[0]!.failures, 1);
  const lateFailure = providerFileDeletion(deleted, 'file', false);
  assert.equal(lateFailure[0]!.deleted, true); assert.equal(lateFailure[0]!.failures, 2); assert.deepEqual(lateFailure[1], files[1]);
  assert.throws(() => providerFileDeletion(files, 'missing', true), error('DOC_NOT_FOUND'));
});
test('cleanup cannot begin during grace or until every known provider file was acknowledged', () => {
  assert.equal(cleanupMayProceed(row(), now), true);
  assert.equal(cleanupMayProceed(row({ cleanup_not_before: now }), now), true);
  assert.equal(cleanupMayProceed(row({ cleanup_not_before: new Date(now.getTime() + 1) }), now), false);
  assert.equal(cleanupMayProceed(row({ provider_files: [{ fileId: 'file', attempt: 1, deleted: false, failures: 0 }] }), now), false);
  assert.equal(cleanupMayProceed(row({ provider_files: [{ fileId: 'file', attempt: 1, deleted: true, failures: 3 }] }), now), true);
});
test('cleanup completion requires tombstone key acknowledgements and retains unknown/unexpired containers', () => {
  const clean = row({ status: 'done', storage_keys: [], purged_keys: [] });
  assert.deepEqual(cleanupCompletion(clean, now.getTime()), { kind: 'done' });
  assert.deepEqual(cleanupCompletion({ ...clean, deleted_at: now, storage_keys: [key('missing')] }, now.getTime()), { kind: 'blocked' });
  assert.deepEqual(cleanupCompletion({ ...clean, deleted_at: now, storage_keys: [key('present')], purged_keys: [key('present')] }, now.getTime()), { kind: 'done' });
  const container = { id: 'remote', attempt: 1, stage: 'plan' as const, expiresAt: null };
  assert.deepEqual(cleanupCompletion({ ...clean, provider_containers: [container] }, now.getTime()), { kind: 'retry_at', nextCheck: new Date(now.getTime() + 86400_000) });
  const soon = new Date(now.getTime() + 1).toISOString();
  assert.deepEqual(cleanupCompletion({ ...clean, provider_containers: [container, { ...container, id: 'other', expiresAt: soon }] }, now.getTime()), { kind: 'retry_at', nextCheck: new Date(soon) });
  assert.deepEqual(cleanupCompletion({ ...clean, provider_containers: [{ ...container, expiresAt: new Date(now.getTime() + 2 * 86400_000).toISOString() }] }, now.getTime()), { kind: 'retry_at', nextCheck: new Date(now.getTime() + 86400_000) });
  assert.deepEqual(cleanupCompletion({ ...clean, provider_containers: [{ ...container, expiresAt: now.toISOString() }] }, now.getTime()), { kind: 'done' });
  assert.deepEqual(cleanupCompletion({ ...clean, cost_reservations: [reserve()] }, now.getTime()), { kind: 'uncertain' });
  assert.deepEqual(cleanupCompletion({ ...clean, cost_reservations: [reserve({ actualUsd: '0.1' })] }, now.getTime()), { kind: 'done' });
});
test('provider-file cleanup selects prior attempts during work, all attempts for queued/terminal/deleted jobs', () => {
  const files = [{ fileId: 'prior', attempt: 1, deleted: false, failures: 0 }, { fileId: 'current', attempt: 2, deleted: false, failures: 0 }, { fileId: 'gone', attempt: 1, deleted: true, failures: 0 }];
  const state = { cleanupNotBefore: null, providerFiles: files, deletedAt: null, status: 'editing' as const, attempts: 2 };
  assert.deepEqual(providerFilesNeedingCleanup(state, now).map(f => f.fileId), ['prior']);
  assert.deepEqual(providerFilesNeedingCleanup({ ...state, cleanupNotBefore: new Date(now.getTime() + 1) }, now), []);
  for (const status of ['queued', 'done', 'failed', 'cancelled'] as const) assert.deepEqual(providerFilesNeedingCleanup({ ...state, status }, now).map(f => f.fileId), ['prior', 'current']);
  assert.deepEqual(providerFilesNeedingCleanup({ ...state, deletedAt: now }, now).map(f => f.fileId), ['prior', 'current']);
});
