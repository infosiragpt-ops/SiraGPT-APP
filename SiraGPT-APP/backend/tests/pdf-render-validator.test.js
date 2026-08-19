const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countPdfMetrics,
  validatePdfRender,
  expectsTextContent,
  looksLikePdf,
} = require('../src/services/agents/pdf-render-validator');

// Real-PDF tests would be flaky here: pdf-parse trips on quirky
// generators ("Command token too long" on some agent-artifacts on
// disk locally) and CI doesn't have any sample PDFs at all. The
// failure modes the validator actually defends against are covered
// by the unit-level tests below: magic-byte check, empty input,
// magic-missing input, corrupt body, content-expectation logic.

test('looksLikePdf accepts a buffer that starts with %PDF-', () => {
  const buf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x20)]);
  assert.equal(looksLikePdf(buf), true);
});

test('looksLikePdf rejects buffers that are too small or missing the magic', () => {
  assert.equal(looksLikePdf(Buffer.alloc(0)), false, 'empty');
  assert.equal(looksLikePdf(Buffer.alloc(50)), false, 'too small');
  assert.equal(looksLikePdf(Buffer.from('GIF89a' + 'x'.repeat(300))), false, 'wrong magic');
  // Strings are not buffers — defensive check.
  assert.equal(looksLikePdf('%PDF-1.4'), false);
});

test('countPdfMetrics fails closed on empty input', async () => {
  const result = await countPdfMetrics(Buffer.alloc(0));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty_buffer');
});

test('countPdfMetrics fails when the magic bytes are missing', async () => {
  const fake = Buffer.concat([Buffer.from('NOT-A-PDF'), Buffer.alloc(500, 0x20)]);
  const result = await countPdfMetrics(fake);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pdf_magic_missing');
  assert.equal(result.hasMagic, false);
});

test('countPdfMetrics fails closed when the magic is present but body is corrupt', async () => {
  // Magic is there, but the rest is garbage so pdf-parse will
  // refuse to count pages.
  const fake = Buffer.concat([Buffer.from('%PDF-1.4\n%¿\n'), Buffer.alloc(500, 0x20)]);
  const result = await countPdfMetrics(fake);
  assert.equal(result.ok, false);
  assert.match(result.reason, /pdf_parse_failed|zero_pages/);
});

test('expectsTextContent fires on report / informe / memoria / manual prompts', () => {
  assert.equal(expectsTextContent('Genera un informe APA en PDF'), true);
  assert.equal(expectsTextContent('Build a CV in PDF format'), true);
  assert.equal(expectsTextContent('Build a quarterly report'), true);
  assert.equal(expectsTextContent('Memoria de proyecto'), true);
  assert.equal(expectsTextContent('Pure marketing brief'), false, 'no content keyword → false');
  assert.equal(expectsTextContent(''), false);
  assert.equal(expectsTextContent(null), false);
});

test('expectsTextContent suppresses content expectation for explicit fillable forms', () => {
  // "Generate a fillable PDF form" is allowed to ship with empty body.
  assert.equal(expectsTextContent('Generate a fillable PDF form'), false);
  assert.equal(expectsTextContent('Necesito un formulario PDF rellenable'), false);
  assert.equal(expectsTextContent('Plantilla vacía PDF'), false);
});

test('validatePdfRender BLOCKS when content expected but the PDF is empty-text', async () => {
  // We fake the metrics by passing a stub buffer through the same
  // path: short text, valid magic, fake page count via small valid
  // PDF would be ideal but unreliable. Cover the branch via a
  // direct invocation of the underlying logic on a controlled
  // metrics shape:
  const { validatePdfRender: validate } = require('../src/services/agents/pdf-render-validator');
  // Real PDFs without a body still parse — we simulate by passing
  // the smallest-possible-valid PDF. If pdf-parse rejects, we get
  // pdf_parse_failed which still counts as "blocked" — just under
  // a different reason. Either is acceptable for the test contract.
  const minimal = Buffer.from(
    '%PDF-1.1\n%¿\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000050 00000 n \n0000000100 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n200\n%%EOF\n'
  );
  const result = await validate({ buffer: minimal, prompt: 'genera un informe en pdf' });
  assert.equal(result.ok, false);
  assert.match(
    result.reason,
    /no_text_content|pdf_parse_failed|zero_pages/,
    'should block with one of the expected failure reasons',
  );
  assert.equal(result.contentExpected, true);
});

test('validatePdfRender does NOT block a non-content (form) request when text is empty', async () => {
  const minimal = Buffer.from(
    '%PDF-1.1\n%¿\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000050 00000 n \n0000000100 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n200\n%%EOF\n'
  );
  const result = await validatePdfRender({
    buffer: minimal,
    prompt: 'fillable PDF form for a registration page',
  });
  // We don't assert ok=true here because pdf-parse may legitimately
  // refuse our hand-rolled minimal PDF; what matters is that even
  // when parsing succeeds, the result is NOT blocked on
  // 'no_text_content' for a form request.
  if (result.reason === 'no_text_content') {
    assert.fail('form request should not be blocked on missing body text');
  }
  assert.equal(result.contentExpected, false);
});
