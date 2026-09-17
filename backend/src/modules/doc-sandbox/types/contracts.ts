import { z } from 'zod';

export const documentFormatSchema = z.enum(['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'md', 'csv', 'json', 'html']);
export type DocumentFormat = z.infer<typeof documentFormatSchema>;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const fileNameSchema = z.string().min(1).max(240).refine(
  (name) => !/[\\/\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..' && name.trim() === name,
  'Nombre de archivo inválido',
);
const leaf = {
  id: identifierSchema,
  inputId: identifierSchema,
  part: z.string().min(1).max(512),
  locator: z.string().min(1).max(2048),
  before: z.string().max(100_000),
  after: z.string().max(100_000),
};
export const editOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), ...leaf }).strict(),
  z.object({ kind: z.literal('cell'), ...leaf }).strict(),
  z.object({ kind: z.literal('pdf_merge'), id: identifierSchema, inputIds: z.array(identifierSchema).min(2).max(10) }).strict(),
  z.object({ kind: z.literal('pdf_overlay'), id: identifierSchema, inputId: identifierSchema,
    page: z.number().int().min(1).max(500), text: z.string().min(1).max(1000),
    x: z.number().finite().nonnegative().max(20_000), y: z.number().finite().nonnegative().max(20_000),
    fontSize: z.number().finite().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('pdf_rotate'), id: identifierSchema, inputId: identifierSchema,
    pages: z.array(z.number().int().min(1).max(500)).min(1).max(500),
    degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export const editPlanSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal('preserve'), outputName: fileNameSchema,
  inputHashes: z.record(identifierSchema, hashSchema),
  edits: z.array(editOperationSchema).max(500),
  notPossible: z.array(z.object({ request: z.string().max(2000), reason: z.string().min(1).max(2000) }).strict()).max(100),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.edits.map((edit) => edit.id)).size !== plan.edits.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Identificadores de edición duplicados' });
  }
  if (plan.edits.length && plan.notPossible.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'No se permite entregar una petición parcialmente editada' });
  }
  for (const edit of plan.edits) {
    const ids = edit.kind === 'pdf_merge' ? edit.inputIds : [edit.inputId];
    if (ids.some((id) => !Object.hasOwn(plan.inputHashes, id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'La edición referencia un archivo desconocido' });
    }
  }
});
export type EditPlan = z.infer<typeof editPlanSchema>;

export const documentOutcomeSchema = z.enum(['edited', 'unchanged', 'not_possible']);
export type DocumentOutcome = z.infer<typeof documentOutcomeSchema>;

export const agentResultSchema = z.object({
  schemaVersion: z.literal(1), outputName: fileNameSchema,
  // Optional only for earlier preserve-v1.0.0 manifests; the worker always
  // persists an explicit outcome after independent validation.
  outcome: documentOutcomeSchema.optional(),
  editsApplied: z.array(identifierSchema).max(500), editsFailed: z.array(identifierSchema).max(500),
  partsModified: z.array(z.string().max(512)).max(5000), pagesAffected: z.array(z.number().int().positive().max(500)).max(500),
  warnings: z.array(z.string().max(2000)).max(100),
  selfCheck: z.object({ openedOk: z.boolean(), textDiffMatchesPlan: z.boolean() }).strict(),
}).strict();
export type AgentResult = z.infer<typeof agentResultSchema>;

/** Classifies the provider claim; this is never approval of document bytes. */
export function classifyAgentResult(plan: EditPlan, candidate: unknown): DocumentOutcome {
  const result = agentResultSchema.parse(candidate);
  const planned = plan.edits.map((edit) => edit.id).sort();
  const sameIds = (ids: string[]): boolean => JSON.stringify([...ids].sort()) === JSON.stringify(planned);
  if (result.outputName !== plan.outputName) throw new Error('DOC_RESULT_PLAN_MISMATCH');
  if (result.outcome === 'not_possible' || plan.notPossible.length) {
    if (result.editsApplied.length || !sameIds(result.editsFailed) || result.partsModified.length ||
        result.pagesAffected.length || !result.warnings.some((warning) => warning.trim().length > 0) ||
        (result.outcome !== undefined && result.outcome !== 'not_possible')) throw new Error('DOC_RESULT_REFUSAL_INVALID');
    return 'not_possible';
  }
  if (result.editsFailed.length || !sameIds(result.editsApplied)) throw new Error('DOC_RESULT_PLAN_MISMATCH');
  const outcome = planned.length ? 'edited' : 'unchanged';
  if ((result.outcome && result.outcome !== outcome) ||
      (outcome === 'unchanged' && (result.partsModified.length || result.pagesAffected.length))) throw new Error('DOC_RESULT_PLAN_MISMATCH');
  return outcome;
}

export interface InputFile {
  id: string; name: string; format: DocumentFormat; mime: string; data: Buffer; sha256: string;
}
export type ArtifactKind = 'input' | 'output' | 'edit_plan' | 'recipe' | 'agent_result' |
  'validation_report' | 'thumbnail_before' | 'thumbnail_after' | 'text_diff' | 'transcript';
export interface Artifact {
  name: string; kind: ArtifactKind; data: Buffer; mime: string; sha256: string;
}
export interface Usage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  costUsd: number | null; costExact: boolean;
}
export interface JobForEngine { id: string; userId: string; attempt: number; promptVersion: string }
export interface RunRequest {
  stage: 'plan' | 'edit'; instructions: string; mode: 'preserve'; formats: DocumentFormat[];
  skills: string[]; modelTier: 'mechanical' | 'academic'; requestedModel: string;
  budget: { maxTurns: number; maxTokens: number; timeoutMs: number; maxCostUsd: number };
  approvedPlan?: EditPlan; inventory?: unknown; signal?: AbortSignal;
}
export interface JobEvent {
  type: 'status_changed' | 'phase' | 'agent_message' | 'tool_call' | 'validation_level' | 'warning' | 'error';
  payload: Record<string, unknown>;
}
export interface ValidationLevelResult {
  level: 1 | 2 | 3 | 4; passed: boolean; applicable: boolean;
  details: Record<string, unknown>; durationMs: number;
}
export interface ValidationReport {
  passed: boolean; levels: ValidationLevelResult[];
  originalSha256?: string; outputSha256?: string;
  artifacts?: Artifact[]; changes?: unknown[];
}
export function hasCompleteValidation(report: ValidationReport, format: DocumentFormat): boolean {
  if (!report.passed || report.levels.length !== 4) return false;
  const officeOrPdf = ['docx', 'xlsx', 'pptx', 'pdf'].includes(format);
  return [1, 2, 3, 4].every((level) => {
    const checks = report.levels.filter((check) => check.level === level);
    if (checks.length !== 1) return false;
    const check = checks[0]!;
    if (!check.applicable) {
      return !officeOrPdf && (level === 2 || level === 3) &&
        typeof check.details.reason === 'string' && check.details.reason.length > 0;
    }
    return check.passed;
  });
}
