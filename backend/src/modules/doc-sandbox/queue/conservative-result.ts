import PizZip from 'pizzip';
import { sha256 } from '../engine/artifacts';
import { agentResultSchema, editPlanSchema, hasCompleteValidation, type Artifact, type EditPlan,
  type InputFile, type ValidationReport } from '../types/contracts';
import { DocSandboxError } from '../types/errors';

export interface ConservativeBundle {
  outputs: Artifact[];
  artifacts: Artifact[];
  validationPlans: EditPlan[];
  originalPlanHash: string;
}

/** An executable reproduction of the trusted Buffer copies below, never generated code. */
const RESTORE_SCRIPT = `import hashlib, json, pathlib, shutil, sys
manifest = json.loads(pathlib.Path(__file__).with_name('commands.json').read_text('utf-8'))
source, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
destination.mkdir(exist_ok=True)
for item in manifest['files']:
    incoming, outgoing = source / item['inputAlias'], destination / item['outputAlias']
    if hashlib.sha256(incoming.read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Original hash mismatch')
    with incoming.open('rb') as src, outgoing.open('xb') as dst:
        shutil.copyfileobj(src, dst)
    if hashlib.sha256(outgoing.read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Preservation hash mismatch')
`;

function jsonArtifact(name: string, kind: Artifact['kind'], value: unknown): Artifact {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  return { name, kind, data, mime: 'application/json', sha256: sha256(data) };
}

/**
 * Restores ALL originals, never provider output. The immutable requested plan is
 * retained; per-input no-op plans authorize only validation of this separate
 * preservation outcome. They cannot be passed back to the editing engine.
 */
export function createConservativeBundle(inputs: InputFile[], frozenPlan: EditPlan,
  stage: 'planning' | 'editing', reasons: string[]): ConservativeBundle {
  const plan = editPlanSchema.parse(frozenPlan);
  if (!inputs.length || inputs.length > 10 || new Set(inputs.map((input) => input.id)).size !== inputs.length ||
      Object.keys(plan.inputHashes).length !== inputs.length || plan.outputName !== inputs[0]!.name ||
      (stage === 'planning' && !plan.notPossible.length) || (stage === 'editing' && plan.notPossible.length) ||
      !reasons.length || reasons.length > 100 || reasons.some((reason) => !reason.trim() || reason.length > 2000)) {
    throw new DocSandboxError('E_VALIDATION', 422);
  }
  const originalPlanHash = sha256(Buffer.from(JSON.stringify(plan), 'utf8'));
  const outputs: Artifact[] = inputs.map((input) => {
    if (sha256(input.data) !== input.sha256 || plan.inputHashes[input.id] !== input.sha256) throw new DocSandboxError('E_VALIDATION', 422);
    return { kind: 'output', name: input.name, data: Buffer.from(input.data), sha256: input.sha256, mime: input.mime };
  });
  const validationPlans = inputs.map((input) => editPlanSchema.parse({ schemaVersion: 1, mode: 'preserve',
    outputName: input.name, inputHashes: { [input.id]: input.sha256 }, edits: [], notPossible: [] }));
  const zip = new PizZip();
  const date = new Date('2000-01-01T00:00:00.000Z');
  zip.file('01_restore.py', RESTORE_SCRIPT, { date });
  zip.file('commands.json', JSON.stringify({ schemaVersion: 1, originalPlanHash, outcome: 'not_possible',
    execution: { implementation: 'worker-buffer-copy', scriptExecuted: false },
    commands: ['python 01_restore.py /inputs /outputs'],
    files: inputs.map((input, index) => ({ inputId: input.id, originalName: input.name,
      inputAlias: `input-${index}.${input.format}`, outputAlias: `output-${index}.${input.format}`, sha256: input.sha256 })) }), { date });
  // STORE avoids compression-ratio surprises for this small trusted recipe.
  const recipe = zip.generate({ type: 'nodebuffer', compression: 'STORE' });
  const result = agentResultSchema.parse({ schemaVersion: 1, outputName: plan.outputName, outcome: 'not_possible',
    editsApplied: [], editsFailed: plan.edits.map((edit) => edit.id), partsModified: [], pagesAffected: [],
    warnings: reasons, selfCheck: { openedOk: false, textDiffMatchesPlan: false } });
  return { outputs, validationPlans, originalPlanHash, artifacts: [
    { kind: 'recipe', name: 'recipe.zip', data: recipe, sha256: sha256(recipe), mime: 'application/zip' },
    jsonArtifact('result.json', 'agent_result', result),
  ] };
}

/** Every child report is required; one failed/missing child blocks the whole job. */
export function combinePreservationReports(inputs: InputFile[], bundle: ConservativeBundle,
  reports: ValidationReport[]): ValidationReport {
  const complete = reports.length === inputs.length && bundle.outputs.length === inputs.length &&
    bundle.validationPlans.length === inputs.length && inputs.every((input, index) => {
      const report = reports[index]!;
      const output = bundle.outputs[index]!;
      return hasCompleteValidation(report, input.format) && report.originalSha256 === input.sha256 &&
        report.outputSha256 === input.sha256 && output.sha256 === input.sha256 &&
        sha256(output.data) === input.sha256 && input.data.equals(output.data);
    });
  const levels = ([1, 2, 3, 4] as const).map((level) => {
    const checks = reports.map((report) => report.levels.find((entry) => entry.level === level));
    // A missing report for an Office/PDF input is NOT a non-applicable check.
    const applicable = level === 1 || level === 4 ||
      inputs.some((input) => ['docx', 'xlsx', 'pptx', 'pdf'].includes(input.format));
    return { level, applicable, passed: complete && applicable,
      durationMs: checks.reduce((sum, check) => sum + (check?.durationMs ?? 0), 0),
      details: { purpose: 'preservation_not_edit_success', originalPlanHash: bundle.originalPlanHash,
        ...(applicable ? {} : { reason: 'Plain text is not paginated; see per-input independent reports.' }),
        inputs: inputs.map((input, index) => ({ inputId: input.id, sha256: input.sha256,
          validationPlan: bundle.validationPlans[index], report: checks[index] ?? null })) } };
  });
  return { passed: complete, originalSha256: inputs[0]?.sha256, outputSha256: bundle.outputs[0]?.sha256,
    levels, changes: [], artifacts: reports.flatMap((report, index) => (report.artifacts ?? []).map((artifact) => ({
      ...artifact, name: `input-${index}-${artifact.name}`,
    }))) };
}
