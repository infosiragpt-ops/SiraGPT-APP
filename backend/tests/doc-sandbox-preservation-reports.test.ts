import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/modules/doc-sandbox/engine/artifacts';
import { combinePreservationReports, createConservativeBundle } from '../src/modules/doc-sandbox/queue/conservative-result';
import { editPlanSchema, type InputFile, type ValidationReport } from '../src/modules/doc-sandbox/types/contracts';

function file(id: string, name: string, format: InputFile['format'], mime: string, text: string): InputFile {
  const data = Buffer.from(text);
  return { id, name, format, mime, data, sha256: sha256(data) };
}

function report(input: InputFile, overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    passed: true, originalSha256: input.sha256, outputSha256: input.sha256, changes: [],
    levels: ([1, 2, 3, 4] as const).map(level => ({
      level, passed: true, applicable: true, durationMs: 4, details: { reason: 'ok' },
    })),
    artifacts: [{ name: 'text-diff.json', kind: 'text_diff', mime: 'application/json',
      data: Buffer.from('{}'), sha256: sha256(Buffer.from('{}')) }],
    ...overrides,
  };
}

test('incomplete or hash-mismatched child reports fail the combined preservation gate', () => {
  const inputs = [file('one', 'a.txt', 'txt', 'text/plain', 'A'), file('two', 'b.txt', 'txt', 'text/plain', 'B')];
  const plan = editPlanSchema.parse({
    schemaVersion: 1, mode: 'preserve', outputName: 'a.txt',
    inputHashes: Object.fromEntries(inputs.map(input => [input.id, input.sha256])),
    edits: [], notPossible: [{ request: 'x', reason: 'Cannot preserve the requested change.' }],
  });
  const bundle = createConservativeBundle(inputs, plan, 'planning', ['Cannot preserve the requested change.']);
  const incomplete = combinePreservationReports(inputs, bundle, [report(inputs[0]!)]);
  assert.equal(incomplete.passed, false);
  const mismatched = combinePreservationReports(inputs, bundle, [
    report(inputs[0]!), report(inputs[1]!, { originalSha256: '0'.repeat(64), passed: false }),
  ]);
  assert.equal(mismatched.passed, false);
  const ok = combinePreservationReports(inputs, bundle, inputs.map(input => report(input)));
  assert.equal(ok.passed, true);
  assert.equal(ok.artifacts?.[0]?.name, 'input-0-text-diff.json');
  assert.equal(ok.originalSha256, inputs[0]!.sha256);
  assert.equal(ok.outputSha256, bundle.outputs[0]!.sha256);
});

test('office originals keep pagination levels applicable even when a child report is missing', () => {
  const inputs = [file('doc', 'memo.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK')];
  const plan = editPlanSchema.parse({
    schemaVersion: 1, mode: 'preserve', outputName: 'memo.docx',
    inputHashes: { doc: inputs[0]!.sha256 }, edits: [],
    notPossible: [{ request: 'x', reason: 'The source cannot be changed as requested.' }],
  });
  const bundle = createConservativeBundle(inputs, plan, 'planning', ['The source cannot be changed as requested.']);
  const combined = combinePreservationReports(inputs, bundle, []);
  assert.equal(combined.passed, false);
  assert.equal(combined.levels.every(level => level.applicable), true);
  assert.equal(combined.levels.every(level => level.passed === false), true);
});
