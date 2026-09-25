'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const { createDocxSession } = require('../src/services/docx-engine/session');
const { runDocxEngineEdit } = require('../src/services/docx-engine/agent');
const { verifyEditedDocx } = require('../src/services/docx-engine/verify');
const { editedFilename, buildUserSummary, editWordDocument } = require('../src/services/docx-engine');

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
  s.apply('fill_field', { label: 'Apellidos y nombres del experto:', value: 'Torres Pérez, Ana' });
  const xml = documentXml(s.save());
  assert.match(xml, /<w:t xml:space="preserve"> del experto:<\/w:t><\/w:r><w:r><w:rPr><w:rFonts w:ascii="Arial Narrow" w:hAnsi="Arial Narrow"\/><w:b w:val="0"\/><w:bCs w:val="0"\/><w:sz w:val="24"\/><\/w:rPr><w:t xml:space="preserve"> Torres Pérez, Ana<\/w:t>/);
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
  s.apply('fill_field', { label: 'Firma:', value: 'Ana Torres' });
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const text = s.outline().text;
  assert.match(text, /"Firma: Ana Torres"/);
  assert.match(text, /"DNI: 12345678"/);
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
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const edited = s.save();
  const origZip = new PizZip(original);
  const newZip = new PizZip(edited);
  for (const name of ['word/header1.xml', 'word/media/logo.png', '[Content_Types].xml']) {
    assert.deepEqual(Buffer.from(newZip.file(name).asUint8Array()), Buffer.from(origZip.file(name).asUint8Array()), name);
  }
  const v = await verifyEditedDocx({
    originalBuffer: original, editedBuffer: edited, changedParts: s.changedParts(),
    expectedValues: ['12345678'], render: async () => ({ pages: 1, text: 'DNI: 12345678' }), originalRender: async () => ({ pages: 1, text: '' }),
  });
  assert.equal(v.ok, true, v.issues.join('; '));
  assert.deepEqual(s.changedParts(), ['word/document.xml']);
});

