'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');
const { PDFDocument } = require('pdf-lib');
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph } = require('docx');
const PptxGenJS = require('pptxgenjs');
const adapter = require('../src/services/document-editing/pptx-adapter');
const { parsePresentationTitleEdit, slideNumberFromRequest } = require('../src/services/document-editing/presentation-title-intent');
const { verifyContentChanged, verifySlideTitleEdit } = require('../src/services/document-editing/edit-output-proof');
const { runAgentRunner, runAgentRunnerForChat, collectValidOutputs } = require('../src/services/agent-runner');
const { trySurgicalPresentationFollowup } = require('../src/services/agent-runner/surgical-followup');
const { getLatestConversationArtifact, resolveTurnFiles, loadArtifactBuffer, persistOutputs } = require('../src/services/agent-runner/artifacts');
const editor = require('../src/services/source-preserving-document-edit');
const PROMPT = 'en la primera Landin agrega en la Historia de los Dinosaurios de 1998.';
const NEW_TITLE = 'Historia de los Dinosaurios de 1998';
async function deck() {
  const pptx = new PptxGenJS();
  for (let n = 1; n <= 11; n++) {
    const slide = pptx.addSlide(); slide.background = { color: '142A42' };
    slide.addText(n === 1 ? 'Historia de los Dinosaurios' : `Capítulo ${n}`, { x: 1, y: 0.5, w: 8, h: 1, bold: true, fontSize: 30, color: 'F0D290' });
    slide.addText(`Contenido científico ${n}`, { x: 1, y: 2, w: 8, h: 2, fontSize: 16 });
    slide.addNotes(`Notas originales ${n}`);
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}
function changedParts(a, b) {
  const before = new PizZip(a); const after = new PizZip(b);
  assert.deepEqual(Object.keys(before.files).sort(), Object.keys(after.files).sort());
  return Object.keys(before.files).filter((name) => !before.files[name].dir && !before.file(name).asNodeBuffer().equals(after.file(name).asNodeBuffer()));
}
test('exact user follow-up edits the existing 11-slide ZIP without any model or sandbox regeneration', async () => {
  const original = await deck(); const copy = Buffer.from(original);
  const result = await runAgentRunner({ files: [{ name: 'historia_dinosaurios.pptx', buffer: original, isPriorArtifact: true }], instruction: PROMPT,
    client: { chat: { completions: { create() { throw new Error('No paid call permitted'); } } } } });
  assert.equal(result.stoppedReason, 'surgical_edit'); assert.equal(result.iterations, 0);
  assert.equal(result.outputs.length, 1); assert.equal(result.outputs[0].valid, true);
  assert.deepEqual(original, copy, 'original bytes immutable');
  assert.equal(adapter.listPptxSlides(result.outputs[0].buffer)[0].title, NEW_TITLE);
  assert.equal(adapter.listPptxSlides(result.outputs[0].buffer).length, 11);
  assert.deepEqual(changedParts(original, result.outputs[0].buffer), ['ppt/slides/slide1.xml']);
  assert.match(result.finalText, /Cambié/); assert.doesNotMatch(result.finalText, /Generé/);
});
test('ordinal, misspelling and explicit title parsing remain grounded in the existing title', () => {
  for (const unit of ['primera lámina', 'primera Landin', 'primera diapositiva', 'slide 1', 'portada']) assert.equal(slideNumberFromRequest(unit), 1);
  assert.deepEqual(parsePresentationTitleEdit(PROMPT, { slides: [{ number: 1, title: 'Historia de los Dinosaurios' }] }), { kind: 'set_slide_title', slideNumber: 1, title: NEW_TITLE });
  assert.equal(parsePresentationTitleEdit(PROMPT, { slides: [{ number: 1, title: 'Tema distinto' }] }), null);
  assert.equal(parsePresentationTitleEdit('En la primera lámina cambia el título a Nuevo y agrega una tabla'), null);
  assert.equal(editor.isSourcePreservingEditRequest(PROMPT, []), true);
});
test('no-op requested title yields no downloadable output, not an invented success', async () => {
  const original = await deck();
  const result = await runAgentRunner({ files: [{ name: 'historia.pptx', buffer: original }], instruction: 'En la primera lámina cambia el título a Historia de los Dinosaurios' });
  assert.equal(result.outputs.length, 0); assert.equal(result.stoppedReason, 'edit_not_applied');
  assert.match(result.finalText, /ya coincide/);
});
test('title fast path never hijacks Word/Excel/PDF edits or silently completes one compound operation', async () => {
  for (const format of ['docx', 'xlsx', 'pdf']) assert.equal(trySurgicalPresentationFollowup({ instruction: 'Cambia el título a Nuevo título', files: [{ name: `original.${format}`, buffer: Buffer.from('other adapter') }] }), null);
  const original = await deck();
  for (const instruction of ['En la primera lámina cambia el título a Nuevo y pinta el fondo rojo', 'En la primera lámina cambia el título a Nuevo y una tabla de resultados', 'En la primera lámina cambia el título a Nuevo, agrega una imagen']) {
    assert.equal(trySurgicalPresentationFollowup({ instruction, files: [{ name: 'historia.pptx', buffer: original }] }), null);
  }
});
test('same exact instruction works through the source-preserving document entry with real saved bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-followup-source-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = await deck(); const filePath = path.join(dir, 'historia_dinosaurios.pptx'); fs.writeFileSync(filePath, original);
  const result = await editor.generateSourcePreservingDocumentEdit({ sourceFile: { id: 'real-pptx', path: filePath, originalName: 'historia_dinosaurios.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }, prompt: PROMPT, displayPrompt: PROMPT, userId: 'test-followup-owner', chatId: 'test-followup-chat' });
  assert.equal(result.validation.passed, true); assert.equal(result.format, 'pptx');
  const edited = fs.readFileSync(result.artifact.path);
  assert.equal(adapter.listPptxSlides(edited)[0].title, NEW_TITLE);
  assert.deepEqual(changedParts(original, edited), ['ppt/slides/slide1.xml']);
  assert.deepEqual(fs.readFileSync(filePath), original);
});
test('an unresolved edit inside the first slide asks for exact text, never appends an annex', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-followup-unclear-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = await deck(); const filePath = path.join(dir, 'historia.pptx'); fs.writeFileSync(filePath, original);
  const prompt = 'En la primera Landin agrega en el Tema No Existente de 1998';
  const result = await editor.generateSourcePreservingDocumentEdit({ sourceFile: { path: filePath, originalName: 'historia.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }, prompt, displayPrompt: prompt, userId: 'test-owner', chatId: 'test-chat' });
  assert.equal(result.clarification, true); assert.equal(result.artifact, null);
  assert.match(result.content, /texto actual y el texto nuevo/);
  assert.deepEqual(fs.readFileSync(filePath), original);
});
test('strict proof rejects old title, another slide change, extra slide, and a body edit', async () => {
  const original = await deck(); const edit = { slideNumber: 1, title: NEW_TITLE };
  assert.equal(verifySlideTitleEdit(original, original, edit).passed, false);
  const correct = adapter.setSlideTitle({ buffer: original, ...edit }).buffer;
  assert.equal(verifySlideTitleEdit(original, correct, edit).passed, true);
  const wrong = adapter.setSlideTitle({ buffer: correct, slideNumber: 2, title: 'Cambio indebido' }).buffer;
  assert.equal(verifySlideTitleEdit(original, wrong, edit).passed, false);
  const zip = new PizZip(correct); zip.file('ppt/slides/slide1.xml', zip.file('ppt/slides/slide1.xml').asText().replace('Contenido científico 1', 'Cambio indebido'));
  assert.equal(verifySlideTitleEdit(original, zip.generate({ type: 'nodebuffer' }), edit).passed, false);
  zip.file('ppt/slides/slide12.xml', zip.file('ppt/slides/slide1.xml').asText());
  assert.equal(verifySlideTitleEdit(original, zip.generate({ type: 'nodebuffer' }), edit).passed, false);
});
test('shared runner rejects byte-identical real DOCX/XLSX/PPTX/PDF files and Office metadata-only repacks', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Datos').getCell('A1').value = 2026;
  const pdf = await PDFDocument.create(); pdf.addPage();
  const samples = { docx: await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Título 2026')] }] })),
    xlsx: Buffer.from(await workbook.xlsx.writeBuffer()), pptx: await deck(), pdf: Buffer.from(await pdf.save()) };
  for (const [format, buffer] of Object.entries(samples)) {
    const outputs = await collectValidOutputs({ collectOutputs: async () => [{ name: `editado.${format}`, buffer: Buffer.from(buffer) }] }, () => {},
      { files: [{ name: `original.${format}`, buffer }], isEdit: true, instruction: 'Cambia 2026 por 2027' });
    assert.equal(outputs[0].valid, false, format);
    if (format !== 'pdf') {
      const zip = new PizZip(buffer); zip.file('docProps/core.xml', (zip.file('docProps/core.xml')?.asText() || '') + ' ');
      assert.equal(verifyContentChanged(buffer, zip.generate({ type: 'nodebuffer' }), format).passed, false, `${format} metadata-only`);
    }
  }
});
test('latest requested-format artifact wins over newer preview and reattached original', async () => {
  const latest = await deck(); const original = Buffer.from(latest);
  const rows = [{ id: 'preview', filename: 'preview.pdf', path: '/preview' }, { id: 'last-edit', filename: 'historia_editada.pptx', path: '/edited' }];
  const prisma = { generatedArtifact: { findMany: async (query) => { assert.deepEqual(query.where, { userId: 'u', chatId: 'c' }); return rows; } } };
  assert.equal((await getLatestConversationArtifact(prisma, { userId: 'u', chatId: 'c', instruction: PROMPT })).id, 'last-edit');
  const result = await resolveTurnFiles({ prisma, userId: 'u', chatId: 'c', instruction: PROMPT, attachedFiles: [{ name: 'original.pptx', buffer: original }], objectStorage: { readFile: async (p) => { assert.equal(p, '/edited'); return latest; } } });
  assert.equal(result.files[0].artifactId, 'last-edit'); assert.equal(result.files[0].isPriorArtifact, true);
});
test('multiple DOCX/PPTX edits map each output to its named original and ambiguous names fail closed', async () => {
  for (const format of ['docx', 'pptx']) {
    const first = format === 'docx' ? await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Documento uno 2026')] }] })) : await deck();
    const second = format === 'docx' ? await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Documento dos 2026')] }] })) : adapter.setSlideTitle({ buffer: first, slideNumber: 2, title: 'Segundo archivo' }).buffer;
    const files = [{ name: `uno.${format}`, buffer: first }, { name: `dos.${format}`, buffer: second }];
    const copies = await collectValidOutputs({ collectOutputs: async () => [{ name: `uno_editado.${format}`, buffer: first }, { name: `dos.${format}`, buffer: second }, { name: `resultado.${format}`, buffer: first }] }, () => {}, { files, isEdit: true, instruction: 'Cambia 2026 por 2027 en ambos documentos' });
    assert.deepEqual(copies.map((out) => out.valid), [false, false, false], format);
    assert.equal(copies[2].validation.reason, 'source_ambiguous');
    files[0].isPriorArtifact = true;
    const named = await collectValidOutputs({ collectOutputs: async () => [{ name: `dos.${format}`, buffer: second }] }, () => {}, { files, isEdit: true, instruction: 'Cambia 2026 por 2027' });
    assert.equal(named[0].valid, false, 'the exact named original must win over an unrelated prior artifact');
  }
});
test('artifact disk metadata is owner/chat scoped and rejects path traversal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-followup-artifact-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'abcdef1234567890'; const buffer = await deck(); const row = { id, userId: 'owner', chatId: 'chat', filename: 'historia.pptx' };
  fs.writeFileSync(path.join(dir, 'source.pptx'), buffer);
  const writeMeta = (extra) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ownerUserId: 'owner', chatId: 'chat', storedRelPath: 'source.pptx', ...extra }));
  writeMeta({}); assert.deepEqual(await loadArtifactBuffer(row, { artifactDir: dir, objectStorage: {} }), buffer);
  writeMeta({ ownerUserId: 'other' }); assert.equal(await loadArtifactBuffer(row, { artifactDir: dir, objectStorage: {} }), null);
  writeMeta({ chatId: 'other' }); assert.equal(await loadArtifactBuffer(row, { artifactDir: dir, objectStorage: {} }), null);
  writeMeta({ storedRelPath: '../escape.pptx' }); assert.equal(await loadArtifactBuffer(row, { artifactDir: dir, objectStorage: {} }), null);
});
test('strict proof survives artifact persistence instead of being replaced with ZIP-only validation', async () => {
  const proof = { ok: true, passed: true, engine: 'pptx_surgical_edit', scope: 'requested_slide_title_and_unchanged_other_parts' };
  const saved = [];
  const result = await persistOutputs({ outputs: [{ name: 'editado.pptx', buffer: await deck(), valid: true, validation: proof }], userId: 'u', chatId: 'c',
    saveArtifact: (item) => { saved.push(item); return { id: 'safe', filename: item.filename, mime: item.mime, downloadUrl: '/safe' }; } });
  assert.deepEqual(saved[0].validation, proof); assert.deepEqual(result[0].validation, proof);
});
test('a storage failure cannot publish a file card or an optimistic chat success', async () => {
  const events = [];
  const result = await runAgentRunnerForChat({ attachedFiles: [{ name: 'historia.pptx', buffer: await deck() }], instruction: PROMPT,
    saveArtifact: () => { throw new Error('private-storage-error'); }, onEvent: (event) => events.push(event) });
  assert.equal(result.ok, false); assert.deepEqual(result.artifacts, []);
  assert.equal(result.stoppedReason, 'artifact_persistence_failed');
  assert.match(result.summary, /no pudo guardarse/); assert.doesNotMatch(result.summary, /Listo|private-storage-error/);
  assert.equal(events.some((event) => event.type === 'file_artifact'), false);
  assert.equal(events.some((event) => event.reason === 'artifact_persistence_failed'), true);
});
