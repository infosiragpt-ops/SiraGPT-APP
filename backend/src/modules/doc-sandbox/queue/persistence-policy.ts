import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { ArtifactInput, ArtifactKind, AttemptLease, CostReservation, CreateDocumentJob,
  DbArtifact, DbEvent, DbJob, DocumentStatus, DurableDocumentEvent, JsonObject, ProviderContainer,
  ProviderFile, PublicationGate, StoredArtifact, StoredDocumentJob } from './repository';
import type { FailureEvidenceMode } from './failure-evidence';
import { DocumentRepositoryError } from './repository-error';

// Snapshot policies only: they neither authorize IO nor hold locks. The repository
// invokes them inside its existing transaction, using the same locked rows and
// authoritative clocks; no SQL, lease fencing or outbox writes live here.
export const TERMINAL: DocumentStatus[] = ['done', 'failed', 'cancelled'];
export const HASH = /^[a-f0-9]{64}$/;
const PLAIN_MIME: Readonly<Record<string, string>> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html' };
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const toJob = (r: DbJob): StoredDocumentJob => ({
  id: r.id, userId: r.user_id, status: r.status, admissionReady: r.admission_ready, mode: r.mode, engine: r.engine, modelTier: r.model_tier,
  requestedModel: r.requested_model, tokenBudget: r.token_budget,
  instructionsKey: r.instructions_key, inputKeys: r.input_keys, outputKeys: r.output_keys, editPlanKey: r.edit_plan_key,
  editPlanHash: r.edit_plan_hash, validationReportKey: r.validation_report_key, errorCode: r.error_code, outcome: r.outcome,
  usage: r.usage, costUsd: String(r.cost_usd), maxCostUsd: String(r.max_cost_usd), costReservations: r.cost_reservations, purgedKeys: r.purged_keys, storageKeys: r.storage_keys, attempts: r.attempts, fence: r.fence, leaseToken: r.lease_token,
  leaseExpiresAt: r.lease_expires_at, eventSeq: r.event_seq, sessionRef: r.session_ref, providerFiles: r.provider_files, providerContainers: r.provider_containers,
  cleanupPending: r.cleanup_pending, cleanupNotBefore: r.cleanup_not_before, parentJobId: r.parent_job_id, promptVersion: r.prompt_version,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, expiresAt: r.expires_at, deletedAt: r.deleted_at,
});
export const toArtifact = (r: DbArtifact): StoredArtifact => ({ id: r.id, jobId: r.job_id, attempt: r.attempt, kind: r.kind, storageKey: r.storage_key, filename: r.filename, mime: r.mime, size: Number(r.size), sha256: r.sha256, published: r.published, purgedAt: r.purged_at });
export const toEvent = (r: DbEvent): DurableDocumentEvent => ({ id: r.id, jobId: r.job_id, seq: r.seq, type: r.type, payload: r.payload, createdAt: r.created_at, outbox: r.outbox });
export function validateArtifact(a: ArtifactInput): void {
  if (!a.storageKey || !a.filename || !a.mime || !HASH.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 0) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
}
export function validateCode(code: string): void { if (!SAFE_CODE.test(code)) throw new DocumentRepositoryError('DOC_INVALID_INPUT'); }
export function validateMoney(value: string): void { if (!/^\d{1,10}(\.\d{1,8})?$/.test(value)) throw new DocumentRepositoryError('DOC_INVALID_INPUT'); }
export function validateEvent(type: string, payload: JsonObject): void {
  if (!['phase', 'validation_level', 'warning', 'error', 'agent_message', 'tool_call'].includes(type)) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'code' && typeof value === 'string' && SAFE_CODE.test(value)) continue;
    if (key === 'phase' && typeof value === 'string' && ['inspecting','planning','editing','validating','cleanup','uploading','downloading'].includes(value)) continue;
    if (key === 'passed' && typeof value === 'boolean') continue;
    if (['level','attempt','progress','durationMs','inputTokens','outputTokens'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) continue;
    throw new DocumentRepositoryError('DOC_INVALID_INPUT');
  }
}
export function assertOwned(row: DbJob | undefined, userId: string): asserts row is DbJob {
  if (!row) throw new DocumentRepositoryError('DOC_NOT_FOUND');
  if (row.user_id !== userId) throw new DocumentRepositoryError('DOC_FORBIDDEN');
}

