import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { sha256 } from '../src/modules/doc-sandbox/engine/artifacts';
import { createConservativeBundle, combinePreservationReports } from '../src/modules/doc-sandbox/queue/conservative-result';
import { agentResultSchema, classifyAgentResult, editPlanSchema, type EditPlan, type InputFile } from '../src/modules/doc-sandbox/types/contracts';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Actual source bytes, PizZip archives, hashes and the fixed trusted Python
// restoration recipe. No fabricated validator report and no engine/SDK call.
// This is not Office/PDF visual validation or evidence of gVisor isolation.
const inputs: InputFile[] = ([
  { id: 'one', name: 'tesis.txt', format: 'txt', mime: 'text/plain', data: Buffer.from('Título: 2026\r\nEspañol — 中文\r\n'), sha256: '' },
  { id: 'two', name: 'matriz.csv', format: 'csv', mime: 'text/csv', data: Buffer.from('nombre,valor\n"a,b",2026\n'), sha256: '' },
] satisfies InputFile[]).map(input => ({ ...input, sha256: sha256(input.data) }));
// Production freezePlan returns this schema's canonical field order before
// hashing. Keep that real boundary in the fixture instead of hashing a raw DTO.
const plan = (files = inputs, editing = false): EditPlan => editPlanSchema.parse({ schemaVersion: 1, mode: 'preserve',
  outputName: files[0]!.name, inputHashes: Object.fromEntries(files.map(input => [input.id, input.sha256])),
  edits: editing ? [{ id: 'edit-one', inputId: files[0]!.id, kind: 'text', part: '$document', locator: 'text', before: '2026', after: '2027' }] : [],
  notPossible: editing ? [] : [{ request: 'Unsupported synthetic instruction', reason: 'The source cannot be changed as requested.' }] });
const rejects = (error: unknown): boolean => error instanceof DocSandboxError && error.code === 'E_VALIDATION';
const python = process.env.DOC_SANDBOX_TEST_PYTHON || 'python3';

test('conservative bundle copies every input, freezes source identity and never claims a successful edit', () => {
  for (const editing of [false, true]) {
    const frozen = plan(inputs, editing), before = JSON.stringify(frozen);
    const bundle = createConservativeBundle(inputs, frozen, editing ? 'editing' : 'planning', ['Unable to preserve the requested change.']);
    assert.equal(JSON.stringify(frozen), before);
    assert.equal(bundle.originalPlanHash, sha256(Buffer.from(before)));
    assert.equal(bundle.outputs.length, inputs.length);
    for (const [index, output] of bundle.outputs.entries()) {
      const original = inputs[index]!;
      assert.equal(output.name, original.name);
      assert.equal(output.mime, original.mime);
      assert.equal(output.sha256, original.sha256);
      assert.notEqual(output.data, original.data);
      assert.deepEqual(output.data, original.data);
      assert.deepEqual(bundle.validationPlans[index], { schemaVersion: 1, mode: 'preserve', outputName: original.name,
        inputHashes: { [original.id]: original.sha256 }, edits: [], notPossible: [] });
    }
    const result = JSON.parse(bundle.artifacts.find(item => item.kind === 'agent_result')!.data.toString());
    assert.equal(classifyAgentResult(frozen, result), 'not_possible');
    assert.deepEqual(result.editsApplied, []);
    assert.deepEqual(result.editsFailed, editing ? ['edit-one'] : []);
    assert.deepEqual(result.partsModified, []);
    assert.deepEqual(result.pagesAffected, []);
    assert.deepEqual(result.selfCheck, { openedOk: false, textDiffMatchesPlan: false });
  }
});

