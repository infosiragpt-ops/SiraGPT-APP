'use strict';

// Chunked uploads for large media: init → chunks at offsets → complete →
// multer-shaped file for the regular pipeline. All on a temp dir.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../src/services/chunked-upload-store');

let userDir;
beforeEach(async () => {
  userDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-chunked-'));
});
afterEach(async () => {
  await fsPromises.rm(userDir, { recursive: true, force: true });
});

function bytes(n, fill) {
  return Buffer.alloc(n, fill);
}

describe('chunked upload store', () => {
  test('reassembles out-of-order chunks into the announced file and hands back a multer-like object', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const total = chunkSize * 2 + 1234;
    const session = await store.initChunkedUpload({ userDir, name: 'clase.mp4', size: total, mimeType: 'video/mp4', chunkSize, maxBytes: 10 * chunkSize });
    assert.equal(session.totalChunks, 3);
    assert.equal(session.chunkSize, chunkSize);
    assert.match(session.uploadId, /^[a-f0-9]{32}$/);

    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 2, buffer: bytes(1234, 0x33) });
    await assert.rejects(() => store.completeChunkedUpload({ userDir, uploadId: session.uploadId }), /Faltan trozos/);
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 0x11) });
    const r = await store.writeChunk({ userDir, uploadId: session.uploadId, index: 1, buffer: bytes(chunkSize, 0x22) });
    assert.equal(r.received, 3);

    const file = await store.completeChunkedUpload({ userDir, uploadId: session.uploadId });
    assert.equal(file.originalname, 'clase.mp4');
    assert.equal(file.mimetype, 'video/mp4');
    assert.equal(file.size, total);
    assert.equal(file.fieldname, 'files');
    assert.match(file.filename, /^files-\d+-[a-f0-9]{12}\.mp4$/);
    assert.equal(path.dirname(file.path), userDir);
    const data = await fsPromises.readFile(file.path);
    assert.equal(data.length, total);
    assert.equal(data[0], 0x11);
    assert.equal(data[chunkSize], 0x22);
    assert.equal(data[chunkSize * 2], 0x33);
    assert.equal(file.replayed, false);
    assert.equal(fs.existsSync(path.join(userDir, store.PARTS_DIR, `${session.uploadId}.part`)), false, 'part renamed on completion');
    const meta = JSON.parse(await fsPromises.readFile(path.join(userDir, store.PARTS_DIR, `${session.uploadId}.json`), 'utf8'));
    assert.ok(meta.completedAt, 'meta kept (for an hour) as the replay record of the completion');
    assert.equal(meta.completedFilename, file.filename);
  });

  test('validates sizes, indexes, caps and ownership-scoped ids', async () => {
    await assert.rejects(() => store.initChunkedUpload({ userDir, name: 'x.mp4', size: 0, mimeType: 'video/mp4' }), /Tamaño de archivo inválido/);
    await assert.rejects(() => store.initChunkedUpload({ userDir, name: 'x.mp4', size: 5 * 1024 * 1024, mimeType: 'video/mp4', maxBytes: 4 * 1024 * 1024 }), /supera el máximo de 4 MB/);
    const chunkSize = store.MIN_CHUNK_BYTES;
    const session = await store.initChunkedUpload({ userDir, name: 'x.mp4', size: chunkSize + 10, mimeType: 'video/mp4', chunkSize, maxBytes: Infinity });
    await assert.rejects(() => store.writeChunk({ userDir, uploadId: session.uploadId, index: 5, buffer: bytes(10) }), /Índice de trozo inválido/);
    await assert.rejects(() => store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(10) }), /debía medir/);
    await assert.rejects(() => store.writeChunk({ userDir, uploadId: 'deadbeef', index: 0, buffer: bytes(10) }), /Identificador de subida inválido/);
    await assert.rejects(() => store.writeChunk({ userDir, uploadId: 'a'.repeat(32), index: 0, buffer: bytes(10) }), /no existe o caducó/);
    assert.equal(store.normalizeChunkSize(1), store.MIN_CHUNK_BYTES);
    assert.equal(store.normalizeChunkSize(10 ** 12), store.MAX_CHUNK_BYTES);
    assert.equal(store.normalizeChunkSize(undefined), store.DEFAULT_CHUNK_BYTES);
  });

  test('a retried chunk is idempotent and abort/sweep clean up sessions', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const session = await store.initChunkedUpload({ userDir, name: 'a.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 1) });
    const again = await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 2) });
    assert.equal(again.received, 1);
    assert.equal(await store.abortChunkedUpload({ userDir, uploadId: session.uploadId }), true);
    await assert.rejects(() => store.completeChunkedUpload({ userDir, uploadId: session.uploadId }), /no existe o caducó/);

    const stale = await store.initChunkedUpload({ userDir, name: 'b.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    const removed = await store.sweepStaleChunkedUploads(userDir, { maxAgeMs: 1, now: Date.now() + 60_000 });
    assert.equal(removed, 2, 'part + meta of the stale session removed');
    await assert.rejects(() => store.writeChunk({ userDir, uploadId: stale.uploadId, index: 0, buffer: bytes(chunkSize) }), /no existe o caducó/);
  });
});