test('verification flags values that are not visible after render', async () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const v = await verifyEditedDocx({ originalBuffer: fixture(), editedBuffer: s.save(), changedParts: s.changedParts(), expectedValues: ['Universidad César Vallejo'], render: async () => ({ pages: 1, text: 'DNI 12345678' }) });
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
      calls.push(structuredClone(payload));
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { choices: [{ message: typeof turn === 'function' ? turn(payload) : turn }] };
    } } },
  };
}
const call = (name, args, id) => ({ id: id || `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('agent loop: model fills fields, finish verifies, summary lists real edits', async () => {
  const client = scriptedClient([
    { content: null, tool_calls: [call('fill_field', { label: 'Apellidos y nombres del experto:', value: 'Torres Pérez, Ana' }), call('fill_field', { label: 'DNI:', value: '12345678' }, 'c2')] },
    { content: null, tool_calls: [call('finish', { status: 'done', summary: 'Completé tus datos.', expected_values: ['Torres Pérez, Ana', '12345678'] })] },
    { content: null, tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: ['Años de experiencia'] })] },
  ]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'completa el word con mis datos', client, model: 'm', render: async (b) => ({ pages: 1, text: new PizZip(b).file('word/document.xml').asText().replace(/<[^>]+>/g, '') }) });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'done');
  assert.match(documentXml(out.buffer), /12345678/);
  assert.match(client.calls[0].messages[1].content, /t0: TABLA/);
  const summary = buildUserSummary({ modelSummary: out.summary, changes: out.changes, verification: out.verification, filename: 'carta.docx' });
  assert.match(summary, /Apellidos y nombres del experto: Torres Pérez, Ana/);
  assert.match(summary, /DNI: 12345678/);
  assert.doesNotMatch(summary, /anexo/i);
  assert.match(summary, /Datos que faltan: Años de experiencia/);
  assert.equal(out.verification.report.intent.passed, true);
  assert.equal(client.calls[2].model, 'm');
  assert.match(client.calls[2].messages[1].content, /original_document/);
  assert.match(client.calls[2].messages[1].content, /edited_document/);
});

test('failed render verification never becomes success on a second finish', async () => {
  const client = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Listo', expected_values: ['12345678'] })] },
  ]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'DNI 12345678', client, model: 'm',
    render: async () => ({ pages: 1, text: 'sin el dato escrito' }) });
  assert.equal(out.ok, false);
  assert.equal(out.buffer, undefined);
  assert.equal(client.calls.length, 3);
});

test('exhausted edit loop cannot deliver partial edits without finish', async () => {
  const client = scriptedClient([{ tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] }]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'completa nombre y DNI', client, model: 'm', maxIterations: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.buffer, undefined);
});

test('structural success cannot override wrong semantic placement', async () => {
  const finish = { tool_calls: [call('finish', { status: 'done', summary: 'Completé el DNI' })] };
  const rejected = { tool_calls: [call('review_document_edit', { passed: false, issues: ['El DNI se escribió en Firma, no en su campo.'], missing_information: [] })] };
  const client = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'Firma:', value: '12345678' })] }, finish, rejected, finish, rejected,
  ]);
  const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'mi DNI es 12345678', client, model: 'chosen' });
  assert.equal(out.ok, false);
  assert.equal(out.buffer, undefined);
  assert.ok(client.calls.every((c) => c.model === 'chosen'));
  assert.match(client.calls[3].messages.filter((m) => m.role === 'tool').at(-1).content, /DNI se escribió en Firma/);
});

test('review failure or malformed review never delivers an artifact', async () => {
  for (const review of [
    { content: 'Everything looks great' },
    { tool_calls: [call('review_document_edit', { passed: true, issues: ['Incorrecto'], missing_information: [] })] },
  ]) {
    const finish = { tool_calls: [call('finish', { status: 'done', summary: 'Listo' })] };
    const client = scriptedClient([{ tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] }, finish, review, finish, review]);
    const out = await runDocxEngineEdit({ buffer: fixture(), instruction: 'DNI 12345678', client, model: 'chosen' });
    assert.equal(out.ok, false);
    assert.equal(out.buffer, undefined);
  }
});

test('renderer errors and unexpected ZIP entries fail verification', async () => {
  const original = fixture();
  const s = createDocxSession(original);
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const renderFailed = await verifyEditedDocx({ originalBuffer: original, editedBuffer: s.save(), changedParts: s.changedParts(), render: async () => { throw new Error('render broke'); } });
  assert.equal(renderFailed.ok, false);
  const zip = new PizZip(s.save());
  zip.file('word/extra.xml', '<unexpected/>');
  const unexpected = await verifyEditedDocx({ originalBuffer: original, editedBuffer: zip.generate({ type: 'nodebuffer' }), changedParts: s.changedParts() });
  assert.equal(unexpected.ok, false);
  assert.match(unexpected.issues.join(';'), /no autorizada/);
});

test('claimed values checked without renderer and summary never invents layout proof', async () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const out = await verifyEditedDocx({ originalBuffer: fixture(), editedBuffer: s.save(), changedParts: s.changedParts(), expectedValues: ['not present'] });
  assert.equal(out.ok, false);
  const summary = buildUserSummary({ changes: [{ op: 'set_format', after: 'bold' }], verification: { report: { totalEntries: 4, identicalEntries: 3, changedParts: ['word/document.xml'] } } });
  assert.doesNotMatch(summary, /diseño.*sin alterar/);
});

test('independent reviewer sees full long cell text and every run format', () => {
  const { reviewSnapshot } = require('../src/services/docx-engine/intent-review');
  const s = createDocxSession(fixture());
  const longValue = 'Un texto largo '.repeat(20) + 'DATO AL FINAL';
  s.apply('set_cell', { cell: 't0.r1.c1', text: longValue });
  const snapshot = reviewSnapshot(s.save());
  const paragraph = snapshot.flatMap((part) => part.paragraphs).find((p) => p.text.includes('DATO AL FINAL'));
  assert.equal(paragraph.text, longValue);
  assert.equal(paragraph.runs.map((r) => r.text).join(''), longValue);
  assert.ok(paragraph.runs[0].format.font);
});

test('legitimate page reflow is reported rather than misclassified as an annex', async () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'DNI:', value: '12345678' });
  const out = await verifyEditedDocx({ originalBuffer: fixture(), editedBuffer: s.save(), changedParts: s.changedParts(),
    render: async () => ({ pages: 4, text: '12345678' }), originalRender: async () => ({ pages: 1, text: '' }) });
  assert.equal(out.ok, true);
  assert.equal(out.report.pageCountChanged, true);
  assert.equal(out.report.pagesAfter, 4);
});

test('legacy conversion with different pagination delivers the verified DOCX, not unproved DOC bytes', async () => {
  const client = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Completé el DNI.' })] },
    { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] },
  ]);
  const badLegacy = Buffer.from('legacy-doc');
  const changedPages = Buffer.from('different-pages');
  const out = await editWordDocument({ filename: 'carta.doc', buffer: Buffer.from('source-doc'), instruction: 'DNI 12345678', model: 'm', client,
    convert: { docToDocx: async (b) => b.equals(badLegacy) ? changedPages : fixture(), docxToDoc: async () => badLegacy },
    render: async (b) => ({ pages: b.equals(changedPages) ? 3 : 1, text: '12345678' }),
  });
  assert.equal(out.ok, true);
  assert.match(out.filename, /\.docx$/);
  assert.match(out.summary, /no pude verificar la conversión/);
  assert.match(documentXml(out.buffer), /12345678/);
});

test('cancellation during legacy conversion cannot deliver a completed artifact', async () => {
  const controller = new AbortController();
  const client = scriptedClient([
    { tool_calls: [call('fill_field', { label: 'DNI:', value: '12345678' })] },
    { tool_calls: [call('finish', { status: 'done', summary: 'Completé el DNI.' })] },
    { tool_calls: [call('review_document_edit', { passed: true, issues: [], missing_information: [] })] },
  ]);
  await assert.rejects(() => editWordDocument({ filename: 'carta.doc', buffer: Buffer.from('source-doc'), instruction: 'DNI 12345678', model: 'm', client,
    signal: controller.signal,
    convert: { docToDocx: async () => fixture(), docxToDoc: async () => { controller.abort(); return Buffer.from('legacy-doc'); } },
    render: async () => ({ pages: 1, text: '12345678' }),
  }), { name: 'AbortError' });
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

test('follow-up versions bump instead of stacking, also for sanitised artifact names', () => {
  const { editedFilename } = require('../src/services/docx-engine');
  assert.equal(editedFilename('CARTA_rgp_-_editado_.docx'), 'CARTA_rgp (editado v2).docx');
  assert.equal(editedFilename('CARTA rgp (editado v2).docx'), 'CARTA rgp (editado v3).docx');
});

test('agentic trigger routes subjunctive edit requests ("quiero que agregues …")', () => {
  const { isDocumentEditRequest } = require('../src/services/agents/agentic-trigger');
  assert.equal(isDocumentEditRequest('DOCX quiero que agregues algunas observaciones a cada pregunta'), true);
  assert.equal(isDocumentEditRequest('necesito que insertes una fila'), true);
  assert.equal(isDocumentEditRequest('¿qué dice el documento?'), false);
});

test('values written into table cells pass render verification even when pdftotext interleaves columns', async () => {
  const s = createDocxSession(fixture());
  s.apply('fill_field', { label: 'DNI:', value: 'Coherente con las variables de estudio' });
  const out = await verifyEditedDocx({ originalBuffer: fixture(), editedBuffer: s.save(), changedParts: s.changedParts(),
    expectedValues: ['Coherente con las variables de estudio', 'Valor que no existe en ningún lado'],
    render: async () => ({ pages: 1, text: '5 ¿pregunta? X Coherente con las\nvariables 6 ¿otra? X de estudio' }),
    originalRender: async () => ({ pages: 1, text: '' }) });
  assert.equal(out.ok, false);
  assert.ok(out.issues.some((issue) => /Valor que no existe/.test(issue)));
  assert.ok(out.issues.every((issue) => !/Coherente/.test(issue)), JSON.stringify(out.issues));
});
