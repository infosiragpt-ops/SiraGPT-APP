'use strict';

// Chunked uploads for large media: init → chunks at offsets → complete →
// multer-shaped file for the regular pipeline. All on a temp dir.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

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
    assert.match(file.filename, /^files-[a-f0-9]{32}\.mp4$/);
    assert.equal(path.dirname(file.path), userDir);
    const data = await fsPromises.readFile(file.path);
    assert.equal(data.length, total);
    assert.equal(data[0], 0x11);
    assert.equal(data[chunkSize], 0x22);
    assert.equal(data[chunkSize * 2], 0x33);
    assert.equal(fs.existsSync(path.join(userDir, store.PARTS_DIR, `${session.uploadId}.json`)), true, 'meta survives lost completion acknowledgement');
    const replay = await store.completeChunkedUpload({ userDir, uploadId: session.uploadId });
    assert.equal(replay.path, file.path);
    assert.equal(replay.deterministicId, file.deterministicId);
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
    const again = await store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 1) });
    assert.equal(again.received, 1);
    await assert.rejects(() => store.writeChunk({ userDir, uploadId: session.uploadId, index: 0, buffer: bytes(chunkSize, 2) }), err => err.code === 'chunk_hash_mismatch');
    assert.equal(await store.abortChunkedUpload({ userDir, uploadId: session.uploadId }), true);
    await assert.rejects(() => store.completeChunkedUpload({ userDir, uploadId: session.uploadId }), /no existe o caducó/);

    const stale = await store.initChunkedUpload({ userDir, name: 'b.mp3', size: chunkSize, mimeType: 'audio/mpeg', chunkSize, maxBytes: Infinity });
    const removed = await store.sweepStaleChunkedUploads(userDir, { maxAgeMs: 1, now: Date.now() + 60_000 });
    assert.equal(removed, 2, 'part + meta of the stale session removed');
    await assert.rejects(() => store.writeChunk({ userDir, uploadId: stale.uploadId, index: 0, buffer: bytes(chunkSize) }), /no existe o caducó/);
  });

  test('reselecting identical bytes resumes after restart, rejects mixed chunks, and complete replays its saved response', async () => {
    const chunkSize = store.MIN_CHUNK_BYTES;
    const chunks = [bytes(chunkSize, 4), bytes(17, 8)];
    const chunkHashes = chunks.map(buffer => createHash('sha256').update(buffer).digest('hex'));
    const input = { userDir, name: 'leccion.mp4', size: chunkSize + 17, mimeType: 'video/mp4', chunkSize, chunkHashes };
    const original = await store.initChunkedUpload(input);
    await store.writeChunk({ userDir, uploadId: original.uploadId, index: 0, buffer: chunks[0] });
    delete require.cache[require.resolve('../src/services/chunked-upload-store')];
    const restarted = require('../src/services/chunked-upload-store');
    const resumed = await restarted.initChunkedUpload(input);
    assert.equal(resumed.uploadId, original.uploadId);
    assert.deepEqual(resumed.received, [0]);
    await assert.rejects(() => restarted.writeChunk({ userDir, uploadId: resumed.uploadId, index: 1, buffer: bytes(17, 9) }), err => err.code === 'chunk_hash_mismatch');
    await restarted.writeChunk({ userDir, uploadId: resumed.uploadId, index: 1, buffer: chunks[1] });
    const file = await restarted.completeChunkedUpload({ userDir, uploadId: resumed.uploadId });
    const response = { files: [{ id: file.deterministicId, name: file.originalname }], chunked: true };
    await restarted.saveCompletedResponse({ userDir, uploadId: resumed.uploadId, response });
    assert.deepEqual(await restarted.getCompletedResponse({ userDir, uploadId: resumed.uploadId }), response);
    assert.deepEqual((await restarted.getChunkedUploadStatus({ userDir, uploadId: resumed.uploadId })).files, response.files);
    assert.equal(await restarted.abortChunkedUpload({ userDir, uploadId: resumed.uploadId }), false);
    assert.equal(fs.existsSync(file.path), true, 'cancellation after registration cannot delete the library binary');
    const otherDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-other-owner-'));
    try { await assert.rejects(() => restarted.getChunkedUploadStatus({ userDir: otherDir, uploadId: resumed.uploadId }), err => err.status === 404); }
    finally { await fsPromises.rm(otherDir, { recursive: true, force: true }); }
  });
});
