'use strict';

// Real document/tool tests on the developer host. No validator mocks; this
// deliberately does NOT attest gVisor isolation or paid Anthropic execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { sha256 } = require('../dist/doc-sandbox/engine/artifacts');
const { createConservativeBundle, combinePreservationReports } = require('../dist/doc-sandbox/queue/conservative-result');
const { classifyAgentResult, hasCompleteValidation } = require('../dist/doc-sandbox/types/contracts');
const python = process.env.DOC_SANDBOX_TEST_PYTHON || 'python3';
const validator = path.resolve(__dirname, '../src/modules/doc-sandbox/validation/validator.py');

function checkedPython(args, input) {
  const result = spawnSync(python, args, { input, encoding: 'utf8', timeout: 120_000, maxBuffer: 24 * 1024 * 1024 });
  assert.equal(result.error, undefined, 'Real Python/tool process must start and finish');
  assert.equal(result.status, 0, `Real Python/tool process failed: ${result.stderr}`);
  return result.stdout;
}
function scan(root, index = 0) {
  const file = path.join(root, `input-${index}.pdf`);
  checkedPython(['-c', `import sys
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
image=Image.new('RGB',(595,842),'white')
ImageDraw.Draw(image).text((50,80),'Synthetic scanned paragraph '+sys.argv[2],fill='black')
c=canvas.Canvas(sys.argv[1],pagesize=(595,842),invariant=1)
c.drawImage(ImageReader(image),0,0,width=595,height=842)
c.save()
`, file, String(index)]);
  const data = readFileSync(file);
  return { id: `input-${index}`, name: `escaneado-${index}.pdf`, format: 'pdf', mime: 'application/pdf', data, sha256: sha256(data) };
}
function plan(inputs, editing = false) {
  return { schemaVersion: 1, mode: 'preserve', outputName: inputs[0].name,
    inputHashes: Object.fromEntries(inputs.map(input => [input.id, input.sha256])),
    edits: editing ? [{ kind: 'pdf_rotate', id: 'rotate', inputId: inputs[0].id, pages: [1], degrees: 90 }] : [],
    notPossible: editing ? [] : [{ request: 'Reescribir el párrafo escaneado', reason: 'Requiere una fuente editable; no se ha editado ningún archivo.' }] };
}
function realValidate(root, input, output, validationPlan, suffix) {
  const source = path.join(root, `source-${suffix}.pdf`), destination = path.join(root, `output-${suffix}.pdf`);
  writeFileSync(source, input.data, { flag: 'wx', mode: 0o600 });
  writeFileSync(destination, output, { flag: 'wx', mode: 0o600 });
  const response = JSON.parse(checkedPython([validator], JSON.stringify({ command: 'validate',
    inputs: [{ id: input.id, name: input.name, path: source }], outputPath: destination, plan: validationPlan,
    artifactDir: path.join(root, `artifacts-${suffix}`), inlineArtifacts: true })));
  assert.equal(response.ok, true);
  const report = response.report;
  return { ...report, artifacts: report.artifactFiles.map(name => {
    const data = Buffer.from(report.artifactData[name], 'base64');
    return { name, data, sha256: sha256(data), mime: name.endsWith('.png') ? 'image/png' : 'application/json',
      kind: name === 'text-diff.json' ? 'text_diff' : name.startsWith('before') ? 'thumbnail_before' : 'thumbnail_after' };
  }) };
}

