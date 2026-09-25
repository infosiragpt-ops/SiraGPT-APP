'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const { createDocxSession } = require('../src/services/docx-engine/session');
const { makeDocxToolExecutors } = require('../src/services/docx-engine/tools');
const { openDocxPackage } = require('../src/services/docx-engine/package');

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`;
const p = (text) => `<w:p>${run(text)}</w:p>`;
const cell = (content) => `<w:tc><w:tcPr><w:shd w:fill="AAAAAA"/></w:tcPr>${content}</w:tc>`;
const row = (text) => `<w:tr>${cell(p(text))}</w:tr>`;
function fixture(body, extra = {}, compression = 'DEFLATE') {
  const zip = new PizZip();
  zip.comment = 'keep original metadata';
  for (const [name, bytes] of Object.entries({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    'word/styles.xml': `<w:styles ${NS}/>`,
    'word/media/logo.png': Buffer.from([137, 80, 78, 71, 1, 2, 3]),
    ...extra,
  })) zip.file(name, bytes, { createFolders: false, date: new Date('2025-01-02T03:04:06Z'), comment: name });
  return zip.generate({ type: 'nodebuffer', compression });
}
const xml = (s) => s.pkg.part('word/document.xml').xml;
const protectedError = (err) => /DOCX_ENGINE_(?:PROTECTED|CROSSES_OBJECT)/.test(err.code);

test('semantic replacement retains every unchanged character in its original formatted run', () => {
  const body = `<w:p>${run('MI', '<w:b/>')}${run('C', '<w:i/>')}${run('RO', '<w:u w:val="single"/>')}</w:p>`;
  const s = createDocxSession(fixture(body));
  const before = xml(s);
  s.apply('replace_text', { find: 'MICRO', replace: 'MIXRO' });
  assert.equal(xml(s), before.replace('<w:t>C</w:t>', '<w:t>X</w:t>'));
});

test('semantic edits retain untouched entities, astral characters, and insertion order', () => {
  const s = createDocxSession(fixture(`<w:p>${run('&#65; &amp; 😀')}${run('café', '<w:i/>')}</w:p>`));
  s.apply('replace_text', { find: 'A & 😀café', replace: 'A & 😀XYZcafé' });
  assert.match(xml(s), /&#65; &amp; 😀/);
  assert.match(xml(s), /<w:i\/><\/w:rPr><w:t>XYZcafé/);
});

test('set_cell edits mixed runs in place instead of flattening unchanged styles', () => {
  const s = createDocxSession(fixture(`<w:tbl>${`<w:tr>${cell(`<w:p>${run('MI', '<w:b/>')}${run('C', '<w:i/>')}${run('RO')}</w:p>`)}</w:tr>`}</w:tbl>`));
  const before = xml(s);
  s.apply('set_cell', { cell: 't0.r0.c0', text: 'MIXRO' });
  assert.equal(xml(s), before.replace('<w:t>C</w:t>', '<w:t>X</w:t>'));
});

test('empty/self-closing form cells are filled in their original row without extra sections', () => {
  const s = createDocxSession(fixture(`<w:tbl><w:tr>${cell(p('Nombre:'))}${cell('<w:p/>')}</w:tr></w:tbl>`));
  const before = xml(s);
  s.apply('fill_field', { label: 'Nombre:', value: 'Ana Torres' });
  assert.equal(s.resolve('t0.r0.c1').entry.cell.paragraphs.length, 1);
  assert.match(s.read('t0.r0.c1'), /Ana Torres/);
  assert.equal((xml(s).match(/<w:p(?:>|\/)/g) || []).length, (before.match(/<w:p(?:>|\/)/g) || []).length);
  assert.doesNotMatch(xml(s), /anexo/i);
});

test('set_cell append expands a self-closing empty paragraph safely', () => {
  const s = createDocxSession(fixture(`<w:tbl><w:tr>${cell('<w:p/>')}</w:tr></w:tbl>`));
  s.apply('set_cell', { cell: 't0.r0.c0', text: 'Valor', mode: 'append' });
  assert.match(s.read('t0.r0.c0'), /Valor/);
  assert.match(xml(s), /<w:p><w:r>/);
});

test('set_cell never silently removes an image, bookmark, comment or field', () => {
  const payloads = [
    `<w:r><w:drawing/></w:r>${run('A')}`,
    `<w:bookmarkStart w:id="1"/>${run('A')}<w:bookmarkEnd w:id="1"/>`,
    `${run('A')}<w:r><w:commentReference w:id="1"/></w:r>`,
    `<w:fldSimple w:instr="DATE">${run('A')}</w:fldSimple>`,
  ];
  for (const payload of payloads) {
    const s = createDocxSession(fixture(`<w:tbl><w:tr>${cell(`<w:p>${payload}</w:p>`)}</w:tr></w:tbl>`));
    const before = xml(s);
    assert.throws(() => s.apply('set_cell', { cell: 't0.r0.c0', text: 'Replacement', bold: false }), protectedError);
    assert.equal(xml(s), before);
    assert.deepEqual(s.changes, []);
  }
});

test('protected settings, tracked revisions, macros and signatures are rejected before editing', () => {
  for (const extra of [
    { 'word/settings.xml': `<w:settings ${NS}><w:documentProtection w:enforcement="1"/></w:settings>` },
    { 'word/settings.xml': `<w:settings ${NS}><w:trackRevisions/></w:settings>` },
    { 'word/vbaProject.bin': Buffer.from('macro') },
    { '_xmlsignatures/sig1.xml': '<sig/>' },
  ]) assert.throws(() => createDocxSession(fixture(p('A'), extra)), protectedError);
});

test('targeted edits reject hidden text, revisions, bound or locked controls, and automatic fields', () => {
  for (const body of [
    `<w:p>${run('A', '<w:vanish/>')}</w:p>`,
    `<w:p><w:ins>${run('A')}</w:ins></w:p>`,
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>${run('A')}</w:p>`,
    `<w:sdt><w:sdtPr><w:lock w:val="contentLocked"/></w:sdtPr><w:sdtContent>${p('A')}</w:sdtContent></w:sdt>`,
    `<w:sdt><w:sdtPr><w:dataBinding w:xpath="/name"/></w:sdtPr><w:sdtContent>${p('A')}</w:sdtContent></w:sdt>`,
  ]) {
    const s = createDocxSession(fixture(body));
    assert.throws(() => s.apply('replace_text', { find: 'A', replace: 'B' }), protectedError);
  }
});

