import { randomUUID } from 'node:crypto';
import { totalTokens } from '../engine/cost';
import { sha256 } from '../engine/artifacts';
import { SANDBOX_ENGINE_CONTRACT, type EnginePersistence, type SandboxEngine, type SandboxSession } from '../engine/types';
void SANDBOX_ENGINE_CONTRACT;
import type { PrivateDocumentStorage, StorageScope } from '../storage/private-storage';
import { hasCompleteValidation } from '../types/contracts';
import type { Artifact, DocumentOutcome, InputFile, JobEvent, Usage, ValidationReport } from '../types/contracts';
import { DocSandboxError, publicError } from '../types/errors';
import { DocumentValidationError, freezePlan, type IndependentDocumentValidator } from '../validation';
import { DocumentRepositoryError, type ArtifactInput, type AttemptLease, type DocSandboxRepository } from './repository';
import { combinePreservationReports, createConservativeBundle } from './conservative-result';
import { calculateAttemptBudget } from './attempt-budget';
import { DocumentAttemptLifetime } from './attempt-lifetime';
import type { FailureEvidenceMode } from './failure-evidence';
import { accumulatedUsage, canRecordFailure, candidateBundle, classifyEditedResponse, classifyOutputBundle, decodeDocumentInstructions,
  editPlanArtifact, prepareDocumentRun, prepareFailureRecord, preserveOutputBundle, publicationManifest,
  publicProcessorEvent, reportArtifact, reservedUsage, sourceMetadata } from './processor-policy';

export interface DocumentProcessorDependencies {
  repository: DocSandboxRepository;
  storage: PrivateDocumentStorage;
  validator: IndependentDocumentValidator;
  engineFactory(persistence: EnginePersistence): SandboxEngine;
  /** Operational metadata only, no document/provider error bodies. */
  onNotice?(notice: { jobId: string; attempt: number; code: string }): void;
  onPhase?(phase: 'inspecting' | 'planning' | 'editing' | 'validating', seconds: number): void;
  onValidation?(level: 1 | 2 | 3 | 4, passed: boolean, applicable: boolean): void;
}
export interface DocumentProcessorConfig {
  maxTurns: number;
  maxTokens: number;
  timeoutMs: number;
  leaseMs?: number;
}

class OutputValidationFailure extends DocSandboxError {
  constructor(readonly report: ValidationReport) { super('E_VALIDATION', 422); }
}

function money(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new DocSandboxError('E_QUOTA', 429);
  // Round up reservations/costs; never round a positive charge down to zero.
  return (Math.ceil(value * 100_000_000) / 100_000_000).toFixed(8);
}

/**
 * One delivery claims one fenced DB attempt. Retrying goes back through the
 * durable DB outbox and always reloads pristine original objects. BullMQ itself
 * does not retry provider calls or keep document bytes in its payload.
 */
export class DocumentSandboxProcessor {
  constructor(private readonly dependencies: DocumentProcessorDependencies, private readonly config: DocumentProcessorConfig) {
    const lease = config.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(lease) || lease < 3000 || lease > 300_000
      || ![config.maxTurns, config.maxTokens, config.timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new DocSandboxError('E_NOT_READY', 503);
    }
  }

