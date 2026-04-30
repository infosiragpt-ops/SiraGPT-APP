const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const {
  countMathElements,
  detectMathIntent,
  validateMathRender,
} = require('../src/services/agents/math-render-validator');

// Build a minimal docx-shaped zip with a synthetic word/document.xml
// so we can exercise the parser without spinning up python-docx.
async function makeDocxBuffer(documentXml) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('word/document.xml', documentXml);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

test('countMathElements counts <m:oMath> and <w:drawing> in a docx', async () => {
  const xml = `<?xml version="1.0"?>
    <w:document xmlns:w="x" xmlns:m="y">
      <w:body>
        <w:p><m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara></w:p>
        <w:p><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></w:p>
        <w:p><w:drawing/></w:p>
      </w:body>
    </w:document>`;
  const buf = await makeDocxBuffer(xml);

  const counts = await countMathElements(buf);

  assert.equal(counts.ok, true);
  assert.equal(counts.omath, 2, 'should count both <m:oMath> elements');
  assert.equal(counts.drawings, 1, 'should count the single <w:drawing>');
});

test('countMathElements reports zero when the doc has no math', async () => {
  const xml = `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>plain</w:t></w:r></w:p></w:body></w:document>`;
  const buf = await makeDocxBuffer(xml);

  const counts = await countMathElements(buf);

  assert.equal(counts.ok, true);
  assert.equal(counts.omath, 0);
  assert.equal(counts.drawings, 0);
});

test('countMathElements fails closed when the buffer is empty', async () => {
  const counts = await countMathElements(Buffer.alloc(0));
  assert.equal(counts.ok, false);
  assert.equal(counts.reason, 'empty_buffer');
});

test('countMathElements fails closed when the file is not a real zip', async () => {
  const counts = await countMathElements(Buffer.from('not-a-zip'));
  assert.equal(counts.ok, false);
  assert.match(counts.reason, /zip_open_failed/);
});

test('countMathElements fails closed when word/document.xml is missing', async () => {
  const zip = new JSZip();
  zip.file('not_word.xml', '<x/>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const counts = await countMathElements(buf);

  assert.equal(counts.ok, false);
  assert.equal(counts.reason, 'missing_document_xml');
});

test('detectMathIntent picks up Spanish math vocabulary', () => {
  assert.equal(detectMathIntent('Crea un Word con un ejercicio de integrales'), true);
  assert.equal(detectMathIntent('Necesito derivadas e integrales para mi tesis'), true);
  assert.equal(detectMathIntent('Calcular el alfa de Cronbach del instrumento'), true);
  assert.equal(detectMathIntent('Dame una ecuación que represente la velocidad'), true);
  assert.equal(detectMathIntent('Plot a Pareto chart'), false, 'no math vocab → false');
});

test('detectMathIntent picks up English math vocabulary', () => {
  assert.equal(detectMathIntent('Generate a calculus exam'), true);
  assert.equal(detectMathIntent('Build a matrix decomposition writeup'), true);
  assert.equal(detectMathIntent('Plain marketing brief'), false);
});

test('detectMathIntent fires on direct LaTeX / apa_math source markers', () => {
  assert.equal(detectMathIntent('apa_math(doc, r"\\int_0^1 f(x)dx")'), true);
  assert.equal(detectMathIntent('Use \\frac{a}{b} when needed'), true);
  assert.equal(detectMathIntent('Plain prose'), false);
});

test('validateMathRender passes when math is expected AND rendered', async () => {
  const xml = `<w:document xmlns:m="m"><m:oMath/></w:document>`;
  const buf = await makeDocxBuffer(xml);

  const result = await validateMathRender({
    buffer: buf,
    prompt: 'Crea un word con integrales',
    sourceText: 'apa_math(doc, r"\\int")',
  });

  assert.equal(result.ok, true);
  assert.equal(result.mathExpected, true);
  assert.equal(result.omath, 1);
});

test('validateMathRender BLOCKS when math is expected and zero rendered', async () => {
  const xml = `<w:document><w:body><w:p><w:r><w:t>solo prosa</w:t></w:r></w:p></w:body></w:document>`;
  const buf = await makeDocxBuffer(xml);

  const result = await validateMathRender({
    buffer: buf,
    prompt: 'Crea un word con un ejercicio de integrales y derivadas',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_equations_rendered');
  assert.equal(result.mathExpected, true);
  assert.equal(result.omath, 0);
  assert.equal(result.drawings, 0);
});

test('validateMathRender does NOT block a non-math document with no math', async () => {
  const xml = `<w:document><w:body><w:p><w:r><w:t>prose</w:t></w:r></w:p></w:body></w:document>`;
  const buf = await makeDocxBuffer(xml);

  const result = await validateMathRender({
    buffer: buf,
    prompt: 'Genera un brief de marketing en Word',
  });

  assert.equal(result.ok, true);
  assert.equal(result.mathExpected, false);
});

test('validateMathRender accepts the image fallback as valid math when expected', async () => {
  // After phase 1 lands, most math is OMML, but the matplotlib PNG
  // fallback is still legitimate. A doc with 0 OMML + 1 drawing
  // counts as having math content.
  const xml = `<w:document><w:body><w:p><w:drawing/></w:p></w:body></w:document>`;
  const buf = await makeDocxBuffer(xml);

  const result = await validateMathRender({
    buffer: buf,
    prompt: 'Crea un word con derivadas',
  });

  assert.equal(result.ok, true);
  assert.equal(result.omath, 0);
  assert.equal(result.drawings, 1);
});
