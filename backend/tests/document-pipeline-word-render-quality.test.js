'use strict';

// Word RENDER-quality regressions, found by rendering real pipeline output
// through LibreOffice and reading the pages:
//
// 1. Every bullet/numbered list shipped flat (no markers): pandoc tags list
//    paragraphs with pStyle "Compact", the reference doc didn't define it,
//    and LibreOffice DROPS numbering on paragraphs with undefined styles.
// 2. Section tables ({table} on a content block) were silently discarded.
// 3. numbering.xml carried a <w:num> pointing at an abstractNum that doesn't
//    exist — Word flags the file and offers "repair".
// 4. Table header rows rendered as plain body rows (no bold, no shading),
//    and pandoc's SELF-CLOSED <w:tcPr /> made a naive shading pass miss.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const adp = require('../src/services/document-pipeline/advanced-document-pipeline');

const { buildDocxMarkdown, postProcessWordDocx } = adp.INTERNAL;

function planWith(blocks) {
  const plan = adp.buildPlan({ prompt: 'Informe ejecutivo de prueba', format: 'docx', template: 'business' });
  plan.title = 'Informe de prueba';
  plan.blocks = plan.sections.map((_, i) => blocks[i] || blocks[blocks.length - 1]);
  return plan;
}

test('section tables reach the markdown instead of being dropped', () => {
  const plan = planWith([{
    paragraph: 'Texto.',
    table: { headers: ['Col A', 'Col B'], rows: [['1', '2'], ['3', '4']] },
  }]);
  const md = buildDocxMarkdown(plan);
  assert.match(md, /Col A/, 'table headers must appear');
  assert.match(md, /\|/, 'a markdown table must be emitted');
});

test('the title block uses a human date, not a raw ISO stamp', () => {
  const md = buildDocxMarkdown(planWith([{ paragraph: 'x' }]));
  const dateLine = md.split('\n')[2];
  assert.doesNotMatch(dateLine, /% \d{4}-\d{2}-\d{2}$/, 'no ISO date in the title block');
  assert.match(dateLine, /% \d{1,2} de [a-zá-ú]+ de \d{4}/i, 'es-ES long date expected');
});

function minimalDocx({ documentXml, numberingXml }) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  zip.file('word/document.xml', documentXml);
  if (numberingXml) zip.file('word/numbering.xml', numberingXml);
  return zip.generate({ type: 'nodebuffer' });
}

const PLAN = { title: 'Doc' };

test('dangling numbering references are dropped so Word never offers repair', () => {
  const numbering = '<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:abstractNum w:abstractNumId="991"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="1" /><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1" /></w:lvlOverride></w:num>'
    + '<w:num w:numId="1002"><w:abstractNumId w:val="991" /></w:num>'
    + '</w:numbering>';
  const buffer = minimalDocx({
    documentXml: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
    numberingXml: numbering,
  });
  const out = new PizZip(postProcessWordDocx(buffer, PLAN));
  const sanitized = out.file('word/numbering.xml').asText();
  assert.ok(!sanitized.includes('<w:num w:numId="1">'), 'dangling num must be removed');
  assert.ok(sanitized.includes('<w:num w:numId="1002">'), 'valid num must survive');
});

test('table header rows gain bold + shading, idempotently, both tcPr shapes', () => {
  const table = '<w:tbl><w:tblPr><w:tblLook w:val="0"/></w:tblPr>'
    + '<w:tr><w:tc><w:tcPr /><w:p><w:r><w:t>Encabezado</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:tcPr><w:tcW w:w="100" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Otro</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:tcPr /><w:p><w:r><w:t>Cuerpo</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:tcPr /><w:p><w:r><w:t>Dato</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const buffer = minimalDocx({
    documentXml: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${table}</w:body></w:document>`,
  });
  const once = new PizZip(postProcessWordDocx(buffer, PLAN)).file('word/document.xml').asText();
  assert.equal((once.match(/w:fill="F1F5F9"/g) || []).length, 2, 'both header cells shaded, body cells untouched');
  assert.match(once, /<w:tblHeader\/>/, 'header repeats across page breaks');
  const headerRow = once.slice(once.indexOf('<w:tr>'), once.indexOf('</w:tr>'));
  assert.match(headerRow, /<w:rPr><w:b\/><\/w:rPr>/, 'header runs must be bold');
  const bodyRow = once.slice(once.lastIndexOf('<w:tr>'));
  assert.doesNotMatch(bodyRow, /F1F5F9/, 'body rows keep their plain background');

  const roundTrip = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${once.slice(once.indexOf('<w:tbl>'), once.indexOf('</w:tbl>') + 8)}</w:body></w:document>`;
  const twice = new PizZip(postProcessWordDocx(minimalDocx({ documentXml: roundTrip }), PLAN))
    .file('word/document.xml').asText();
  assert.equal((twice.match(/w:fill="F1F5F9"/g) || []).length, 2, 'reprocessing must not stack duplicate shading');
});

test('the pandoc reference styles cover every id pandoc emits', () => {
  // If any of these goes missing again, LibreOffice silently drops list
  // markers document-wide — the exact bug this suite exists to prevent.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/services/document-pipeline/advanced-document-pipeline.js'), 'utf8');
  for (const styleId of ['Title', 'Author', 'Date', 'FirstParagraph', 'Compact', 'BlockText']) {
    assert.ok(
      new RegExp(`id: '${styleId}'`).test(src),
      `reference doc must define pandoc style "${styleId}"`,
    );
  }
});