export function validateCreateDocumentJob(input: CreateDocumentJob, now: Date): void {
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 500_000 || !input.requestedModel || input.requestedModel.length > 200) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
  if (!input.userId || !input.idempotencyKey || input.idempotencyKey.length > 200 || !HASH.test(input.payloadHash) || !input.instructionsKey || input.inputs.length < 1 || input.inputs.length > 10 || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
  input.inputs.forEach(a => { validateArtifact(a); if (a.kind !== 'input') throw new DocumentRepositoryError('DOC_INVALID_INPUT'); });
  validateMoney(input.maxCostUsd ?? '0');
}

export function admissionReservation(account: Readonly<{ isSuperAdmin: boolean; plan: string; monthlyLimit: bigint; apiUsage: bigint }>, maxTokens: number): bigint {
  if (!account.isSuperAdmin && !['PRO','PRO_MAX','ENTERPRISE'].includes(account.plan)) throw new DocumentRepositoryError('DOC_BUDGET_EXCEEDED');
  const reserved = account.isSuperAdmin ? 0n : BigInt(maxTokens);
  if (account.monthlyLimit > 0n && !account.isSuperAdmin && account.apiUsage + reserved > account.monthlyLimit) throw new DocumentRepositoryError('DOC_BUDGET_EXCEEDED');
  return reserved;
}

export function providerFilesUpdate(row: Pick<DbJob, 'attempt_leases' | 'provider_files' | 'deleted_at' | 'status' | 'fence'>, lease: AttemptLease, fileIds: readonly string[]): { files: ProviderFile[]; cleanupNow: boolean } {
  if (!row.attempt_leases.some(p => p.attempt === lease.attempt && p.tokenHash === hashToken(lease.token))) throw new DocumentRepositoryError('DOC_STALE_LEASE');
  const files = [...row.provider_files];
  for (const fileId of fileIds) if (!files.some(f => f.fileId === fileId)) files.push({ fileId, attempt: lease.attempt, deleted: false, failures: 0 });
  const cleanupNow = row.deleted_at !== null || TERMINAL.includes(row.status) || row.fence !== lease.fence;
  return { files, cleanupNow };
}

export function providerContainersUpdate(row: Pick<DbJob, 'attempt_leases' | 'provider_containers'>, lease: AttemptLease, container: { id: string; expiresAt: string | null; stage: 'plan' | 'edit' }): ProviderContainer[] {
  if (!row.attempt_leases.some(p => p.attempt === lease.attempt && p.tokenHash === hashToken(lease.token))) throw new DocumentRepositoryError('DOC_STALE_LEASE');
  const containers = row.provider_containers.map(item => ({ ...item }));
  const previous = containers.find(c => c.id === container.id && c.stage === container.stage && c.attempt === lease.attempt);
  if (previous) {
    // Never shorten retention on a later report; unknown remains pending until provider metadata arrives.
    if (container.expiresAt !== null && (previous.expiresAt === null || Date.parse(container.expiresAt) > Date.parse(previous.expiresAt))) previous.expiresAt = container.expiresAt;
  } else containers.push({ ...container, attempt: lease.attempt });
  return containers;
}