describe('chunked upload store · concurrent requests for one upload', () => {
  test('parallel chunks all land in the manifest (no lost update) and complete succeeds', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const n = 6;
    const session = await store.initChunkedUpload({ userDir, name: 'clase.mp4', size: chunkSize * n, mimeType: 'video/mp4', chunkSize, maxBytes: Infinity });
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => store.writeChunk({ userDir, uploadId: session.uploadId, index: i, buffer: bytes(chunkSize, i + 1) })),
    );
    assert.deepEqual(results.map((r) => r.status), Array(n).fill('fulfilled'), 'no chunk request fails (no tmp-file collision)');
    const meta = JSON.parse(await fsPromises.readFile(path.join(userDir, store.PARTS_DIR, `${session.uploadId}.json`), 'utf8'));
    assert.deepEqual(meta.received, [0, 1, 2, 3, 4, 5], 'every chunk recorded');
    const file = await store.completeChunkedUpload({ userDir, uploadId: session.uploadId });
    const data = await fsPromises.readFile(file.path);
    for (let i = 0; i < n; i += 1) assert.equal(data[i * chunkSize], i + 1);
  });

  test('a doubled complete finalises exactly once; the second answers the same file (replay), never a 404', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const session = await store.initChunkedUpload({ userDir, name: 'a.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 7) });
    let finalized = 0;
    const finalize = async () => { finalized += 1; return { fileId: 'file-row-1' }; };
    const results = await Promise.allSettled([
      store.completeChunkedUpload({ userDir, uploadId: session.uploadId, finalize }),
      store.completeChunkedUpload({ userDir, uploadId: session.uploadId, finalize }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    const [first, second] = results.map((r) => r.value);
    assert.equal(finalized, 1, 'the File row is created once');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(first.completedFileId, 'file-row-1');
    assert.equal(second.completedFileId, 'file-row-1');
    assert.equal(second.filename, first.filename);
    const finals = (await fsPromises.readdir(userDir)).filter((f) => f.startsWith('files-'));
    assert.equal(finals.length, 1);
  });

  test('a chunk racing a complete never resurrects the part next to the final file', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const session = await store.initChunkedUpload({ userDir, name: 'a.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 7) });
    const [done, late] = await Promise.allSettled([
      store.completeChunkedUpload({ userDir, uploadId: session.uploadId }),
      store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 7) }),
    ]);
    assert.equal(done.status, 'fulfilled');
    // The complete took the upload's lock first, so the late chunk is told the
    // session is finished instead of writing into a part that no longer exists.
    assert.equal(late.status, 'rejected');
    assert.equal(late.reason.name, 'ChunkedUploadError');
    assert.equal(late.reason.status, 409);
    assert.equal(late.reason.code, 'upload_completed');
    const parts = await fsPromises.readdir(path.join(userDir, store.PARTS_DIR));
    assert.deepEqual(parts, [`${session.uploadId}.json`], 'only the replay record is left: no part, no tmp');
  });
});

