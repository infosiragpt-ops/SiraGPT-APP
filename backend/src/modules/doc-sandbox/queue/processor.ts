import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addUsage, emptyUsage, totalTokens } from '../engine/cost';
import { sha256 } from '../engine/artifacts';
import type { EnginePersistence, SandboxEngine, SandboxSession } from '../engine/types';
import type { PrivateDocumentStorage, StorageScope } from '../storage/private-storage';
import { classifyAgentResult, documentFormatSchema, hasCompleteValidation } from '../types/contracts';
import type { Artifact, DocumentOutcome, EditPlan, InputFile, JobEvent, RunRequest, Usage, ValidationReport } from '../types/contracts';
import { DocSandboxError, publicError } from '../types/errors';
import { DocumentValidationError, freezePlan, type IndependentDocumentValidator } from '../validation';
import { DocumentRepositoryError, type ArtifactInput, type AttemptLease, type DocSandboxRepository,
  type JsonObject } from './repository';
import { combinePreservationReports, createConservativeBundle } from './conservative-result';

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

const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(), costExact: z.boolean() });

class OutputValidationFailure extends DocSandboxError {
  constructor(readonly report: ValidationReport) { super('E_VALIDATION', 422); }
}

function money(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new DocSandboxError('E_QUOTA', 429);
  // Round up reservations/costs; never round a positive charge down to zero.
  return (Math.ceil(value * 100_000_000) / 100_000_000).toFixed(8);
}
function usageJson(usage: Usage): JsonObject {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens, costUsd: usage.costUsd, costExact: usage.costExact };
}
function reportArtifact(value: unknown, attempt: number): Artifact {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  return { name: `validation-report-attempt-${attempt}.json`, kind: 'validation_report', data,
    sha256: sha256(data), mime: 'application/json' };
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
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let timedOut = false;
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
      const remainingMs = jobDeadline - Date.now();
      if (remainingMs <= 0) throw new DocSandboxError('E_TIMEOUT', 408);
      deadlineTimer = setTimeout(() => { timedOut = true; controller.abort(); }, remainingMs);
      const storedInputs = (await repository.artifactsInternal(jobId)).filter((artifact) => artifact.kind === 'input' && artifact.purgedAt === null);
      // Preserve the admission order; it defines the original output filename for merges.
      for (const key of job.inputKeys) {
        const metadata = storedInputs.find((artifact) => artifact.storageKey === key);
        if (!metadata) throw new DocSandboxError('E_VALIDATION', 422);
        const format = documentFormatSchema.parse(metadata.filename.split('.').pop()?.toLowerCase());
        const data = await storage.get(scope, key, metadata.sha256, controller.signal);
        originalInputs.push({ id: metadata.id, name: metadata.filename, format, mime: metadata.mime, data, sha256: metadata.sha256 });
      }
      if (!originalInputs.length || originalInputs.length !== storedInputs.length) throw new DocSandboxError('E_VALIDATION', 422);
      const instructionsBytes = await storage.get(scope, job.instructionsKey, undefined, controller.signal);
      if (instructionsBytes.length > 400_000) throw new DocSandboxError('E_PARAMS');
      const instructions = new TextDecoder('utf-8', { fatal: true }).decode(instructionsBytes);
      const inventories = await validator.inspect(originalInputs, controller.signal);
      await repository.heartbeat(lease, leaseMs);
      const baseUsage = Object.keys(job.usage).length ? usageSchema.parse(job.usage) : emptyUsage();
      const pending = job.costReservations.filter((reservation) => reservation.actualUsd === null)
        .reduce((sum, reservation) => sum + Number(reservation.reservedUsd), 0);
      const remainingUsd = Number(job.maxCostUsd) - Number(job.costUsd) - pending;
      const remainingTokens = Math.min(this.config.maxTokens, job.tokenBudget) - totalTokens(baseUsage);
      const previousTurns = typeof job.usage.turns === 'number' && Number.isSafeInteger(job.usage.turns) && job.usage.turns >= 0 ? job.usage.turns : 0;
      const remainingTurns = this.config.maxTurns - previousTurns;
      if (remainingUsd <= 0 || remainingTokens <= 0 || remainingTurns <= 0 || baseUsage.costUsd === null) throw new DocSandboxError('E_QUOTA', 429);
      engine = engineFactory(this.enginePersistence(lease, baseUsage, previousTurns));
      const sessionStartedAt = Date.now();
      session = await engine.createSession({ id: job.id, userId: job.userId, attempt: lease.attempt, promptVersion: job.promptVersion });
      await engine.uploadInputs(session, originalInputs, controller.signal);
      beginPhase('planning');
      await repository.transition(lease, 'planning');
      const formats = [...new Set(originalInputs.map((input) => input.format))];
      const skills = formats.filter((format) => ['docx', 'xlsx', 'pptx', 'pdf'].includes(format)).sort();
      const budget = { maxTurns: remainingTurns, maxTokens: remainingTokens,
        timeoutMs: Math.max(1, jobDeadline - sessionStartedAt), maxCostUsd: remainingUsd };
      // Previous independent failure feedback is private data, not extra authority.
      const previousReport = job.validationReportKey ? await storage.get(scope, job.validationReportKey, undefined, controller.signal) : undefined;
      const inventory = { inputs: inventories, previousValidationReport: previousReport ? JSON.parse(previousReport.toString('utf8')) as unknown : null };
      const shared: Omit<RunRequest, 'stage'> = { instructions, mode: 'preserve', formats, skills, modelTier: job.modelTier,
        requestedModel: job.requestedModel, budget, inventory, signal: controller.signal };
      const planning = await engine.run(session, { ...shared, stage: 'plan' }, (event) => this.recordEvent(lease, event));
      if (planning.status !== 'planned') throw new DocSandboxError('E_VALIDATION', 422);
      const plan = freezePlan(originalInputs, inventories, planning.editPlan);
      const planData = Buffer.from(JSON.stringify(plan), 'utf8');
      const planHash = sha256(planData);
      const planRecord = await this.persist(lease, scope, { name: 'edit_plan.json', kind: 'edit_plan', data: planData,
        sha256: planHash, mime: 'application/json' }, controller.signal);
      await repository.freezePlan(lease, planRecord.storageKey, planHash);
      let refusalStage: 'planning' | 'editing' = 'planning';
      let refusalReasons = plan.notPossible.map((entry) => entry.reason);
      let outcome: DocumentOutcome = 'not_possible';
      let bundle: Artifact[] = [];
      if (!plan.notPossible.length) {
        beginPhase('editing');
        await repository.transition(lease, 'editing');
        const edited = await engine.run(session, { ...shared, stage: 'edit', approvedPlan: plan }, (event) => this.recordEvent(lease, event));
        if (edited.status === 'planned' || JSON.stringify(edited.editPlan) !== JSON.stringify(plan)) throw new DocSandboxError('E_VALIDATION', 422);
        try { outcome = classifyAgentResult(plan, edited.agentResult); }
        catch { throw new DocSandboxError('E_VALIDATION', 422); }
        if ((outcome === 'not_possible') !== (edited.status === 'not_possible')) throw new DocSandboxError('E_VALIDATION', 422);
        if (outcome === 'not_possible') {
          refusalStage = 'editing';
          refusalReasons = edited.agentResult.warnings;
        } else {
          bundle = await engine.downloadOutputs(session);
          // Provider outcome is a claim; persist the explicit worker-classified
          // result only if the independent validation below succeeds.
          const result = Buffer.from(JSON.stringify({ ...edited.agentResult, outcome }), 'utf8');
          bundle = bundle.map((artifact) => artifact.kind === 'agent_result' ? { ...artifact, data: result, sha256: sha256(result) } : artifact);
        }
      }
      const preserved = outcome === 'not_possible' ? createConservativeBundle(originalInputs, plan, refusalStage, refusalReasons) : undefined;
      if (preserved) {
        const exports = await engine.downloadOutputs(session);
        // Keep private trace evidence, but discard ALL provider candidates and
        // recipes: a refused indivisible request only delivers pristine inputs.
        bundle = [...preserved.outputs, ...preserved.artifacts, ...exports.filter((artifact) => artifact.kind === 'transcript')];
      }
      const outputs = bundle.filter((artifact) => artifact.kind === 'output');
      const recipes = bundle.filter((artifact) => artifact.kind === 'recipe');
      if (outputs.length !== (preserved ? originalInputs.length : 1) || recipes.length !== 1 || outputs[0]!.name !== plan.outputName
        || outputs.some((output) => sha256(output.data) !== output.sha256)) throw new DocSandboxError('E_VALIDATION', 422);
      beginPhase('validating');
      await repository.transition(lease, 'validating');
      await validator.inspectRecipeArchive(recipes[0]!.data, controller.signal);
      if (preserved) {
        const reports: ValidationReport[] = [];
        for (const [index, input] of originalInputs.entries()) {
          reports.push(await validator.validate([input], outputs[index]!.data, preserved.validationPlans[index]!, controller.signal));
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
      await repository.publishValidated(lease, {
        planHash, validationReportKey: validationRecord.storageKey, outcome,
        ...(preserved ? { preservedInputs: originalInputs.map((input, index) => ({ inputId: input.id,
          outputStorageKey: recorded.filter((artifact) => artifact.kind === 'output')[index]!.storageKey, sha256: input.sha256 })) } : {}),
        levels: latestReport.levels.map((level) => ({ level: level.level, passed: level.passed, applicable: level.applicable,
          ...(!level.applicable ? { reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' } : {}) })),
      });
    } catch (error: unknown) {
      const normalized = timedOut ? new DocSandboxError('E_TIMEOUT', 408) : this.normalize(error);
      // A late worker cannot turn cancellation/deletion/stale leases into failure
      // or enqueue a new attempt. It may only clean its remote files in finally.
      const state = await repository.getInternal(jobId);
      if (state.deletedAt || state.status === 'cancelled' || state.fence !== lease.fence || state.leaseToken !== lease.token) return;
      const report = error instanceof OutputValidationFailure ? error.report : latestReport;
      const { artifacts: _artifacts, ...reportWithoutBytes } = report ?? { passed: false, levels: [] };
      const failure = reportArtifact({ schemaVersion: 1, ...reportWithoutBytes, passed: false,
        phase, attempt: lease.attempt, error: { code: normalized.code },
        checksNotExecuted: report ? undefined : [1, 2, 3, 4], inputHashes: Object.fromEntries(originalInputs.map((file) => [file.id, file.sha256])) }, lease.attempt);
      // A validation failure is the only automatic retry here. Provider failures
      // and uncertain billing are terminal; they are never hidden by fallback.
      const retryable = normalized.code === 'E_VALIDATION' && phase !== 'inspecting';
      const record = await this.persist(lease, { userId: state.userId, jobId }, failure, AbortSignal.timeout(15_000));
      await repository.failAttempt(lease, normalized.code, retryable, record);
      this.dependencies.onNotice?.({ jobId, attempt: lease.attempt, code: normalized.code });
    } finally {
      measurePhase();
      stopped = true;
      if (heartbeat) clearTimeout(heartbeat);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener('abort', cancel);
      if (engine && session) {
        try { await engine.destroy(session); }
        catch { this.dependencies.onNotice?.({ jobId, attempt: lease.attempt, code: 'DOC_CLEANUP_PENDING' }); }
      }
    }
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
        await repository.recordUsage(lease, { ...usageJson(emptyUsage()), ...state.usage, turns, costExact: false }, state.costUsd);
      },
      settle: async (_session, settlement) => {
        if (!settlement.uncertain && settlement.usage.costUsd !== null) await repository.settleCost(lease, settlement.requestId, money(settlement.usage.costUsd), totalTokens(settlement.usage));
      },
      usageChanged: async (_session, usage) => {
        const state = await repository.getInternal(lease.jobId);
        const accumulated = addUsage(base, usage);
        // DB settlement is the authoritative decimal total, including late bills.
        await repository.recordUsage(lease, { ...usageJson(accumulated), turns }, state.costUsd);
      },
    };
  }

  private async persist(lease: AttemptLease, scope: StorageScope, artifact: Artifact, signal?: AbortSignal): Promise<ArtifactInput> {
    const { repository, storage } = this.dependencies;
    if (sha256(artifact.data) !== artifact.sha256) throw new DocSandboxError('E_VALIDATION', 422);
    const object = storage.prepare(scope, artifact.data);
    await repository.reserveStorageKeys(lease, [object.key]);
    try {
      await storage.putPrepared(scope, object, artifact.data, signal);
      // A DELETE can land after key reservation but before a delayed PUT ends.
      // Recheck the lease and compensate rather than leaving a late object live.
      await repository.heartbeat(lease, this.config.leaseMs ?? 30_000);
    } catch (error: unknown) {
      try {
        await storage.remove(scope, object.key, AbortSignal.timeout(15_000));
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
    const safe: JsonObject = {};
    for (const [key, value] of Object.entries(event.payload)) {
      if (['level', 'durationMs'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = Math.ceil(value);
      else if (key === 'passed' && typeof value === 'boolean' && event.payload.applicable !== false) safe[key] = value;
      else if (key === 'phase' && ['Planificando edición', 'plan'].includes(String(value))) safe[key] = 'planning';
      else if (key === 'phase' && ['Editando documento', 'edit'].includes(String(value))) safe[key] = 'editing';
      else if (key === 'code' && typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value)) safe[key] = value;
    }
    safe.attempt = lease.attempt;
    if (event.payload.applicable === false) safe.code = 'DOC_VALIDATION_NOT_APPLICABLE';
    await this.dependencies.repository.appendEvent(lease, event.type, safe);
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
