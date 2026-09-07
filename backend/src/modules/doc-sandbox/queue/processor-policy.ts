import { sha256 } from '../engine/artifacts';
import { addUsage, emptyUsage } from '../engine/cost';
import type { RunResult } from '../engine/types';
import { classifyAgentResult, documentFormatSchema } from '../types/contracts';
import type { AgentResult, Artifact, DocumentOutcome, EditPlan, InputFile, JobEvent, RunRequest, Usage, ValidationReport } from '../types/contracts';
import { DocSandboxError } from '../types/errors';
import type { ArtifactInput, AttemptLease, JsonObject, PublicationGate, StoredArtifact, StoredDocumentJob } from './repository';
import { validateFailureEvidence, type FailureEvidenceMode } from './failure-evidence';
import type { ConservativeBundle } from './conservative-result';

export type ProcessorPhase = 'inspecting' | 'planning' | 'editing' | 'validating';

function usageJson(usage: Usage): JsonObject {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens, costUsd: usage.costUsd, costExact: usage.costExact };
}

/** Provider usage is descriptive. The caller always supplies the separately
 * settled database cost to recordUsage; these projections cannot settle bills. */
export function reservedUsage(snapshot: Readonly<JsonObject>, turns: number): JsonObject {
  return { ...usageJson(emptyUsage()), ...snapshot, turns, costExact: false };
}

export function accumulatedUsage(base: Usage, current: Usage, turns: number): JsonObject {
  const accumulated = addUsage(base, current);
  return { ...usageJson(accumulated), turns };
}

/** These policies prepare private data; none owns a lease, performs IO, runs a
 * validator or authorizes publication. The worker keeps those ordered effects. */
export function sourceMetadata(key: string, storedInputs: ReadonlyArray<StoredArtifact>):
  { metadata: StoredArtifact; format: InputFile['format'] } {
  const metadata = storedInputs.find((artifact) => artifact.storageKey === key);
  if (!metadata) throw new DocSandboxError('E_VALIDATION', 422);
  const format = documentFormatSchema.parse(metadata.filename.split('.').pop()?.toLowerCase());
  return { metadata, format };
}

