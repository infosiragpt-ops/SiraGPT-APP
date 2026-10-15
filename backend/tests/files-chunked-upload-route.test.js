'use strict';

// Chunked upload endpoints: the source contract (auth + scope on every route,
// raw body with a bounded limit on chunk PUTs, media-aware cap on init,
// completion feeding the SAME async pipeline as the multipart upload), and the
// HTTP behaviour that makes a multi-gigabyte lecture resumable: an owner-scoped
// status route, an idempotent complete, a free-space preflight and ENOSPC
// mapped to a Spanish 507. Also the multipart gate: audio/video get the media
// cap at multer time, documents keep theirs, both in Spanish.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'files.js'), 'utf8');
const MB = 1024 * 1024;

test('chunked upload routes are authenticated, scoped and rate-limited like /upload', () => {
  assert.match(src, /router\.post\('\/upload\/chunked\/init', authenticateToken, requireScope\('files:write'\), enforceOrgRateLimitSafe, async \(req, res\) => \{/);
  assert.match(src, /router\.get\('\/upload\/chunked\/:uploadId', authenticateToken, requireScope\('files:write'\), async \(req, res\) => \{/);
  assert.match(src, /router\.put\('\/upload\/chunked\/:uploadId\/:index', authenticateToken, requireScope\('files:write'\), express\.raw\(\{ type: \(\) => true, limit: CHUNK_BODY_LIMIT \}\), async \(req, res\) => \{/);
  assert.match(src, /router\.delete\('\/upload\/chunked\/:uploadId', authenticateToken, requireScope\('files:write'\), async \(req, res\) => \{/);
  assert.match(src, /router\.post\('\/upload\/chunked\/:uploadId\/complete', authenticateToken, requireScope\('files:write'\), enforceOrgRateLimitSafe, async \(req, res\) => \{/);
  assert.match(src, /const CHUNK_BODY_LIMIT = chunkedUploads\.MAX_CHUNK_BYTES \+ 64 \* 1024;/);
});

test('init validates the declared type and applies the media cap; complete reuses the async pipeline', () => {
  assert.match(src, /if \(!isDeclaredUploadAllowed\(declared\)\) \{/);
  assert.match(src, /maxBytes: chunkedUploadCap\(declared\.mimetype, originalName\),/);
  assert.match(src, /checkFreeSpace: true,/);
  assert.match(src, /return media \? limits\.mediaFileSize : limits\.fileSize;/);
  assert.match(src, /const file = await chunkedUploads\.completeChunkedUpload\(\{\s*userDir,\s*uploadId: req\.params\.uploadId,\s*finalize: async \(assembled\) => \{/);
  assert.match(src, /processedFiles = await processFilesForAsyncPreview\(\[assembled\], req\.user\.id, prisma\);/);
  assert.match(src, /return res\.json\(\{ files: processedFiles, chunked: true \}\);/);
});

test('audio/video extraction gets its own, longer budget', () => {
  // 12 h: one 10-hour recording on CPU whisper fits the budget.
  assert.match(src, /const ASYNC_EXTRACT_MEDIA_TIMEOUT_MS = Number\.parseInt\(process\.env\.SIRAGPT_ASYNC_EXTRACT_MEDIA_TIMEOUT_MS \|\| String\(12 \* 60 \* 60 \* 1000\), 10\);/);
  assert.match(src, /size: dbFileSize\(file\.size\),/, 'files.size is INTEGER: >2 GB media must not break the row insert');
  assert.match(src, /const extractBudgetMs = \/\^\(audio\|video\)\\\/\/i\.test\(String\(file\.mimetype \|\| ''\)\) \? ASYNC_EXTRACT_MEDIA_TIMEOUT_MS : ASYNC_EXTRACT_TIMEOUT_MS;/);
});

test('the global stale-parts sweeper starts with the router outside tests', () => {
  assert.match(src, /if \(process\.env\.NODE_ENV !== 'test'\) \{\s*chunkedUploads\.startChunkedUploadSweeper\(\{ rootDir: upload\.uploadDir \}\);\s*\}/);
});

function mp3Bytes(size) {
  const buf = Buffer.alloc(size, 0);
  // ID3v2 header so the magic-byte check sees real audio.
  Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).copy(buf, 0);
  return buf;
}

describe('chunked upload HTTP · resume, idempotent complete, disk safety', () => {
  let auth;
  let uploadDir;
  let previousUploadDir;
  let prisma;
  let mediaQueue;
  let originals;
  let rows;
  let creates;
  let enqueued;

  beforeEach(() => {
    auth = installAuthSessionMock();
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-chunked-http-'));
    previousUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = uploadDir;
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];

    prisma = require('../src/config/database');
    mediaQueue = require('../src/services/media-transcription-queue');
    originals = {
      create: prisma.file.create,
      update: prisma.file.update,
      findFirst: prisma.file.findFirst,
      enqueue: mediaQueue.enqueueMediaTranscription,
      statfs: fsPromises.statfs,
      open: fsPromises.open,
    };
    rows = new Map();
    creates = 0;
    enqueued = [];
    prisma.file.create = async ({ data }) => {
      creates += 1;
      const row = { id: `file-${creates}`, deletedAt: null, ...data };
      rows.set(row.id, row);
      return row;
    };
    prisma.file.update = async ({ where, data }) => {
      const row = rows.get(where.id);
      if (!row) throw Object.assign(new Error('No record was found for an update.'), { code: 'P2025' });
      Object.assign(row, data);
      return row;
    };
    prisma.file.findFirst = async ({ where }) => {
      const row = rows.get(where.id);
      if (!row || row.userId !== where.userId || row.deletedAt) return null;
      return row;
    };
    mediaQueue.enqueueMediaTranscription = async (payload) => {
      enqueued.push(payload);
      return { stage: 'uploaded' };
    };
  });

  afterEach(() => {
    prisma.file.create = originals.create;
    prisma.file.update = originals.update;
    prisma.file.findFirst = originals.findFirst;
    mediaQueue.enqueueMediaTranscription = originals.enqueue;
    fsPromises.statfs = originals.statfs;
    fsPromises.open = originals.open;
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
    fs.rmSync(uploadDir, { recursive: true, force: true });
    auth.restore();
  });

  function buildApp() {
    return buildRouteTestApp('/api/files', reloadModule('../src/routes/files'));
  }

  async function initUpload(app, header, { name = 'clase.mp3', size = MB + 10, mimeType = 'audio/mpeg' } = {}) {
    const res = await request(app)
      .post('/api/files/upload/chunked/init')
      .set('Authorization', header)
      .send({ name, size, mimeType, chunkSize: MB });
    return res;
  }

  function putChunk(app, header, uploadId, index, body) {
    return request(app)
      .put(`/api/files/upload/chunked/${uploadId}/${index}`)
      .set('Authorization', header)
      .set('Content-Type', 'application/octet-stream')
      .send(body);
  }

  test('status lists the received chunks for the owner only', async () => {
    const app = buildApp();
    const init = await initUpload(app, auth.authHeader);
    assert.equal(init.status, 201);
    const { uploadId } = init.body;
    assert.ok(Date.parse(init.body.expiresAt) > Date.now());
    assert.equal((await putChunk(app, auth.authHeader, uploadId, 1, Buffer.alloc(10, 1))).status, 200);

    const mine = await request(app).get(`/api/files/upload/chunked/${uploadId}`).set('Authorization', auth.authHeader);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.received, [1]);
    assert.equal(mine.body.receivedBytes, 10);
    assert.equal(mine.body.totalChunks, 2);
    assert.equal(mine.body.chunkSize, MB);
    assert.equal(mine.body.size, MB + 10);
    assert.equal(mine.body.completed, false);
    assert.ok(Date.parse(mine.body.expiresAt) > Date.now());
    assert.match(String(mine.headers['cache-control']), /no-store/);

    const intruder = installAuthSessionMock({ id: 'http-user-2', email: 'other@example.com' });
    try {
      const theirs = await request(app).get(`/api/files/upload/chunked/${uploadId}`).set('Authorization', intruder.authHeader);
      assert.equal(theirs.status, 404);
      assert.equal(theirs.body.code, 'upload_not_found');
      const theirChunk = await putChunk(app, intruder.authHeader, uploadId, 0, Buffer.alloc(MB, 2));
      assert.equal(theirChunk.status, 404, 'another user cannot write into the session either');
      const theirComplete = await request(app).post(`/api/files/upload/chunked/${uploadId}/complete`).set('Authorization', intruder.authHeader).send({});
      assert.equal(theirComplete.status, 404);
    } finally {
      intruder.restore();
    }
    const anonymous = await request(app).get(`/api/files/upload/chunked/${uploadId}`);
    assert.equal(anonymous.status, 401);
  });

  test('a repeated complete returns the same File row without a second insert or transcription', async () => {
    const app = buildApp();
    const size = MB + 10;
    const bytes = mp3Bytes(size);
    const init = await initUpload(app, auth.authHeader, { size });
    const { uploadId } = init.body;
    assert.equal((await putChunk(app, auth.authHeader, uploadId, 0, bytes.subarray(0, MB))).status, 200);
    assert.equal((await putChunk(app, auth.authHeader, uploadId, 1, bytes.subarray(MB))).status, 200);

    const first = await request(app).post(`/api/files/upload/chunked/${uploadId}/complete`).set('Authorization', auth.authHeader).send({});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.chunked, true);
    assert.equal(first.body.files.length, 1);
    assert.equal(first.body.files[0].success, true);
    assert.equal(first.body.files[0].id, 'file-1');

    const again = await request(app).post(`/api/files/upload/chunked/${uploadId}/complete`).set('Authorization', auth.authHeader).send({});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.files[0].id, 'file-1');
    assert.equal(again.body.files[0].name, 'clase.mp3');
    assert.equal(again.body.files[0].filename, first.body.files[0].filename);
    assert.equal(again.body.files[0].size, size);
    assert.equal(creates, 1, 'one File row');
    assert.equal(enqueued.length, 1, 'one transcription job');

    const status = await request(app).get(`/api/files/upload/chunked/${uploadId}`).set('Authorization', auth.authHeader);
    assert.equal(status.body.completed, true);
    assert.equal(status.body.fileId, 'file-1');

    // The row was deleted meanwhile: the replay says so instead of a ghost id.
    rows.get('file-1').deletedAt = new Date();
    const gone = await request(app).post(`/api/files/upload/chunked/${uploadId}/complete`).set('Authorization', auth.authHeader).send({});
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'upload_not_found');
  });

  test('init refuses with a Spanish 507 when the disk cannot hold the file (statfs preflight)', async () => {
    fsPromises.statfs = async () => ({ bavail: 1, bsize: 4096 });
    const app = buildApp();
    const res = await initUpload(app, auth.authHeader, { size: 4 * 1024 * MB, name: 'clase.mp4', mimeType: 'video/mp4' });
    assert.equal(res.status, 507);
    assert.equal(res.body.code, 'insufficient_storage');
    assert.match(res.body.error, /No hay espacio suficiente en el servidor/);
    const partsDir = path.join(uploadDir, 'http-user-1', '.parts');
    assert.deepEqual(fs.existsSync(partsDir) ? fs.readdirSync(partsDir) : [], [], 'no session is created');
  });

  test('ENOSPC while writing a chunk becomes a Spanish 507, not a generic 500', async () => {
    const app = buildApp();
    const init = await initUpload(app, auth.authHeader);
    const { uploadId } = init.body;
    const realOpen = originals.open;
    fsPromises.open = async (target, flags, ...rest) => {
      const fh = await realOpen(target, flags, ...rest);
      if (!String(target).endsWith('.part') || flags !== 'r+') return fh;
      return {
        write: async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); },
        close: () => fh.close(),
      };
    };
    const res = await putChunk(app, auth.authHeader, uploadId, 0, Buffer.alloc(MB, 1));
    assert.equal(res.status, 507);
    assert.equal(res.body.code, 'insufficient_storage');
    assert.match(res.body.error, /espacio suficiente/);
  });
});

describe('multipart upload gate · media cap vs document cap (MAX_FILE_SIZE=50)', () => {
  let auth;
  let uploadDir;
  let saved;
  let prisma;
  let originalCreate;

  beforeEach(() => {
    auth = installAuthSessionMock();
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-multer-cap-'));
    saved = { UPLOAD_DIR: process.env.UPLOAD_DIR, MAX_FILE_SIZE: process.env.MAX_FILE_SIZE, MAX_MEDIA_FILE_MB: process.env.MAX_MEDIA_FILE_MB, UPLOAD_MAX_MEDIA_MB: process.env.UPLOAD_MAX_MEDIA_MB, UPLOAD_MAX_FILE_MB: process.env.UPLOAD_MAX_FILE_MB };
    process.env.UPLOAD_DIR = uploadDir;
    process.env.MAX_FILE_SIZE = '50';
    delete process.env.MAX_MEDIA_FILE_MB;
    delete process.env.UPLOAD_MAX_MEDIA_MB;
    delete process.env.UPLOAD_MAX_FILE_MB;
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];
    prisma = require('../src/config/database');
    originalCreate = prisma.file.create;
    // Reaching the row insert proves multer accepted the bytes.
    prisma.file.create = async () => { throw new Error('offline test double'); };
  });

  afterEach(() => {
    prisma.file.create = originalCreate;
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(uploadDir, { recursive: true, force: true });
    auth.restore();
  });

  function buildApp() {
    const { errorToResponse } = require('../src/middleware/error-handler');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/files', reloadModule('../src/routes/files'));
    // The production mapping (MulterError → 400 with its message).
    app.use((err, req, res, _next) => {
      const { statusCode, body } = errorToResponse(err, req);
      res.status(statusCode).json(body);
    });
    return app;
  }

  test('the multer ceiling is the media cap and each kind keeps its own limit', () => {
    const upload = reloadModule('../src/middleware/upload');
    assert.equal(upload.uploadLimits.fileSize, 50 * MB);
    assert.equal(upload.multerFileSizeLimit(), upload.uploadLimits.mediaFileSize);
    assert.ok(upload.uploadLimits.mediaFileSize >= 10 * 1024 * MB);
    assert.equal(upload.perFileLimitFor({ originalname: 'clase.mp3', mimetype: 'audio/mpeg' }), upload.uploadLimits.mediaFileSize);
    assert.equal(upload.perFileLimitFor({ originalname: 'grabacion.m4a', mimetype: 'application/octet-stream' }), upload.uploadLimits.mediaFileSize, 'extension fallback');
    assert.equal(upload.perFileLimitFor({ originalname: 'informe.pdf', mimetype: 'application/pdf' }), 50 * MB);
    assert.equal(upload.multerFileSizeLimit({ fileSize: 50 * MB, mediaFileSize: 10 * MB }), 50 * MB);
    assert.equal(upload.multerFileSizeLimit({ fileSize: Infinity, mediaFileSize: Infinity }), Infinity);
    assert.match(upload.fileTooLargeMessage({ name: 'informe.pdf', media: false }), /«informe\.pdf» supera el máximo de 50 MB por documento\. Los audios y videos admiten hasta 10 GB\./);
    assert.match(upload.fileTooLargeMessage({ name: 'clase.mp4', media: true }), /«clase\.mp4» supera el máximo de 10 GB para audio y video\./);
    assert.match(upload.fileTooLargeMessage(null), /^El archivo supera el tamaño máximo permitido/);
  });

  test('a 60 MB mp3 passes the multipart gate while a 60 MB pdf is refused in Spanish', async () => {
    const app = buildApp();
    const audio = await request(app)
      .post('/api/files/upload')
      .set('Authorization', auth.authHeader)
      .attach('files', mp3Bytes(60 * MB), { filename: 'clase-5h.mp3', contentType: 'audio/mpeg' });
    assert.equal(audio.status, 200, JSON.stringify(audio.body));
    assert.equal(audio.body.files[0].name, 'clase-5h.mp3');
    assert.notEqual(audio.body.files[0].code, 'LIMIT_FILE_SIZE');
    assert.equal(audio.body.files[0].code, 'db_create_failed', 'the bytes reached the pipeline');

    const pdf = await request(app)
      .post('/api/files/upload')
      .set('Authorization', auth.authHeader)
      .attach('files', Buffer.alloc(60 * MB, 0x20), { filename: 'informe.pdf', contentType: 'application/pdf' });
    assert.equal(pdf.status, 400);
    assert.equal(pdf.body.code, 'LIMIT_FILE_SIZE');
    assert.match(pdf.body.error, /«informe\.pdf» supera el máximo de 50 MB por documento/);
    const userDir = path.join(uploadDir, 'http-user-1');
    const leftovers = fs.existsSync(userDir) ? fs.readdirSync(userDir).filter((f) => !f.startsWith('.')) : [];
    assert.deepEqual(leftovers, [], 'the partial document is removed');
  });
});