export function costReservationUpdate(row: Pick<DbJob, 'quota_epoch' | 'cost_reservations' | 'cost_usd' | 'max_cost_usd'>, account: Readonly<{ deletedAt: Date | null; docQuotaEpoch: bigint }> | undefined, lease: AttemptLease, requestId: string, reservedUsd: string): CostReservation[] | null {
  if (!account || account.deletedAt || account.docQuotaEpoch !== row.quota_epoch) throw new DocumentRepositoryError('DOC_BUDGET_EXCEEDED');
  if (row.cost_reservations.some(r => r.requestId === requestId)) return null;
  if (row.cost_reservations.length >= 600) throw new DocumentRepositoryError('DOC_BUDGET_EXCEEDED');
  const outstanding = row.cost_reservations.filter(r => r.actualUsd === null).reduce((sum, r) => sum.plus(r.reservedUsd), new Prisma.Decimal(0));
  if (outstanding.plus(row.cost_usd).plus(reservedUsd).greaterThan(row.max_cost_usd)) throw new DocumentRepositoryError('DOC_BUDGET_EXCEEDED');
  const reservations = [...row.cost_reservations, { requestId, attempt: lease.attempt, reservedUsd, actualUsd: null, actualTokens: null }];
  return reservations;
}

export function costSettlementUpdate(row: Pick<DbJob, 'attempt_leases' | 'cost_reservations'>, lease: AttemptLease, requestId: string, actualUsd: string, actualTokens?: number): CostReservation[] | null {
  if (!row.attempt_leases.some(p => p.attempt === lease.attempt && p.tokenHash === hashToken(lease.token))) throw new DocumentRepositoryError('DOC_STALE_LEASE');
  const reservations = row.cost_reservations.map(item => ({ ...item }));
  const entry = reservations.find(r => r.requestId === requestId && r.attempt === lease.attempt);
  if (!entry) throw new DocumentRepositoryError('DOC_NOT_FOUND');
  if (entry.actualUsd !== null) { if (entry.actualUsd !== actualUsd || (entry.actualTokens ?? null) !== (actualTokens ?? null)) throw new DocumentRepositoryError('DOC_CONFLICT'); return null; }
  entry.actualUsd = actualUsd;
  entry.actualTokens = actualTokens ?? null;
  return reservations;
}

export function validatePublicationGate(gate: PublicationGate): void {
  if (!['edited','unchanged','not_possible'].includes(gate.outcome) || !HASH.test(gate.planHash) || !gate.validationReportKey || gate.levels.length !== 4 || [1,2,3,4].some(n => !gate.levels.some(l => l.level === n)) || gate.levels.some(l => l.applicable ? !l.passed : (!(l.level === 2 || l.level === 3) || l.reasonCode !== 'PLAIN_TEXT_NOT_PAGINATED'))) throw new DocumentRepositoryError('DOC_VALIDATION_GATE');
}

export function publicationArtifacts(row: Pick<DbJob, 'edit_plan_key' | 'edit_plan_hash'>, artifacts: readonly DbArtifact[], gate: PublicationGate): DbArtifact[] {
  const required: ArtifactKind[] = ['output', 'edit_plan', 'recipe', 'agent_result', 'validation_report', 'text_diff'];
  if (required.some(kind => !artifacts.some(a => a.kind === kind)) || !artifacts.some(a => a.kind === 'validation_report' && a.storage_key === gate.validationReportKey)) throw new DocumentRepositoryError('DOC_VALIDATION_GATE');
  const plans = artifacts.filter(a => a.kind === 'edit_plan');
  if (plans.length !== 1 || plans[0]!.storage_key !== row.edit_plan_key || plans[0]!.sha256 !== row.edit_plan_hash) throw new DocumentRepositoryError('DOC_VALIDATION_GATE');
  const outputs = artifacts.filter(a => a.kind === 'output');
  return outputs;
}

