'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const {
  applyDocxPrecisionEdit, verifyDocxPrecisionEdit, DocxPrecisionError,
} = require('../src/services/document-editing/docx-precision-edit');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS = `xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const run = (text, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`;
const paragraph = (text) => `<w:p>${run(text)}</w:p>`;
const document = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

function fixture(body, extra = {}) {
  const zip = new PizZip();
  zip.comment = 'Original archive comment';
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': document(body),
    'word/styles.xml': `<w:styles ${NS}><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Garamond"/><w:sz w:val="21"/></w:rPr></w:style></w:styles>`,
    'word/numbering.xml': `<w:numbering ${NS}/>`,
    'word/settings.xml': `<w:settings ${NS}/>`,
    'word/media/logo.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    'customXml/item1.xml': '<private keep="original">No regenerar</private>',
    ...extra,
  };
  for (const [name, bytes] of Object.entries(entries)) zip.file(name, bytes, {
    date: new Date('2025-01-02T03:04:06Z'), comment: `original:${name}`, createFolders: false,
  });
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function part(buffer, name = 'word/document.xml') { return new PizZip(buffer).file(name).asText(); }
function mutatePart(buffer, name, mutate) {
  const zip = new PizZip(buffer); zip.file(name, mutate(zip.file(name).asText()));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function assertCode(fn, code) { assert.throws(fn, (error) => error instanceof DocxPrecisionError && error.code === code); }
function assertUnchangedParts(before, after, changedParts = ['word/document.xml']) {
  const a = new PizZip(before); const b = new PizZip(after);
  assert.deepEqual(Object.keys(a.files), Object.keys(b.files));
  for (const name of Object.keys(a.files)) {
    if (a.files[name].dir) continue;
    if (!changedParts.includes(name)) assert.deepEqual(a.file(name).asNodeBuffer(), b.file(name).asNodeBuffer(), name);
    assert.equal(a.file(name).date.getTime(), b.file(name).date.getTime(), `date:${name}`);
    assert.equal(a.file(name).comment, b.file(name).comment, `comment:${name}`);
  }
  assert.equal(a.comment, b.comment);
}

test('one letter changes inside its original italic run, not the bold/underlined neighboring runs', () => {
  const body = `<w:p w:rsidR="ABC">${run('MI', '<w:b/>')}${run('C', '<w:i/>')}${run('RO', '<w:u w:val="single"/>')}</w:p>`;
  const source = fixture(body);
  const edit = { needle: 'MICRO', replacement: 'MIXRO' };
  const result = applyDocxPrecisionEdit(source, edit);
  assert.equal(part(result.buffer), document(body.replace('<w:t>C</w:t>', '<w:t>X</w:t>')));
  assertUnchangedParts(source, result.buffer);
  assert.equal(result.changedCount, 1);
  assert.equal(result.validation.changedTextNodes, 1);
  assert.equal(result.validation.passed, true);
});

test('literal matching accepts single letters and preserves case, accents, spaces and punctuation', () => {
  const source = fixture(paragraph('A a á &amp; dos  espacios.'));
  const result = applyDocxPrecisionEdit(source, { needle: 'á', replacement: 'é' });
  assert.equal(part(result.buffer), part(source).replace('á', 'é'));
  const spaces = applyDocxPrecisionEdit(result.buffer, { needle: 'dos  espacios', replacement: 'dos   espacios!' });
  assert.match(part(spaces.buffer), /dos   espacios!/);
  assert.match(part(spaces.buffer), /xml:space="preserve"/);
});

test('default exact matching never chooses different case or accent', () => {
  const source = fixture(paragraph('CASA casa casá'));
  const result = applyDocxPrecisionEdit(source, { needle: 'casa', replacement: 'cosa' });
  assert.match(part(result.buffer), /CASA cosa casá/);
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'Casa', replacement: 'Mesa' }), 'DOCX_EDIT_NOT_FOUND');
});

