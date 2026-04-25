import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBackendAssetUrl,
  resolveImageAttachmentUrl,
} from '../lib/attachment-url';

test('resolves uploaded image URLs against the backend asset host', () => {
  assert.equal(
    resolveImageAttachmentUrl({ url: '/uploads/user-1/image.png', mimeType: 'image/png' }, 'http://localhost:5000'),
    'http://localhost:5000/uploads/user-1/image.png',
  );
});

test('does not turn short backend paths into broken base64 image data', () => {
  const resolved = resolveImageAttachmentUrl({ url: '/uploads/user-1/image.png' }, undefined);

  assert.equal(resolved, 'http://localhost:5000/uploads/user-1/image.png');
  assert.equal(resolved.startsWith('data:image/jpeg;base64,/uploads'), false);
});

test('resolves stored filesystem upload paths to public URLs', () => {
  assert.equal(
    resolveImageAttachmentUrl({ path: '/Users/luis/Desktop/siraGPT/backend/uploads/user-1/paste.png' }, 'http://localhost:5000'),
    'http://localhost:5000/uploads/user-1/paste.png',
  );
});

test('preserves real data URLs and absolute URLs', () => {
  assert.equal(resolveBackendAssetUrl('data:image/png;base64,abc'), 'data:image/png;base64,abc');
  assert.equal(resolveImageAttachmentUrl({ url: 'https://cdn.example.com/a.png' }), 'https://cdn.example.com/a.png');
});
