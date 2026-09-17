'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createImageWorkspaceService } = require('../src/services/media/image-workspace-assets');

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-workspace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = await sharp({ create: { width: 24, height: 12, channels: 4, background: '#2244aaff' } }).png().toBuffer();
  const sourcePath = path.join(dir, 'original.png');
  await fs.writeFile(sourcePath, original);
  const selected = {
    fileId: 'source-file', type: 'image', url: '/uploads/images/original.png',
    width: 24, height: 12, rootFileId: 'root-file', version: 3,
    model: 'selected-image-model', provider: 'selected-provider', quality: '2K', prompt: 'La misma playa',
  };
  const sibling = { fileId: 'sibling-file', type: 'image', url: '/uploads/images/sibling.png', comments: [{ id: 'note-old', text: 'No tocar', x: 3, y: 5 }] };
  let messages = new Map([
    ['message-1', { id: 'message-1', chatId: 'chat-1', files: JSON.stringify([selected, sibling]) }],
    ['message-neighbor', { id: 'message-neighbor', chatId: 'chat-1', files: JSON.stringify([selected]) }],
    ['message-other', { id: 'message-other', chatId: 'chat-2', files: JSON.stringify([selected]) }],
  ]);
  let files = new Map([['source-file', { id: 'source-file', userId: 'owner-1', filename: 'original.png', path: sourcePath, mimeType: 'image/png' }]]);
  let creates = 0;
  const removed = [];
  const writes = [];
  const lookupMessage = (where) => {
    const record = messages.get(where.id);
    return record && record.chatId === where.chatId && !record.deletedAt ? record : null;
  };
  const prisma = {
    chat: {
      findFirst: async ({ where }) => where.id === 'chat-1' && where.userId === 'owner-1' ? { id: where.id } : null,
      update: async () => ({}),
    },
    message: {
      findFirst: async ({ where }) => lookupMessage(where),
      findMany: async ({ where }) => [...messages.values()].filter((message) => message.chatId === where.chatId && (!where.id || message.id === where.id)),
      updateMany: async ({ where, data }) => {
        if (options.conflict) return { count: 0 };
        const current = lookupMessage(where);
        if (!current || JSON.stringify(current.files) !== JSON.stringify(where.files.equals)) return { count: 0 };
        messages.set(where.id, { ...current, ...data });
        return { count: 1 };
      },
      create: async ({ data }) => {
        if (options.failMessage) throw new Error('database unavailable');
        const row = { id: `version-message-${creates}`, ...data };
        messages.set(row.id, row);
        return row;
      },
    },
    file: {
      findFirst: async ({ where }) => [...files.values()].find((file) => (!where.id || file.id === where.id) && file.userId === where.userId && !file.deletedAt) || null,
      create: async ({ data }) => {
        creates += 1;
        const row = { id: `version-file-${creates}`, ...data };
        files.set(row.id, row);
        return row;
      },
    },
    $transaction: async (work) => {
      const beforeMessages = structuredClone(messages);
      const beforeFiles = structuredClone(files);
      try { return await work(prisma); } catch (error) {
        messages = beforeMessages;
        files = beforeFiles;
        throw error;
      }
    },
  };
  const storage = {
    enabled: () => Boolean(options.remote),
    persistLocalFile: async ({ localPath, key, contentType }) => {
      const buffer = await fs.readFile(localPath);
      writes.push({ key, buffer, contentType });
      if (options.remote) {
        await fs.unlink(localPath);
        return { ref: `r2:${key}`, key, storage: 'r2' };
      }
      return { ref: localPath, storage: 'local' };
    },
    remove: async (ref) => { removed.push(ref); if (!ref.startsWith('r2:')) await fs.unlink(ref).catch(() => {}); },
  };
  const service = createImageWorkspaceService({ prisma, storage, uploadsDir: path.join(dir, 'versions') });
  const context = { userId: 'owner-1', fileId: 'source-file', chatId: 'chat-1', messageId: 'message-1' };
  return {
    service, prisma, original, sourcePath, context, selected, sibling, dir, writes, removed,
    messages: () => messages, files: () => files,
  };
}

