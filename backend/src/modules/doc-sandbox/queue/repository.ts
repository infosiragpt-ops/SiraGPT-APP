import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { DocumentOutcome } from '../types/contracts';
import { canClaimDocumentAttempt, documentFailureStatus, documentTransitionFailure, isDocumentLeaseCurrent } from './lease-policy';
import { validateFailureEvidence, type FailureEvidenceMode } from './failure-evidence';

import { DocumentRepositoryError } from './repository-error';
import { TERMINAL, HASH, hashToken, toJob, toArtifact, toEvent, validateArtifact, validateCode, validateMoney, validateEvent, assertOwned,
  validateCreateDocumentJob, admissionReservation, providerFilesUpdate, providerContainersUpdate, costReservationUpdate, costSettlementUpdate, validatePublicationGate, publicationArtifacts, validatePublicationOutputs, failureEvidenceIdentity, cleanupStorageUpdate, accountQuotaSettlement,
  assertOwnedAvailable, inputsNeedReady, providerFileDeletion, cleanupMayProceed, cleanupCompletion, providerFilesNeedingCleanup } from './persistence-policy';

export type DocumentStatus = 'queued' | 'inspecting' | 'planning' | 'awaiting_approval' | 'editing' | 'validating' | 'done' | 'failed' | 'cancelled';
export type ArtifactKind = 'input' | 'output' | 'edit_plan' | 'recipe' | 'agent_result' | 'validation_report' | 'thumbnail_before' | 'thumbnail_after' | 'text_diff' | 'transcript';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface AttemptLease { jobId: string; token: string; fence: number; attempt: number; }
export interface ProviderFile { fileId: string; attempt: number; deleted: boolean; failures: number; }
export interface ProviderContainer { id: string; attempt: number; expiresAt: string | null; stage: 'plan' | 'edit'; }
export interface CostReservation { requestId: string; attempt: number; reservedUsd: string; actualUsd: string | null; actualTokens?: number | null; }
interface HistoricalLease { attempt: number; tokenHash: string; }
export interface ArtifactInput { id?: string; kind: ArtifactKind; storageKey: string; filename: string; mime: string; size: number; sha256: string; }
export interface StoredArtifact extends ArtifactInput { id: string; jobId: string; attempt: number; published: boolean; purgedAt: Date | null; }
export interface StoredDocumentJob {
  id: string; userId: string; status: DocumentStatus; admissionReady: boolean; mode: string; engine: string; modelTier: 'mechanical' | 'academic';
  requestedModel: string; tokenBudget: number;
  instructionsKey: string; inputKeys: string[]; outputKeys: string[]; editPlanKey: string | null; editPlanHash: string | null;
  validationReportKey: string | null; errorCode: string | null; usage: JsonObject; costUsd: string; maxCostUsd: string; costReservations: CostReservation[]; purgedKeys: string[]; storageKeys: string[];
  outcome: DocumentOutcome | null;
  attempts: number; fence: number; leaseToken: string | null; leaseExpiresAt: Date | null; eventSeq: number;
  sessionRef: string | null; providerFiles: ProviderFile[]; providerContainers: ProviderContainer[]; cleanupPending: boolean; cleanupNotBefore: Date | null; parentJobId: string | null;
  promptVersion: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; expiresAt: Date; deletedAt: Date | null;
}
export interface CreateDocumentJob {
  id?: string; userId: string; idempotencyKey: string; payloadHash: string; instructionsKey: string;
  inputs: ArtifactInput[]; modelTier: 'mechanical' | 'academic'; promptVersion: string; expiresAt: Date; parentJobId?: string; maxCostUsd?: string; ready?: boolean;
  requestedModel: string; maxTokens: number;
}
export interface DurableDocumentEvent {
  id: string; jobId: string; seq: number; type: string; payload: JsonObject; createdAt: Date;
  outbox: 'enqueue' | 'cleanup' | null;
}
export interface PublicationGate {
  planHash: string; validationReportKey: string; outcome: DocumentOutcome;
  preservedInputs?: ReadonlyArray<{ inputId: string; outputStorageKey: string; sha256: string }>;
  levels: ReadonlyArray<{ level: 1 | 2 | 3 | 4; passed: boolean; applicable: boolean; reasonCode?: string }>;
}
export { DocumentRepositoryError } from './repository-error';
type Db = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
type Client = Pick<PrismaClient, '$transaction' | '$queryRaw' | '$executeRaw'>;
export interface DbJob {
  id: string; user_id: string; status: DocumentStatus; admission_ready: boolean; mode: string; engine: string; model_tier: 'mechanical' | 'academic';
  requested_model: string; token_budget: number; quota_reserved_tokens: bigint; quota_epoch: bigint; quota_settled_tokens: bigint | null; quota_settled_at: Date | null;
  instructions_key: string; input_keys: string[]; output_keys: string[]; edit_plan_key: string | null; edit_plan_hash: string | null;
  validation_report_key: string | null; error_code: string | null; usage: JsonObject; cost_usd: Prisma.Decimal; max_cost_usd: Prisma.Decimal; cost_reservations: CostReservation[]; purged_keys: string[]; storage_keys: string[];
  outcome: DocumentOutcome | null;
  attempts: number; fence: number; lease_token: string | null; lease_expires_at: Date | null; event_seq: number;
  session_ref: string | null; provider_files: ProviderFile[]; provider_containers: ProviderContainer[]; attempt_leases: HistoricalLease[]; cleanup_pending: boolean; cleanup_not_before: Date | null;
  parent_job_id: string | null; payload_hash: string; prompt_version: string; created_at: Date; started_at: Date | null;
  finished_at: Date | null; expires_at: Date; deleted_at: Date | null;
}
export interface DbArtifact { id: string; job_id: string; attempt: number; kind: ArtifactKind; storage_key: string; filename: string; mime: string; size: bigint; sha256: string; published: boolean; purged_at: Date | null; }
export interface DbEvent { id: string; job_id: string; seq: number; type: string; payload: JsonObject; created_at: Date; outbox: 'enqueue' | 'cleanup' | null; }
const json = (value: unknown): string => JSON.stringify(value);