test('repeated matches in same and different paragraphs require disambiguation', () => {
  const source = fixture(paragraph('a a') + paragraph('a'));
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'a', replacement: 'e' }), 'DOCX_EDIT_AMBIGUOUS');
  const result = applyDocxPrecisionEdit(source, { needle: 'a', replacement: 'e', occurrence: 2 });
  assert.equal(part(result.buffer), document(paragraph('a e') + paragraph('a')));
  const all = applyDocxPrecisionEdit(source, { needle: 'a', replacement: 'e', all: true });
  assert.equal(all.changedCount, 3);
  assert.equal(part(all.buffer), document(paragraph('e e') + paragraph('e')));
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'a', replacement: 'e', occurrence: 4 }), 'DOCX_EDIT_NOT_FOUND');
});

test('paragraph and exact context select only requested location including start-of-paragraph context', () => {
  const source = fixture(paragraph('Uno: valor') + paragraph('Dos: valor') + paragraph('Final Uno: valor'));
  const byParagraph = applyDocxPrecisionEdit(source, { needle: 'valor', replacement: 'importe', paragraph: 2 });
  assert.equal(part(byParagraph.buffer), document(paragraph('Uno: valor') + paragraph('Dos: importe') + paragraph('Final Uno: valor')));
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'valor', replacement: 'importe', context: 'Uno:' }), 'DOCX_EDIT_AMBIGUOUS');
  const byStart = applyDocxPrecisionEdit(source, { needle: 'valor', replacement: 'importe', context: 'Uno:', contextPosition: 'start' });
  assert.equal(part(byStart.buffer), document(paragraph('Uno: importe') + paragraph('Dos: valor') + paragraph('Final Uno: valor')));
});

test('overlapping occurrences require a unique occurrence rather than silently selecting the first', () => {
  const source = fixture(paragraph('banana'));
  const edit = { needle: 'ana', replacement: 'oso' };
  assertCode(() => applyDocxPrecisionEdit(source, edit), 'DOCX_EDIT_AMBIGUOUS');
  assertCode(() => applyDocxPrecisionEdit(source, { ...edit, all: true }), 'DOCX_EDIT_AMBIGUOUS');
  assert.equal(part(applyDocxPrecisionEdit(source, { ...edit, occurrence: 2 }).buffer), document(paragraph('banoso')));
});

test('XML entities and non-BMP letters retain lexical encoding of unchanged characters', () => {
  const source = fixture(paragraph('&#65; &amp; &#x1F600; caf&#233;'));
  const result = applyDocxPrecisionEdit(source, { needle: 'A & 😀 café', replacement: 'A & 😀 cafó' });
  assert.equal(part(result.buffer), part(source).replace('caf&#233;', 'cafó'));
  const emoji = applyDocxPrecisionEdit(source, { needle: '😀', replacement: '🦊' });
  assert.equal(part(emoji.buffer), part(source).replace('&#x1F600;', '🦊'));
});

test('new literal XML characters are escaped, never injected as markup', () => {
  const source = fixture(paragraph('abc'));
  const result = applyDocxPrecisionEdit(source, { needle: 'b', replacement: '<w:b/> & texto' });
  assert.match(part(result.buffer), /a&lt;w:b\/&gt; &amp; textoc/);
  assert.doesNotMatch(part(result.buffer), /<w:b\/>/);
});

test('insertions, deletions and multiple substitutions retain unchanged differently styled text', () => {
  const source = fixture(`<w:p>${run('ab', '<w:b/>')}${run('cd', '<w:i/>')}${run('ef', '<w:u w:val="single"/>')}</w:p>`);
  const result = applyDocxPrecisionEdit(source, { needle: 'abcdef', replacement: 'axcdyef' });
  assert.match(part(result.buffer), /<w:b\/><\/w:rPr><w:t>ax<\/w:t>/);
  assert.match(part(result.buffer), /<w:i\/><\/w:rPr><w:t>cd<\/w:t>/);
  assert.match(part(result.buffer), /<w:u w:val="single"\/><\/w:rPr><w:t>yef<\/w:t>/);
  const deletion = applyDocxPrecisionEdit(source, { needle: 'bcde', replacement: '' });
  assert.match(part(deletion.buffer), /<w:b\/><\/w:rPr><w:t>a<\/w:t>/);
  assert.match(part(deletion.buffer), /<w:i\/><\/w:rPr><w:t><\/w:t>/);
  assert.match(part(deletion.buffer), /<w:u w:val="single"\/><\/w:rPr><w:t>f<\/w:t>/);
});

