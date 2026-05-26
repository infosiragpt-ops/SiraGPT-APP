const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  contentDispositionHeader,
  parseHttpByteRange,
  resolveConfinedFile,
  safeDownloadFilename,
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

  test('sanitizes user-provided download filenames and enforces extensions', () => {
    assert.equal(
      safeDownloadFilename('Quarterly Report 2026.xlsx', { fallback: 'ai-response.xlsx', extension: '.xlsx' }),
      'Quarterly-Report-2026.xlsx',
    );
    assert.equal(
      safeDownloadFilename('../secret.txt', { fallback: 'ai-response.csv', extension: '.csv' }),
      'secret.csv',
    );
    assert.equal(
      safeDownloadFilename('bad\r\nname.csv', { fallback: 'ai-response.csv', extension: '.csv' }),
      'badname.csv',
    );
    assert.equal(
      safeDownloadFilename('', { fallback: 'ai-response.txt', extension: '.txt' }),
      'ai-response.txt',
    );
  });

  test('parses valid video byte ranges', () => {
    assert.deepEqual(parseHttpByteRange('bytes=0-99', 1000), {
      start: 0,
      end: 99,
      contentLength: 100,
      contentRange: 'bytes 0-99/1000',
    });
    assert.deepEqual(parseHttpByteRange('bytes=900-', 1000), {
      start: 900,
      end: 999,
      contentLength: 100,
      contentRange: 'bytes 900-999/1000',
    });
    assert.deepEqual(parseHttpByteRange('bytes=-50', 1000), {
      start: 950,
      end: 999,
      contentLength: 50,
      contentRange: 'bytes 950-999/1000',
    });
  });

  test('reports invalid and unsatisfiable byte ranges without throwing', () => {
    assert.deepEqual(parseHttpByteRange('bytes=100-10', 1000), {
      error: 'unsatisfiable',
      contentRange: 'bytes */1000',
    });
    assert.deepEqual(parseHttpByteRange('bytes=1000-1001', 1000), {
      error: 'unsatisfiable',
      contentRange: 'bytes */1000',
    });
    assert.deepEqual(parseHttpByteRange('bytes=a-b', 1000), {
      error: 'invalid',
      contentRange: 'bytes */1000',
    });
  });
});
