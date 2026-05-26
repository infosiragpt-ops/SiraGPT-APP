import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendUploadAuthToken,
  normalizeBackendAssetUrl,
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

test('browser runtime resolves relative uploads through the current frontend origin', () => {
  const previousWindow = (globalThis as any).window;
  const previousImageUrl = process.env.NEXT_PUBLIC_IMAGE_URL;
  const previousApiUrl = process.env.NEXT_PUBLIC_API_URL;

  try {
    delete process.env.NEXT_PUBLIC_IMAGE_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    (globalThis as any).window = { location: { origin: 'https://siragpt.com' } };

    assert.equal(
      resolveImageAttachmentUrl({ url: '/uploads/user-1/image.png' }, undefined),
      'https://siragpt.com/uploads/user-1/image.png',
    );
  } finally {
    (globalThis as any).window = previousWindow;
    if (previousImageUrl === undefined) delete process.env.NEXT_PUBLIC_IMAGE_URL;
    else process.env.NEXT_PUBLIC_IMAGE_URL = previousImageUrl;
    if (previousApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = previousApiUrl;
  }
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

test('normalizeBackendAssetUrl rewrites absolute /uploads/* URLs to the frontend host', () => {
  // Backend baked in BASE_URL=http://api-internal:5000 — unreachable
  // from the browser. Rewrite to the public NEXT_PUBLIC_IMAGE_URL.
  assert.equal(
    normalizeBackendAssetUrl(
      'http://api-internal:5000/uploads/documents/u1/file.docx',
      'https://siragpt.io',
    ),
    'https://siragpt.io/uploads/documents/u1/file.docx',
  );
});

test('normalizeBackendAssetUrl preserves the query string when rewriting the origin', () => {
  assert.equal(
    normalizeBackendAssetUrl(
      'http://localhost:5000/uploads/documents/u1/file.pdf?v=42',
      'https://siragpt.io',
    ),
    'https://siragpt.io/uploads/documents/u1/file.pdf?v=42',
  );
});

test('normalizeBackendAssetUrl leaves absolute URLs that do NOT point at /uploads/ untouched', () => {
  // Third-party CDN, the frontend has no business overriding it.
  assert.equal(
    normalizeBackendAssetUrl('https://cdn.example.com/img.png', 'http://localhost:5000'),
    'https://cdn.example.com/img.png',
  );
});

test('normalizeBackendAssetUrl prepends the base for relative paths (legacy behaviour)', () => {
  assert.equal(
    normalizeBackendAssetUrl('/uploads/u1/file.docx', 'http://localhost:5000'),
    'http://localhost:5000/uploads/u1/file.docx',
  );
  assert.equal(
    normalizeBackendAssetUrl('uploads/u1/file.docx', 'http://localhost:5000'),
    'http://localhost:5000/uploads/u1/file.docx',
  );
});

test('normalizeBackendAssetUrl passes through data: and blob: URLs verbatim', () => {
  assert.equal(normalizeBackendAssetUrl('data:image/png;base64,abc'), 'data:image/png;base64,abc');
  assert.equal(normalizeBackendAssetUrl('blob:http://localhost:3000/abc-def'), 'blob:http://localhost:3000/abc-def');
});

test('appendUploadAuthToken appends JWTs only to upload URLs', () => {
  assert.equal(
    appendUploadAuthToken('https://api.siragpt.com/uploads/user-1/image.png', 'jwt-123'),
    'https://api.siragpt.com/uploads/user-1/image.png?token=jwt-123',
  );
  assert.equal(
    appendUploadAuthToken('https://cdn.example.com/image.png', 'jwt-123'),
    'https://cdn.example.com/image.png',
  );
  assert.equal(
    appendUploadAuthToken('blob:http://localhost:3000/local', 'jwt-123'),
    'blob:http://localhost:3000/local',
  );
});

test('normalizeBackendAssetUrl returns absolute URL unchanged when no baseUrl is configured', () => {
  // baseUrl=null → cleanBaseUrl falls back to the legacy default
  // (http://localhost:5000); rewriting only kicks in when the
  // resolved base is meaningful, so an absolute /uploads/ URL with
  // a missing-frontend-config gets to stay as-is rather than
  // bouncing to the dev default.
  assert.equal(
    normalizeBackendAssetUrl('https://api.example.com/uploads/u1/file.pdf', ''),
    'https://api.example.com/uploads/u1/file.pdf',
  );
});
