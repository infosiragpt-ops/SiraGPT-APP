const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const {
  fillDocxSectionBuffer,
  appendToDocxBuffer,
  parseTargetSectionRequest,
} = require('../src/services/source-preserving-document-edit');

// Build a minimal-but-valid DOCX buffer from a list of paragraph texts so we
// can exercise the in-place section fill / append logic without depending on
// a real uploaded file.
function makeDocx(paragraphTexts) {
  const body = paragraphTexts
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>`
    + '</w:document>';
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file('word/document.xml', documentXml);
  return zip.generate({ type: 'nodebuffer' });
}

function docxText(buffer) {
  const xml = new PizZip(buffer).file('word/document.xml').asText();
  const out = [];
  const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let match;
  while ((match = re.exec(xml))) out.push(match[1]);
  return out.join('\n');
}

test('parseTargetSectionRequest reads "completa el anexo 3"', () => {
  const target = parseTargetSectionRequest('completa el anexo 3');
  assert.ok(target);
  assert.equal(target.kind, 'anexo');
  assert.equal(target.number, 3);
  assert.equal(target.label, 'Anexo 3');
});

test('fillDocxSectionBuffer fills the requested section in place and preserves the rest', () => {
  const target = parseTargetSectionRequest('completa el anexo 3');
  const buffer = makeDocx(['Portada original UPN', 'Anexo 3', 'Anexo 4']);
  const blocks = [{ kind: 'normal', text: 'Contenido nuevo del anexo tres.' }];
  const out = fillDocxSectionBuffer(buffer, target, blocks);
  const text = docxText(out);

  assert.match(text, /Portada original UPN/);
  assert.match(text, /Contenido nuevo del anexo tres\./);
  assert.match(text, /Anexo 4/);
  // The new content lands under "Anexo 3" and before the next section.
  assert.ok(text.indexOf('Anexo 3') < text.indexOf('Contenido nuevo'));
  assert.ok(text.indexOf('Contenido nuevo') < text.indexOf('Anexo 4'));
});

test('fillDocxSectionBuffer flags SECTION_NOT_FOUND when the heading is absent', () => {
  const target = parseTargetSectionRequest('completa el anexo 3');
  const buffer = makeDocx(['Portada original UPN', 'Introducción', 'Conclusiones']);
  assert.throws(
    () => fillDocxSectionBuffer(buffer, target, [{ kind: 'normal', text: 'x' }]),
    (err) => err && err.code === 'SECTION_NOT_FOUND',
  );
});

test('append fallback keeps the original content and adds the section heading at the end', () => {
  // Mirrors what generateSourcePreservingDocumentEdit does when the in-place
  // fill reports SECTION_NOT_FOUND: prepend the section heading, then append.
  const target = parseTargetSectionRequest('completa el anexo 3');
  const buffer = makeDocx(['Portada original UPN', 'Introducción']);
  const fallbackBlocks = [
    { kind: 'pageBreak', text: '' },
    { kind: 'heading2', text: target.label },
    { kind: 'normal', text: 'Contenido nuevo del anexo tres.' },
  ];
  const out = appendToDocxBuffer(buffer, fallbackBlocks);
  const text = docxText(out);

  assert.match(text, /Portada original UPN/);
  assert.match(text, /Introducción/);
  assert.match(text, /Anexo 3/);
  assert.match(text, /Contenido nuevo del anexo tres\./);
  // The appended section comes after the original body.
  assert.ok(text.indexOf('Introducción') < text.indexOf('Anexo 3'));
});