test('package validation rejects path traversal, corrupt CRC and DTDs', () => {
  assert.throws(() => openDocxPackage(fixture(p('A'), { '../escape.xml': 'unsafe' })), /válido/);
  const source = fixture(p('UNIQUE_TEXT'), {}, 'STORE');
  const corrupted = Buffer.from(source);
  corrupted[corrupted.indexOf(Buffer.from('UNIQUE_TEXT'))] = 65;
  assert.throws(() => openDocxPackage(corrupted), /válido/);
  assert.throws(() => openDocxPackage(fixture(p('A'), { 'word/document.xml': `<!DOCTYPE word [<!ENTITY x "value">]><w:document ${NS}><w:body/></w:document>` })), /XML inválido/);
});

test('paragraph IDs survive insertions/deletions and never select the shifted neighbor', () => {
  const s = createDocxSession(fixture(p('A') + p('B') + p('C') + p('D')));
  s.outline();
  s.apply('insert_paragraph', { after: 'p0', text: 'NEW' });
  assert.equal(s.resolve('p1').entry.paragraph.text, 'B');
  s.apply('delete', { target: 'p0' });
  assert.equal(s.resolve('p0'), null);
  s.apply('delete', { target: 'p1' });
  assert.equal(s.resolve('p1'), null);
  assert.equal(s.resolve('p2').entry.paragraph.text, 'C');
  assert.match(xml(s), /NEW/);
});

test('table row/cell IDs survive inserted rows and edits still target the original cells', () => {
  const s = createDocxSession(fixture(`<w:tbl>${row('A')}${row('B')}${row('C')}</w:tbl>`));
  s.outline();
  s.apply('insert_table_row', { table: 't0', after_row: 't0.r0', cells: ['NEW'] });
  assert.match(s.read('t0.r1.c0'), /B/);
  s.apply('set_cell', { cell: 't0.r1.c0', text: 'B edited' });
  const rows = s.resolve('t0').entry.table.rows;
  assert.deepEqual(rows.map((r) => s.resolve(r.cells[0].id).entry.cell.paragraphs.map((id) => s.resolve(id).entry.paragraph.text).join('')), ['A', 'NEW', 'B edited', 'C']);
});

test('set_cells is atomic and restores original IDs and change log on any failure', () => {
  const s = createDocxSession(fixture(`<w:tbl>${row('A')}${row('B')}</w:tbl>`));
  s.outline();
  const before = xml(s);
  assert.throws(() => s.apply('set_cells', { cells: [{ cell: 't0.r0.c0', text: 'updated' }, { cell: 't0.r99.c0', text: 'wrong' }] }));
  assert.equal(xml(s), before);
  assert.deepEqual(s.changes, []);
  assert.match(s.read('t0.r0.c0'), /A/);
});

