'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveImageSource, resolveImageSources } = require('../src/services/media/image-source');
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


test('multiple reference inputs retain explicit target and supplied order, deduplicating without dropping references', async () => {
  const ctx = await context([], { target: {}, palette: {}, logo: {} });
  const sources = await resolveImageSources({ fileId: 'target', referenceFileIds: ['palette', 'target', 'logo', 'palette'] }, ctx);
  assert.deepEqual(sources.map((source) => source.fileId), ['target', 'palette', 'logo']);
  assert.equal(sources.length, 3);
  assert.ok(sources.every((source) => source.buffer.toString() === 'source-pixels'));
});

test('a missing, deleted or unowned reference stops the whole edit, without history substitution', async () => {
  for (const references of [['target', 'missing'], ['target', 'hidden']]) {
    const ctx = await context([{ files: [{ type: 'image', fileId: 'hidden', deletedAt: '2026-10-09' }] }], { target: {}, hidden: {} });
    await assert.rejects(resolveImageSources({ referenceFileIds: references }, ctx), { code: 'image_source_required', status: 400 });
    await assert.rejects(resolveImageSources({ referenceFileIds: ['target'] }, { ...ctx, chatId: 'foreign' }), { code: 'image_source_required' });
  }
});

test('reference count and invalid IDs are rejected without materializing files', async () => {
  const ctx = await context();
  ctx.prisma.file.findFirst = async () => { throw new Error('must validate before reading'); };
  for (const references of [Array.from({ length: 9 }, (_, i) => `file-${i}`), [''], [null], 'file']) {
    await assert.rejects(resolveImageSources({ referenceFileIds: references }, ctx), { code: 'E_PARAMS' });
  }
});

test('reference-free follow-up keeps historical source resolution and explicit references never add history', async () => {
  const ctx = await context([{ files: [{ type: 'image', fileId: 'previous' }] }], { previous: {}, uploaded: {} });
  assert.deepEqual((await resolveImageSources({}, ctx)).map((source) => source.fileId), ['previous']);
  assert.deepEqual((await resolveImageSources({ referenceFileIds: ['uploaded'] }, ctx)).map((source) => source.fileId), ['uploaded']);
});

test('context attachments keep the user-selected image order even if the database returns a different order', async () => {
  const ctx = await context([], { first: {}, second: {} });
  const sourcePath = path.join(await fixtures, 'source.png');
  ctx.prisma.file.findMany = async () => ['second', 'first'].map((id) => ({ id, path: sourcePath, mimeType: 'image/png' }));
  const source = await resolveImageSource({}, { ...ctx, fileIds: ['first', 'second'] });
  assert.equal(source.fileId, 'first');
});


test('an explicit URL remains the primary target when file references are also supplied', async () => {
  const ctx = await context([], { palette: {} });
  const sources = await resolveImageSources({ imageUrl: 'data:image/png;base64,cHJpbWFyeQ==', referenceFileIds: ['palette'] }, ctx);
  assert.equal(sources[0].buffer.toString(), 'primary');
  assert.equal(sources[1].fileId, 'palette');
  await assert.rejects(resolveImageSources({ imageUrl: '/uploads/images/missing.png', referenceFileIds: ['palette'] }, ctx), { code: 'image_source_required' });
});


test('agent context automatically includes all image attachments while leaving documents out', async () => {
  const ctx = await context([], { subject: {}, style: {} });
  ctx.fileIds = ['document', 'subject', 'style'];
  ctx.prisma.file.findMany = async () => [
    { id: 'style', mimeType: 'image/png' }, { id: 'subject', mimeType: 'image/png' }, { id: 'document', mimeType: 'application/pdf' },
  ];
  assert.deepEqual((await resolveImageSources({}, ctx)).map((source) => source.fileId), ['subject', 'style']);
  assert.deepEqual((await resolveImageSources({ fileId: 'style' }, ctx)).map((source) => source.fileId), ['style', 'subject']);
  ctx.fileIds.push('missing-image');
  await assert.rejects(resolveImageSources({}, ctx), { code: 'image_source_required' });
});

test('remote image references reject hostnames resolving to private networks before any request', async () => {
  let requests = 0;
  const originalFetch = global.fetch;
  const rejectRequest = async () => { requests++; throw new Error('private address must not be reached'); };
  global.fetch = rejectRequest;
  try {
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]]) {
      const source = await resolveImageSource({ imageUrl: 'https://references.example.com/picture.png' }, {
        userId: 'owner', lookup: async () => addresses, fetch: rejectRequest,
      });
      assert.equal(source, null);
    }
    assert.equal(requests, 0);
  } finally { global.fetch = originalFetch; }
});

test('remote image references use the pinned public transport and reject redirects', async () => {
  let lookups = 0; let requests = 0;
  const ctx = {
    userId: 'owner',
    lookup: async (host, options) => {
      lookups++;
      assert.equal(host, 'references.example.com');
      assert.equal(options.all, true);
      return [{ address: '93.184.216.34', family: 4 }];
    },
    fetch: async (_url, options) => {
      requests++;
      assert.equal(options.redirect, 'error');
      assert.equal(typeof options.dispatcher.dispatch, 'function');
      assert.ok(options.signal);
      return new Response('image-pixels', { headers: { 'content-type': 'image/png' } });
    },
  };
  const source = await resolveImageSource({ imageUrl: 'https://references.example.com/picture.png' }, ctx);
  assert.equal(source.buffer.toString(), 'image-pixels');
  assert.equal(lookups, 1); assert.equal(requests, 1);
  ctx.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
  assert.equal(await resolveImageSource({ imageUrl: 'https://references.example.com/picture.png' }, ctx), null);
});

test('rejected remote image responses cancel unread bodies instead of holding the connection open', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const source = await resolveImageSource({ imageUrl: 'https://references.example.com/picture.png' }, {
    userId: 'owner', lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(source, null); assert.equal(cancelled, true);
});