test('a canonically valid refusal discards only blank warnings and preserves every original byte', () => {
  for (const editing of [false, true]) {
    const frozen = plan(inputs, editing);
    const warnings = ['', '  Cannot preserve the requested change.  ', '\t\n', 'Originals are retained.', '\u00a0'];
    const refusal = agentResultSchema.parse({ schemaVersion: 1, outputName: frozen.outputName,
      outcome: 'not_possible', editsApplied: [], editsFailed: frozen.edits.map(edit => edit.id),
      partsModified: [], pagesAffected: [], warnings,
      selfCheck: { openedOk: false, textDiffMatchesPlan: false } });
    const before = JSON.stringify({ frozen, refusal, inputs });
    Object.freeze(refusal.warnings);
    assert.equal(classifyAgentResult(frozen, refusal), 'not_possible');
    const bundle = createConservativeBundle(inputs, frozen, editing ? 'editing' : 'planning', refusal.warnings);
    const resultArtifact = bundle.artifacts.find(item => item.kind === 'agent_result')!;
    const result = agentResultSchema.parse(JSON.parse(resultArtifact.data.toString('utf8')));
    assert.equal(resultArtifact.sha256, sha256(resultArtifact.data));
    assert.equal(classifyAgentResult(frozen, result), 'not_possible');
    assert.deepEqual(result.warnings, ['  Cannot preserve the requested change.  ', 'Originals are retained.']);
    assert.deepEqual(result.editsApplied, []);
    assert.deepEqual(result.editsFailed, frozen.edits.map(edit => edit.id));
    assert.equal(bundle.outputs.length, inputs.length);
    for (const [index, output] of bundle.outputs.entries()) {
      assert.notEqual(output.data, inputs[index]!.data);
      assert.deepEqual(output.data, inputs[index]!.data);
      assert.equal(output.sha256, inputs[index]!.sha256);
    }
    assert.equal(JSON.stringify({ frozen, refusal, inputs }), before);
  }
});

test('empty or all-blank refusal reasons remain rejected by both classification and preservation', () => {
  const frozen = plan(inputs, true);
  for (const warnings of [[], [''], [' ', '\t\r\n', '\u00a0']]) {
    const refusal = agentResultSchema.parse({ schemaVersion: 1, outputName: frozen.outputName,
      outcome: 'not_possible', editsApplied: [], editsFailed: ['edit-one'], partsModified: [], pagesAffected: [],
      warnings, selfCheck: { openedOk: false, textDiffMatchesPlan: false } });
    const before = JSON.stringify({ refusal, frozen, inputs });
    assert.throws(() => classifyAgentResult(frozen, refusal), { message: 'DOC_RESULT_REFUSAL_INVALID' });
    for (const editing of [false, true]) {
      assert.throws(() => createConservativeBundle(inputs, plan(inputs, editing),
        editing ? 'editing' : 'planning', refusal.warnings), rejects);
    }
    assert.equal(JSON.stringify({ refusal, frozen, inputs }), before);
  }
});

test('blank normalization cannot bypass original warning length and count limits', () => {
  const frozen = plan(inputs, true);
  for (const warnings of [
    ['Valid reason.', ' '.repeat(2001)],
    ['Valid reason.', 'r'.repeat(2001)],
    ['Valid reason.', ...Array.from({ length: 100 }, () => '')],
  ]) {
    const before = JSON.stringify({ warnings, inputs, frozen });
    assert.throws(() => createConservativeBundle(inputs, frozen, 'editing', warnings), rejects);
    assert.equal(JSON.stringify({ warnings, inputs, frozen }), before);
  }
  const longestReason = 'r'.repeat(2000);
  const bundle = createConservativeBundle(inputs, frozen, 'editing',
    [longestReason, ...Array.from({ length: 99 }, () => '')]);
  const result = agentResultSchema.parse(JSON.parse(bundle.artifacts.find(item => item.kind === 'agent_result')!.data.toString('utf8')));
  assert.deepEqual(result.warnings, [longestReason]);
  assert.equal(classifyAgentResult(frozen, result), 'not_possible');
});