test('undo restores original XML, stable IDs and audit log', async () => {
  const s = createDocxSession(fixture(p('A') + p('B')));
  s.outline();
  const before = xml(s);
  const tools = makeDocxToolExecutors(s);
  await tools.insert_paragraph({ after: 'p0', text: 'NEW' });
  assert.equal(s.changes.length, 1);
  assert.match(await tools.undo({}), /Deshice/);
  assert.equal(xml(s), before);
  assert.equal(s.resolve('p1').entry.paragraph.text, 'B');
  assert.deepEqual(s.changes, []);
});

test('invalid text, raw XML escape hatches, no-op changes and unrestricted regexes fail closed', () => {
  const s = createDocxSession(fixture(p('A')));
  for (const args of [{ find: 'A', replace: 'A' }, { find: 'A', replace: '\0' }, { find: 'A', replace: 'B', _rpr: '<w:rPr/>' }])
    assert.throws(() => s.apply('replace_text', args));
  assert.throws(() => s.find('(a+)+$', { regex: true }), /literal/);
  assert.deepEqual(s.changes, []);
});

test('saving preserves all unedited package bytes and ZIP entry metadata', () => {
  const source = fixture(p('A'));
  const s = createDocxSession(source);
  s.apply('replace_text', { find: 'A', replace: 'B' });
  const before = new PizZip(source); const after = new PizZip(s.save());
  assert.deepEqual(Object.keys(before.files), Object.keys(after.files));
  for (const name of Object.keys(before.files)) {
    if (name !== 'word/document.xml') assert.deepEqual(after.file(name).asNodeBuffer(), before.file(name).asNodeBuffer());
    assert.equal(after.file(name).comment, before.file(name).comment);
    assert.equal(after.file(name).date.getTime(), before.file(name).date.getTime());
  }
  assert.equal(after.comment, before.comment);
});

test('set_format targets exact substrings and keeps surrounding text and style untouched', () => {
  const s = createDocxSession(fixture(`<w:p>${run('before café after', '<w:i/>')}</w:p>`));
  s.apply('set_format', { target: 'p0', text: 'café', bold: true });
  const runs = s.resolve('p0').entry.paragraph.runs;
  assert.deepEqual(runs.map((r) => [r.segments.map((seg) => seg.text).join(''), !!r.format.bold, !!r.format.italic]), [
    ['before ', false, true], ['café', true, true], [' after', false, true],
  ]);
});

test('set_format recognizes a selected phrase across differently styled runs', () => {
  const s = createDocxSession(fixture(`<w:p>${run('left Ana', '<w:i/>')}${run(' Torres right', '<w:u w:val="single"/>')}</w:p>`));
  s.apply('set_format', { target: 'p0', text: 'Ana Torres', bold: true });
  const runs = s.resolve('p0').entry.paragraph.runs;
  assert.deepEqual(runs.map((r) => [r.segments.map((seg) => seg.text).join(''), !!r.format.bold]), [
    ['left ', false], ['Ana', true], [' Torres', true], [' right', false],
  ]);
  assert.equal(runs[1].format.italic, true);
  assert.equal(runs[2].format.underline, 'single');
});

test('failed first operation keeps original IDs even without a prior outline', () => {
  const s = createDocxSession(fixture(p('A') + p('B')));
  assert.throws(() => s.apply('replace_text', { find: 'not found', replace: 'x' }));
  assert.equal(s.resolve('p0').entry.paragraph.text, 'A');
  assert.equal(s.resolve('p1').entry.paragraph.text, 'B');
});

test('automatic field protection includes middle result paragraphs without field markers', () => {
  const s = createDocxSession(fixture(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p>${p('AUTOMATIC RESULT')}<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`));
  assert.throws(() => s.apply('replace_text', { find: 'AUTOMATIC RESULT', replace: 'Wrong' }), protectedError);
  assert.throws(() => s.apply('set_format', { target: 'p1', bold: true }), protectedError);
  assert.throws(() => s.apply('delete', { target: 'p1' }), protectedError);
});

test('undo after an intermediate verification save never resurrects the discarded edit', async () => {
  const source = fixture(p('A') + p('B'));
  const s = createDocxSession(source);
  const tools = makeDocxToolExecutors(s);
  await tools.replace_text({ find: 'A', replace: 'DISCARDED' });
  s.save();
  await tools.undo({});
  await tools.replace_text({ find: 'B', replace: 'RETAINED' });
  const output = new PizZip(s.save()).file('word/document.xml').asText();
  assert.match(output, /<w:t>A<\/w:t>/);
  assert.match(output, /RETAINED/);
  assert.doesNotMatch(output, /DISCARDED/);
});