test('multiple inserted characters at a run boundary retain their order', () => {
  const source = fixture(`<w:p>${run('ab', '<w:b/>')}${run('cd', '<w:i/>')}</w:p>`);
  const result = applyDocxPrecisionEdit(source, { needle: 'abcd', replacement: 'abXYZcd' });
  assert.match(part(result.buffer), /<w:t>ab<\/w:t>/);
  assert.match(part(result.buffer), /<w:t>XYZcd<\/w:t>/);
});

test('leading and trailing spaces enable xml:space while preserving all other attributes', () => {
  const source = fixture('<w:p><w:r><w:t xml:space="default">abc</w:t></w:r></w:p>');
  const result = applyDocxPrecisionEdit(source, { needle: 'abc', replacement: ' abc ' });
  assert.match(part(result.buffer), /<w:t xml:space="preserve"> abc <\/w:t>/);
});

test('hyperlinks, bookmarks, comments and paragraph/list properties are byte-identical', () => {
  const body = `<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:bookmarkStart w:id="1" w:name="Marcador"/>${run('Visita ')}<w:hyperlink r:id="rId8">${run('SiraGPT', '<w:b/>')}</w:hyperlink><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="8"/>${run(' hoy')}<w:commentRangeEnd w:id="8"/></w:p>`;
  const source = fixture(body, { 'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Target="https://siragpt.com" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External"/></Relationships>' });
  const result = applyDocxPrecisionEdit(source, { needle: 'Visita SiraGPT hoy', replacement: 'Visita SiraGpt hoy' });
  assert.equal(part(result.buffer), part(source).replace('SiraGPT', 'SiraGpt'));
  assertUnchangedParts(source, result.buffer);
});

test('paragraphs in table cells edit in place without changing table dimensions/styles', () => {
  const body = `<w:tbl><w:tblPr><w:tblW w:w="9300" w:type="dxa"/></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="CCDDFF"/></w:tcPr>${paragraph('Valor 2026')}</w:tc></w:tr></w:tbl>`;
  const source = fixture(body);
  const result = applyDocxPrecisionEdit(source, { needle: '6', replacement: '7' });
  assert.equal(part(result.buffer), part(source).replace('Valor 2026', 'Valor 2027'));
});

for (const [scope, filename, root] of [['header', 'header1.xml', 'hdr'], ['footer', 'footer1.xml', 'ftr'], ['footnote', 'footnotes.xml', 'footnotes'], ['endnote', 'endnotes.xml', 'endnotes']]) {
  test(`edits only selected ${scope} story and leaves body/other parts identical`, () => {
    const key = `word/${filename}`;
    const source = fixture(paragraph('Nombre original'), { [key]: `<w:${root} ${NS}>${paragraph('Nombre original')}</w:${root}>` });
    assertCode(() => applyDocxPrecisionEdit(source, { needle: 'original', replacement: 'nuevo' }), 'DOCX_EDIT_AMBIGUOUS');
    const result = applyDocxPrecisionEdit(source, { needle: 'original', replacement: 'nuevo', scope });
    assert.equal(part(result.buffer, key), part(source, key).replace('original', 'nuevo'));
    assertUnchangedParts(source, result.buffer, [key]);
    assert.deepEqual(result.validation.changedParts, [key]);
  });
}

test('supports arbitrary Word namespace prefix without reserialization', () => {
  const source = fixture(paragraph('Exacto'));
  const alternate = mutatePart(source, 'word/document.xml', (xml) => xml.replaceAll('xmlns:w=', 'xmlns:x=').replaceAll('<w:', '<x:').replaceAll('</w:', '</x:').replaceAll(' w:', ' x:'));
  const result = applyDocxPrecisionEdit(alternate, { needle: 'Exacto', replacement: 'Exacta' });
  assert.equal(part(result.buffer), part(alternate).replace('Exacto', 'Exacta'));
});

