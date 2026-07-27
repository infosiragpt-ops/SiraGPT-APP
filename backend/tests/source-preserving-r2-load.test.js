'use strict';

/**
 * R2-aware source loading for the surgical document editor.
 *
 * Production uploads live as `r2:uploads/...` refs. Before this fix,
 * resolveStoredFilePath rejected them (fs.existsSync always false) so
 * loadEditableSourceFiles dropped the user's attachment and the editor
 * never saw the file. These tests pin the R2 acceptance + materialization.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveStoredFilePath,
  readSourceBuffer,
} = require('../src/services/source-preserving-document-edit');
const objectStorage = require('../src/services/object-storage');

test('resolveStoredFilePath accepts r2: refs without touching the filesystem', () => {
  const ref = 'r2:uploads/user-1/informe.docx';
  assert.equal(resolveStoredFilePath({ path: ref }, 'user-1'), ref);
  assert.equal(objectStorage.isRemote(ref), true);
});

test('resolveStoredFilePath still resolves a real local file', () => {
  const tmp = path.join(os.tmpdir(), `sp-local-${Date.now()}.docx`);
  fs.writeFileSync(tmp, 'local-bytes');
  try {
    assert.equal(resolveStoredFilePath({ path: tmp }, 'u1'), tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  }
});

test('resolveStoredFilePath returns null for a missing local path', () => {
  assert.equal(resolveStoredFilePath({ path: '/tmp/does-not-exist-siragpt-xyz.docx' }, 'u1'), null);
});

test('readSourceBuffer materializes an r2: ref via toLocalTemp and cleans up', async () => {
  const tmp = path.join(os.tmpdir(), `sp-r2-${Date.now()}.docx`);
  fs.writeFileSync(tmp, 'r2-materialized-bytes');
  let cleaned = false;
  const previous = objectStorage.__setStorageForTests
    ? null
    : null;
  // Stub toLocalTemp on the module the editor already requires.
  const originalToLocalTemp = objectStorage.toLocalTemp;
  objectStorage.toLocalTemp = async (ref) => {
    assert.equal(ref, 'r2:uploads/u1/doc.docx');
    return {
      path: tmp,
      cleanup: async () => { cleaned = true; try { fs.unlinkSync(tmp); } catch { /* noop */ } },
    };
  };
  try {
    const { buffer, cleanup } = await readSourceBuffer({ path: 'r2:uploads/u1/doc.docx' });
    assert.equal(buffer.toString('utf8'), 'r2-materialized-bytes');
    await cleanup();
    assert.equal(cleaned, true);
  } finally {
    objectStorage.toLocalTemp = originalToLocalTemp;
    void previous;
  }
});

test('readSourceBuffer reads a local path with a no-op cleanup', async () => {
  const tmp = path.join(os.tmpdir(), `sp-local-read-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'hello-local');
  try {
    const { buffer, cleanup } = await readSourceBuffer({ path: tmp });
    assert.equal(buffer.toString('utf8'), 'hello-local');
    await cleanup(); // must not throw
    assert.equal(fs.existsSync(tmp), true); // local files are never deleted
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  }
});