export function decodeDocumentInstructions(bytes: Buffer): string {
  if (bytes.length > 400_000) throw new DocSandboxError('E_PARAMS');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function prepareDocumentRun(input: {
  originals: ReadonlyArray<InputFile>; instructions: string;
  job: Pick<StoredDocumentJob, 'modelTier' | 'requestedModel'>;
  budget: RunRequest['budget']; inventories: unknown; previousReport?: Buffer; signal: AbortSignal;
}): Omit<RunRequest, 'stage'> {
  const formats = [...new Set(input.originals.map((file) => file.format))];
  const skills = formats.filter((format) => ['docx', 'xlsx', 'pptx', 'pdf'].includes(format)).sort();
  // Previous independent feedback remains inventory data, never instructions.
  const inventory = { inputs: input.inventories, previousValidationReport:
    input.previousReport ? JSON.parse(input.previousReport.toString('utf8')) as unknown : null };
  return { instructions: input.instructions, mode: 'preserve', formats, skills,
    modelTier: input.job.modelTier, requestedModel: input.job.requestedModel,
    budget: input.budget, inventory, signal: input.signal };
}

export function editPlanArtifact(plan: EditPlan): Artifact {
  const data = Buffer.from(JSON.stringify(plan), 'utf8');
  return { name: 'edit_plan.json', kind: 'edit_plan', data, sha256: sha256(data), mime: 'application/json' };
}

/** Provider claims only. The independent validator still determines whether
 * any candidate is eligible for the final fenced publication transaction. */
export function classifyEditedResponse(plan: EditPlan, edited: RunResult):
  { outcome: DocumentOutcome; warnings: string[]; result: AgentResult } {
  if (edited.status === 'planned' || JSON.stringify(edited.editPlan) !== JSON.stringify(plan)) throw new DocSandboxError('E_VALIDATION', 422);
  let outcome: DocumentOutcome;
  try { outcome = classifyAgentResult(plan, edited.agentResult); }
  catch { throw new DocSandboxError('E_VALIDATION', 422); }
  if ((outcome === 'not_possible') !== (edited.status === 'not_possible')) throw new DocSandboxError('E_VALIDATION', 422);
  return { outcome, warnings: edited.agentResult.warnings, result: edited.agentResult };
}

export function classifyOutputBundle(bundle: ReadonlyArray<Artifact>, result: AgentResult, outcome: DocumentOutcome): Artifact[] {
  const data = Buffer.from(JSON.stringify({ ...result, outcome }), 'utf8');
  // Preserve the provider manifest identity, replacing only its claim bytes.
  return bundle.map((artifact) => artifact.kind === 'agent_result'
    ? { ...artifact, data, sha256: sha256(data) } : artifact);
}

export function preserveOutputBundle(preserved: ConservativeBundle, exports: ReadonlyArray<Artifact>): Artifact[] {
  // A refused indivisible request delivers only pristine copies and the trusted
  // recipe. Provider candidates/recipes/results cannot leak through this path.
  return [...preserved.outputs, ...preserved.artifacts, ...exports.filter((artifact) => artifact.kind === 'transcript')];
}

export function candidateBundle(bundle: ReadonlyArray<Artifact>, expectedOutputs: number, outputName: string):
  { outputs: Artifact[]; recipes: Artifact[] } {
  const outputs = bundle.filter((artifact) => artifact.kind === 'output');
  const recipes = bundle.filter((artifact) => artifact.kind === 'recipe');
  if (outputs.length !== expectedOutputs || recipes.length !== 1 || outputs[0]!.name !== outputName
    || outputs.some((output) => sha256(output.data) !== output.sha256)) throw new DocSandboxError('E_VALIDATION', 422);
  return { outputs, recipes };
}

export function reportArtifact(value: unknown, attempt: number): Artifact {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  return { name: `validation-report-attempt-${attempt}.json`, kind: 'validation_report', data,
    sha256: sha256(data), mime: 'application/json' };
}

export function prepareFailureRecord(input: {
  report?: ValidationReport; mode: FailureEvidenceMode; normalized: DocSandboxError;
  phase: ProcessorPhase; attempt: number; originals: ReadonlyArray<InputFile>;
}): { evidence: Artifact[]; failure: Artifact; retryable: boolean } {
  const evidence = input.report?.artifacts ?? [];
  // Verify the entire batch before the caller reserves or writes even one key.
  for (const artifact of evidence) {
    if (!artifact || !Buffer.isBuffer(artifact.data) || sha256(artifact.data) !== artifact.sha256) {
      throw new DocSandboxError('E_VALIDATION', 422);
    }
  }
  validateFailureEvidence(evidence.map(artifact => ({ kind: artifact.kind, filename: artifact.name,
    mime: artifact.mime, size: artifact.data.length, sha256: artifact.sha256 })), input.mode);
  const { artifacts: _artifacts, ...reportWithoutBytes } = input.report ?? { passed: false, levels: [] };
  const failure = reportArtifact({ schemaVersion: 1, ...reportWithoutBytes, passed: false,
    phase: input.phase, attempt: input.attempt, error: { code: input.normalized.code },
    checksNotExecuted: input.report ? undefined : [1, 2, 3, 4],
    inputHashes: Object.fromEntries(input.originals.map((file) => [file.id, file.sha256])) }, input.attempt);
  // Unknown bills/provider failures never gain automatic retries or fallback.
  const retryable = input.normalized.code === 'E_VALIDATION' && input.phase !== 'inspecting';
  return { evidence, failure, retryable };
}

/** Snapshot exclusion only: the database must still fence failAttempt(). */
export function canRecordFailure(state: Pick<StoredDocumentJob, 'deletedAt' | 'status' | 'fence' | 'leaseToken'>,
  lease: AttemptLease): boolean {
  return !(state.deletedAt || state.status === 'cancelled' || state.fence !== lease.fence || state.leaseToken !== lease.token);
}

/** Serialization only, called after actual independent validation and storage.
 * The repository must independently enforce the complete publication gate. */
export function publicationManifest(input: {
  planHash: string; validationReportKey: string; outcome: DocumentOutcome;
  preserved: boolean; originals: ReadonlyArray<InputFile>; recorded: ReadonlyArray<ArtifactInput>;
  levels: ValidationReport['levels'];
}): PublicationGate {
  return { planHash: input.planHash, validationReportKey: input.validationReportKey, outcome: input.outcome,
    ...(input.preserved ? { preservedInputs: input.originals.map((file, index) => ({ inputId: file.id,
      outputStorageKey: input.recorded.filter((artifact) => artifact.kind === 'output')[index]!.storageKey, sha256: file.sha256 })) } : {}),
    levels: input.levels.map((level) => ({ level: level.level, passed: level.passed, applicable: level.applicable,
      ...(!level.applicable ? { reasonCode: 'PLAIN_TEXT_NOT_PAGINATED' } : {}) })),
  };
}

export function publicProcessorEvent(event: JobEvent, attempt: number): JsonObject {
  const safe: JsonObject = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (['level', 'durationMs'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = Math.ceil(value);
    else if (key === 'passed' && typeof value === 'boolean' && event.payload.applicable !== false) safe[key] = value;
    else if (key === 'phase' && ['Planificando edición', 'plan'].includes(String(value))) safe[key] = 'planning';
    else if (key === 'phase' && ['Editando documento', 'edit'].includes(String(value))) safe[key] = 'editing';
    else if (key === 'code' && typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value)) safe[key] = value;
  }
  safe.attempt = attempt;
  if (event.payload.applicable === false) safe.code = 'DOC_VALIDATION_NOT_APPLICABLE';
  return safe;
}