test('planning refusal restores a scanned PDF and passes four real independent levels without claiming an edit', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-conservative-real-'));
  try {
    const original = scan(root), frozen = plan([original]), serialized = JSON.stringify(frozen);
    const bundle = createConservativeBundle([original], frozen, 'planning', [frozen.notPossible[0].reason]);
    assert.equal(JSON.stringify(frozen), serialized);
    assert.equal(bundle.originalPlanHash, sha256(Buffer.from(serialized)));
    assert.equal(bundle.outputs[0].name, original.name);
    assert.notEqual(bundle.outputs[0].data, original.data);
    assert.deepEqual(bundle.outputs[0].data, original.data);
    const report = realValidate(root, original, bundle.outputs[0].data, bundle.validationPlans[0], 'scan');
    assert.ok(hasCompleteValidation(report, 'pdf'), JSON.stringify(report.levels));
    assert.deepEqual(report.levels.map(level => [level.level, level.passed, level.applicable]), [[1,true,true],[2,true,true],[3,true,true],[4,true,true]]);
    const combined = combinePreservationReports([original], bundle, [report]);
    assert.ok(hasCompleteValidation(combined, 'pdf'));
    assert.deepEqual(combined.changes, []);
    assert.equal(combined.levels[0].details.originalPlanHash, bundle.originalPlanHash);
    const result = JSON.parse(bundle.artifacts.find(item => item.kind === 'agent_result').data);
    assert.equal(result.outcome, 'not_possible'); assert.deepEqual(result.editsApplied, []);
    assert.equal(result.selfCheck.openedOk, false, 'Only real independent validation, not a fabricated self-check');
    assert.equal(classifyAgentResult(frozen, result), 'not_possible');
    const recipePath = path.join(root, 'recipe.zip');
    writeFileSync(recipePath, bundle.artifacts.find(item => item.kind === 'recipe').data, { mode: 0o600 });
    const recipe = JSON.parse(checkedPython([validator], JSON.stringify({ command: 'inspect_recipe',
      inputs: [{ id: 'recipe', name: 'recipe.zip', path: recipePath }] })));
    assert.equal(recipe.ok, true); assert.deepEqual(recipe.recipe.scripts, ['01_restore.py']);
    // Reproduce the fixed trusted recipe for verification, not generated code.
    const source = path.join(root, 'recipe-inputs'), target = path.join(root, 'recipe-outputs');
    mkdirSync(source); writeFileSync(path.join(source, 'input-0.pdf'), original.data);
    checkedPython(['-c', `import pathlib,sys,zipfile,subprocess
root=pathlib.Path(sys.argv[1]); archive=zipfile.ZipFile(root/'recipe.zip')
archive.extractall(root/'recipe')
subprocess.run([sys.executable,str(root/'recipe'/'01_restore.py'),str(root/'recipe-inputs'),str(root/'recipe-outputs')],check=True)
`, root]);
    assert.deepEqual(readFileSync(path.join(target, 'output-0.pdf')), original.data);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('execution refusal preserves every PDF; missing or modified output fails real validation and the all-input gate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-conservative-multiple-'));
  try {
    const inputs = [scan(root, 0), scan(root, 1)], frozen = plan(inputs, true), originalPlan = JSON.stringify(frozen);
    const bundle = createConservativeBundle(inputs, frozen, 'editing', ['The full requested operation cannot preserve every source.']);
    const result = JSON.parse(bundle.artifacts.find(item => item.kind === 'agent_result').data);
    assert.equal(result.outcome, 'not_possible'); assert.deepEqual(result.editsFailed, ['rotate']);
    assert.equal(classifyAgentResult(frozen, result), 'not_possible');
    assert.equal(JSON.stringify(frozen), originalPlan);
    const reports = inputs.map((input, index) => realValidate(root, input, bundle.outputs[index].data, bundle.validationPlans[index], `real-${index}`));
    assert.ok(reports.every(report => hasCompleteValidation(report, 'pdf')), JSON.stringify(reports.map(report => report.levels)));
    assert.ok(hasCompleteValidation(combinePreservationReports(inputs, bundle, reports), 'pdf'));
    assert.equal(combinePreservationReports(inputs, bundle, reports.slice(0, 1)).passed, false);
    assert.equal(combinePreservationReports(inputs, { ...bundle, outputs: bundle.outputs.slice(0, 1) }, reports).passed, false);
    const modified = Buffer.concat([bundle.outputs[1].data, Buffer.from('\n')]);
    const rejected = realValidate(root, inputs[1], modified, bundle.validationPlans[1], 'modified');
    assert.equal(rejected.passed, false); assert.equal(rejected.levels[0].details.code, 'NOOP_CHANGED');
    assert.equal(combinePreservationReports(inputs, bundle, [reports[0], rejected]).passed, false);
    assert.equal(combinePreservationReports(inputs, { ...bundle, outputs: bundle.outputs.map((item, index) => index ? { ...item, data: modified } : item) }, reports).passed, false);
    assert.throws(() => classifyAgentResult(frozen, { ...result, outcome: 'edited' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conservative contract rejects partial plans, tampered input hashes, absent reasons, and fake success claims', () => {
  const data = Buffer.from('unmodified'), input = { id: 'one', name: 'a.txt', format: 'txt', mime: 'text/plain', data, sha256: sha256(data) };
  const frozen = plan([input]);
  assert.throws(() => createConservativeBundle([input], { ...frozen, inputHashes: { one: 'a'.repeat(64) } }, 'planning', ['reason']));
  assert.throws(() => createConservativeBundle([input], frozen, 'planning', []));
  assert.throws(() => createConservativeBundle([input], frozen, 'planning', [' ']));
  assert.throws(() => createConservativeBundle([input], { ...frozen, edits: [{ kind: 'text', id: 'e1', inputId: 'one', part: '$document', locator: 'text', before: 'unmodified', after: 'changed' }] }, 'planning', ['reason']));
  const result = JSON.parse(createConservativeBundle([input], frozen, 'planning', ['reason']).artifacts.find(item => item.kind === 'agent_result').data);
  assert.throws(() => classifyAgentResult(frozen, { ...result, outcome: 'edited' }));
  assert.throws(() => classifyAgentResult(frozen, { ...result, editsApplied: ['e1'] }));
  assert.throws(() => classifyAgentResult(frozen, { ...result, partsModified: ['$document'] }));
});