for (const separator of ['<w:tab/>', '<w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/>', '<w:br/>', '<w:cr/>', '<w:noBreakHyphen/>', '<w:softHyphen/>', '<w:sym w:font="Wingdings" w:char="F020"/>']) {
  test(`never matches across ${separator}`, () => {
    const source = fixture(`<w:p><w:r><w:t>uno</w:t>${separator}<w:t>dos</w:t></w:r></w:p>`);
    assertCode(() => applyDocxPrecisionEdit(source, { needle: 'unodos', replacement: 'nuevo' }), 'DOCX_EDIT_NOT_FOUND');
  });
}

test('does not match through paragraph boundaries or mutate raw XML attributes', () => {
  const source = fixture('<w:p w:rsidR="ABC">' + run('uno') + '</w:p>' + paragraph('dos'));
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'unodos', replacement: 'nuevo' }), 'DOCX_EDIT_NOT_FOUND');
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'ABC', replacement: 'XYZ' }), 'DOCX_EDIT_NOT_FOUND');
});

for (const container of ['ins', 'moveTo', 'fldSimple', 'sdt']) {
  test(`fails closed when the selected text is inside ${container}`, () => {
    const source = fixture(`<w:${container}>${paragraph('No tocar')}</w:${container}>`);
    assertCode(() => applyDocxPrecisionEdit(source, { needle: 'tocar', replacement: 'editar' }), 'DOCX_EDIT_UNSUPPORTED');
  });
}

test('complex field results and hidden text cannot be rewritten', () => {
  const source = fixture(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DATE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('2026')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
  assertCode(() => applyDocxPrecisionEdit(source, { needle: '2026', replacement: '2027' }), 'DOCX_EDIT_UNSUPPORTED');
  const hidden = fixture(`<w:p>${run('Oculto', '<w:vanish/>')}${run(' Visible')}</w:p>`);
  assertCode(() => applyDocxPrecisionEdit(hidden, { needle: 'Oculto', replacement: 'Nuevo' }), 'DOCX_EDIT_UNSUPPORTED');
  assert.equal(applyDocxPrecisionEdit(hidden, { needle: 'Visible', replacement: 'Vigente' }).changedCount, 1);
});

test('deleted revision text is not a visible target', () => {
  const source = fixture('<w:p><w:del><w:r><w:delText>Borrado</w:delText></w:r></w:del>' + run('Vigente') + '</w:p>');
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'Borrado', replacement: 'Nuevo' }), 'DOCX_EDIT_NOT_FOUND');
  assert.equal(applyDocxPrecisionEdit(source, { needle: 'Vigente', replacement: 'Actual' }).changedCount, 1);
});

test('active document protection, tracked changes, macros and digital signatures fail closed', () => {
  const edit = { needle: 'original', replacement: 'nuevo' };
  for (const extra of [
    { 'word/settings.xml': `<w:settings ${NS}><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>` },
    { 'word/settings.xml': `<w:settings ${NS}><w:trackRevisions/></w:settings>` },
    { 'word/vbaProject.bin': Buffer.from('macro') },
    { '_xmlsignatures/sig1.xml': '<Signature/>' },
  ]) assertCode(() => applyDocxPrecisionEdit(fixture(paragraph('original'), extra), edit), 'DOCX_EDIT_UNSUPPORTED');
});