test('trusted recipe preserves exact UTF-8, CRLF and CSV bytes when executed by real Python', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'doc-sandbox-release-recipe-'));
  try {
    const bundle = createConservativeBundle(inputs, plan(), 'planning', ['Cannot apply the requested change.']);
    const recipe = bundle.artifacts.find(item => item.kind === 'recipe')!;
    assert.equal(recipe.sha256, sha256(recipe.data));
    const archive = new PizZip(recipe.data);
    assert.deepEqual(Object.keys(archive.files).sort(), ['01_restore.py', 'commands.json']);
    const manifest = JSON.parse(archive.file('commands.json')!.asText());
    assert.equal(manifest.originalPlanHash, bundle.originalPlanHash);
    assert.deepEqual(manifest.execution, { implementation: 'worker-buffer-copy', scriptExecuted: false });
    assert.deepEqual(manifest.files.map((item: { inputId: string; sha256: string }) => [item.inputId, item.sha256]), inputs.map(input => [input.id, input.sha256]));
    const source = path.join(directory, 'inputs'), destination = path.join(directory, 'outputs');
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(path.join(directory, 'commands.json'), archive.file('commands.json')!.asNodeBuffer(), { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(directory, '01_restore.py'), archive.file('01_restore.py')!.asNodeBuffer(), { flag: 'wx', mode: 0o600 });
    for (const [index, input] of inputs.entries()) writeFileSync(path.join(source, `input-${index}.${input.format}`), input.data, { flag: 'wx', mode: 0o600 });
    execFileSync(python, [path.join(directory, '01_restore.py'), source, destination], { timeout: 10_000, stdio: 'pipe' });
    for (const [index, input] of inputs.entries()) {
      const actual = readFileSync(path.join(destination, `output-${index}.${input.format}`));
      assert.deepEqual(actual, input.data);
      assert.equal(sha256(actual), input.sha256);
    }
    // The recipe does not overwrite existing outputs, even on a second run.
    const rerun = spawnSync(python, [path.join(directory, '01_restore.py'), source, destination], { timeout: 10_000, encoding: 'utf8' });
    assert.equal(rerun.error, undefined);
    assert.equal(rerun.status, 1);
    assert.match(rerun.stderr, /FileExistsError/);
    assert.deepEqual(readFileSync(path.join(destination, 'output-0.txt')), inputs[0]!.data);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('trusted recipe rejects tampered source hashes instead of restoring altered bytes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'doc-sandbox-release-recipe-reject-'));
  try {
    const archive = new PizZip(createConservativeBundle(inputs, plan(), 'planning', ['Cannot apply.']).artifacts.find(item => item.kind === 'recipe')!.data);
    const source = path.join(directory, 'inputs'), destination = path.join(directory, 'outputs');
    mkdirSync(source, { mode: 0o700 });
    for (const name of ['commands.json', '01_restore.py']) writeFileSync(path.join(directory, name), archive.file(name)!.asNodeBuffer(), { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(source, 'input-0.txt'), 'changed', { flag: 'wx', mode: 0o600 });
    const result = spawnSync(python, [path.join(directory, '01_restore.py'), source, destination], { timeout: 10_000, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Original hash mismatch/);
    assert.throws(() => readFileSync(path.join(destination, 'output-0.txt')), { code: 'ENOENT' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('conservative bundle refuses mismatched source identity, source count, stage and reasons', () => {
  const frozen = plan();
  const badInputs: InputFile[][] = [[], [inputs[0]!, inputs[0]!], Array.from({ length: 11 }, (_, index) => ({ ...inputs[0]!, id: `input-${index}` })),
    [{ ...inputs[0]!, data: Buffer.from('changed') }, inputs[1]!]];
  for (const files of badInputs) assert.throws(() => createConservativeBundle(files, frozen, 'planning', ['Reason.']), rejects);
  const planChanges: Partial<EditPlan>[] = [{ outputName: 'other.txt' }, { inputHashes: { one: inputs[0]!.sha256 } },
    { inputHashes: { one: 'b'.repeat(64), two: inputs[1]!.sha256 } }];
  for (const change of planChanges) {
    assert.throws(() => createConservativeBundle(inputs, { ...frozen, ...change }, 'planning', ['Reason.']), rejects);
  }
  assert.throws(() => createConservativeBundle(inputs, plan(inputs, true), 'planning', ['Reason.']), rejects);
  assert.throws(() => createConservativeBundle(inputs, frozen, 'editing', ['Reason.']), rejects);
  for (const reasons of [[], [' '], ['r'.repeat(2001)], Array.from({ length: 101 }, () => 'Reason.')]) {
    assert.throws(() => createConservativeBundle(inputs, frozen, 'planning', reasons), rejects);
  }
});

test('absent independent reports block every preservation result without fabricated validation', () => {
  const bundle = createConservativeBundle(inputs, plan(), 'planning', ['Cannot apply.']);
  const combined = combinePreservationReports(inputs, bundle, []);
  assert.equal(combined.passed, false);
  assert.deepEqual(combined.levels.map(level => [level.level, level.passed, level.applicable]),
    [[1, false, true], [2, false, false], [3, false, false], [4, false, true]]);
  assert.deepEqual(combined.artifacts, []);
  assert.deepEqual(combined.changes, []);
  assert.equal(combined.originalSha256, inputs[0]!.sha256);
  assert.equal(combined.outputSha256, inputs[0]!.sha256);
  for (const level of combined.levels) {
    assert.equal(level.durationMs, 0);
    assert.equal(level.details.purpose, 'preservation_not_edit_success');
    assert.equal(level.details.originalPlanHash, bundle.originalPlanHash);
  }
});
