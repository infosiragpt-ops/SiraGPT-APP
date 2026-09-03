'use strict';

// Source contract for the chunked upload endpoints: auth + scope on every
// route, raw body with a bounded limit on chunk PUTs, media-aware cap on init,
// and completion feeding the SAME async pipeline as the multipart upload.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'files.js'), 'utf8');

test('chunked upload routes are authenticated, scoped and rate-limited like /upload', () => {
  assert.match(src, /router\.post\('\/upload\/chunked\/init', authenticateToken, requireScope\('files:write'\), enforceOrgRateLimitSafe, async \(req, res\) => \{/);
  assert.match(src, /router\.put\('\/upload\/chunked\/:uploadId\/:index', authenticateToken, requireScope\('files:write'\), express\.raw\(\{ type: \(\) => true, limit: CHUNK_BODY_LIMIT \}\), async \(req, res\) => \{/);
  assert.match(src, /router\.delete\('\/upload\/chunked\/:uploadId', authenticateToken, requireScope\('files:write'\), async \(req, res\) => \{/);
  assert.match(src, /router\.post\('\/upload\/chunked\/:uploadId\/complete', authenticateToken, requireScope\('files:write'\), enforceOrgRateLimitSafe, async \(req, res\) => \{/);
  assert.match(src, /const CHUNK_BODY_LIMIT = chunkedUploads\.MAX_CHUNK_BYTES \+ 64 \* 1024;/);
});

test('init validates the declared type and applies the media cap; complete reuses the async pipeline', () => {
  assert.match(src, /if \(!isDeclaredUploadAllowed\(declared\)\) \{/);
  assert.match(src, /maxBytes: chunkedUploadCap\(declared\.mimetype, originalName\),/);
  assert.match(src, /return media \? limits\.mediaFileSize : limits\.fileSize;/);
  assert.match(src, /const file = await chunkedUploads\.completeChunkedUpload\(\{ userDir, uploadId: req\.params\.uploadId \}\);/);
  assert.match(src, /const processedFiles = await processFilesForAsyncPreview\(\[file\], req\.user\.id, prisma\);\s*return res\.json\(\{ files: processedFiles, chunked: true \}\);/);
});

test('audio/video extraction gets its own, longer budget', () => {
  assert.match(src, /const ASYNC_EXTRACT_MEDIA_TIMEOUT_MS = Number\.parseInt\(process\.env\.SIRAGPT_ASYNC_EXTRACT_MEDIA_TIMEOUT_MS \|\| '7200000', 10\);/);
  assert.match(src, /const extractBudgetMs = \/\^\(audio\|video\)\\\/\/i\.test\(String\(file\.mimetype \|\| ''\)\) \? ASYNC_EXTRACT_MEDIA_TIMEOUT_MS : ASYNC_EXTRACT_TIMEOUT_MS;/);
});