describe('chunked upload store · resume status', () => {
  test('reports received chunks, bytes and the expiry; unknown, other-owner and expired sessions are 404', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const total = chunkSize * 2 + 10;
    const session = await store.initChunkedUpload({ userDir, name: 'clase.mp4', size: total, mimeType: 'video/mp4', chunkSize, maxBytes: Infinity });
    assert.ok(Date.parse(session.expiresAt) > Date.now() + 47 * 60 * 60 * 1000, 'init announces the 48 h window');
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 2, buffer: bytes(10, 3) });
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 1) });

    const status = await store.getChunkedUploadStatus({ userDir, uploadId: session.uploadId });
    assert.deepEqual(status.received, [0, 2]);
    assert.equal(status.receivedBytes, chunkSize + 10);
    assert.equal(status.totalChunks, 3);
    assert.equal(status.size, total);
    assert.equal(status.chunkSize, chunkSize);
    assert.equal(status.name, 'clase.mp4');
    assert.equal(status.state, 'uploading');
    assert.equal(status.completed, false);
    assert.ok(Date.parse(status.expiresAt) > Date.now());

    const other = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-chunked-other-'));
    try {
      await assert.rejects(() => store.getChunkedUploadStatus({ userDir: other, uploadId: session.uploadId }), (err) => err.status === 404 && err.code === 'upload_not_found');
    } finally {
      await fsPromises.rm(other, { recursive: true, force: true });
    }
    await assert.rejects(() => store.getChunkedUploadStatus({ userDir, uploadId: 'b'.repeat(32) }), (err) => err.status === 404);
    await assert.rejects(() => store.getChunkedUploadStatus({ userDir, uploadId: '../etc' }), (err) => err.status === 400);
    await assert.rejects(
      () => store.getChunkedUploadStatus({ userDir, uploadId: session.uploadId, now: Date.now() + 49 * 60 * 60 * 1000 }),
      (err) => err.status === 404,
      'an unfinished session past its window is gone even before the sweep',
    );
  });

  test('a completed session reports its File id until the record expires', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const session = await store.initChunkedUpload({ userDir, name: 'a.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 7) });
    await store.completeChunkedUpload({ userDir, uploadId: session.uploadId, finalize: async () => ({ fileId: 'row-9' }) });
    const status = await store.getChunkedUploadStatus({ userDir, uploadId: session.uploadId });
    assert.equal(status.completed, true);
    assert.equal(status.state, 'completed');
    assert.equal(status.fileId, 'row-9');
    assert.deepEqual(status.received, [0]);
  });
});

describe('chunked upload store · finalize outcomes', () => {
  async function readyUpload(name = 'a.mp3') {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const session = await store.initChunkedUpload({ userDir, name, size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 5) });
    return session;
  }

  test('a finalize that throws rolls the rename back so the complete can be retried', async () => {
    const session = await readyUpload();
    await assert.rejects(
      () => store.completeChunkedUpload({ userDir, uploadId: session.uploadId, finalize: async () => { throw new Error('db down'); } }),
      /db down/,
    );
    assert.equal(fs.existsSync(path.join(userDir, store.PARTS_DIR, `${session.uploadId}.part`)), true, 'part restored');
    assert.deepEqual((await fsPromises.readdir(userDir)).filter((f) => f.startsWith('files-')), []);
    const retried = await store.completeChunkedUpload({ userDir, uploadId: session.uploadId, finalize: async () => ({ fileId: 'row-2' }) });
    assert.equal(retried.completedFileId, 'row-2');
    assert.equal(retried.replayed, false);
  });

  test('a finalize without a File id (policy rejection, DB failure) ends the session', async () => {
    const session = await readyUpload();
    const done = await store.completeChunkedUpload({
      userDir,
      uploadId: session.uploadId,
      finalize: async (file) => { await fsPromises.unlink(file.path); return { fileId: null, reason: 'policy' }; },
    });
    assert.equal(done.completedFileId, null);
    assert.deepEqual(done.finalizeResult, { fileId: null, reason: 'policy' });
    await assert.rejects(() => store.completeChunkedUpload({ userDir, uploadId: session.uploadId }), (err) => err.status === 404);
  });

  test('a complete interrupted after the rename finishes from the final file instead of a 409', async () => {
    const session = await readyUpload('clase.m4a');
    const metaPath = path.join(userDir, store.PARTS_DIR, `${session.uploadId}.json`);
    // Simulate a crash between the rename and the completion record.
    const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
    const filename = 'files-1-abcdefabcdef.m4a';
    meta.finalizing = { filename, startedAt: new Date().toISOString() };
    await fsPromises.writeFile(metaPath, JSON.stringify(meta));
    await fsPromises.rename(path.join(userDir, store.PARTS_DIR, `${session.uploadId}.part`), path.join(userDir, filename));
    const done = await store.completeChunkedUpload({ userDir, uploadId: session.uploadId, finalize: async (file) => ({ fileId: `row-${file.filename}` }) });
    assert.equal(done.filename, filename);
    assert.equal(done.completedFileId, `row-${filename}`);
  });
});

