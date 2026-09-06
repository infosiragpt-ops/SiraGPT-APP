import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../../src/modules/doc-sandbox/engine/artifacts';
import { editPlanSchema, hashSchema, type EditPlan, type InputFile, type ValidationReport } from '../../src/modules/doc-sandbox/types/contracts';

export interface TextFailureEvidenceFixture {
  original: InputFile;
  requestedOutput: Buffer;
  incorrectOutput: Buffer;
  plan: EditPlan;
}

/** Synthetic source/plan only; reusable without registering node:test cases. */
export function createTextFailureEvidenceFixture(): TextFailureEvidenceFixture {
  const data = Buffer.from('2026', 'utf8');
  const original: InputFile = { id: 'original-year', name: 'year.txt', format: 'txt',
    mime: 'text/plain', data, sha256: sha256(data) };
  return { original, requestedOutput: Buffer.from('2027', 'utf8'), incorrectOutput: Buffer.from('2028', 'utf8'),
    plan: editPlanSchema.parse({ schemaVersion: 1, mode: 'preserve', outputName: original.name,
      inputHashes: { [original.id]: original.sha256 }, edits: [{ kind: 'text', id: 'replace-year', inputId: original.id,
        part: '$document', locator: 'text', before: '2026', after: '2027' }], notPossible: [] }) };
}

const responseSchema = z.object({ ok: z.literal(true), report: z.object({
  schemaVersion: z.literal(1), passed: z.boolean(), originalSha256: hashSchema, outputSha256: hashSchema,
  levels: z.array(z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    passed: z.boolean(), applicable: z.boolean(), details: z.record(z.string(), z.unknown()),
    durationMs: z.number().finite().nonnegative() }).strict()),
  artifactFiles: z.array(z.string()), artifactData: z.record(z.string(), z.string()), changes: z.array(z.unknown()),
}).strict() }).strict();
const diffSchema = z.object({ schemaVersion: z.literal(1),
  observedChanges: z.array(z.object({ part: z.string(), locator: z.string(), before: z.string().nullable(),
    after: z.string().nullable() }).strict()), validatedChanges: z.array(z.unknown()),
}).strict();

/**
 * Executes ONLY the checked-in Python validator on this small TXT fixture.
 * Returned reports/artifacts come from that process and its real filesystem,
 * never a replacement validator. This does not attest runsc or persistence.
 */
export function runRealTextEvidenceValidation(fixture: TextFailureEvidenceFixture, candidate: Buffer) {
  assert.ok(fixture.original.data.length > 0 && fixture.original.data.length <= 1024);
  assert.ok(candidate.length > 0 && candidate.length <= 1024);
  assert.equal(fixture.original.sha256, sha256(fixture.original.data));
  const directory = mkdtempSync(path.join(tmpdir(), 'doc-failure-evidence-'));
  try {
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    const originalPath = path.join(directory, 'original.txt');
    const candidatePath = path.join(directory, 'candidate.txt');
    const artifactDirectory = path.join(directory, 'artifacts');
    writeFileSync(originalPath, fixture.original.data, { flag: 'wx', mode: 0o600 });
    writeFileSync(candidatePath, candidate, { flag: 'wx', mode: 0o600 });
    const result = spawnSync(process.env.DOC_SANDBOX_TEST_PYTHON || 'python3',
      [path.resolve(__dirname, '../../src/modules/doc-sandbox/validation/validator.py')], {
        input: JSON.stringify({ command: 'validate',
          inputs: [{ id: fixture.original.id, name: fixture.original.name, path: originalPath }],
          outputPath: candidatePath, plan: fixture.plan, artifactDir: artifactDirectory, inlineArtifacts: true }),
        encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, TMPDIR: directory,
          PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
      });
    assert.equal(result.error, undefined, 'The real Python validator must start and finish within its bound');
    assert.equal(result.signal, null, 'The real Python validator must not be killed');
    assert.equal(result.status, 0, 'The real Python validator must exit successfully (stderr withheld)');
    const { report: rawReport } = responseSchema.parse(JSON.parse(result.stdout) as unknown);
    assert.deepEqual(rawReport.artifactFiles, ['text-diff.json']);
    assert.deepEqual(Object.keys(rawReport.artifactData), ['text-diff.json']);
    const data = readFileSync(path.join(artifactDirectory, 'text-diff.json'));
    assert.equal(rawReport.artifactData['text-diff.json'], data.toString('base64'));
    const textDiff = diffSchema.parse(JSON.parse(data.toString('utf8')) as unknown);
    // Same projection as IndependentDocumentValidator.validate; every value
    // below is read from the actual Python result or emitted artifact bytes.
    const report: ValidationReport = { passed: rawReport.passed, levels: rawReport.levels,
      originalSha256: rawReport.originalSha256, outputSha256: rawReport.outputSha256, changes: rawReport.changes,
      artifacts: [{ name: 'text-diff.json', kind: 'text_diff', data, mime: 'application/json', sha256: sha256(data) }] };
    return { report, textDiff, directory, originalAfter: readFileSync(originalPath), candidateAfter: readFileSync(candidatePath) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