/** No in-memory state and no best-effort DB writes. The caller owns the Prisma client. */
export class DocSandboxRepository {
  constructor(private readonly client: Client) {}
  private async locked(db: Db, id: string): Promise<DbJob> {
    const rows = await db.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE id=${id} FOR UPDATE`);
    if (!rows[0]) throw new DocumentRepositoryError('DOC_NOT_FOUND');
    return rows[0];
  }
  private async assertLease(db: Db, lease: AttemptLease): Promise<DbJob> {
    const row = await this.locked(db, lease.jobId);
    const clocks = await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`);
    if (!isDocumentLeaseCurrent({ status: row.status, deletedAt: row.deleted_at, fence: row.fence,
      leaseToken: row.lease_token, attempts: row.attempts, leaseExpiresAt: row.lease_expires_at,
      expiresAt: row.expires_at }, lease, clocks[0]!.now)) throw new DocumentRepositoryError('DOC_STALE_LEASE');
    return row;
  }
  private async event(db: Db, jobId: string, type: string, payload: JsonObject, outbox: 'enqueue' | 'cleanup' | null = null): Promise<void> {
    const rows = await db.$queryRaw<Array<{ event_seq: number }>>(Prisma.sql`UPDATE doc_jobs SET event_seq=event_seq+1,updated_at=clock_timestamp() WHERE id=${jobId} RETURNING event_seq`);
    await db.$executeRaw(Prisma.sql`INSERT INTO doc_job_events(id,job_id,seq,type,payload,outbox) VALUES(${randomUUID()},${jobId},${rows[0]!.event_seq},${type},${json(payload)}::jsonb,${outbox})`);
  }
  private async insertArtifact(db: Db, jobId: string, attempt: number, a: ArtifactInput, published: boolean): Promise<void> {
    validateArtifact(a);
    await db.$executeRaw(Prisma.sql`INSERT INTO doc_job_artifacts(id,job_id,attempt,kind,storage_key,filename,mime,size,sha256,published) VALUES(${a.id ?? randomUUID()},${jobId},${attempt},${a.kind},${a.storageKey},${a.filename},${a.mime},${BigInt(a.size)},${a.sha256},${published})`);
    await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET storage_keys=array_append(storage_keys,${a.storageKey}) WHERE id=${jobId} AND NOT (${a.storageKey}=ANY(storage_keys))`);
  }
  async createJob(input: CreateDocumentJob): Promise<{ job: StoredDocumentJob; created: boolean }> {
    validateCreateDocumentJob(input, new Date());
    return this.client.$transaction(async db => {
      // Account lifecycle updates hold this same row lock before revoking jobs.
      // A request authenticated just before deletion cannot admit new work later.
      const owners = await db.$queryRaw<Array<{ id: string; deletedAt: Date | null; plan: string; isSuperAdmin: boolean; apiUsage: bigint; monthlyLimit: bigint; docQuotaEpoch: bigint }>>(Prisma.sql`SELECT id,"deletedAt",plan,"isSuperAdmin","apiUsage","monthlyLimit","docQuotaEpoch" FROM users WHERE id=${input.userId} FOR UPDATE`);
      if (!owners[0]) throw new DocumentRepositoryError('DOC_FORBIDDEN');
      if (owners[0].deletedAt) throw new DocumentRepositoryError('DOC_DELETED');
      // Serializes identical admission keys without racing unique violations.
      await db.$queryRaw(Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${json([input.userId, input.idempotencyKey])},0))`);
      const previous = await db.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE user_id=${input.userId} AND idempotency_key=${input.idempotencyKey} FOR UPDATE`);
      if (previous[0]) {
        if (previous[0].payload_hash !== input.payloadHash) throw new DocumentRepositoryError('DOC_CONFLICT');
        if (previous[0].deleted_at) throw new DocumentRepositoryError('DOC_DELETED');
        return { job: toJob(previous[0]), created: false };
      }
      const account = owners[0];
      const reserved = admissionReservation(account, input.maxTokens);
      if (reserved) await db.$executeRaw(Prisma.sql`UPDATE users SET "apiUsage"="apiUsage"+${reserved} WHERE id=${input.userId}`);
      if (input.parentJobId) { const parent = await this.locked(db, input.parentJobId); assertOwned(parent, input.userId); if (parent.deleted_at) throw new DocumentRepositoryError('DOC_DELETED'); }
      const id = input.id ?? randomUUID();
      await db.$executeRaw(Prisma.sql`INSERT INTO doc_jobs(id,user_id,model_tier,requested_model,token_budget,quota_reserved_tokens,quota_epoch,instructions_key,input_keys,parent_job_id,idempotency_key,payload_hash,prompt_version,expires_at,max_cost_usd,admission_ready) VALUES(${id},${input.userId},${input.modelTier},${input.requestedModel},${input.maxTokens},${reserved},${account.docQuotaEpoch},${input.instructionsKey},ARRAY[${Prisma.join(input.inputs.map(a => a.storageKey))}]::text[],${input.parentJobId ?? null},${input.idempotencyKey},${input.payloadHash},${input.promptVersion},${input.expiresAt},${input.maxCostUsd ?? '0'}::numeric,${input.ready === true})`);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET storage_keys=ARRAY[${input.instructionsKey}]::text[] WHERE id=${id}`);
      for (const a of input.inputs) await this.insertArtifact(db, id, 0, a, false);
      await this.event(db, id, 'status_changed', { status: 'queued', attempt: 0, admissionReady: input.ready === true }, input.ready === true ? 'enqueue' : null);
      return { job: toJob(await this.locked(db, id)), created: true };
    });
  }
  /** Called only after every reserved input/instruction object was uploaded and verified. */
  async markInputsReadyOwned(id: string, userId: string): Promise<void> {
    await this.client.$transaction(async db => {
      const row = await this.locked(db, id); assertOwned(row, userId);
      if (!inputsNeedReady(row, new Date())) return;
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET admission_ready=true WHERE id=${id}`);
      await this.event(db, id, 'status_changed', { status: 'queued', attempt: 0, admissionReady: true }, 'enqueue');
    });
  }
  async getOwned(id: string, userId: string): Promise<StoredDocumentJob> {
    const rows = await this.client.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE id=${id}`);
    assertOwnedAvailable(rows[0], userId, new Date());
    return toJob(rows[0]);
  }
  /** Owner-scoped recovery after a lost admission response; no cross-user lookup. */
  async getByIdempotencyKeyOwned(key: string, userId: string): Promise<StoredDocumentJob> {
    if (!key || key.length > 200 || !userId) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    const rows = await this.client.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE user_id=${userId} AND idempotency_key=${key}`);
    assertOwnedAvailable(rows[0], userId, new Date());
    return toJob(rows[0]);
  }
  /** Internal worker/cleanup snapshot; never expose unfiltered on the public API. */
  async getInternal(id: string): Promise<StoredDocumentJob> {
    const rows = await this.client.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE id=${id}`);
    if (!rows[0]) throw new DocumentRepositoryError('DOC_NOT_FOUND');
    return toJob(rows[0]);
  }
  async artifactsInternal(id: string): Promise<StoredArtifact[]> {
    return (await this.client.$queryRaw<DbArtifact[]>(Prisma.sql`SELECT * FROM doc_job_artifacts WHERE job_id=${id} ORDER BY created_at,id`)).map(toArtifact);
  }
  async artifactsOwned(id: string, userId: string): Promise<StoredArtifact[]> {
    await this.getOwned(id, userId);
    // Second ownership/tombstone check in the same query closes read/delete races.
    const rows = await this.client.$queryRaw<DbArtifact[]>(Prisma.sql`SELECT a.* FROM doc_job_artifacts a JOIN doc_jobs j ON j.id=a.job_id WHERE j.id=${id} AND j.user_id=${userId} AND j.deleted_at IS NULL AND j.expires_at>clock_timestamp() AND a.published=true AND a.purged_at IS NULL AND (a.kind<>'output' OR j.status='done') ORDER BY a.created_at,a.id`);
    return rows.map(toArtifact);
  }
  async listEventsOwned(id: string, userId: string, afterSeq = 0, limit = 200): Promise<DurableDocumentEvent[]> {
    await this.getOwned(id, userId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = await this.client.$queryRaw<DbEvent[]>(Prisma.sql`SELECT e.* FROM doc_job_events e JOIN doc_jobs j ON j.id=e.job_id WHERE j.id=${id} AND j.user_id=${userId} AND j.deleted_at IS NULL AND j.expires_at>clock_timestamp() AND e.seq>${afterSeq} ORDER BY e.seq LIMIT ${bounded}`);
    return rows.map(toEvent);
  }
  async claimAttempt(id: string, leaseMs: number): Promise<AttemptLease | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    return this.client.$transaction(async db => {
      const row = await this.locked(db, id);
      const now = (await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`))[0]!.now;
      if (!canClaimDocumentAttempt({ admissionReady: row.admission_ready, status: row.status,
        deletedAt: row.deleted_at, expiresAt: row.expires_at, attempts: row.attempts }, now)) return null;
      const lease: AttemptLease = { jobId: id, token: randomUUID(), fence: row.fence + 1, attempt: row.attempts + 1 };
      const history: HistoricalLease[] = [...row.attempt_leases, { attempt: lease.attempt, tokenHash: hashToken(lease.token) }];
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status='inspecting',attempts=${lease.attempt},fence=${lease.fence},lease_token=${lease.token},lease_expires_at=clock_timestamp()+${leaseMs}*interval '1 millisecond',attempt_leases=${json(history)}::jsonb,started_at=COALESCE(started_at,clock_timestamp()),error_code=NULL WHERE id=${id}`);
      await this.event(db, id, 'status_changed', { status: 'inspecting', attempt: lease.attempt });
      return lease;
    });
  }
  async heartbeat(lease: AttemptLease, leaseMs: number): Promise<void> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => { await this.assertLease(db, lease); await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET lease_expires_at=clock_timestamp()+${leaseMs}*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=${lease.jobId}`); });
  }
  async appendEvent(lease: AttemptLease, type: string, payload: JsonObject): Promise<void> {
    validateEvent(type, payload);
    await this.client.$transaction(async db => { await this.assertLease(db, lease); await this.event(db, lease.jobId, type, payload); });
  }
  async transition(lease: AttemptLease, next: DocumentStatus): Promise<void> {
    await this.client.$transaction(async db => {
      const row = await this.assertLease(db, lease);
      const failure = documentTransitionFailure(row.status, next, row.edit_plan_hash);
      if (failure) throw new DocumentRepositoryError(failure);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status=${next} WHERE id=${lease.jobId}`);
      await this.event(db, lease.jobId, 'status_changed', { status: next, attempt: lease.attempt });
    });
  }
  async freezePlan(lease: AttemptLease, key: string, hash: string): Promise<void> {
    if (!key || !HASH.test(hash)) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => {
      const row = await this.assertLease(db, lease);
      if (row.status !== 'planning' || (row.edit_plan_hash && row.edit_plan_hash !== hash)) throw new DocumentRepositoryError('DOC_CONFLICT');
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET edit_plan_key=${key},edit_plan_hash=${hash} WHERE id=${lease.jobId}`);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET storage_keys=array_append(storage_keys,${key}) WHERE id=${lease.jobId} AND NOT (${key}=ANY(storage_keys))`);
    });
  }
  async registerArtifacts(lease: AttemptLease, artifacts: ArtifactInput[]): Promise<void> {
    if (artifacts.some(a => a.kind === 'input')) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => { await this.assertLease(db, lease); for (const artifact of artifacts) await this.insertArtifact(db, lease.jobId, lease.attempt, artifact, false); });
  }
  /** Persist object identities before uploading bytes so crashes/cancellation cannot orphan known keys. */
  async reserveStorageKeys(lease: AttemptLease, keys: string[]): Promise<void> {
    if (!keys.length || keys.some(key => !key || key.length > 1500)) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => {
      const row = await this.assertLease(db, lease);
      const stored = [...new Set([...row.storage_keys, ...keys])];
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET storage_keys=ARRAY[${Prisma.join(stored)}]::text[] WHERE id=${lease.jobId}`);
    });
  }
  async recordSession(lease: AttemptLease, sessionRef: string): Promise<void> {
    if (!sessionRef || sessionRef.length > 500) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => { await this.assertLease(db, lease); await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET session_ref=${sessionRef} WHERE id=${lease.jobId}`); });
  }
  /** Late provider responses may ONLY add a cleanup obligation, never resurrect a job. */
  async recordProviderFiles(lease: AttemptLease, fileIds: string[]): Promise<void> {
    if (fileIds.some(id => !/^[A-Za-z0-9_-]{1,200}$/.test(id))) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => {
      const row = await this.locked(db, lease.jobId);
      const { files, cleanupNow } = providerFilesUpdate(row, lease, fileIds);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET provider_files=${json(files)}::jsonb,cleanup_pending=true WHERE id=${lease.jobId}`);
      if (cleanupNow) await this.event(db, lease.jobId, 'cleanup_pending', { attempt: lease.attempt }, 'cleanup');
    });
  }
  /** Session deletion is not implied by Files.delete: track each provider container through expiration. */
  async recordContainer(lease: AttemptLease, container: { id: string; expiresAt: string | null; stage: 'plan' | 'edit' }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(container.id) || !['plan', 'edit'].includes(container.stage) || (container.expiresAt !== null && !Number.isFinite(Date.parse(container.expiresAt)))) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => {
      const row = await this.locked(db, lease.jobId);
      const containers = providerContainersUpdate(row, lease, container);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET provider_containers=${json(containers)}::jsonb,cleanup_pending=true WHERE id=${lease.jobId}`);
      if (row.deleted_at || TERMINAL.includes(row.status) || row.fence !== lease.fence) await this.event(db, lease.jobId, 'cleanup_pending', { attempt: lease.attempt }, 'cleanup');
    });
  }
  async recordUsage(lease: AttemptLease, usage: JsonObject, costUsd: string): Promise<void> {
    validateMoney(costUsd);
    await this.client.$transaction(async db => {
      const row = await this.assertLease(db, lease);
      if (new Prisma.Decimal(costUsd).lessThan(row.cost_usd)) throw new DocumentRepositoryError('DOC_CONFLICT');
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET usage=${json(usage)}::jsonb,cost_usd=${costUsd}::numeric WHERE id=${lease.jobId}`);
    });
  }
  /** Commit BEFORE calling the provider. An uncertain response keeps its full reservation. */
  async reserveCost(lease: AttemptLease, requestId: string, reservedUsd: string): Promise<boolean> {
    validateMoney(reservedUsd);
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(requestId)) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    return this.client.$transaction(async db => {
      const owner = await db.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`SELECT user_id FROM doc_jobs WHERE id=${lease.jobId}`);
      if (!owner[0]) throw new DocumentRepositoryError('DOC_NOT_FOUND');
      const account = await db.$queryRaw<Array<{ deletedAt: Date | null; docQuotaEpoch: bigint }>>(Prisma.sql`SELECT "deletedAt","docQuotaEpoch" FROM users WHERE id=${owner[0].user_id} FOR UPDATE`);
      const row = await this.assertLease(db, lease);
      const reservations = costReservationUpdate(row, account[0], lease, requestId, reservedUsd);
      if (!reservations) return false;
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cost_reservations=${json(reservations)}::jsonb WHERE id=${lease.jobId}`);
      return true;
    });
  }
  /** May record a late bill after cancellation, but cannot change lifecycle or publish files. */
  async settleCost(lease: AttemptLease, requestId: string, actualUsd: string, actualTokens?: number): Promise<void> {
    validateMoney(actualUsd);
    if (actualTokens !== undefined && (!Number.isSafeInteger(actualTokens) || actualTokens < 0)) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.client.$transaction(async db => {
      const row = await this.locked(db, lease.jobId);
      const reservations = costSettlementUpdate(row, lease, requestId, actualUsd, actualTokens);
      if (!reservations) return;
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cost_reservations=${json(reservations)}::jsonb,cost_usd=cost_usd+${actualUsd}::numeric WHERE id=${lease.jobId}`);
    });
  }
  async publishValidated(lease: AttemptLease, gate: PublicationGate): Promise<void> {
    validatePublicationGate(gate);
    await this.client.$transaction(async db => {
      const existing = await this.locked(db, lease.jobId);
      if (existing.status === 'done' && !existing.deleted_at && existing.fence === lease.fence && existing.edit_plan_hash === gate.planHash && existing.validation_report_key === gate.validationReportKey && existing.outcome === gate.outcome && existing.attempt_leases.some(h => h.attempt === lease.attempt && h.tokenHash === hashToken(lease.token))) return;
      const row = await this.assertLease(db, lease);
      if (row.status !== 'validating' || row.edit_plan_hash !== gate.planHash) throw new DocumentRepositoryError('DOC_VALIDATION_GATE');
      const artifacts = await db.$queryRaw<DbArtifact[]>(Prisma.sql`SELECT * FROM doc_job_artifacts WHERE job_id=${lease.jobId} AND attempt=${lease.attempt} AND purged_at IS NULL FOR UPDATE`);
      const outputs = publicationArtifacts(row, artifacts, gate);
      const inputs = await db.$queryRaw<DbArtifact[]>(Prisma.sql`SELECT * FROM doc_job_artifacts WHERE job_id=${lease.jobId} AND kind='input' AND purged_at IS NULL`);
      validatePublicationOutputs(inputs, outputs, gate);
      await db.$executeRaw(Prisma.sql`UPDATE doc_job_artifacts SET published=true WHERE job_id=${lease.jobId} AND attempt=${lease.attempt}`);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status='done',outcome=${gate.outcome},error_code=NULL,output_keys=ARRAY[${Prisma.join(outputs.map(a => a.storage_key))}]::text[],validation_report_key=${gate.validationReportKey},finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,cleanup_pending=true WHERE id=${lease.jobId}`);
      if (gate.outcome === 'not_possible') await this.event(db, lease.jobId, 'warning', { code: 'E_NOT_POSSIBLE', attempt: lease.attempt });
      await this.event(db, lease.jobId, 'status_changed', { status: 'done', outcome: gate.outcome, attempt: lease.attempt }, 'cleanup');
    });
  }
  async failAttempt(lease: AttemptLease, code: string, retryable: boolean, report?: ArtifactInput,
    evidence?: { artifacts: readonly ArtifactInput[]; mode: FailureEvidenceMode }): Promise<DocumentStatus> {
    validateCode(code);
    if (report && report.kind !== 'validation_report') throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    if (evidence) {
      validateFailureEvidence(evidence.artifacts, evidence.mode);
      if (!report || report.mime !== 'application/json' || report.size <= 0) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    }
    // Snapshot primitive metadata before the first await, not mutable caller
    // arrays. Legacy report-only callers retain their established contract.
    const batch = evidence ? [...evidence.artifacts, report!].map(artifact => ({ ...artifact, id: artifact.id ?? randomUUID() })) : [];
    const failureReportKey = evidence ? batch[batch.length - 1]!.storageKey : report?.storageKey;
    const mode = evidence?.mode.kind === 'preservation' ? { ...evidence.mode } : { kind: 'single' as const };
    for (const artifact of batch) validateArtifact(artifact);
    return this.client.$transaction(async db => {
      const row = await this.assertLease(db, lease);
      if (evidence) {
        const { ids, keys } = failureEvidenceIdentity(row, batch, mode);
        const existing = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM doc_job_artifacts WHERE id=ANY(${[...ids]}::text[]) OR storage_key=ANY(${[...keys]}::text[]) LIMIT 1`);
        if (existing.length) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
        // Bounded batched inserts avoid one transaction round-trip per image.
        // Every key was reserved before PUT; uniqueness errors roll back the
        // entire batch, report, status and outbox together. No partial publish.
        for (let offset = 0; offset < batch.length; offset += 500) {
          const values = batch.slice(offset, offset + 500).map(artifact => Prisma.sql`(${artifact.id},${lease.jobId},${lease.attempt},${artifact.kind},${artifact.storageKey},${artifact.filename},${artifact.mime},${BigInt(artifact.size)},${artifact.sha256},${artifact.kind === 'validation_report'})`);
          await db.$executeRaw(Prisma.sql`INSERT INTO doc_job_artifacts(id,job_id,attempt,kind,storage_key,filename,mime,size,sha256,published) VALUES ${Prisma.join(values)}`);
        }
        // SQL does not accept AbortSignal: retain the existing transaction
        // timeout and recheck the lease against the database clock before commit.
        await this.assertLease(db, lease);
      } else if (report) await this.insertArtifact(db, lease.jobId, lease.attempt, report, true);
      const next = documentFailureStatus(retryable, row.attempts);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status=${next},error_code=${code},validation_report_key=${failureReportKey ?? row.validation_report_key},lease_token=NULL,lease_expires_at=NULL,fence=fence+1,edit_plan_key=NULL,edit_plan_hash=NULL,session_ref=NULL,cleanup_pending=true,cleanup_not_before=clock_timestamp()+interval '15 minutes',finished_at=CASE WHEN ${next}='failed' THEN clock_timestamp() ELSE NULL END WHERE id=${lease.jobId}`);
      await this.event(db, lease.jobId, 'status_changed', { status: next, attempt: lease.attempt, code }, next === 'queued' ? 'enqueue' : 'cleanup');
      if (next === 'queued') await this.event(db, lease.jobId, 'cleanup_pending', { attempt: lease.attempt }, 'cleanup');
      return next;
    });
  }
  async cancelOwned(id: string, userId: string): Promise<void> { await this.stopOwned(id, userId, false); }
  async deleteOwned(id: string, userId: string): Promise<void> { await this.stopOwned(id, userId, true); }
  private async stopOwned(id: string, userId: string, deleting: boolean): Promise<void> {
    await this.client.$transaction(async db => {
      const row = await this.locked(db, id); assertOwned(row, userId);
      if (row.deleted_at || (!deleting && TERMINAL.includes(row.status))) return;
      const next: DocumentStatus = TERMINAL.includes(row.status) ? row.status : 'cancelled';
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status=${next},deleted_at=CASE WHEN ${deleting} THEN clock_timestamp() ELSE deleted_at END,fence=fence+1,lease_token=NULL,lease_expires_at=NULL,finished_at=COALESCE(finished_at,clock_timestamp()),cleanup_pending=true,cleanup_not_before=clock_timestamp()+interval '15 minutes',purged_keys=ARRAY[]::text[] WHERE id=${id}`);
      await db.$executeRaw(Prisma.sql`UPDATE doc_job_artifacts SET purged_at=NULL WHERE job_id=${id}`);
      if (deleting) await db.$executeRaw(Prisma.sql`UPDATE doc_job_artifacts SET published=false WHERE job_id=${id}`);
      await this.event(db, id, deleting ? 'deleted' : 'status_changed', { status: next }, 'cleanup');
    });
  }
  async recoverExpiredLeases(limit = 100): Promise<number> {
    return this.client.$transaction(async db => {
      const rows = await db.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE status IN ('inspecting','planning','editing','validating') AND lease_expires_at<clock_timestamp() AND deleted_at IS NULL ORDER BY lease_expires_at LIMIT ${Math.max(1, Math.min(500, limit))} FOR UPDATE SKIP LOCKED`);
      for (const row of rows) {
        const next: DocumentStatus = row.attempts < 3 && row.expires_at > new Date() ? 'queued' : 'failed';
        await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status=${next},fence=fence+1,lease_token=NULL,lease_expires_at=NULL,edit_plan_key=NULL,edit_plan_hash=NULL,session_ref=NULL,error_code='DOC_WORKER_LOST',cleanup_pending=true,cleanup_not_before=clock_timestamp()+interval '15 minutes',finished_at=CASE WHEN ${next}='failed' THEN clock_timestamp() ELSE NULL END WHERE id=${row.id}`);
        await this.event(db, row.id, 'status_changed', { status: next, attempt: row.attempts, code: 'DOC_WORKER_LOST' }, next === 'queued' ? 'enqueue' : 'cleanup');
        if (next === 'queued') await this.event(db, row.id, 'cleanup_pending', { attempt: row.attempts }, 'cleanup');
      }
      return rows.length;
    });
  }
  async pendingOutbox(limit = 100, kind?: 'enqueue' | 'cleanup'): Promise<DurableDocumentEvent[]> {
    const filter = kind ? Prisma.sql`AND outbox=${kind}` : Prisma.empty;
    const rows = await this.client.$queryRaw<DbEvent[]>(Prisma.sql`SELECT * FROM doc_job_events WHERE outbox IS NOT NULL AND dispatched_at IS NULL ${filter} ORDER BY created_at,job_id,seq LIMIT ${Math.max(1, Math.min(500, limit))}`);
    return rows.map(toEvent);
  }
  /** Repairs DB jobs whose acknowledged delivery disappeared (for example, Redis lost its queue). */
  async recoverUndeliveredJobs(minAgeMs = 60_000, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 1000) throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    await this.recoverAbandonedAdmissions(limit);
    return this.client.$transaction(async db => {
      const rows = await db.$queryRaw<DbJob[]>(Prisma.sql`SELECT j.* FROM doc_jobs j WHERE j.status='queued' AND j.admission_ready=true AND j.deleted_at IS NULL AND j.expires_at>clock_timestamp() AND j.updated_at<clock_timestamp()-${minAgeMs}*interval '1 millisecond' AND NOT EXISTS(SELECT 1 FROM doc_job_events e WHERE e.job_id=j.id AND e.outbox='enqueue' AND e.dispatched_at IS NULL) ORDER BY j.updated_at LIMIT ${Math.max(1, Math.min(500, limit))} FOR UPDATE OF j SKIP LOCKED`);
      for (const row of rows) await this.event(db, row.id, 'delivery_recovered', { status: 'queued', attempt: row.attempts }, 'enqueue');
      return rows.length;
    });
  }
  /** Admission uploads have a hard 120s bound. An unready job after 15m cannot be
   * resumed safely: revoke it and preserve every reserved key for durable cleanup. */
  async recoverAbandonedAdmissions(limit = 100): Promise<number> {
    return this.client.$transaction(async db => {
      const rows = await db.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE status='queued' AND admission_ready=false AND deleted_at IS NULL AND created_at<clock_timestamp()-interval '15 minutes' ORDER BY created_at LIMIT ${Math.max(1, Math.min(500, limit))} FOR UPDATE SKIP LOCKED`);
      for (const row of rows) {
        await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET status='cancelled',deleted_at=clock_timestamp(),error_code='DOC_ADMISSION_ABANDONED',fence=fence+1,lease_token=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),cleanup_pending=true,cleanup_not_before=clock_timestamp()+interval '15 minutes',purged_keys=ARRAY[]::text[] WHERE id=${row.id}`);
        await db.$executeRaw(Prisma.sql`UPDATE doc_job_artifacts SET published=false,purged_at=NULL WHERE job_id=${row.id}`);
        await this.event(db, row.id, 'deleted', { status: 'cancelled', code: 'DOC_ADMISSION_ABANDONED' }, 'cleanup');
      }
      return rows.length;
    });
  }
  async acknowledgeOutbox(eventId: string): Promise<void> {
    await this.client.$executeRaw(Prisma.sql`UPDATE doc_job_events SET dispatched_at=clock_timestamp() WHERE id=${eventId} AND outbox IS NOT NULL AND dispatched_at IS NULL`);
  }
  async markProviderFileDeleted(jobId: string, fileId: string, succeeded: boolean): Promise<void> {
    await this.client.$transaction(async db => {
      const row = await this.locked(db, jobId);
      const updated = providerFileDeletion(row.provider_files, fileId, succeeded);
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET provider_files=${json(updated)}::jsonb WHERE id=${jobId}`);
    });
  }
  async markArtifactPurged(jobId: string, artifactId: string): Promise<void> {
    await this.client.$transaction(async db => {
      const row = await this.locked(db, jobId);
      if (row.cleanup_not_before && row.cleanup_not_before > new Date()) throw new DocumentRepositoryError('DOC_CLEANUP_PENDING');
      const artifacts = await db.$queryRaw<Array<{ storage_key: string }>>(Prisma.sql`UPDATE doc_job_artifacts SET purged_at=clock_timestamp(),published=false WHERE id=${artifactId} AND job_id=${jobId} RETURNING storage_key`);
      if (artifacts[0]) await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET purged_keys=ARRAY[${Prisma.join([...new Set([...row.purged_keys, artifacts[0].storage_key])])}]::text[] WHERE id=${jobId}`);
    });
  }
  async markStorageKeysPurged(jobId: string, keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.client.$transaction(async db => {
      const row = await this.locked(db, jobId);
      if (row.cleanup_not_before && row.cleanup_not_before > new Date()) throw new DocumentRepositoryError('DOC_CLEANUP_PENDING');
      const purged = [...new Set([...row.purged_keys, ...keys])];
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET purged_keys=ARRAY[${Prisma.join(purged)}]::text[] WHERE id=${jobId}`);
    });
  }
  /** Journal a cleanup page BEFORE DELETE, including unregistered orphan keys.
   * Tombstones have no attempt lease. Authority is the locked, grace-expired
   * deleted job and its exact owner prefix; discovery never revives execution. */
  async reserveCleanupStorageKeys(jobId: string, keys: string[]): Promise<void> {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 1000
      || keys.some(key => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) {
      throw new DocumentRepositoryError('DOC_INVALID_INPUT');
    }
    await this.client.$transaction(async db => {
      const row = await this.locked(db, jobId);
      const clocks = await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`);
      const { known, purged } = cleanupStorageUpdate(row, keys, clocks[0]!.now);
      const purgedSql = purged.length ? Prisma.sql`ARRAY[${Prisma.join(purged)}]::text[]` : Prisma.sql`ARRAY[]::text[]`;
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET storage_keys=ARRAY[${Prisma.join(known)}]::text[],purged_keys=${purgedSql},cleanup_pending=true WHERE id=${jobId}`);
    });
  }
  /** Marks cleanup complete only after all known remote IDs are deleted. Retains tombstones for revocation. */
  async finishCleanup(jobId: string): Promise<boolean> {
    return this.client.$transaction(async db => {
      const row = await this.locked(db, jobId);
      if (!cleanupMayProceed(row, new Date())) return false;
      if (row.deleted_at) {
        const remaining = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS count FROM doc_job_artifacts WHERE job_id=${jobId} AND purged_at IS NULL`);
        if (remaining[0]!.count !== 0n) return false;
      }
      const completion = cleanupCompletion(row, Date.now());
      if (completion.kind === 'blocked') return false;
      if (completion.kind === 'retry_at') {
        await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=${completion.nextCheck} WHERE id=${jobId}`);
        return false;
      }
      if (completion.kind === 'uncertain') {
        // An uncertain paid request may have created a remote container whose response was lost.
        await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_not_before=clock_timestamp()+interval '1 day' WHERE id=${jobId}`);
        return false;
      }
      await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET cleanup_pending=false WHERE id=${jobId}`);
      return true;
    });
  }
  async jobsNeedingCleanup(limit = 100): Promise<StoredDocumentJob[]> {
    const rows = await this.client.$queryRaw<DbJob[]>(Prisma.sql`SELECT * FROM doc_jobs WHERE cleanup_pending=true AND (cleanup_not_before IS NULL OR cleanup_not_before<=clock_timestamp()) AND (status IN ('queued','done','failed','cancelled') OR EXISTS (SELECT 1 FROM jsonb_array_elements(provider_files) f WHERE (f->>'attempt')::integer<attempts AND (f->>'deleted')::boolean=false)) ORDER BY updated_at LIMIT ${Math.max(1, Math.min(500, limit))}`);
    return rows.map(toJob);
  }
  async providerFilesForCleanup(jobId: string): Promise<ProviderFile[]> {
    const row = await this.getInternal(jobId);
    return providerFilesNeedingCleanup(row, new Date());
  }
  async expireJobs(limit = 100): Promise<number> {
    const rows = await this.client.$queryRaw<Array<{ id: string; user_id: string }>>(Prisma.sql`SELECT id,user_id FROM doc_jobs WHERE deleted_at IS NULL AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT ${Math.max(1, Math.min(500, limit))}`);
    for (const row of rows) await this.deleteOwned(row.id, row.user_id);
    return rows.length;
  }
  /** Reconciles terminal reservations after restart too. Lock order is always
   * user then job, shared with admission/account deletion. Unknown usage retains
   * its reservation; a reset epoch prevents refunding a newer billing period. */
  async reconcileAccountQuota(limit = 100): Promise<number> {
    const rows = await this.client.$queryRaw<Array<{ id: string; user_id: string }>>(Prisma.sql`SELECT id,user_id FROM doc_jobs WHERE status IN ('done','failed','cancelled') AND quota_settled_at IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cost_reservations) r WHERE r->>'actualUsd' IS NULL OR r->>'actualTokens' IS NULL) ORDER BY finished_at LIMIT ${Math.max(1, Math.min(500, limit))}`);
    let settled = 0;
    for (const candidate of rows) {
      const finished = await this.client.$transaction(async db => {
        const accounts = await db.$queryRaw<Array<{ docQuotaEpoch: bigint; apiUsage: bigint }>>(Prisma.sql`SELECT "docQuotaEpoch","apiUsage" FROM users WHERE id=${candidate.user_id} FOR UPDATE`);
        const row = await this.locked(db, candidate.id);
        const settlement = accountQuotaSettlement(row, accounts[0]);
        if (!settlement) return false;
        const { actual } = settlement;
        if (settlement.refundReservation) await db.$executeRaw(Prisma.sql`UPDATE users SET "apiUsage"="apiUsage"-${row.quota_reserved_tokens}+${actual} WHERE id=${candidate.user_id}`);
        // No fictitious cost conversion: this usage row uses the authoritative
        // decimal provider ledger and actual token counts. No-call failures have
        // no ApiUsage row, so they cannot consume a daily successful-call quota.
        if (row.cost_reservations.length) await db.$executeRaw(Prisma.sql`INSERT INTO api_usage(id,"userId",model,tokens,cost,timestamp) VALUES(${`doc-quota-${row.id}`},${row.user_id},${row.requested_model},${actual},${row.cost_usd},${row.created_at})`);
        await db.$executeRaw(Prisma.sql`UPDATE doc_jobs SET quota_settled_tokens=${actual},quota_settled_at=clock_timestamp() WHERE id=${row.id}`);
        return true;
      });
      if (finished) settled++;
    }
    return settled;
  }
}