describe('chunked upload store · disk safety', () => {
  test('the free-space preflight refuses with a Spanish 507 when the disk cannot hold size × 1.1', async () => {
    const size = 100 * 1024 * 1024;
    const statfs = async () => ({ bavail: 105, bsize: 1024 * 1024 }); // 105 MB free < 110 MB needed
    await assert.rejects(
      () => store.initChunkedUpload({ userDir, name: 'clase.mp4', size, mimeType: 'video/mp4', maxBytes: Infinity, checkFreeSpace: true, statfs }),
      (err) => err.status === 507 && err.code === 'insufficient_storage' && /espacio suficiente/.test(err.message),
    );
    const parts = await fsPromises.readdir(path.join(userDir, store.PARTS_DIR)).catch(() => []);
    assert.deepEqual(parts, [], 'nothing is created for a refused upload');

    const roomy = async () => ({ bavail: 111, bsize: 1024 * 1024 });
    const ok = await store.initChunkedUpload({ userDir, name: 'clase.mp4', size, mimeType: 'video/mp4', maxBytes: Infinity, checkFreeSpace: true, statfs: roomy });
    assert.match(ok.uploadId, /^[a-f0-9]{32}$/);
    // statfs unavailable or failing: the preflight is skipped (ENOSPC on write stays the net).
    assert.deepEqual(await store.assertFreeSpace({ dir: userDir, size, statfs: async () => { throw new Error('ENOSYS'); } }), { checked: false, free: null, needed: Math.ceil(size * 1.1) });
    assert.equal((await store.assertFreeSpace({ dir: userDir, size, statfs: null })).checked, false);
  });

  test('ENOSPC while writing a chunk is a typed 507 with a Spanish message', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const session = await store.initChunkedUpload({ userDir, name: 'a.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    const originalOpen = fsPromises.open;
    fsPromises.open = async (...args) => {
      const fh = await originalOpen(...args);
      return {
        write: async () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); },
        close: () => fh.close(),
      };
    };
    try {
      await assert.rejects(
        () => store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 1) }),
        (err) => err.name === 'ChunkedUploadError' && err.status === 507 && err.code === 'insufficient_storage' && /espacio suficiente/.test(err.message),
      );
    } finally {
      fsPromises.open = originalOpen;
    }
    const status = await store.getChunkedUploadStatus({ userDir, uploadId: session.uploadId });
    assert.deepEqual(status.received, [], 'the failed chunk is not recorded as received');
    assert.equal(store.mapStorageError(Object.assign(new Error('quota'), { code: 'EDQUOT' })).status, 507);
    const other = new Error('EIO');
    assert.equal(store.mapStorageError(other), other);
  });
});