test('workspace annotations save a new PNG version and preserve source bytes, lineage and selected model', async (t) => {
  const f = await fixture(t);
  const annotation = await sharp(f.original).composite([{ input: await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ff0000ff' } }).png().toBuffer(), left: 2, top: 2 }]).png().toBuffer();
  const beforeMessage = structuredClone(f.messages().get('message-1'));
  const result = await f.service.edit({ ...f.context, operation: 'annotate', sourceImageDataUrl: `data:image/png;base64,${annotation.toString('base64')}` });
  const output = result.files[0];
  assert.equal(result.chatId, 'chat-1');
  assert.notEqual(result.messageId, 'message-1');
  assert.equal(output.parentFileId, 'source-file');
  assert.equal(output.rootFileId, 'root-file');
  assert.equal(output.version, 4);
  assert.equal(output.model, f.selected.model);
  assert.equal(output.provider, f.selected.provider);
  assert.equal(output.width, 24);
  assert.equal(output.height, 12);
  assert.equal(f.messages().get(result.messageId).role, 'ASSISTANT');
  assert.deepEqual(f.messages().get('message-1'), beforeMessage);
  assert.deepEqual(await fs.readFile(f.sourcePath), f.original);
  assert.notDeepEqual(await fs.readFile(f.files().get(output.fileId).path), f.original);
  assert.equal(f.files().size, 2);
});

test('resize contains the original with transparent padding and never stretches it', async (t) => {
  const f = await fixture(t);
  const result = await f.service.edit({ ...f.context, operation: 'resize', width: 48, height: 48 });
  const output = result.files[0];
  const raw = await sharp(f.files().get(output.fileId).path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(output.width, 48);
  assert.equal(output.height, 48);
  assert.equal(output.aspectRatio, '1:1', 'ratio is canonical for subsequent edits');
  assert.equal(raw.data[3], 0, 'top padding transparent');
  assert.deepEqual([...raw.data.subarray((24 * 48 + 24) * 4, (24 * 48 + 24) * 4 + 4)], [34, 68, 170, 255]);
  assert.deepEqual(await fs.readFile(f.sourcePath), f.original);
});

test('comments persist only on the selected attachment without creating files or messages', async (t) => {
  const f = await fixture(t);
  const comments = [{ id: 'comment-1', text: 'Aclarar esta zona', x: 42, y: 73 }];
  const neighbor = structuredClone(f.messages().get('message-neighbor'));
  const result = await f.service.edit({ ...f.context, operation: 'comment', comments });
  assert.deepEqual(result.files[0].comments, comments);
  assert.deepEqual(result.files[1], f.sibling);
  assert.deepEqual(JSON.parse(f.messages().get('message-1').files)[0].comments, comments);
  assert.deepEqual(f.messages().get('message-neighbor'), neighbor);
  assert.equal(f.files().size, 1);
  assert.equal(f.messages().size, 3);
  assert.equal(f.writes.length, 0);
  const cleared = await f.service.edit({ ...f.context, operation: 'comment', comments: [] });
  assert.deepEqual(cleared.files[0].comments, []);
});

test('hide tombstones only the selected message attachment, keeps bytes and is idempotent', async (t) => {
  const f = await fixture(t);
  const neighbor = structuredClone(f.messages().get('message-neighbor'));
  const first = await f.service.hide(f.context);
  assert.ok(first.files[0].deletedAt);
  assert.deepEqual(first.files[1], f.sibling);
  assert.deepEqual(f.messages().get('message-neighbor'), neighbor);
  assert.equal(f.files().get('source-file').deletedAt, undefined);
  assert.deepEqual(await fs.readFile(f.sourcePath), f.original);
  assert.equal(f.removed.length, 0);
  const second = await f.service.hide(f.context);
  assert.equal(second.files[0].deletedAt, first.files[0].deletedAt);
  await assert.rejects(f.service.edit({ ...f.context, operation: 'resize', width: 20, height: 20 }), { status: 404 });
});

test('chat, message, file ownership and attachment membership are all required', async (t) => {
  const f = await fixture(t);
  for (const override of [
    { userId: 'other-user' }, { chatId: 'chat-2' }, { messageId: 'message-other' }, { fileId: 'missing-file' },
  ]) {
    await assert.rejects(f.service.edit({ ...f.context, ...override, operation: 'comment', comments: [] }), { status: 404 });
    await assert.rejects(f.service.hide({ ...f.context, ...override }), { status: 404 });
  }
  f.files().get('source-file').userId = 'other-user';
  await assert.rejects(f.service.edit({ ...f.context, operation: 'comment', comments: [] }), { status: 404 });
  assert.equal(f.writes.length, 0);
});

test('hiding one occurrence does not prevent editing the same owned file in another message', async (t) => {
  const f = await fixture(t);
  await f.service.hide(f.context);
  const result = await f.service.edit({ ...f.context, messageId: 'message-neighbor', operation: 'comment', comments: [{ id: 'n1', text: 'Comentario del otro mensaje', x: 20, y: 20 }] });
  assert.equal(result.messageId, 'message-neighbor');
  assert.equal(result.files[0].comments[0].text, 'Comentario del otro mensaje');
  assert.ok(JSON.parse(f.messages().get('message-1').files)[0].deletedAt);
});

test('reject invalid PNG bytes, mismatched annotation dimensions, oversized resize and invalid comments', async (t) => {
  const f = await fixture(t);
  const small = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#ff0000ff' } }).png().toBuffer();
  for (const buffer of [Buffer.from('not png'), f.original.subarray(0, 40), small]) {
    await assert.rejects(f.service.edit({ ...f.context, operation: 'annotate', sourceImageDataUrl: `data:image/png;base64,${buffer.toString('base64')}` }), { status: 400 });
  }
  for (const dimensions of [{ width: 8193, height: 20 }, { width: 8192, height: 8192 }, { width: 0, height: 1 }]) {
    await assert.rejects(f.service.edit({ ...f.context, operation: 'resize', ...dimensions }), { status: 400 });
  }
  for (const comments of [
    [{ id: 'a', text: 'test', x: -1, y: 0 }],
    [{ id: 'a', text: 'test', x: 1, y: 101 }],
    [{ id: 'a', text: 'test', x: 1, y: 1 }, { id: 'a', text: 'duplicate', x: 2, y: 2 }],
  ]) {
    await assert.rejects(f.service.edit({ ...f.context, operation: 'comment', comments }), { status: 400 });
  }
  assert.equal(f.writes.length, 0);
});

test('failed database persistence rolls back records and cleans newly written local bytes', async (t) => {
  const f = await fixture(t, { failMessage: true });
  await assert.rejects(f.service.edit({ ...f.context, operation: 'resize', width: 32, height: 32 }), { code: 'E_PERSISTENCE' });
  assert.equal(f.files().size, 1);
  assert.equal(f.messages().size, 3);
  assert.equal(f.removed.length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'versions')), []);
  assert.deepEqual(await fs.readFile(f.sourcePath), f.original);
});

test('R2 version persists the remote ref and removes it if the database transaction fails', async (t) => {
  const f = await fixture(t, { remote: true });
  const result = await f.service.edit({ ...f.context, operation: 'resize', width: 32, height: 32 });
  const record = f.files().get(result.files[0].fileId);
  assert.match(record.path, /^r2:uploads\/images\/image-.*\.png$/);
  assert.equal(f.writes[0].contentType, 'image/png');
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'versions')), []);
  const broken = await fixture(t, { remote: true, failMessage: true });
  await assert.rejects(broken.service.edit({ ...broken.context, operation: 'resize', width: 32, height: 32 }), { code: 'E_PERSISTENCE' });
  assert.match(broken.removed[0], /^r2:uploads\/images\//);
});

test('concurrent attachment writes return a conflict instead of overwriting message files', async (t) => {
  const f = await fixture(t, { conflict: true });
  const before = structuredClone(f.messages().get('message-1'));
  await assert.rejects(f.service.edit({ ...f.context, operation: 'comment', comments: [] }), { status: 409, code: 'E_CONFLICT' });
  assert.deepEqual(f.messages().get('message-1'), before);
});
