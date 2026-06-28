const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isDeclaredUploadAllowed,
  isOfficeTemporaryLockFile,
  mimeMatchesExtension,
  resolveUploadLimits,
  validateUploadPolicy,
} = require('../src/services/upload-security-policy');

test('upload policy accepts extension fallback for octet-stream browser uploads', () => {
  assert.equal(isDeclaredUploadAllowed({
    originalname: 'report.pdf',
    mimetype: 'application/octet-stream',
  }), true);

  const result = validateUploadPolicy({
    originalName: 'report.pdf',
    declaredMime: 'application/octet-stream',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'application/pdf');
});

test('upload policy canonicalizes xlsx browser/zip uploads for extraction', () => {
  const zipDetected = validateUploadPolicy({
    originalName: 'base_sucesion_intestada_seleccionados.xlsx',
    declaredMime: 'application/octet-stream',
    detectedMime: 'application/zip',
    detectionSource: 'magic-bytes',
    size: 2048,
  });

  assert.equal(zipDetected.ok, true);
  assert.equal(zipDetected.detectedMime, 'application/zip');
  assert.equal(zipDetected.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const noMagic = validateUploadPolicy({
    originalName: 'base_sucesion_intestada_seleccionados.xlsx',
    declaredMime: 'application/octet-stream',
    detectedMime: 'application/octet-stream',
    detectionSource: 'fallback',
    size: 2048,
  });

  assert.equal(noMagic.ok, true);
  assert.equal(noMagic.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('upload policy accepts harmless repeated dots in basename', () => {
  const result = validateUploadPolicy({
    originalName: 'Captura de pantalla 2026-01-01 a la(s) 5.20.33 p. m..png',
    declaredMime: 'image/png',
    detectedMime: 'image/png',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'accepted');
});

test('upload policy still rejects path traversal style names', () => {
  const result = validateUploadPolicy({
    originalName: '../report.pdf',
    declaredMime: 'application/pdf',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_filename');
});

test('upload policy rejects Microsoft Office temporary lock files with a clear message', () => {
  assert.equal(isOfficeTemporaryLockFile('~$2 267 Formato para el proyecto de tesis.docx'), true);
  assert.equal(isOfficeTemporaryLockFile('2 267 Formato para el proyecto de tesis.docx'), false);

  const result = validateUploadPolicy({
    originalName: '~$2 267 Formato para el proyecto de tesis.docx',
    declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    detectedMime: 'application/octet-stream',
    detectionSource: 'fallback',
    size: 162,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'office_temp_lock_file');
  assert.match(result.message, /temporal de Microsoft Office/);
  assert.match(result.message, /documento original/);
});

test('upload policy rejects mismatched extension and magic bytes', () => {
  const result = validateUploadPolicy({
    originalName: 'renamed.docx',
    declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'extension_mime_mismatch');
  assert.equal(result.detectedMime, 'application/pdf');
});

test('upload policy rejects detected binary types outside the allowlist', () => {
  const result = validateUploadPolicy({
    originalName: 'payload.txt',
    declaredMime: 'text/plain',
    detectedMime: 'application/x-msdownload',
    detectionSource: 'magic-bytes',
    size: 1024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'detected_type_not_allowed');
});

test('upload policy keeps text-ish extension fallbacks usable', () => {
  const result = validateUploadPolicy({
    originalName: 'dataset.csv',
    declaredMime: 'text/plain',
    detectedMime: 'text/plain',
    detectionSource: 'fallback',
    size: 1024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'text/plain');
  assert.equal(mimeMatchesExtension('text/plain', 'csv'), true);
});

test('upload policy accepts legacy binary .xls spreadsheets for Office workflows', () => {
  const result = validateUploadPolicy({
    originalName: 'legacy.xls',
    declaredMime: 'application/vnd.ms-excel',
    detectedMime: 'application/vnd.ms-excel',
    detectionSource: 'fallback',
    size: 1024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'application/vnd.ms-excel');
});

test('upload limits default to a bounded commercial ceiling unless explicitly overridden', () => {
  const limits = resolveUploadLimits({});
  assert.equal(limits.fileSize, 100 * 1024 * 1024);
  assert.equal(limits.files, 400);

  const tooLarge = validateUploadPolicy({
    originalName: 'large.pdf',
    declaredMime: 'application/pdf',
    detectedMime: 'application/pdf',
    detectionSource: 'magic-bytes',
    size: limits.fileSize + 1,
    env: {},
  });

  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'file_too_large');
});

test('upload limits honour deployment env caps', () => {
  const limits = resolveUploadLimits({ MAX_FILE_SIZE: '25', MAX_UPLOAD_FILES: '3' });
  assert.equal(limits.fileSize, 25 * 1024 * 1024);
  assert.equal(limits.files, 3);
});

test('an SVG reported as generic XML is accepted (still active-content sanitized)', () => {
  // Some detectors report an SVG as application/xml; the ext→mime map only had
  // image/svg+xml, so a legit .svg got an extension_mime_mismatch.
  const r = validateUploadPolicy({ originalName: 'logo.svg', declaredMime: 'application/xml', detectedMime: 'application/xml', detectionSource: 'magic-bytes', size: 1000 });
  assert.equal(r.ok, true, r.code);
  // The native image/svg+xml form still works too.
  const native = validateUploadPolicy({ originalName: 'logo.svg', declaredMime: 'image/svg+xml', size: 1000 });
  assert.equal(native.ok, true, native.code);
});
