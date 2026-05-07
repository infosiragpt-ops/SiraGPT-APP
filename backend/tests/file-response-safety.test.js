const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  contentDispositionHeader,
  resolveConfinedFile,
  safeFileSegment,
} = require('../src/middleware/file-response-safety');

describe('file response safety helpers', () => {
  test('accepts simple generated asset names with expected extensions', () => {
    assert.equal(
      safeFileSegment('video_123_abcd.mp4', { allowedExtensions: ['.mp4'] }),
      'video_123_abcd.mp4',
    );
    assert.equal(
      safeFileSegment('tts_123_abcd.mp3', { allowedExtensions: ['.mp3'] }),
      'tts_123_abcd.mp3',
    );
  });

  test('rejects traversal, encoded slashes, control characters, and extension confusion', () => {
    assert.equal(safeFileSegment('../secret.mp4', { allowedExtensions: ['.mp4'] }), null);
    assert.equal(safeFileSegment('%2e%2e%2fsecret.mp4', { allowedExtensions: ['.mp4'] }), null);
    assert.equal(safeFileSegment('bad\r\nname.mp4', { allowedExtensions: ['.mp4'] }), null);
    assert.equal(safeFileSegment('video_123.txt', { allowedExtensions: ['.mp4'] }), null);
  });

  test('resolves files only inside the configured base directory', () => {
    const baseDir = path.join(os.tmpdir(), 'siragpt-safe-files');
    const resolved = resolveConfinedFile(baseDir, 'asset.mp4', { allowedExtensions: ['.mp4'] });

    assert.equal(resolved.filename, 'asset.mp4');
    assert.equal(resolved.filePath, path.join(baseDir, 'asset.mp4'));
    assert.equal(resolveConfinedFile(baseDir, '..%2fasset.mp4', { allowedExtensions: ['.mp4'] }), null);
  });

  test('builds safe Content-Disposition filenames', () => {
    assert.equal(
      contentDispositionHeader('attachment', 'safe-name.mp4'),
      'attachment; filename="safe-name.mp4"',
    );
    assert.equal(
      contentDispositionHeader('inline', '../secret.mp3'),
      'inline; filename="download"',
    );
  });
});
