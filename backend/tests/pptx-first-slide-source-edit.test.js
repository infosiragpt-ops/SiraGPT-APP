'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PptxGenJS = require('pptxgenjs');
const PizZip = require('pizzip');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-first-slide-'));
process.env.ARTIFACT_DIR = path.join(fixtureDir, 'artifacts');
after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

const editor = require('../src/services/source-preserving-document-edit');
const { parsePresentationTitleEdit } = require('../src/services/document-editing/presentation-title-intent');
const { trySurgicalPresentationFollowup } = require('../src/services/agent-runner/surgical-followup');
const adapter = require('../src/services/document-editing/pptx-adapter');
const PROMPT = 'En siragpt-release-pr563-original.pptx, cambia el título de la primera diapositiva a "Historia de los Dinosaurios de 1998".';
const NEW_TITLE = 'Historia de los Dinosaurios de 1998';

async function makeDeck() {
  const pptx = new PptxGenJS();
  for (let i = 1; i <= 11; i++) {
    const slide = pptx.addSlide();
    slide.addText(i === 1 ? 'Historia de los Dinosaurios' : `Etapa ${i}`, { x: 0.5, y: 0.4, w: 8, h: 1, bold: true, fontSize: 28 });
    slide.addText(`Contenido científico ${i}: 2026`, { x: 0.5, y: 2, w: 8, h: 1, fontSize: 14 });
    slide.addNotes(`Nota preservada ${i}`);
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

test('production full filename/comma prompt selects slide 1 and the exact quoted title in the shared parser', () => {
  const expected = { kind: 'set_slide_title', slideNumber: 1, title: NEW_TITLE };
  assert.deepEqual(parsePresentationTitleEdit(PROMPT), expected);
  assert.deepEqual(editor.parsePresentationEditRequest(PROMPT), expected);
});

test('a first edit after a location comma is not mistaken for an additional operation', () => {
  for (const scope of ['En "historia.pptx",', 'En Informe final.pptx,', 'En cambios.pptx,', 'En cambia.pptx,', 'En "cambia historia.pptx",', 'En la primera diapositiva,', 'En la primera lámina,', 'En la slide 1,']) {
    const result = parsePresentationTitleEdit(`${scope} cambia el título de la primera diapositiva a "Nuevo título".`);
    assert.deepEqual(result, { kind: 'set_slide_title', slideNumber: 1, title: 'Nuevo título' }, scope);
  }
});

test('a source comma never permits silently dropping a second instruction', () => {
  for (const suffix of [', agrega una imagen', '; cambia el fondo a rojo', '. Quita una diapositiva', ' y agrega una tabla', ', luego pon un logo', ', inserta una imagen', '; duplica la segunda diapositiva', ', mueve la segunda diapositiva al final', ', exporta a PDF', ', conserva el diseño e inserta una imagen']) {
    assert.equal(parsePresentationTitleEdit(PROMPT.replace(/\.$/, '') + suffix), null, suffix);
  }
  for (const initial of ['agrega una diapositiva', 'pinta el fondo rojo', 'quita una imagen', 'elimina una diapositiva', 'colorea el fondo', 'borra una imagen', 'inserta una imagen', 'duplica la segunda diapositiva', 'mueve la segunda al final']) {
    assert.equal(parsePresentationTitleEdit(`En historia.pptx, ${initial}, cambia el título a "Nuevo".`), null, initial);
  }
  assert.equal(parsePresentationTitleEdit('En historia.pptx, ¿qué título tiene la primera diapositiva?'), null);
  assert.equal(parsePresentationTitleEdit('En cambia.pptx, el título a "Nuevo".'), null, 'a filename is not authorization to edit');
  for (const suffix of [', inserta una imagen.', '; duplica la segunda diapositiva.', ' y mueve la segunda al final.']) {
    assert.equal(parsePresentationTitleEdit(`en la primera Landin agrega en la Historia de los Dinosaurios de 1998${suffix}`, { slides: [{ number: 1, title: 'Historia de los Dinosaurios' }] }), null);
  }
});

test('title values and filenames cannot override the requested slide location', () => {
  for (const title of ['Diapositiva 7', 'Diapositiva7', 'Segunda diapositiva', 'Slide 11']) {
    for (const filename of ['historia.pptx', 'Diapositiva7.pptx', '"Diapositiva 7.pptx"', 'Diapositiva 7 resumen.pptx']) {
      const prompt = `En ${filename}, cambia el título de la primera diapositiva a "${title}".`;
      assert.deepEqual(parsePresentationTitleEdit(prompt), { kind: 'set_slide_title', slideNumber: 1, title }, prompt);
    }
  }
});

test('a title suffix allows only preservation or a source reference, never an unknown second action', () => {
  for (const suffix of ['.', ', conserva el diseño.', ' y mantén el formato original.', ', sin cambiar el resto.', ' en B.pptx.', ' en "B.pptx", conserva el diseño.']) {
    assert.deepEqual(parsePresentationTitleEdit(`Cambia el título de la primera diapositiva a "Nuevo"${suffix}`), { kind: 'set_slide_title', slideNumber: 1, title: 'Nuevo' }, suffix);
  }
  assert.equal(parsePresentationTitleEdit('Cambia el título de la primera diapositiva a Nuevo, inserta una imagen.'), null);
});

const ambiguousScopes = [
  'En la primera diapositiva reemplaza "2026" por "2027" y en la segunda diapositiva reemplaza "2026" por "2028".',
  'Reemplaza "2026" por "2027" en la primera y segunda diapositiva.',
  'Reemplaza "2026" por "2027" en las diapositivas 1 y 2.',
];
test('the single-scope planner explicitly rejects multiple scopes instead of editing one slide or the whole deck', () => {
  for (const requestText of ambiguousScopes) {
    assert.throws(() => editor.INTERNAL.planGenericOfficeOperations({ requestText, format: 'pptx' }), { code: 'PPTX_SLIDE_SCOPE_AMBIGUOUS' }, requestText);
  }
  assert.equal(parsePresentationTitleEdit('Cambia el título de la primera y segunda diapositiva a "Nuevo".'), null);
  assert.equal(parsePresentationTitleEdit('Cambia el título de todas las diapositivas a "Nuevo".'), null);
  const all = editor.INTERNAL.planGenericOfficeOperations({ requestText: 'Reemplaza "2026" por "2027" en todas las diapositivas.', format: 'pptx' });
  assert.ok(all.every(op => op.kind === 'replace_text' && op.slideNumber == null), 'explicit whole-deck replacement remains supported');
  const ops = editor.INTERNAL.planGenericOfficeOperations({ requestText: 'En "Diapositiva 7.pptx", en la primera diapositiva reemplaza "2026" por "2027".', format: 'pptx' });
  assert.ok(ops.every(op => op.slideNumber === 1));
});

test('real PPTX title containing a slide number edits only slide 1; compound edits produce no surgical output', async () => {
  const input = await makeDeck(), before = new PizZip(input);
  const result = trySurgicalPresentationFollowup({ files: [{ name: 'Diapositiva 7.pptx', buffer: input }], instruction: 'En "Diapositiva 7.pptx", cambia el título de la primera diapositiva a "Diapositiva 7".' });
  assert.equal(result.outputs.length, 1);
  assert.equal(adapter.listPptxSlides(result.outputs[0].buffer)[0].title, 'Diapositiva 7');
  const edited = new PizZip(result.outputs[0].buffer);
  assert.deepEqual(Object.keys(before.files).filter(name => !before.files[name].dir && !before.file(name).asNodeBuffer().equals(edited.file(name).asNodeBuffer())), ['ppt/slides/slide1.xml']);
  for (const suffix of [', inserta una imagen.', '; duplica la segunda diapositiva.', ', mueve la segunda diapositiva al final.']) {
    assert.equal(trySurgicalPresentationFollowup({ files: [{ name: 'historia.pptx', buffer: input }], instruction: `En historia.pptx, cambia el título de la primera diapositiva a "Nuevo"${suffix}` }), null);
  }
});

test('the source-preserving entry clarifies ambiguous slide scopes without an artifact or source modification', async () => {
  const input = await makeDeck(), filePath = path.join(fixtureDir, 'ambiguous.pptx');
  fs.writeFileSync(filePath, input);
  const result = await editor.generateSourcePreservingDocumentEdit({ sourceFile: { path: filePath, originalName: 'ambiguous.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }, prompt: ambiguousScopes[0], userId: 'fixture-owner', chatId: 'fixture-chat' });
  assert.equal(result.clarification, true);
  assert.equal(result.artifact, null);
  assert.deepEqual(fs.readFileSync(filePath), input);
});

test('quoted replacement pairs remain replacements instead of full title assignments', () => {
  const prompt = 'En la primera diapositiva, reemplaza "2026" por "2027" en el título.';
  assert.equal(parsePresentationTitleEdit(prompt), null);
  const operations = editor.INTERNAL.planGenericOfficeOperations({ requestText: prompt, format: 'pptx' });
  assert.ok(operations.length > 0);
  for (const op of operations) {
    assert.equal(op.kind, 'replace_text');
    assert.equal(op.needle, '2026');
    assert.equal(op.replacement, '2027');
    assert.equal(op.slideNumber, 1);
  }
});

test('ordinal replacement scope edits only its actual PPTX slide', async () => {
  const input = await makeDeck();
  const operations = editor.INTERNAL.planGenericOfficeOperations({ requestText: 'En la segunda diapositiva reemplaza "2026" por "2027".', format: 'pptx' });
  assert.ok(operations.every(op => op.kind === 'replace_text' && op.slideNumber === 2));
  const output = editor.INTERNAL.executePptxOperations({ input, ops: operations, blocks: [] }).buffer;
  const before = new PizZip(input), result = new PizZip(output);
  for (const name of Object.keys(before.files).filter(name => !before.files[name].dir)) {
    if (name === 'ppt/slides/slide2.xml') assert.match(result.file(name).asText(), /2027/);
    else assert.deepEqual(result.file(name).asNodeBuffer(), before.file(name).asNodeBuffer(), name);
  }
});

test('a location before its source filename remains scoped for numeric and ordinal replacements', async () => {
  const input = await makeDeck(), before = new PizZip(input);
  for (const location of ['la diapositiva 2', 'la segunda diapositiva', 'slide 2', 'la diapositiva número 2', 'la diapositiva nro.2', 'la diapositiva #2']) {
    for (const comma of ['', ',']) {
      const requestText = `En ${location} de historia.pptx${comma} reemplaza "2026" por "2027".`;
      const operations = editor.INTERNAL.planGenericOfficeOperations({ requestText, format: 'pptx' });
      assert.ok(operations.length > 0 && operations.every(op => op.kind === 'replace_text' && op.slideNumber === 2), requestText);
      const edited = new PizZip(editor.INTERNAL.executePptxOperations({ input, ops: operations, blocks: [] }).buffer);
      assert.deepEqual(Object.keys(before.files).filter(name => !before.files[name].dir && !before.file(name).asNodeBuffer().equals(edited.file(name).asNodeBuffer())), ['ppt/slides/slide2.xml']);
    }
  }
});

test('ordinal-looking quoted content is not interpreted as a slide location', () => {
  const operations = editor.INTERNAL.planGenericOfficeOperations({ requestText: 'Reemplaza "primera diapositiva" por "introducción" en toda la presentación.', format: 'pptx' });
  assert.ok(operations.length > 0);
  assert.ok(operations.every(op => op.kind === 'replace_text' && op.slideNumber == null));
});

test('exact production prompt saves an actual 11-slide edit with all other OOXML parts unchanged', async () => {
  const input = await makeDeck(), original = Buffer.from(input);
  const sourcePath = path.join(fixtureDir, 'siragpt-release-pr563-original.pptx');
  fs.writeFileSync(sourcePath, input);
  const result = await editor.generateSourcePreservingDocumentEdit({
    sourceFile: { id: 'first-slide-fixture', path: sourcePath, originalName: path.basename(sourcePath), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    prompt: PROMPT, displayPrompt: PROMPT, userId: 'fixture-first-slide-owner', chatId: 'fixture-first-slide-chat',
  });
  assert.equal(result.validation.passed, true);
  assert.equal(result.format, 'pptx');
  assert.ok(result.artifact?.path);
  const output = fs.readFileSync(result.artifact.path), before = new PizZip(input), edited = new PizZip(output);
  assert.equal(adapter.listPptxSlides(output).length, 11);
  assert.equal(adapter.listPptxSlides(output)[0].title, NEW_TITLE);
  const names = Object.keys(before.files).filter(name => !before.files[name].dir).sort();
  assert.deepEqual(Object.keys(edited.files).filter(name => !edited.files[name].dir).sort(), names);
  assert.deepEqual(names.filter(name => !before.file(name).asNodeBuffer().equals(edited.file(name).asNodeBuffer())), ['ppt/slides/slide1.xml']);
  assert.deepEqual(fs.readFileSync(sourcePath), original);
  assert.match(result.content, /título/);
  assert.doesNotMatch(result.content, /anex|Generé/);
});