export function validatePublicationOutputs(inputs: readonly DbArtifact[], outputs: readonly DbArtifact[], gate: PublicationGate): void {
  if (gate.outcome === 'not_possible') {
    const preserved = gate.preservedInputs;
    if (!preserved || preserved.length !== inputs.length || outputs.length !== inputs.length ||
        new Set(preserved.map(item => item.inputId)).size !== inputs.length ||
        new Set(preserved.map(item => item.outputStorageKey)).size !== inputs.length ||
        preserved.some(item => {
          const original = inputs.find(input => input.id === item.inputId);
          const output = outputs.find(candidate => candidate.storage_key === item.outputStorageKey);
          return !original || !output || !HASH.test(item.sha256) || item.sha256 !== original.sha256 ||
            output.sha256 !== original.sha256 || output.size !== original.size ||
            output.filename !== original.filename || output.mime !== original.mime;
        })) throw new DocumentRepositoryError('DOC_VALIDATION_GATE');
  } else if (gate.preservedInputs || outputs.length !== 1 ||
      (gate.outcome === 'unchanged' && (inputs.length !== 1 || outputs[0]!.sha256 !== inputs[0]!.sha256 ||
        outputs[0]!.size !== inputs[0]!.size || outputs[0]!.filename !== inputs[0]!.filename || outputs[0]!.mime !== inputs[0]!.mime))) {
    throw new DocumentRepositoryError('DOC_VALIDATION_GATE');
  }
  // A report cannot excuse an opening/visual gate on a paginated format.
  if (gate.levels.some(l => !l.applicable)) {
    if ([...inputs, ...outputs].some(a => PLAIN_MIME[a.filename.split('.').pop()?.toLowerCase() ?? ''] !== a.mime)) throw new DocumentRepositoryError('DOC_VALIDATION_GATE');
  }
}

export function failureEvidenceIdentity(row: Pick<DbJob, 'id' | 'user_id' | 'input_keys' | 'output_keys' | 'purged_keys' | 'instructions_key' | 'edit_plan_key' | 'storage_keys'>, batch: ReadonlyArray<ArtifactInput & { id: string }>, mode: FailureEvidenceMode): { ids: Set<string>; keys: Set<string> } {
  if (mode.kind === 'preservation' && mode.groups > row.input_keys.length) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
  const prefix = `doc-sandbox/${row.user_id}/${row.id}/`;
  const reserved = new Set(row.storage_keys);
  const protectedKeys = new Set([...row.input_keys, ...row.output_keys, ...row.purged_keys, row.instructions_key, row.edit_plan_key]);
  const keys = new Set<string>(); const ids = new Set<string>(); const names = new Set<string>();
  for (const artifact of batch) {
    if (!artifact.storageKey.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]+\.sealed$/.test(artifact.storageKey.slice(prefix.length))
      || !reserved.has(artifact.storageKey) || protectedKeys.has(artifact.storageKey)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(artifact.id)
      || keys.has(artifact.storageKey) || ids.has(artifact.id) || names.has(artifact.filename)) {
      throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    }
    keys.add(artifact.storageKey); ids.add(artifact.id); names.add(artifact.filename);
  }
  return { ids, keys };
}

export function cleanupStorageUpdate(row: Pick<DbJob, 'id' | 'user_id' | 'deleted_at' | 'cleanup_not_before' | 'storage_keys' | 'purged_keys'>, keys: readonly string[], now: Date): { known: string[]; purged: string[] } {
  if (!row.deleted_at || (row.cleanup_not_before && row.cleanup_not_before > now)) {
    throw new DocumentRepositoryError('DOC_CLEANUP_PENDING');
  }
  const prefix = `doc-sandbox/${row.user_id}/${row.id}/`;
  if (keys.some(key => !key.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]+\.sealed$/.test(key.slice(prefix.length)))) {
    throw new DocumentRepositoryError('DOC_INVALID_INPUT');
  }
  const known = [...new Set([...row.storage_keys, ...keys])];
  const discovered = new Set(keys);
  // A reappearing object invalidates its old acknowledgement (late PUT).
  const purged = row.purged_keys.filter(key => !discovered.has(key));
  return { known, purged };
}

