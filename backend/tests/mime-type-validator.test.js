const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const {
  validateMimeType,
  mimesAreEquivalent,
  EXTENSION_TO_MIME,
  MAGICLESS_DECLARED_MIMES,
} = require('../src/services/agents/mime-type-validator');

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Smallest possible buffer that file-type recognises as PDF.
function fakePdfBuffer(extra = '') {
  return Buffer.concat([Buffer.from(`%PDF-1.4\n%¿\n${extra}`), Buffer.alloc(300, 0x20)]);
}

// JSZip-built minimal DOCX-shaped file. file-type peeks into the
// ZIP and lifts the OOXML mime from [Content_Types].xml; without
// that file we'd just get application/zip back.
async function fakeDocxBuffer() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" '
    + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="x"/>');
  return await zip.generateAsync({ type: 'nodebuffer' });
}

test('mimesAreEquivalent treats identical mimes as equal', () => {
  assert.equal(mimesAreEquivalent(PDF_MIME, PDF_MIME), true);
  assert.equal(mimesAreEquivalent(DOCX_MIME, DOCX_MIME), true);
});

test('mimesAreEquivalent accepts application/zip as equivalent for DOCX/XLSX/PPTX', () => {
  // Older file-type versions returned 'application/zip' for OOXML
  // because they didn't peek inside [Content_Types].xml. Both reads
  // are valid; pin the equivalence so a runner pinned to an older
  // version doesn't trip the validator.
  assert.equal(mimesAreEquivalent(DOCX_MIME, 'application/zip'), true);
});

test('mimesAreEquivalent rejects unrelated mimes', () => {
  assert.equal(mimesAreEquivalent(PDF_MIME, DOCX_MIME), false);
  assert.equal(mimesAreEquivalent(DOCX_MIME, 'application/pdf'), false);
});

test('validateMimeType passes when declared and detected match', async () => {
  const result = await validateMimeType({
    buffer: fakePdfBuffer(),
    declaredMime: PDF_MIME,
    declaredExtension: 'pdf',
  });
  assert.equal(result.ok, true);
  assert.equal(result.detectedMime, PDF_MIME);
  assert.equal(result.detectedExtension, 'pdf');
});

test('validateMimeType passes when only the extension is supplied (resolved through table)', async () => {
  const result = await validateMimeType({
    buffer: fakePdfBuffer(),
    declaredExtension: 'pdf',
  });
  assert.equal(result.ok, true);
  assert.equal(result.declaredMime, PDF_MIME);
  assert.equal(result.detectedMime, PDF_MIME);
});

test('validateMimeType BLOCKS a renamed file (declared docx, real PDF)', async () => {
  const result = await validateMimeType({
    buffer: fakePdfBuffer(),
    declaredMime: DOCX_MIME,
    declaredExtension: 'docx',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mime_mismatch');
  assert.equal(result.detectedMime, PDF_MIME);
});

test('validateMimeType BLOCKS empty buffers', async () => {
  const result = await validateMimeType({
    buffer: Buffer.alloc(0),
    declaredMime: PDF_MIME,
    declaredExtension: 'pdf',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty_buffer|magic_bytes_unreadable/);
});

test('validateMimeType BLOCKS unknown declared extensions', async () => {
  const result = await validateMimeType({
    buffer: fakePdfBuffer(),
    declaredExtension: 'fakeext',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'declared_extension_unknown');
});

test('validateMimeType passes plain-text formats with no magic bytes (CSV / MD / TXT)', async () => {
  for (const ext of ['csv', 'md', 'txt', 'json', 'xml', 'html', 'yaml', 'yml']) {
    const declaredMime = EXTENSION_TO_MIME[ext];
    assert.equal(MAGICLESS_DECLARED_MIMES.has(declaredMime), true, `${ext} should be in MAGICLESS set`);
    const result = await validateMimeType({
      buffer: Buffer.from('a,b,c\n1,2,3\n'),
      declaredMime,
      declaredExtension: ext,
    });
    assert.equal(result.ok, true, `expected ${ext} (${declaredMime}) to pass; got ${result.reason}`);
    assert.equal(result.detectedMime, null, 'magic-less formats should detect as null');
  }
});

test('validateMimeType BLOCKS a binary masquerading as txt (claims text but has PDF magic)', async () => {
  // file-type detects the PDF signature, declared is text/plain — those
  // never line up via the equivalence table, so we should refuse it.
  const result = await validateMimeType({
    buffer: fakePdfBuffer(),
    declaredMime: 'text/plain',
    declaredExtension: 'txt',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mime_mismatch');
});

test('validateMimeType passes a real DOCX-shaped zip with the OOXML mime', async () => {
  const buf = await fakeDocxBuffer();
  const result = await validateMimeType({
    buffer: buf,
    declaredMime: DOCX_MIME,
    declaredExtension: 'docx',
  });
  // file-type 22+ returns the OOXML mime; 21- returns application/zip.
  // Both are in the equivalence map so both must pass.
  assert.equal(result.ok, true, `expected ok, got ${result.reason}`);
});
