'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const PizZip = require('pizzip');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-office-multiple-'));
process.env.ARTIFACT_DIR = path.join(dir, 'artifacts');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const editor = require('../src/services/source-preserving-document-edit');
const slides = require('../src/services/document-editing/pptx-adapter');
const { planOfficeLiteralEdits, executeOfficeLiteralEdits, validateEditedBuffer } = editor.INTERNAL;

async function workbook({ multi = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Ventas Perú');
  sheet.addRow(['Mes', 'Total', 'Saldo', 'Fórmula', 'Nota']);
  sheet.addRow(['Enero', 100, 200, { formula: 'B2+C2', result: 300 }, 'Conservar']);
  sheet.addRow(['Febrero', 110, 210, { formula: 'B3+C3', result: 320 }, 'Conservar']);
  sheet.getCell('B3').font = { name: 'Arial', bold: true, color: { argb: 'FF123456' } };
  sheet.getCell('C3').numFmt = '0.00';
  if (multi) {
    wb.addWorksheet('Costos').addRows([['Mes', 'Total'], ['Enero', 20], ['Febrero', 30]]);
    wb.addWorksheet('No tocar').addRow(['Mantener íntegro']);
  }
  const zip = new PizZip(Buffer.from(await wb.xlsx.writeBuffer()));
  zip.file('xl/charts/chart1.xml', '<c:chartSpace xmlns:c="urn:fixture"><c:chart/></c:chartSpace>');
  return zip.generate({ type: 'nodebuffer' });
}

async function deck() {
  const ppt = new PptxGenJS();
  for (let i = 1; i <= 3; i += 1) {
    const slide = ppt.addSlide();
    slide.background = { color: 'F0F0F0' };
    slide.addText(`Título ${i}`, { x: 1, y: 0.3, w: 8, h: 1, fontSize: 30, bold: true });
    slide.addText('Resultado 2026', { x: 1, y: 2, w: 8, h: 1, fontSize: 18 });
    slide.addNotes(`Nota original ${i}`);
  }
  return Buffer.from(await ppt.write({ outputType: 'nodebuffer' }));
}

function unchangedParts(before, after, allowed) {
  const a = new PizZip(before); const b = new PizZip(after);
  const names = Object.keys(a.files).filter((name) => !a.files[name].dir).sort();
  assert.deepEqual(Object.keys(b.files).filter((name) => !b.files[name].dir).sort(), names);
  for (const name of names) if (!allowed.includes(name)) assert.deepEqual(b.file(name).asNodeBuffer(), a.file(name).asNodeBuffer(), name);
}

async function edit(input, extension, request) {
  const sourcePath = path.join(dir, `source-${Math.random().toString(36).slice(2)}.${extension}`);
  fs.writeFileSync(sourcePath, input);
  const sourceFile = { id: `file-${path.basename(sourcePath)}`, path: sourcePath, originalName: path.basename(sourcePath), filename: path.basename(sourcePath), userId: 'fixture-owner', size: input.length };
  const result = await editor.generateSourcePreservingDocumentEdit({ sourceFile, prompt: request, userId: 'fixture-owner', chatId: 'office-multiple' });
  assert.deepEqual(fs.readFileSync(sourcePath), input, 'source is immutable');
  return { result, sourceFile, output: result.artifact ? fs.readFileSync(result.artifact.path) : null };
}

test('two cell assignments in one instruction both land; styles, formulas and charts survive byte-for-byte', async () => {
  const input = await workbook();
  const { result, output, sourceFile } = await edit(input, 'xlsx', 'Cambia la celda B3 a 500 y la celda C3 a 700');
  assert.equal(result.validation.passed, true);
  assert.equal(result.validation.details.operationCriteria.length, 2);
  const afterZip = new PizZip(output); const beforeZip = new PizZip(input);
  const afterXml = afterZip.file('xl/worksheets/sheet1.xml').asText();
  assert.match(afterXml, /<c\b[^>]*r="B3"[^>]*><v>500<\/v>/);
  assert.match(afterXml, /<c\b[^>]*r="C3"[^>]*><v>700<\/v>/);
  const cell = (xml, ref) => xml.match(new RegExp(`<c\\b[^>]*r="${ref}"[^>]*>[\\s\\S]*?</c>`))?.[0];
  assert.equal(cell(afterXml, 'D3'), cell(beforeZip.file('xl/worksheets/sheet1.xml').asText(), 'D3'));
  unchangedParts(input, output, ['xl/worksheets/sheet1.xml']);
  assert.deepEqual(result.validation.documentEdit, { sourceFileId: sourceFile.id, sourceFilename: sourceFile.originalName, parentArtifactId: null });
});

test('different named sheets retain their own scopes and quoted text/formulas are not split at conjunctions', async () => {
  const input = await workbook({ multi: true });
  const request = 'En la hoja "Ventas Perú" cambia la celda B3 a 500; en la hoja "Costos" cambia la celda B3 a 700; en la hoja "Ventas Perú" pon la celda E3 a "Investigación y Desarrollo" y la celda D3 a "=SUM(B3,C3)"';
  const { output, result } = await edit(input, 'xlsx', request);
  assert.equal(result.validation.passed, true);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(output);
  assert.equal(wb.getWorksheet('Ventas Perú').getCell('B3').value, 500);
  assert.equal(wb.getWorksheet('Costos').getCell('B3').value, 700);
  assert.equal(wb.getWorksheet('Ventas Perú').getCell('E3').value, 'Investigación y Desarrollo');
  assert.equal(wb.getWorksheet('Ventas Perú').getCell('D3').value.formula, 'SUM(B3,C3)');
  unchangedParts(input, output, ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
});

test('a polite prefix never drops the first requested cell update', async () => {
  const { output, result } = await edit(await workbook(), 'xlsx', 'Por favor, cambia la celda B3 a 500 y la celda C3 a 700, por favor');
  assert.equal(result.validation.details.operationCriteria.length, 2);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(output);
  assert.equal(wb.getWorksheet(1).getCell('B3').value, 500);
  assert.equal(wb.getWorksheet(1).getCell('C3').value, 700);
});

test('unquoted assignment qualifiers and conditional prefixes never become unconditional cell values', async () => {
  const input = await workbook();
  for (const request of [
    'En la hoja "Ventas Perú", pon la celda A1 en 20 si B2 es mayor que 30',
    'En la hoja "Ventas Perú", pon la celda A1 en 20 sin alterar el formato',
    'si B2>30, pon la celda A1 en 20',
    'si B2>30, pon la celda A1 en "20"',
    'Pon la celda A1 en "20" si B2 es mayor que 30',
    'Pon la celda A1 en "20" o en "30"',
    'Pon la celda A1 en "Revisado" con formato azul',
    'Analiza los datos antes de poner la celda A1 en 20',
    'Pon la celda B3 en 500; si B2>30, pon la celda A1 en 20',
  ]) {
    await assert.rejects(edit(input, 'xlsx', request), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' }, request);
  }
});

test('quoted literal values may contain conditions and qualifiers as their actual text', async () => {
  const input = await workbook();
  const text = '20 si B2 es mayor que 30 y no cambies la celda C3 sin alterar el formato';
  const { output, result } = await edit(input, 'xlsx', `Pon la celda E3 en "${text}" y la celda B3 en -20.25`);
  assert.equal(result.validation.passed, true);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(output);
  assert.equal(wb.getWorksheet(1).getCell('E3').value, text);
  assert.equal(wb.getWorksheet(1).getCell('B3').value, -20.25);
  unchangedParts(input, output, ['xl/worksheets/sheet1.xml']);
});

test('quoted replacements and slide titles cannot hide conditions or unexplained extra instructions', async () => {
  const input = await deck();
  for (const request of [
    'Si las ventas crecen cambia el título de la diapositiva 1 a "Nuevo"',
    'En caso de que las ventas crezcan cambia el título de la diapositiva 1 a "Nuevo"',
    'Cambia el título de la diapositiva 1 a "Nuevo" siempre que las ventas crezcan',
    'En la diapositiva 1 cambia el título a "Nuevo" si las ventas crecen',
    'Si las ventas crecen reemplaza "Resultado 2026" por "Resultado 2027"',
    'Reemplaza "Resultado 2026" por "Resultado 2027" si las ventas crecen',
    'Reemplaza "Resultado 2026" por "Resultado 2027" con formato grande',
  ]) await assert.rejects(edit(input, 'pptx', request), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' }, request);
});

test('cell write and number format both apply to one workbook without losing the existing formula', async () => {
  const input = await workbook();
  const { output, result } = await edit(input, 'xlsx', 'Cambia la celda B3 a 500 y aplica formato de moneda al rango C2:C3');
  assert.equal(result.validation.passed, true);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(output);
  assert.equal(wb.getWorksheet(1).getCell('B3').value, 500);
  assert.match(wb.getWorksheet(1).getCell('C3').numFmt, /€/);
  assert.equal(wb.getWorksheet(1).getCell('D3').value.formula, 'B3+C3');
  unchangedParts(input, output, ['xl/worksheets/sheet1.xml', 'xl/styles.xml']);
});

test('literal text replacement and a cell write share the surgical workbook path', async () => {
  const input = await workbook();
  const { output, result } = await edit(input, 'xlsx', 'Reemplaza "Conservar" por "Revisado" y en la celda B3 escribe "500"');
  assert.equal(result.validation.passed, true);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(output);
  assert.equal(wb.getWorksheet(1).getCell('E2').value, 'Revisado');
  assert.equal(wb.getWorksheet(1).getCell('E3').value, 'Revisado');
  assert.equal(wb.getWorksheet(1).getCell('B3').value, 500);
  assert.equal(wb.getWorksheet(1).getCell('D3').value.formula, 'B3+C3');
  unchangedParts(input, output, ['xl/worksheets/sheet1.xml']);
});

test('multiple slide scopes and repeated source text edit only the requested slides', async () => {
  const input = await deck();
  const { output, result } = await edit(input, 'pptx', 'En la diapositiva 1 cambia el título a "Visión y misión"; en la diapositiva 2 cambia el título a "Resultados" y reemplaza "Resultado 2026" por "Resultado 2027"');
  assert.equal(result.validation.passed, true);
  const list = slides.listPptxSlides(output);
  assert.equal(list[0].title, 'Visión y misión');
  assert.equal(list[1].title, 'Resultados');
  assert.match(list[0].textSnippet, /Resultado 2026/);
  assert.match(list[1].textSnippet, /Resultado 2027/);
  assert.equal(list[2].title, 'Título 3');
  unchangedParts(input, output, ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);
});

test('an unresolved change after a literal request declines the whole turn without publishing its prefix', async () => {
  for (const [format, input, request] of [
    ['xlsx', await workbook(), 'Cambia la celda B3 a 500 y reorganiza el resumen por trimestre'],
    ['xlsx', await workbook(), 'Cambia la celda B3 a formato moneda y la celda C3 a 700'],
    ['xlsx', await workbook({ multi: true }), 'En la hoja "Ventas Perú" cambia la celda B3 a 500 y en la hoja "Costos" reorganiza el resumen por trimestre'],
    ['pptx', await deck(), 'En la diapositiva 1 cambia el título a "Nuevo" y agrega un gráfico con las ventas'],
  ]) {
    const sourcePath = path.join(dir, `decline.${format}`); fs.writeFileSync(sourcePath, input);
    const sourceFile = { id: `decline-${format}`, path: sourcePath, originalName: `decline.${format}`, filename: `decline.${format}`, size: input.length, userId: 'fixture-owner' };
    await assert.rejects(editor.generateSourcePreservingDocumentEdit({ sourceFile, prompt: request }), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' });
    const prisma = { file: { findMany: async () => [sourceFile] }, generatedArtifact: { findMany: async () => [] }, message: { findMany: async () => [] } };
    assert.equal(await editor.tryGenerateSourcePreservingDocumentEdit({ prisma, fileIds: [sourceFile.id], userId: 'fixture-owner', prompt: request }), null);
    assert.deepEqual(fs.readFileSync(sourcePath), input);
  }
});

test('preservation or delivery prefixes never hide additional clauses or negated cell edits', async () => {
  const input = await workbook();
  const suffixes = [
    'conserva el formato pero cambia la celda B2 a 30',
    'mantén el formato aunque cambia la celda B2 a 30',
    'preserva el diseño sino cambia la celda B2 a 30',
    'conserva el formato o cambia la celda B2 a 30',
    'conserva el formato salvo la celda B2 a 30',
    'conserva el formato excepto la celda B2 a 30',
    'conserva el formato sin cambiar la celda B2 a 30',
    'conserva el formato y no cambies la celda B2 a 30',
    'conserva el formato y no pongas la celda B2 en 30',
    'conserva el formato y tampoco escribas la celda B2 a 30',
    'conserva el formato y ni cambies la celda B2 a 30',
    'conserva el formato y evita cambiar la celda B2 a 30',
    'no cambies el formato pero cambia la celda B2 a 30',
    'sin tocar el resto pero cambia la celda B2 a 30',
    'devuélveme el Excel completo pero cambia la celda B2 a 30',
  ];
  for (const suffix of suffixes) {
    const request = `En la hoja "Ventas Perú", pon la celda A1 en 20; ${suffix}`;
    const plan = planOfficeLiteralEdits({ input, format: 'xlsx', requestText: request });
    assert.equal(plan.status, 'declined', suffix);
    await assert.rejects(edit(input, 'xlsx', request), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' });
  }
  const pptx = await deck();
  const request = 'En la diapositiva 1 cambia el título a "Nuevo"; conserva el diseño pero reemplaza "Resultado 2026" por "Resultado 2027"';
  assert.equal(planOfficeLiteralEdits({ input: pptx, format: 'pptx', requestText: request }).status, 'declined');
  await assert.rejects(edit(pptx, 'pptx', request), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' });
});

test('complete preservation and delivery clauses still allow every explicit cell update', async () => {
  const input = await workbook();
  const request = 'Cambia la celda B3 a 500 y la celda C3 a 700; conserva el diseño; mantén el formato original; sin cambiar el resto; no modifiques el resto; devuélveme el Excel completo';
  const { output, result } = await edit(input, 'xlsx', request);
  assert.equal(result.validation.details.operationCriteria.length, 2);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(output);
  assert.equal(wb.getWorksheet(1).getCell('B3').value, 500);
  assert.equal(wb.getWorksheet(1).getCell('C3').value, 700);
  unchangedParts(input, output, ['xl/worksheets/sheet1.xml']);
});

test('unrecognized Office edits never create a sheet/slide containing the instruction', async () => {
  for (const [format, input, request] of [
    ['xlsx', await workbook(), 'Reorganiza esta tabla por trimestre'],
    ['pptx', await deck(), 'Moderniza esta presentación profesionalmente'],
  ]) {
    await assert.rejects(edit(input, format, request), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' });
  }
  await assert.rejects(editor.INTERNAL.executeXlsxOperations({ input: await workbook(), ops: [{ kind: 'append_generic' }], blocks: [{ kind: 'normal', text: 'petición literal' }] }), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' });
  assert.throws(() => editor.INTERNAL.executePptxOperations({ input: Buffer.alloc(0), ops: [{ kind: 'append_generic' }], blocks: [] }), { code: 'OFFICE_EDIT_INTENT_UNRESOLVED' });
});

test('a failing later target does not publish the earlier valid change', async () => {
  const input = await workbook({ multi: true });
  const { result } = await edit(input, 'xlsx', 'En la hoja "Ventas Perú" cambia la celda B3 a 500 y en la hoja "No existe" cambia la celda C3 a 700');
  assert.equal(result.clarification, true);
  assert.equal(result.artifact, null);
});

test('literal cell proof rejects a substring value and unrelated package changes', async () => {
  const input = await workbook();
  const plan = planOfficeLiteralEdits({ input, format: 'xlsx', requestText: 'Cambia la celda B3 a 500 y la celda C3 a 700' });
  const execution = await executeOfficeLiteralEdits({ input, format: 'xlsx', plan, sourceFile: { originalName: 'prueba.xlsx' } });
  const zip = new PizZip(execution.buffer);
  zip.file('xl/worksheets/sheet1.xml', zip.file('xl/worksheets/sheet1.xml').asText().replace('<v>500</v>', '<v>5000</v>'));
  const badValue = await validateEditedBuffer(zip.generate({ type: 'nodebuffer' }), 'xlsx', [], { beforeBuffer: input, operations: execution.operations });
  assert.equal(badValue.passed, false);
  const other = new PizZip(execution.buffer); other.file('xl/charts/chart1.xml', '<changed/>');
  const badPart = await validateEditedBuffer(other.generate({ type: 'nodebuffer' }), 'xlsx', [], { beforeBuffer: input, operations: execution.operations });
  assert.equal(badPart.passed, false);
  const otherCell = new PizZip(execution.buffer);
  otherCell.file('xl/worksheets/sheet1.xml', otherCell.file('xl/worksheets/sheet1.xml').asText().replace('<v>100</v>', '<v>999</v>'));
  const badCell = await validateEditedBuffer(otherCell.generate({ type: 'nodebuffer' }), 'xlsx', [], { beforeBuffer: input, operations: execution.operations });
  assert.equal(badCell.passed, false, 'same worksheet does not authorize changing an unrelated cell');
});