  async process(jobId: string, externalSignal?: AbortSignal): Promise<void> {
    const { repository, storage, validator, engineFactory } = this.dependencies;
    const leaseMs = this.config.leaseMs ?? 30_000;
    const lease = await repository.claimAttempt(jobId, leaseMs);
    if (!lease) return;
    const lifetime = new DocumentAttemptLifetime(externalSignal);
    const { controller } = lifetime;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let engine: SandboxEngine | undefined;
    let session: SandboxSession | undefined;
    let originalInputs: InputFile[] = [];
    let phase: 'inspecting' | 'planning' | 'editing' | 'validating' = 'inspecting';
    let phaseStartedAt = Date.now();
    const measurePhase = (): void => {
      try { this.dependencies.onPhase?.(phase, Math.max(0, Date.now() - phaseStartedAt) / 1000); }
      catch { this.dependencies.onNotice?.({ jobId, attempt: lease.attempt, code: 'DOC_METRICS_FAILURE' }); }
    };
    const beginPhase = (next: typeof phase): void => { measurePhase(); phase = next; phaseStartedAt = Date.now(); };
    let latestReport: ValidationReport | undefined;
    let failureEvidenceMode: FailureEvidenceMode = { kind: 'single' };
    const renew = async (): Promise<void> => {
      try { await repository.heartbeat(lease, leaseMs); }
      catch { controller.abort(); }
      finally { if (!stopped && !controller.signal.aborted) heartbeat = setTimeout(() => { void renew(); }, Math.min(10_000, Math.floor(leaseMs / 3))); }
    };
    heartbeat = setTimeout(() => { void renew(); }, Math.min(10_000, Math.floor(leaseMs / 3)));
    try {
      const job = await repository.getInternal(jobId);
      const scope = { userId: job.userId, jobId };
      const jobDeadline = (job.startedAt ?? new Date()).getTime() + this.config.timeoutMs;
      lifetime.expireAt(jobDeadline);
      const storedInputs = (await repository.artifactsInternal(jobId)).filter((artifact) => artifact.kind === 'input' && artifact.purgedAt === null);
      // Preserve the admission order; it defines the original output filename for merges.
      for (const key of job.inputKeys) {
        const { metadata, format } = sourceMetadata(key, storedInputs);
        const data = await storage.get(scope, key, metadata.sha256, controller.signal);
        originalInputs.push({ id: metadata.id, name: metadata.filename, format, mime: metadata.mime, data, sha256: metadata.sha256 });
      }
      if (!originalInputs.length || originalInputs.length !== storedInputs.length) throw new DocSandboxError('E_VALIDATION', 422);
      const instructionsBytes = await storage.get(scope, job.instructionsKey, undefined, controller.signal);
      const instructions = decodeDocumentInstructions(instructionsBytes);
      const inventories = await validator.inspect(originalInputs, controller.signal);
      await repository.heartbeat(lease, leaseMs);
      const { baseUsage, previousTurns, remainingUsd, remainingTokens, remainingTurns } = calculateAttemptBudget(job, this.config);
      engine = engineFactory(this.enginePersistence(lease, baseUsage, previousTurns));
      const sessionStartedAt = Date.now();
      session = await engine.createSession({ id: job.id, userId: job.userId, attempt: lease.attempt, promptVersion: job.promptVersion });
      await engine.uploadInputs(session, originalInputs, controller.signal);
      beginPhase('planning');
      await repository.transition(lease, 'planning');
      const budget = { maxTurns: remainingTurns, maxTokens: remainingTokens,
        timeoutMs: Math.max(1, jobDeadline - sessionStartedAt), maxCostUsd: remainingUsd };
      // Previous independent failure feedback is private data, not extra authority.
      const previousReport = job.validationReportKey ? await storage.get(scope, job.validationReportKey, undefined, controller.signal) : undefined;
      const shared = prepareDocumentRun({ originals: originalInputs, instructions, job, budget, inventories,
        previousReport, signal: controller.signal });
      const planning = await engine.run(session, { ...shared, stage: 'plan' }, (event) => this.recordEvent(lease, event));
      if (planning.status !== 'planned') throw new DocSandboxError('E_VALIDATION', 422);
      const plan = freezePlan(originalInputs, inventories, planning.editPlan);
      const planArtifact = editPlanArtifact(plan);
      const planHash = planArtifact.sha256;
      const planRecord = await this.persist(lease, scope, planArtifact, controller.signal);
      await repository.freezePlan(lease, planRecord.storageKey, planHash);
      let refusalStage: 'planning' | 'editing' = 'planning';
      let refusalReasons = plan.notPossible.map((entry) => entry.reason);
      let outcome: DocumentOutcome = 'not_possible';
      let bundle: Artifact[] = [];
      if (!plan.notPossible.length) {
        beginPhase('editing');
        await repository.transition(lease, 'editing');
        const edited = await engine.run(session, { ...shared, stage: 'edit', approvedPlan: plan }, (event) => this.recordEvent(lease, event));
        const classified = classifyEditedResponse(plan, edited);
        outcome = classified.outcome;
        if (outcome === 'not_possible') {
          refusalStage = 'editing';
          refusalReasons = classified.warnings;
        } else {
          bundle = await engine.downloadOutputs(session);
          // Provider outcome is a claim; persist the explicit worker-classified
          // result only if the independent validation below succeeds.
          bundle = classifyOutputBundle(bundle, classified.result, outcome);
        }
      }
      const preserved = outcome === 'not_possible' ? createConservativeBundle(originalInputs, plan, refusalStage, refusalReasons) : undefined;
      if (preserved) {
        const exports = await engine.downloadOutputs(session);
        // Keep private trace evidence, but discard ALL provider candidates and
        // recipes: a refused indivisible request only delivers pristine inputs.
        bundle = preserveOutputBundle(preserved, exports);
      }
      const { outputs, recipes } = candidateBundle(bundle, preserved ? originalInputs.length : 1, plan.outputName);
      beginPhase('validating');
      await repository.transition(lease, 'validating');
      await validator.inspectRecipeArchive(recipes[0]!.data, controller.signal);
      if (preserved) {
        const reports: ValidationReport[] = [];
        for (const [index, input] of originalInputs.entries()) {
          reports.push(await validator.validate([input], outputs[index]!.data, preserved.validationPlans[index]!, controller.signal));
          failureEvidenceMode = { kind: 'preservation', groups: reports.length };
          // Retain real partial evidence if cancellation or a later child fails.
          latestReport = combinePreservationReports(originalInputs, preserved, reports);
          if (!hasCompleteValidation(reports[index]!, input.format)) throw new OutputValidationFailure(latestReport);
        }
        latestReport = combinePreservationReports(originalInputs, preserved, reports);
      } else latestReport = await validator.validate(originalInputs, outputs[0]!.data, plan, controller.signal);
      for (const level of latestReport.levels) {
        try { this.dependencies.onValidation?.(level.level, level.passed, level.applicable); }
        catch { this.dependencies.onNotice?.({ jobId, attempt: lease.attempt, code: 'DOC_METRICS_FAILURE' }); }
        await this.recordEvent(lease, { type: 'validation_level', payload: {
          level: level.level, passed: level.passed, applicable: level.applicable, durationMs: level.durationMs,
        } });
      }
      if (!hasCompleteValidation(latestReport, originalInputs[0]!.format)
        || latestReport.outputSha256 !== outputs[0]!.sha256
        || latestReport.originalSha256 !== originalInputs[0]!.sha256
        || sha256(Buffer.from(JSON.stringify(plan), 'utf8')) !== planHash) throw new OutputValidationFailure(latestReport);
      // Persist private outputs only after independent validation. No publication
      // happens until the final fenced DB transaction below.
      const recorded: ArtifactInput[] = [];
      for (const artifact of [...bundle.filter((item) => item.kind !== 'edit_plan'), ...(latestReport.artifacts ?? [])]) {
        recorded.push(await this.persist(lease, scope, artifact, controller.signal));
      }
      const { artifacts: _artifacts, ...reportWithoutBytes } = latestReport;
      const validationRecord = await this.persist(lease, scope, reportArtifact(reportWithoutBytes, lease.attempt), controller.signal);
      recorded.push(validationRecord);
      await repository.registerArtifacts(lease, [planRecord, ...recorded]);
      await repository.heartbeat(lease, leaseMs);
      controller.signal.throwIfAborted();
      await repository.publishValidated(lease, publicationManifest({
        planHash, validationReportKey: validationRecord.storageKey, outcome, preserved: !!preserved,
        originals: originalInputs, recorded, levels: latestReport.levels,
      }));
    } catch (error: unknown) {
      await this.handleFailure(lease, error, { timedOut: lifetime.timedOut, phase, latestReport, originalInputs, failureEvidenceMode });
    } finally {
      measurePhase();
      stopped = true;
      if (heartbeat) clearTimeout(heartbeat);
      lifetime.dispose();
      if (engine && session) {
        try { await engine.destroy(session); }
        catch { this.dependencies.onNotice?.({ jobId, attempt: lease.attempt, code: 'DOC_CLEANUP_PENDING' }); }
      }
    }
  }

