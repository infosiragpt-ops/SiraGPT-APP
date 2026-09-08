'use strict';
// Oracle regression tests, NOT editor goldens or validation attestations.
// Real originals and the actual Office inspector; deliberately mutated test
// outputs test the oracle itself. No provider, Docker runtime or fake report.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const PizZip = require('pizzip');
const { buildFixtures, sha256 } = require('./fixtures/build-docs.cjs');
const { loadComplexCases } = require('./fixtures/complex-cases.cjs');
const { verifyOffice, verifyPdfPlan, expectedPdfEdits, verifyComplexOutcome, verifyComplexExpected } = require('./fixtures/complex-oracle.cjs');
const { loadSuite } = require('./doc-sandbox-real.cjs');
let directory, cases;
test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-complex-oracle-unit-'));
  await buildFixtures(path.join(directory, 'originals'));
  cases = await loadComplexCases(path.join(directory, 'originals'));
  for (const candidate of cases) candidate.inputs = candidate.inputs.map((input, index) => ({ ...input, id: `input-${index}` }));
});
test.after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });
async function inventory(input) {
  const target = await fs.mkdtemp(path.join(directory, 'inspect-'));
  await fs.writeFile(path.join(target, input.name), input.data);
  const validator = path.join(__dirname, '../src/modules/doc-sandbox/validation/validator.py');
  const code = 'import importlib.util,json,sys; from pathlib import Path; s=importlib.util.spec_from_file_location("validator",sys.argv[1]); v=importlib.util.module_from_spec(s); s.loader.exec_module(v); print(json.dumps(v.inspect(Path(sys.argv[2]),sys.argv[3])))';
  const result = spawnSync(process.env.DOC_FIXTURE_PYTHON || 'python3', ['-c', code, validator, path.join(target, input.name), input.name],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function mutate(input, edits) {
  const zip = new PizZip(input.data);
  for (const [name, transform] of edits) {
    const before = zip.file(name).asText(), after = transform(before);
    assert.notEqual(before, after, 'Regression mutation must actually modify its intended XML');
    zip.file(name, after, { createFolders: false });
  }
  const data = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  return { ...input, data, sha256: sha256(data) };
}
async function check(id, edits, extra = []) {
  const candidate = cases.find((entry) => entry.id === id), original = candidate.inputs[0];
  const output = mutate(original, [...edits, ...extra]);
  return verifyOffice(candidate, output, [await inventory(original)], await inventory(output));
}
const word = [['word/document.xml', (xml) => xml.replace('compras reduce', 'compras mejora')]];
const sheet = [['xl/worksheets/sheet1.xml', (xml) => xml.replace(/(<c r="B4"[^>]*><v>)100(<\/v>)/, '$1110$2')
  .replace(/(<c r="B5"[^>]*><v>)120(<\/v>)/, '$1130$2').replace(/(<c r="B6"[^>]*><v>)80(<\/v>)/, '$190$2')]];
const slides = [
  ['ppt/slides/slide3.xml', (xml) => xml.replace('Objetivos originales 2026', 'Objetivos revisados 2027')],
  ['ppt/notesSlides/notesSlide3.xml', (xml) => xml.replace('Nota original de la diapositiva 3.', 'Nota revisada de la diapositiva 3.')],
];
test('complex loader is opt-in and yields all six candidates without editor/phase claims', async () => {
  const loaded = await loadSuite({ suite: 'complex', 'fixtures-dir': path.join(directory, 'originals') });
  assert.deepEqual(loaded.fixtures.map((entry) => entry.id), ['G1', 'G4', 'G7', 'G8', 'G11', 'G10']);
  assert.ok(loaded.fixtures.every((entry) => entry.candidateOnly === true));
  const smoke = await loadSuite({ suite: 'smoke' });
  assert.equal(smoke.fixtures.length, 5); assert.ok(smoke.fixtures.every((entry) => entry.id.startsWith('SMOKE_')));
});
test('G1 oracle accepts only exact phrase replacement and preserved run properties', async () => {
  const result = await check('G1', word); assert.equal(result.changes.length, 1);
  await assert.rejects(check('G1', []), /incomplete/);
  await assert.rejects(check('G1', word, [['word/document.xml', (xml) => xml.replace('174A45', 'FF0000')]]), /formatting changed/);
  await assert.rejects(check('G1', word, [['word/header1.xml', (xml) => xml.replace('UNIVERSIDAD', 'ALTERADA')]]), /Unrequested package part/);
  await assert.rejects(check('G1', word, [['word/document.xml', (xml) => xml.replace('Primera observacion', 'Cambio indebido')]]), /outside/);
});
test('G4 oracle accepts all three exact cells and refuses changed formulas/chart/shared strings', async () => {
  const result = await check('G4', sheet); assert.equal(result.changes.length, 3);
  await assert.rejects(check('G4', []));
  await assert.rejects(check('G4', sheet, [['xl/worksheets/sheet1.xml', (xml) => xml.replace('B4*C4', 'B4+C4')]]), /outside/);
  await assert.rejects(check('G4', sheet, [['xl/sharedStrings.xml', (xml) => xml.replace('Encabezado', 'Modificado')]]), /Unrequested package part/);
  await assert.rejects(check('G4', sheet, [['xl/charts/chart1.xml', (xml) => xml.replace('Subtotales de prueba', 'Grafico alterado')]]), /Unrequested package part/);
  await assert.rejects(check('G4', sheet, [['xl/workbook.xml', (xml) => xml.replace('fullCalcOnLoad="1"', 'fullCalcOnLoad="0"')]]), /recalculation/);
});
test('G7 oracle accepts slide 3 plus note and rejects missing note or unrelated slide', async () => {
  const result = await check('G7', slides); assert.equal(result.changes.length, 2);
  await assert.rejects(check('G7', slides.slice(0, 1)), /more than/);
  await assert.rejects(check('G7', slides, [['ppt/slides/slide1.xml', (xml) => xml.replace('Defensa sintetica', 'Defensa alterada')]]), /Unrequested package part/);
});
test('G8 plan oracle requires exact merge order and page-local coordinates for every overlay', () => {
  const inputs = cases.find((entry) => entry.id === 'G8').inputs;
  const edits = expectedPdfEdits(inputs);
  verifyPdfPlan({ edits }, inputs);
  for (const wrong of [edits.slice(0, 6), [...edits, edits[1]],
    edits.map((edit) => edit.kind === 'pdf_merge' ? { ...edit, inputIds: [...edit.inputIds].reverse() } : edit),
    edits.map((edit, index) => index === 1 ? { ...edit, x: 271 } : edit),
    edits.map((edit, index) => index === 6 ? { ...edit, inputId: inputs[0].id, page: 3 } : edit)])
    assert.throws(() => verifyPdfPlan({ edits: wrong }, inputs), /all six/);
});
test('complex result gate rejects false outcomes before a validation report can be used', () => {
  for (const id of ['G10', 'G11']) {
    const candidate = cases.find((entry) => entry.id === id), input = candidate.inputs[0];
    const plan = { schemaVersion: 1, mode: 'preserve', outputName: input.name, inputHashes: { [input.id]: input.sha256 }, edits: [], notPossible: [] };
    const result = { schemaVersion: 1, outputName: input.name, outcome: 'edited', editsApplied: [], editsFailed: [],
      partsModified: [], pagesAffected: [], warnings: [], selfCheck: { openedOk: true, textDiffMatchesPlan: true } };
    assert.throws(() => verifyComplexExpected(candidate, input, [], {}, plan, undefined, { status: 'done', outcome: 'edited' }, result), /Persisted job outcome/);
  }
});
test('G10/G11 byte-and-outcome oracle distinguishes unchanged from explicit impossible, without validation attestation', () => {
  for (const id of ['G10', 'G11']) {
    const candidate = cases.find((entry) => entry.id === id), input = candidate.inputs[0];
    const outcome = id === 'G10' ? 'not_possible' : 'unchanged';
    const plan = { schemaVersion: 1, mode: 'preserve', outputName: input.name, inputHashes: { [input.id]: input.sha256 }, edits: [],
      notPossible: id === 'G10' ? [{ request: 'Reescribir texto escaneado', reason: 'El original solo contiene una imagen.' }] : [] };
    const result = { schemaVersion: 1, outputName: input.name, outcome, editsApplied: [], editsFailed: [],
      partsModified: [], pagesAffected: [], warnings: id === 'G10' ? ['El PDF no contiene texto editable.'] : [],
      selfCheck: { openedOk: false, textDiffMatchesPlan: false } };
    const job = { status: 'done', outcome };
    assert.equal(verifyComplexOutcome(candidate, input, plan, job, result).outcome, outcome);
    assert.throws(() => verifyComplexOutcome(candidate, { ...input, data: Buffer.concat([input.data, Buffer.from('tamper')]) }, plan, job, result), /byte-identical/);
    assert.throws(() => verifyComplexOutcome(candidate, input, plan, { ...job, status: 'failed' }, result));
    assert.throws(() => verifyComplexOutcome(candidate, input, plan, job, { ...result, partsModified: ['word/document.xml'] }));
    if (id === 'G10') {
      assert.throws(() => verifyComplexOutcome(candidate, input, plan, job, { ...result, warnings: [] }), /refusal reason/);
      assert.throws(() => verifyComplexOutcome(candidate, input, { ...plan, notPossible: [] }, job, result), /disguise refusal/);
    }
  }
});