test('no-op, invalid selection, line/control injection, and invalid XML do not create a deliverable', () => {
  const source = fixture(paragraph('original'));
  assertCode(() => applyDocxPrecisionEdit(source, { needle: 'original', replacement: 'original' }), 'DOCX_EDIT_NO_CHANGE');
  for (const options of [{ replacement: '\n' }, { replacement: '\t' }, { replacement: '\u0000' }, { replacement: '\ud800' }, { paragraph: 0 }, { occurrence: -1 }, { scope: 'page' }, { all: true, occurrence: 1 }, { context: '' }])
    assertCode(() => applyDocxPrecisionEdit(source, { needle: 'original', replacement: 'nuevo', ...options }), 'DOCX_EDIT_INVALID_REQUEST');
  const invalid = mutatePart(source, 'word/document.xml', () => '<w:document><w:p></w:document>');
  assertCode(() => applyDocxPrecisionEdit(invalid, { needle: 'original', replacement: 'nuevo' }), 'DOCX_EDIT_INVALID_DOCUMENT');
});

test('output proof rejects changed formatting, unrelated text, metadata, parts and deleted entries', () => {
  const source = fixture(paragraph('original') + paragraph('No tocar'));
  const edit = { needle: 'original', replacement: 'nuevo' };
  const output = applyDocxPrecisionEdit(source, edit).buffer;
  const corruptions = [
    mutatePart(output, 'word/document.xml', (xml) => xml.replace('<w:t>nuevo', '<w:rPr><w:b/></w:rPr><w:t>nuevo')),
    mutatePart(output, 'word/document.xml', (xml) => xml.replace('No tocar', 'Cambiado')),
    mutatePart(output, 'word/document.xml', (xml) => xml.replace('w:w="12240"', 'w:w="13000"')),
    mutatePart(output, 'word/styles.xml', (xml) => xml.replace('Garamond', 'Calibri')),
  ];
  const missing = new PizZip(output); missing.remove('word/media/logo.png');
  corruptions.push(missing.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  for (const corrupted of corruptions) assert.equal(verifyDocxPrecisionEdit(source, corrupted, edit).passed, false);
  assert.equal(verifyDocxPrecisionEdit(source, source, edit).passed, false, 'repacking/unchanged output is not a valid edit');
});

test('deeply nested XML and excessive tiny tags are bounded independently of compressed ZIP size', () => {
  const edit = { needle: 'original', replacement: 'nuevo' };
  const deep = fixture('<w:customXml>'.repeat(300) + paragraph('original') + '</w:customXml>'.repeat(300));
  assertCode(() => applyDocxPrecisionEdit(deep, edit), 'DOCX_EDIT_LIMIT_EXCEEDED');
  const manyTokens = fixture('<w:proofErr/>'.repeat(500001) + paragraph('original'));
  assert.ok(manyTokens.length < 100000, 'compressed input is small: the XML work cap, not upload size, must reject it');
  assertCode(() => applyDocxPrecisionEdit(manyTokens, edit), 'DOCX_EDIT_LIMIT_EXCEEDED');
});

test('invalid and over-budget package errors use the precision API error namespace', () => {
  const edit = { needle: 'original', replacement: 'nuevo' };
  assertCode(() => applyDocxPrecisionEdit(Buffer.from('not a DOCX'), edit), 'DOCX_EDIT_INVALID_DOCUMENT');
  const source = fixture(paragraph('original'));
  // A forged central-directory count is rejected by the existing Office
  // allocation guard, then normalized to this API's stable error contract.
  const excessive = Buffer.from(source);
  const end = excessive.length - 22 - new PizZip(source).comment.length;
  excessive.writeUInt16LE(6000, end + 10);
  assertCode(() => applyDocxPrecisionEdit(excessive, edit), 'DOCX_EDIT_LIMIT_EXCEEDED');
});

test('Word-generated DOCX is readable by mammoth after a precision edit', async () => {
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  const mammoth = require('mammoth');
  const source = Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({
    children: [new TextRun({ text: 'MI', bold: true }), new TextRun({ text: 'C', italics: true }), new TextRun({ text: 'RO', underline: {} })],
  })] }] })));
  const output = applyDocxPrecisionEdit(source, { needle: 'MICRO', replacement: 'MIXRO' });
  const text = await mammoth.extractRawText({ buffer: output.buffer });
  assert.equal(text.value.trim(), 'MIXRO');
  assertUnchangedParts(source, output.buffer);
});