export function accountQuotaSettlement(row: Pick<DbJob, 'quota_settled_at' | 'status' | 'cost_reservations' | 'quota_epoch' | 'quota_reserved_tokens'>, account: Readonly<{ docQuotaEpoch: bigint; apiUsage: bigint }> | undefined): { actual: bigint; refundReservation: boolean } | null {
  if (row.quota_settled_at || !TERMINAL.includes(row.status)) return null;
  if (row.cost_reservations.some(r => r.actualUsd === null || !Number.isSafeInteger(r.actualTokens) || (r.actualTokens ?? -1) < 0)) return null;
  const actual = row.cost_reservations.reduce((sum, r) => sum + BigInt(r.actualTokens!), 0n);
  if (!account) throw new DocumentRepositoryError('DOC_FORBIDDEN');
  if (account.docQuotaEpoch === row.quota_epoch && row.quota_reserved_tokens > 0n) {
    if (account.apiUsage < row.quota_reserved_tokens) throw new DocumentRepositoryError('DOC_CONFLICT');
  }
  return { actual, refundReservation: account.docQuotaEpoch === row.quota_epoch && row.quota_reserved_tokens > 0n };
}

export function assertOwnedAvailable(row: DbJob | undefined, userId: string, now: Date): asserts row is DbJob {
  assertOwned(row, userId);
  if (row.deleted_at) throw new DocumentRepositoryError('DOC_DELETED');
  if (row.expires_at <= now) throw new DocumentRepositoryError('DOC_EXPIRED');
}

export function inputsNeedReady(row: Pick<DbJob, 'deleted_at' | 'expires_at' | 'status' | 'admission_ready'>, now: Date): boolean {
  if (row.deleted_at) throw new DocumentRepositoryError('DOC_DELETED');
  if (row.expires_at <= now) throw new DocumentRepositoryError('DOC_EXPIRED');
  if (row.status !== 'queued') throw new DocumentRepositoryError('DOC_CONFLICT');
  return !row.admission_ready;
}

export function providerFileDeletion(files: readonly ProviderFile[], fileId: string, succeeded: boolean): ProviderFile[] {
  const updated = files.map(file => ({ ...file }));
  const entry = updated.find(f => f.fileId === fileId);
  if (!entry) throw new DocumentRepositoryError('DOC_NOT_FOUND');
  if (succeeded) entry.deleted = true; else entry.failures += 1;
  return updated;
}

export function cleanupMayProceed(row: Pick<DbJob, 'cleanup_not_before' | 'provider_files'>, now: Date): boolean {
  if (row.cleanup_not_before && row.cleanup_not_before > now) return false;
  if (row.provider_files.some(f => !f.deleted)) return false;
  return true;
}

export type CleanupCompletion = { kind: 'blocked' | 'done' | 'uncertain' } | { kind: 'retry_at'; nextCheck: Date };
export function cleanupCompletion(row: Pick<DbJob, 'deleted_at' | 'storage_keys' | 'purged_keys' | 'provider_containers' | 'cost_reservations'>, now: number): CleanupCompletion {
  if (row.deleted_at && row.storage_keys.some(key => !row.purged_keys.includes(key))) return { kind: 'blocked' };
  const retained = row.provider_containers.filter(c => c.expiresAt === null || Date.parse(c.expiresAt) > now);
  if (retained.length) {
    const nextCheck = new Date(Math.min(now + 86400_000, ...retained.filter(c => c.expiresAt !== null).map(c => Date.parse(c.expiresAt!))));
    return { kind: 'retry_at', nextCheck };
  }
  // The repository schedules this using clock_timestamp(), not this wall clock.
  if (row.cost_reservations.some(r => r.actualUsd === null)) return { kind: 'uncertain' };
  return { kind: 'done' };
}

export function providerFilesNeedingCleanup(row: Pick<StoredDocumentJob, 'cleanupNotBefore' | 'providerFiles' | 'deletedAt' | 'status' | 'attempts'>, now: Date): ProviderFile[] {
  if (row.cleanupNotBefore && row.cleanupNotBefore > now) return [];
  return row.providerFiles.filter(f => !f.deleted && (row.deletedAt !== null || row.status === 'queued' || TERMINAL.includes(row.status) || f.attempt < row.attempts));
}
