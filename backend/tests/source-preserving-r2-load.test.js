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

// ── Generated artifacts offloaded to R2 (incident 2026-09-28) ────────────
// saveArtifact() uploads the binary and startArtifactMirror() deletes the
// local copy. The quick editor only looked on disk, found no source for a
// follow-up edit of a generated deck, and returned null.

const crypto = require('crypto');
const {
  INTERNAL: spInternal,
} = require('../src/services/source-preserving-document-edit');
const { ARTIFACT_DIR } = require('../src/services/agents/task-tools');

function writeOffloadedArtifactMeta({ ownerUserId = 'u-r2', chatId = 'c-r2', filename = 'deck.pptx' } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const storedRelPath = `${id}-${filename}`;
  const storageRef = `r2:agent-artifacts/${storedRelPath}`;
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.json`), JSON.stringify({
    id, filename, format: 'pptx', ownerUserId, chatId, storedRelPath, storageRef,
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }));
  return { id, storageRef, cleanup: () => { try { fs.unlinkSync(path.join(ARTIFACT_DIR, `${id}.json`)); } catch { /* best-effort */ } } };
}

function prismaWithRow(row) {
  return {
    generatedArtifact: { findMany: async () => [row] },
  };
}

test('generated artifact whose local copy was offloaded to R2 is still a source (storageRef)', async () => {
  const meta = writeOffloadedArtifactMeta();
  try {
    const sources = await spInternal.loadRecentGeneratedArtifactSourceFiles(prismaWithRow({
      id: meta.id,
      filename: 'deck.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      format: 'pptx',
      path: path.join(os.tmpdir(), `gone-${meta.id}.pptx`),
      createdAt: new Date(),
    }), { userId: 'u-r2', chatId: 'c-r2' });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].path, meta.storageRef, 'readSourceBuffer materialises the r2: ref');
    assert.equal(sources[0].source, 'generated_artifact');
  } finally {
    meta.cleanup();
  }
});

test('an offloaded artifact of another user or another chat is never loaded', async () => {
  const foreignOwner = writeOffloadedArtifactMeta({ ownerUserId: 'someone-else' });
  const foreignChat = writeOffloadedArtifactMeta({ chatId: 'other-chat' });
  try {
    for (const meta of [foreignOwner, foreignChat]) {
      const sources = await spInternal.loadRecentGeneratedArtifactSourceFiles(prismaWithRow({
        id: meta.id, filename: 'deck.pptx', format: 'pptx', path: null, createdAt: new Date(),
      }), { userId: 'u-r2', chatId: 'c-r2' });
      assert.deepEqual(sources, []);
    }
  } finally {
    foreignOwner.cleanup();
    foreignChat.cleanup();
  }
});

test('assistant download cards of an offloaded artifact resolve to its storageRef too', async () => {
  const meta = writeOffloadedArtifactMeta();
  try {
    const prisma = {
      message: {
        findMany: async () => [{
          files: JSON.stringify([{ url: `/api/agent/artifact/${meta.id}?name=deck.pptx`, filename: 'deck.pptx' }]),
          timestamp: new Date(),
        }],
      },
    };
    const sources = await spInternal.loadRecentAssistantArtifactSourceFiles(prisma, { chatId: 'c-r2', userId: 'u-r2' });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].path, meta.storageRef);
    // A traversal id from a crafted card URL never reaches the metadata read.
    const crafted = {
      message: {
        findMany: async () => [{ files: JSON.stringify([{ url: '/api/agent/artifact/..%2F..%2Fetc%2Fpasswd', filename: 'x.pptx' }]), timestamp: new Date() }],
      },
    };
    assert.deepEqual(await spInternal.loadRecentAssistantArtifactSourceFiles(crafted, { chatId: 'c-r2', userId: 'u-r2' }), []);
  } finally {
    meta.cleanup();
  }
});