  /** The catch delegates to this exact path so failure persistence can be
   * exercised with real reports/storage without substituting the validator. */
  private async handleFailure(lease: AttemptLease, error: unknown, context: {
    timedOut: boolean; phase: 'inspecting' | 'planning' | 'editing' | 'validating';
    latestReport?: ValidationReport; originalInputs: InputFile[];
    failureEvidenceMode?: FailureEvidenceMode;
  }): Promise<void> {
    const { repository } = this.dependencies;
    const { jobId } = lease;
    const { timedOut, phase, latestReport, originalInputs } = context;
    const normalized = timedOut ? new DocSandboxError('E_TIMEOUT', 408) : this.normalize(error);
    // A late worker cannot turn cancellation/deletion/stale leases into failure
    // or enqueue a new attempt. It may only clean its remote files in finally.
    const state = await repository.getInternal(jobId);
    if (!canRecordFailure(state, lease)) return;
    const report = error instanceof OutputValidationFailure ? error.report : latestReport;
    const mode = context.failureEvidenceMode ?? { kind: 'single' };
    const { evidence, failure, retryable } = prepareFailureRecord({ report, mode, normalized, phase,
      attempt: lease.attempt, originals: originalInputs });
    // One bounded storage window for the whole failure, including compensation;
    // never grant a fresh 15 seconds per thumbnail. Unfinished reserved keys
    // remain in the durable journal for the existing cleanup/recovery worker.
    const signal = AbortSignal.timeout(15_000);
    const scope = { userId: state.userId, jobId };
    const records: ArtifactInput[] = [];
    for (const artifact of evidence) records.push(await this.persist(lease, scope, artifact, signal, signal));
    const record = await this.persist(lease, scope, failure, signal, signal);
    signal.throwIfAborted();
    await repository.failAttempt(lease, normalized.code, retryable, record, { artifacts: records, mode });
    this.dependencies.onNotice?.({ jobId, attempt: lease.attempt, code: normalized.code });
  }

