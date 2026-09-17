'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveImageSource } = require('../src/services/media/image-source');
const storage = require('../src/services/object-storage');
const fixtures = fs.mkdtemp(path.join(os.tmpdir(), 'image-source-test-'));
after(async () => fs.rm(await fixtures, { recursive: true, force: true }));

async function context(messages = [], records = {}) {
  const dir = await fixtures;
  const sourcePath = path.join(dir, 'source.png'); await fs.writeFile(sourcePath, 'source-pixels');
  const prisma = {
    chat: { findFirst: async ({ where }) => where.id === 'chat' && where.userId === 'owner' && where.deletedAt === null ? { id: 'chat' } : null },
    message: { findMany: async ({ where }) => { assert.equal(where.deletedAt, null); return messages; } },
    file: { findFirst: async ({ where }) => {
      assert.equal(where.userId, 'owner'); assert.equal(where.deletedAt, null);
      const record = records[where.id || where.filename];
      return record ? { path: sourcePath, mimeType: 'image/png', id: where.id, ...record } : null;
    } },
  };
  return { prisma, userId: 'owner', chatId: 'chat', requireChatOwnership: true, artifactDir: dir };
}

test('explicit missing or unowned image never falls back to another chat image', async () => {
  const ctx = await context([{ files: [{ type: 'image', fileId: 'previous' }] }], { previous: {} });
  assert.equal(await resolveImageSource({ fileId: 'missing' }, ctx), null);
  assert.equal(await resolveImageSource({ fileId: 'previous' }, { ...ctx, chatId: 'other-chat' }), null);
});

test('history scans past non-image messages and accepts image MIME file ids', async () => {
  const ctx = await context([
    { files: 'invalid-json' },
    { files: [{ type: 'application/pdf', id: 'document' }] },
    { files: [{ type: 'image/png', fileId: 'beach', version: 3 }] },
  ], { beach: {} });
  const source = await resolveImageSource({}, ctx);
  assert.equal(source.fileId, 'beach'); assert.equal(source.metadata.version, 3);
  assert.equal(source.buffer.toString(), 'source-pixels');
});

test('soft deleted images are excluded from explicit and history selection', async () => {
  const ctx = await context([{ files: [{ type: 'image', fileId: 'hidden', deletedAt: '2026-09-17' }] }], { hidden: {} });
  assert.equal(await resolveImageSource({}, ctx), null);
  assert.equal(await resolveImageSource({ fileId: 'hidden' }, ctx), null);
});

test('agent artifact references reuse owned materialization and enforce chat binding', async () => {
  const dir = await fixtures; const id = '123456abcdef';
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ownerUserId: 'owner', chatId: 'chat', mime: 'image/png', storedRelPath: `${id}-source.png` }));
  await fs.writeFile(path.join(dir, `${id}-source.png`), 'artifact-pixels');
  const ctx = await context([{ content: `![image](/api/agent/artifact/${id})` }]);
  const source = await resolveImageSource({}, ctx);
  assert.equal(source.fileId, `artifact:${id}`); assert.equal(source.buffer.toString(), 'artifact-pixels');
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ownerUserId: 'other', mime: 'image/png', storedRelPath: `${id}-source.png` }));
  assert.equal(await resolveImageSource({ fileId: `artifact:${id}` }, ctx), null);
});

test('R2 source materialization is cleaned up after reading', async () => {
  const ctx = await context([], { remote: { path: 'r2://private/source.png' } });
  const localPath = path.join(await fixtures, 'r2-copy.png'); await fs.writeFile(localPath, 'r2-pixels');
  const previous = storage.toLocalTemp; let cleaned = false;
  storage.toLocalTemp = async (ref) => { assert.equal(ref, 'r2://private/source.png'); return { path: localPath, cleanup: async () => { cleaned = true; } }; };
  try {
    assert.equal((await resolveImageSource({ fileId: 'remote' }, ctx)).buffer.toString(), 'r2-pixels');
    assert.equal(cleaned, true);
  } finally { storage.toLocalTemp = previous; }
});

test('an image hidden in one message remains editable from another visible occurrence', async () => {
  const visible = { type: 'image', fileId: 'same-file', version: 2 };
  const ctx = await context([{ files: [{ ...visible, deletedAt: '2026-09-17' }] }, { files: [visible] }], { 'same-file': {} });
  assert.equal((await resolveImageSource({ fileId: 'same-file' }, ctx)).metadata.version, 2);
  ctx.prisma.message.findMany = async ({ where }) => {
    assert.equal(where.id, 'message-visible'); return [{ files: [visible] }];
  };
  assert.equal((await resolveImageSource({ fileId: 'same-file' }, { ...ctx, messageId: 'message-visible' })).fileId, 'same-file');
});