describe('chunked upload store · stale window and sweeper', () => {
  test('the stale window defaults to 48 h and follows SIRAGPT_CHUNKED_UPLOAD_STALE_MS (bounded)', () => {
    assert.equal(store.DEFAULT_STALE_MS, 48 * 60 * 60 * 1000);
    assert.equal(store.resolveStaleMs({}), 48 * 60 * 60 * 1000);
    assert.equal(store.resolveStaleMs({ SIRAGPT_CHUNKED_UPLOAD_STALE_MS: String(24 * 60 * 60 * 1000) }), 24 * 60 * 60 * 1000);
    assert.equal(store.resolveStaleMs({ SIRAGPT_CHUNKED_UPLOAD_STALE_MS: '5' }), 10 * 60 * 1000, 'floor of 10 min');
    assert.equal(store.resolveStaleMs({ SIRAGPT_CHUNKED_UPLOAD_STALE_MS: 'nope' }), 48 * 60 * 60 * 1000);
  });

  test('an unfinished session survives an overnight gap (7 h) and is swept after 48 h; finished records after 1 h', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const open = await store.initChunkedUpload({ userDir, name: 'clase.mp4', size: chunkSize, mimeType: 'video/mp4', chunkSize, maxBytes: Infinity });
    const done = await store.initChunkedUpload({ userDir, name: 'nota.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    await store.writeChunk({ userDir, uploadId: done.uploadId, index: 0, buffer: bytes(chunkSize, 1) });
    await store.completeChunkedUpload({ userDir, uploadId: done.uploadId });

    const hour = 60 * 60 * 1000;
    assert.equal(await store.sweepStaleChunkedUploads(userDir, { now: Date.now() + 30 * 60 * 1000 }), 0, 'nothing is stale after 30 min');
    assert.equal(await store.sweepStaleChunkedUploads(userDir, { now: Date.now() + 7 * hour }), 1, 'only the finished record goes after 1 h');
    assert.ok(await store.getChunkedUploadStatus({ userDir, uploadId: open.uploadId }), 'the unfinished upload is still resumable after 7 h');
    await assert.rejects(() => store.getChunkedUploadStatus({ userDir, uploadId: done.uploadId }), (err) => err.status === 404);
    assert.equal(await store.sweepStaleChunkedUploads(userDir, { now: Date.now() + 49 * hour }), 2, 'part + meta after 48 h');
    assert.ok((await fsPromises.readdir(userDir)).some((f) => f.startsWith('files-')), 'the final file of a finished upload is never swept');
  });

  test('the global sweeper walks every user dir, is unref\'d and idempotent', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-chunked-root-'));
    try {
      const chunkSize = store.MIN_CHUNK_BYTES;
      for (const user of ['user-a', 'user-b']) {
        const dir = path.join(root, user);
        await fsPromises.mkdir(dir, { recursive: true });
        await store.initChunkedUpload({ userDir: dir, name: 'x.mp4', size: chunkSize, mimeType: 'video/mp4', chunkSize, maxBytes: Infinity });
      }
      await fsPromises.writeFile(path.join(root, 'stray-file'), 'x');
      const swept = await store.sweepAllChunkedUploads(root, { maxAgeMs: 1, now: Date.now() + 60_000 });
      assert.deepEqual({ dirs: swept.dirs, removed: swept.removed }, { dirs: 2, removed: 4 });
      assert.ok(swept.bytes >= 0);

      const handle = store.startChunkedUploadSweeper({ rootDir: root, intervalMs: 60_000, logger: { log() {}, warn() {} } });
      try {
        assert.equal(handle.timer.hasRef(), false, 'never keeps the process alive');
        assert.equal(store.startChunkedUploadSweeper({ rootDir: root }), handle, 'one sweeper per process');
        const run = await handle.runNow();
        assert.equal(run.dirs, 2);
      } finally {
        handle.stop();
      }
      assert.notEqual(store.startChunkedUploadSweeper({ rootDir: root, logger: { log() {}, warn() {} } }), handle, 'a stopped sweeper can be restarted');
      store.startChunkedUploadSweeper({ rootDir: root }).stop();
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });
});