  private enginePersistence(lease: AttemptLease, base: Usage, previousTurns: number): EnginePersistence {
    const { repository } = this.dependencies;
    let turns = previousTurns;
    return {
      sessionCreated: async (session) => { await repository.recordSession(lease, session.id); },
      containerCreated: async (_session, reference) => { await repository.recordContainer(lease, reference); },
      fileChanged: async (_session, reference) => {
        if (reference.state === 'known') await repository.recordProviderFiles(lease, [reference.id]);
        else await repository.markProviderFileDeleted(lease.jobId, reference.id, reference.state === 'deleted');
      },
      reserve: async (_session, reservation) => {
        const created = await repository.reserveCost(lease, reservation.requestId, money(reservation.usd));
        if (!created) throw new DocSandboxError('E_CONFLICT', 409);
        turns += 1;
        const state = await repository.getInternal(lease.jobId);
        await repository.recordUsage(lease, reservedUsage(state.usage, turns), state.costUsd);
      },
      settle: async (_session, settlement) => {
        if (!settlement.uncertain && settlement.usage.costUsd !== null) await repository.settleCost(lease, settlement.requestId, money(settlement.usage.costUsd), totalTokens(settlement.usage));
      },
      usageChanged: async (_session, usage) => {
        const state = await repository.getInternal(lease.jobId);
        // DB settlement is the authoritative decimal total, including late bills.
        await repository.recordUsage(lease, accumulatedUsage(base, usage, turns), state.costUsd);
      },
    };
  }

  private async persist(lease: AttemptLease, scope: StorageScope, artifact: Artifact, signal?: AbortSignal, compensationSignal?: AbortSignal): Promise<ArtifactInput> {
    const { repository, storage } = this.dependencies;
    signal?.throwIfAborted();
    if (sha256(artifact.data) !== artifact.sha256) throw new DocSandboxError('E_VALIDATION', 422);
    const object = storage.prepare(scope, artifact.data);
    await repository.reserveStorageKeys(lease, [object.key]);
    try {
      signal?.throwIfAborted();
      await storage.putPrepared(scope, object, artifact.data, signal);
      signal?.throwIfAborted();
      // A DELETE can land after key reservation but before a delayed PUT ends.
      // Recheck the lease and compensate rather than leaving a late object live.
      await repository.heartbeat(lease, this.config.leaseMs ?? 30_000);
      signal?.throwIfAborted();
    } catch (error: unknown) {
      try {
        const cleanupSignal = compensationSignal ?? AbortSignal.timeout(15_000);
        cleanupSignal.throwIfAborted();
        await storage.remove(scope, object.key, cleanupSignal);
        cleanupSignal.throwIfAborted();
        await repository.markStorageKeysPurged(lease.jobId, [object.key]);
      } catch {
        this.dependencies.onNotice?.({ jobId: lease.jobId, attempt: lease.attempt, code: 'DOC_STORAGE_CLEANUP_PENDING' });
      }
      throw error;
    }
    return { id: randomUUID(), kind: artifact.kind, storageKey: object.key, filename: artifact.name,
      mime: artifact.mime, size: object.size, sha256: object.sha256 };
  }

  private async recordEvent(lease: AttemptLease, event: JobEvent): Promise<void> {
    // Defense in depth: never let a future engine emit raw text to public SSE.
    await this.dependencies.repository.appendEvent(lease, event.type, publicProcessorEvent(event, lease.attempt));
  }

  private normalize(error: unknown): DocSandboxError {
    if (error instanceof DocSandboxError) return error;
    if (error instanceof DocumentRepositoryError) {
      if (error.code === 'DOC_BUDGET_EXCEEDED') return new DocSandboxError('E_QUOTA', 429);
      if (['DOC_STALE_LEASE', 'DOC_DELETED', 'DOC_EXPIRED'].includes(error.code)) return new DocSandboxError('E_CANCELLED', 409);
      return new DocSandboxError('E_CONFLICT', 409);
    }
    if (error instanceof DocumentValidationError) {
      if (error.code === 'E_CANCELLED') return new DocSandboxError('E_CANCELLED', 409);
      if (error.code.includes('TIMEOUT')) return new DocSandboxError('E_TIMEOUT', 408);
      if (['VALIDATOR_UNAVAILABLE', 'VALIDATOR_RUNTIME_FAILED', 'VALIDATOR_IMAGE_UNPINNED', 'VALIDATOR_RUNTIME_UNSAFE'].includes(error.code)) return new DocSandboxError('E_NOT_READY', 503);
      return new DocSandboxError('E_VALIDATION', 422);
    }
    return new DocSandboxError(publicError(error).code, 500);
  }
}
