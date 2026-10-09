import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLatestVideoReferenceUrls, resolveVideoReferenceUrls } from '../lib/chat/video-references';
const base = { backendBaseUrl: 'https://api.example.com', getFile: async () => { throw new Error('not found'); } };
test('video references retain data images and reply artifact URLs', async () => {
  const data = 'data:image/png;base64,aGVsbG8=';
  const urls = await resolveVideoReferenceUrls({ ...base, sourceImageUrls: [data, '/api/agent/artifact/abcdef'] });
  assert.deepEqual(urls, [data, 'https://api.example.com/api/agent/artifact/abcdef']);
});
test('video uses explicit selected snapshots, excludes stale composer uploads', async () => {
  const urls = await resolveVideoReferenceUrls({ ...base, fileIds: ['chosen'], sourceImageFiles: [{ id: 'chosen', type: 'image/png', url: '/uploads/u/chosen.png' }], uploadedFiles: [{ id: 'stale', type: 'image/png', url: '/uploads/u/stale.png' }] });
  assert.deepEqual(urls, ['https://api.example.com/uploads/u/chosen.png']);
});
test('missing references stop generation instead of downgrading to text-only video', async () => {
  await assert.rejects(resolveVideoReferenceUrls({ ...base, fileIds: ['missing'] }), /recuperar/);
});
test('local browser previews resolve persisted image before cloud generation', async () => {
  const urls = await resolveVideoReferenceUrls({ ...base, fileIds: ['img'], sourceImageFiles: [{ id: 'img', type: 'image/png', url: 'blob:https://app.example.com/preview' }], getFile: async () => ({ mimeType: 'image/png', filename: 'img.png', userId: 'u' }) });
  assert.deepEqual(urls, ['https://api.example.com/uploads/u/img.png']);
});

test('video follow-up reuses the latest uploaded image turn and keeps all references', () => {
  const files = Array.from({ length: 7 }, (_, i) => ({ type: 'image/png', url: `/uploads/u/ref${i}.png` }));
  const urls = collectLatestVideoReferenceUrls([
    { role: 'ASSISTANT', files: [{ type: 'image/png', url: '/uploads/u/old.png' }] },
    { role: 'USER', files },
    { role: 'ASSISTANT', content: 'He revisado tus imágenes.' },
    { role: 'ASSISTANT', deletedAt: 'today', files: [{ type: 'image/png', url: '/uploads/u/deleted.png' }] },
  ], (file) => (file as { url: string }).url);
  assert.deepEqual(urls, files.map((file) => file.url));
});

test('asynchronous first-reference lookup keeps the requested image order', async () => {
  const urls = await resolveVideoReferenceUrls({ ...base, fileIds: ['first', 'second'], sourceImageFiles: [
    { id: 'first', type: 'image/png', url: 'blob:https://app.example.com/pending' },
    { id: 'second', type: 'image/png', url: '/uploads/u/second.png' },
  ], getFile: async () => ({ file: { mimeType: 'image/png', url: '/uploads/u/first.png' } }) });
  assert.deepEqual(urls, ['https://api.example.com/uploads/u/first.png', 'https://api.example.com/uploads/u/second.png']);
});
test('removed image cannot be resurrected from the legacy text URL', () => {
  const urls = collectLatestVideoReferenceUrls([{ role: 'ASSISTANT', content: 'https://example.com/hidden.png', files: [
    { type: 'image/png', url: 'https://example.com/hidden.png', deletedAt: 'today' },
  ] }], (file) => (file as { url: string }).url);
  assert.deepEqual(urls, []);
});
