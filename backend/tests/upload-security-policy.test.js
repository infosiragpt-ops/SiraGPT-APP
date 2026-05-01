const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isDeclaredUploadAllowed,
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

test('upload limits default to a bounded commercial ceiling unless explicitly overridden', () => {
  const limits = resolveUploadLimits({});
  assert.equal(limits.fileSize, 100 * 1024 * 1024);
  assert.equal(limits.files, 10);

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
