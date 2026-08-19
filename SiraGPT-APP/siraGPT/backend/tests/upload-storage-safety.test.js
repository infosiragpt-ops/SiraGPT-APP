const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('upload storage path safety', () => {
  let previousUploadDir;
  let uploadDir;

  afterEach(() => {
    delete require.cache[require.resolve('../src/middleware/upload')];
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
    if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
    uploadDir = null;
  });

  function loadUploadForTempRoot() {
    previousUploadDir = process.env.UPLOAD_DIR;
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-upload-root-'));
    process.env.UPLOAD_DIR = uploadDir;
    delete require.cache[require.resolve('../src/middleware/upload')];
    return require('../src/middleware/upload');
  }

  test('resolves user upload directories inside UPLOAD_DIR only', () => {
    const upload = loadUploadForTempRoot();
    const resolved = upload.resolveUserUploadDir('user-abc_123');

    assert.equal(resolved, path.join(uploadDir, 'user-abc_123'));
    assert.equal(upload.resolveUserUploadDir('../escape'), null);
    assert.equal(upload.resolveUserUploadDir('user/escape'), null);
  });

  test('accepts only filesystem-safe storage segments', () => {
    const upload = loadUploadForTempRoot();

    assert.equal(upload.safeStorageSegment('cuid-123_ABC'), 'cuid-123_ABC');
    assert.equal(upload.safeStorageSegment(''), null);
    assert.equal(upload.safeStorageSegment('..'), null);
    assert.equal(upload.safeStorageSegment('bad\nid'), null);
  });
});
