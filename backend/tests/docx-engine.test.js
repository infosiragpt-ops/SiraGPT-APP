'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const { createDocxSession } = require('../src/services/docx-engine/session');
const { runDocxEngineEdit } = require('../src/services/docx-engine/agent');
const { verifyEditedDocx } = require('../src/services/docx-engine/verify');
const { editedFilename, buildUserSummary } = require('../src/services/docx-engine');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const BOLD = '<w:rPr><w:rFonts w:ascii="Arial Narrow" w:hAnsi="Arial Narrow"/><w:b/><w:sz w:val="24"/></w:rPr>';
const PLAIN = '<w:rPr><w:rFonts w:ascii="Arial Narrow" w:hAnsi="Arial Narrow"/><w:sz w:val="24"/></w:rPr>';
const cell = (inner, extra = '') => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${extra}</w:tcPr>${inner}</w:tc>`;
const para = (runs, pPr = '') => `<w:p>${pPr}${runs}</w:p>`;
const run = (rPr, text) => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;

function fixture() {
  const body = [
    para(run(BOLD, 'MATRIZ PARA EVALUACIÓN DE EXPERTOS'), '<w:pPr><w:jc w:val="center"/></w:pPr>'),
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>',
    `<w:tr>${cell(para(run(BOLD, 'Apellidos y nombres') + run(BOLD, ' del experto:')), '<w:gridSpan w:val="2"/>')}</w:tr>`,
    `<w:tr>${cell(para(run(BOLD, 'Grado académico:')))}${cell(para(run(PLAIN, 'Magister')))}</w:tr>`,
    `<w:tr>${cell(para(run(BOLD, 'Años de experiencia:')))}${cell('<w:p><w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:pPr></w:p>')}</w:tr>`,
    '</w:tbl>',
    '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="500"/><w:gridCol w:w="3000"/><w:gridCol w:w="500"/><w:gridCol w:w="500"/></w:tblGrid>',
    `<w:tr>${cell(para(run(BOLD, 'N')))}${cell(para(run(BOLD, 'PREGUNTA')))}${cell(para(run(BOLD, 'SI')))}${cell(para(run(BOLD, 'NO')))}</w:tr>`,
    `<w:tr>${cell(para(run(PLAIN, '1')))}${cell(para(run(PLAIN, '¿Es claro?')))}${cell(para(run(PLAIN, 'X')))}${cell('<w:p/>')}</w:tr>`,
    `<w:tr>${cell(para(run(PLAIN, '2')))}${cell(para(run(PLAIN, '¿Es útil?')))}${cell(para(run(PLAIN, 'X')))}${cell('<w:p/>')}</w:tr>`,
    '</w:tbl>',
    para(run(PLAIN, 'Firma: ') + run(PLAIN, '__________')),
    para(run(PLAIN, 'DNI:')),
    para('<w:sdt><w:sdtPr><w:tag w:val="acepto"/><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>' + run(PLAIN, ' Acepto')),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
  ].join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  zip.file('word/header1.xml', `<?xml version="1.0"?><w:hdr ${W}>${para(run(BOLD, 'TRABAJO DE INVESTIGACIÓN'))}</w:hdr>`);
  zip.file('word/media/logo.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  return zip.generate({ type: 'nodebuffer' });
}

function documentXml(buffer) {
  return new PizZip(buffer).file('word/document.xml').asText();
}

test('outline exposes addressable ids for cells, header and checkboxes', () => {
  const s = createDocxSession(fixture());
  const text = s.outline().text;
  assert.match(text, /t0: TABLA 3 filas/);
  assert.match(text, /r1: c0=\*"Grado académico:" \| c1="Magister"/);
  assert.match(text, /h1\.p0: "TRABAJO DE INVESTIGACIÓN"/);
  assert.match(text, /cb0: CASILLA ☐ sin marcar \(sdt\)/);
});

test('fill_field across split runs appends a plain value after a bold label', () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'Apellidos y nombres del experto:', value: 'Carrera Salas, Luis' });
  const xml = documentXml(s.save());
  assert.match(xml, /<w:t xml:space="preserve"> del experto:<\/w:t><\/w:r><w:r><w:rPr><w:rFonts w:ascii="Arial Narrow" w:hAnsi="Arial Narrow"\/><w:b w:val="0"\/><w:bCs w:val="0"\/><w:sz w:val="24"\/><\/w:rPr><w:t xml:space="preserve"> Carrera Salas, Luis<\/w:t>/);
});

test('fill_field writes into the value cell to the right and keeps its formatting', () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'Grado académico:', value: 'Magíster' });
  s.apply('fill_field', { label: 'Años de experiencia:', value: '8 años' });
  const text = s.outline().text;
  assert.match(text, /c1="Magíster"/);
  assert.match(text, /c1="8 años"/);
  assert.match(documentXml(s.save()), /<w:r><w:rPr><w:rFonts w:ascii="Arial Narrow" w:hAnsi="Arial Narrow"\/><w:sz w:val="24"\/><\/w:rPr><w:t xml:space="preserve">Magíster<\/w:t><\/w:r>/);
});

test('fill_field replaces a placeholder line and labels without space', () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'Firma:', value: 'Luis Carrera' });
  s.apply('fill_field', { label: 'DNI:', value: '72792992' });
  const text = s.outline().text;
  assert.match(text, /"Firma: Luis Carrera"/);
  assert.match(text, /"DNI: 72792992"/);
  assert.doesNotMatch(text, /____/);
});

test('set_cells moves X marks in a matrix; checkbox and header edits work', () => {
  const s = createDocxSession(fixture());
  s.apply('set_cells', { cells: [{ cell: 't1.r2.c2', text: '' }, { cell: 't1.r2.c3', text: 'X' }] });
  s.apply('set_checkbox', { checkbox: 'cb0', checked: true });
  s.apply('replace_text', { find: 'TRABAJO DE INVESTIGACIÓN', replace: 'TESIS DE MAESTRÍA', target: 'h1' });
  const text = s.outline().text;
  assert.match(text, /r2: c0="2" \| c1="¿Es útil\?" \| c2=∅ \| c3="X"/);
  assert.match(text, /cb0: CASILLA ☒ marcada/);
  assert.match(text, /h1\.p0: "TESIS DE MAESTRÍA"/);
});

test('untouched parts stay byte-identical and verification passes', async () => {
  const original = fixture();
  const s = createDocxSession(original);
  s.apply('fill_field', { label: 'DNI:', value: '72792992' });
  const edited = s.save();
  const origZip = new PizZip(original);
  const newZip = new PizZip(edited);
  for (const name of ['word/header1.xml', 'word/media/logo.png', '[Content_Types].xml']) {
    assert.deepEqual(Buffer.from(newZip.file(name).asUint8Array()), Buffer.from(origZip.file(name).asUint8Array()), name);
  }
  const v = await verifyEditedDocx({
    originalBuffer: original, editedBuffer: edited, changedParts: s.changedParts(),
    expectedValues: ['72792992'], render: async () => ({ pages: 1, text: 'DNI: 72792992' }), originalRender: async () => ({ pages: 1, text: '' }),
  });
  assert.equal(v.ok, true, v.issues.join('; '));
  assert.deepEqual(s.changedParts(), ['word/document.xml']);
});

test('verification flags values that are not visible after render', async () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'DNI:', value: '72792992' });
  const v = await verifyEditedDocx({ originalBuffer: fixture(), editedBuffer: s.save(), changedParts: s.changedParts(), expectedValues: ['Universidad César Vallejo'], render: async () => ({ pages: 1, text: 'DNI 72792992' }) });
  assert.equal(v.ok, false);
  assert.match(v.issues[0], /Universidad César Vallejo/);
});

test('ambiguous and missing targets return actionable errors', () => {
  const s = createDocxSession(fixture());
  assert.throws(() => s.apply('replace_text', { find: 'X', replace: 'Y' }), /aparece \d+ veces/);
  assert.throws(() => s.apply('fill_field', { label: 'Institución:', value: 'UCV' }), /No encontré la etiqueta/);
});

function scriptedClient(turns) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { async create(payload) {
      calls.push(payload);
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { choices: [{ message: typeof turn === 'function' ? turn(payload) : turn }] };
    } } },
  };
}
const call = (name, args, id) => ({ id: id || `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('agent loop: model fills fields, finish verifies, summary lists real edits', async () => {
  const client = scriptedClient([
    { content: null, tool_calls: [call('fill_field', { label: 'Apellidos y nombres del experto:', value: 'Carrera Salas, Luis' }), call('fill_field', { label: 'DNI:', value: '72792992' }, 'c2')] },
    { content: null, tool_calls: [call('finish', { status: 'done', summary: 'Completé tus datos.', expected_values: ['Carrera Salas, Luis', '72792992'] })] },
  ]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'completa el word con mis datos', client, model: 'm', render: async (b) => ({ pages: 1, text: new PizZip(b).file('word/document.xml').asText().replace(/<[^>]+>/g, '') }) });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'done');
  assert.match(documentXml(out.buffer), /72792992/);
  assert.match(client.calls[0].messages[1].content, /t0: TABLA/);
  const summary = buildUserSummary({ modelSummary: out.summary, changes: out.changes, verification: out.verification, filename: 'carta.docx' });
  assert.match(summary, /Apellidos y nombres del experto: Carrera Salas, Luis/);
  assert.match(summary, /DNI: 72792992/);
  assert.doesNotMatch(summary, /anexo/i);
});

test('agent loop: finish without edits is refused; prose-only answer is not a success', async () => {
  const client = scriptedClient([
    { content: null, tool_calls: [call('finish', { status: 'done', summary: 'Listo' })] },
    { content: 'Listo, ya lo hice.' },
    { content: 'Listo, ya lo hice.' },
  ]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'completa', client, model: 'm' });
  assert.equal(out.ok, false);
  assert.match(client.calls[1].messages.find((m) => m.role === 'tool').content, /Todavía no hiciste ningún cambio/);
});

test('editedFilename versions the output name', () => {
  assert.equal(editedFilename('carta.docx'), 'carta (editado).docx');
  assert.equal(editedFilename('carta (editado).docx'), 'carta (editado v2).docx');
  assert.equal(editedFilename('carta (editado v2).doc'), 'carta (editado v3).doc');
});
